/**
 * MCP usage statistics: the Tools panel's only source of truth.
 *
 * What matters here is that the three outcomes stay distinct (answered,
 * empty, failed) and that they partition the calls exactly: the stacked
 * bars in the dashboard read as a whole, and an overlap would draw a bar
 * wider than the number of calls it represents.
 */

import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS module, no types
import { createToolLog, recordToolCall, summarizeTools, readEmptiness, normalizeError, readScreenshotPolicy, screenshotAdvice } from "../server/tools.mjs";

const logWith = (calls: Array<Record<string, unknown>>) => {
  const log = createToolLog();
  for (const call of calls) recordToolCall(log, call);
  return log;
};

describe("readEmptiness", () => {
  it("reads count, list fields and bare arrays", () => {
    expect(readEmptiness({ count: 0, matches: [] }).empty).toBe(true);
    expect(readEmptiness({ count: 2, matches: [1, 2] }).empty).toBe(false);
    expect(readEmptiness([]).empty).toBe(true);
    expect(readEmptiness({ actions: [{ name: "nav:home" }] }).empty).toBe(false);
  });

  it("takes the reason from the answer's own explanation", () => {
    expect(readEmptiness({ count: 0, absence: { reason: "attribute-absent" } }).reason).toBe("attribute-absent");
    expect(readEmptiness({ count: 0, events: [], capture: { instrumented: false } }).reason).toBe("not-instrumented");
    expect(readEmptiness({ count: 0, events: [], capture: { instrumented: true } }).reason).toBe("instrumented-but-quiet");
    expect(readEmptiness({ stores: [], note: "register one" }).reason).toBe("nothing-registered");
  });

  it("treats a scalar answer as non-empty", () => {
    expect(readEmptiness({ ok: true }).empty).toBe(false);
  });
});

describe("normalizeError", () => {
  it("folds the volatile parts so the same failure buckets together", () => {
    const a = normalizeError("Timed out after 8000 ms\nat handler");
    const b = normalizeError("Timed out after 15000 ms");
    expect(a).toBe(b);
    expect(a).not.toContain("\n");
  });
});

describe("summarizeTools", () => {
  it("partitions calls into answered, empty and failed", () => {
    const log = logWith([
      { name: "query_ui", ok: true, empty: false, bytes: 100, durationMs: 10, at: 1000 },
      { name: "query_ui", ok: true, empty: true, emptyReason: "attribute-absent", bytes: 20, durationMs: 12, at: 2000 },
      { name: "query_ui", ok: false, error: "No element matches role=\"button\"", bytes: 30, durationMs: 5, at: 3000 },
    ]);
    const [tool] = summarizeTools(log).tools;
    expect(tool.calls).toBe(3);
    expect(tool.errors).toBe(1);
    expect(tool.empty).toBe(1);
    // The dashboard draws calls - errors - empty as the answered segment
    expect(tool.calls - tool.errors - tool.empty).toBe(1);
    expect(tool.emptyReasons).toEqual([{ reason: "attribute-absent", count: 1 }]);
  });

  it("ranks failures by frequency and names the tools they came from", () => {
    const log = logWith([
      { name: "ui_act", ok: false, error: "No device available", at: 1000 },
      { name: "query_ui", ok: false, error: "No device available", at: 2000 },
      { name: "get_state", ok: false, error: "Unknown store \"auth\"", at: 3000 },
    ]);
    const [top] = summarizeTools(log).errors;
    expect(top.message).toBe("No device available");
    expect(top.count).toBe(2);
    expect(top.tools.sort()).toEqual(["query_ui", "ui_act"]);
  });

  it("counts selector families only on the tools that take one", () => {
    const log = logWith([
      { name: "query_ui", ok: true, empty: true, selector: { by: "role", value: "button" }, at: 1000 },
      { name: "query_ui", ok: true, empty: false, selector: { by: "testID", value: "submit" }, at: 2000 },
      { name: "get_recent_network", ok: true, selector: { by: "role", value: "button" }, at: 3000 },
    ]);
    const { selectors } = summarizeTools(log);
    expect(selectors).toHaveLength(2);
    expect(selectors.find((entry: { by: string }) => entry.by === "role")).toMatchObject({ calls: 1, empty: 1 });
  });

  it("reads the loop from consecutive calls, and ignores a long gap", () => {
    const log = logWith([
      { name: "ui_act", ok: true, at: 1000 },
      { name: "wait_for_event", ok: true, at: 2000 },
      { name: "wait_for_event", ok: true, at: 3000 },
      { name: "query_ui", ok: true, at: 3000 + 120000 },
    ]);
    const { loop } = summarizeTools(log);
    expect(loop.repeats).toBe(1);
    expect(loop.pairs).toEqual([{ pair: "ui_act → wait_for_event", count: 1 }]);
  });

  it("keeps the ring bounded and the totals consistent with it", () => {
    const log = createToolLog(3);
    for (let index = 0; index < 10; index += 1) {
      recordToolCall(log, { name: "list_devices", ok: true, bytes: 10, at: index });
    }
    const summary = summarizeTools(log);
    expect(summary.totals.calls).toBe(3);
    expect(summary.totals.bytes).toBe(30);
    expect(log.seq).toBe(10);
  });
});

/**
 * Pixels.
 *
 * "Never verify with a screenshot" has been the first habit in the skill
 * from the start, and a skill is advice: an agent that ignores it
 * screenshots every step and bills a megabyte of context each time. These
 * are the two things that turn the advice into something the hub can
 * actually do: count what the pixels cost, and let them be switched off.
 */
describe("readScreenshotPolicy", () => {
  it("leaves screenshots alone when nothing is set", () => {
    expect(readScreenshotPolicy({})).toMatchObject({ mode: "on", budget: null });
  });

  it("reads off, and the spellings people actually type", () => {
    for (const raw of ["off", "OFF", " none ", "false", "0", "no"]) {
      expect(readScreenshotPolicy({ RN_DEVTOOLS_SCREENSHOTS: raw }).mode).toBe("off");
    }
  });

  it("reads a budget, with or without the prefix", () => {
    expect(readScreenshotPolicy({ RN_DEVTOOLS_SCREENSHOTS: "5" })).toMatchObject({ mode: "budget", budget: 5 });
    expect(readScreenshotPolicy({ RN_DEVTOOLS_SCREENSHOTS: "budget:12" })).toMatchObject({ mode: "budget", budget: 12 });
  });

  it("keeps the capability and warns when the value cannot be read", () => {
    // Silently disabling a tool because a variable was mistyped is worse
    // than ignoring the variable
    const policy = readScreenshotPolicy({ RN_DEVTOOLS_SCREENSHOTS: "yes please" });
    expect(policy.mode).toBe("on");
    expect(policy.warning).toMatch(/stay enabled/);
  });
});

describe("screenshotAdvice", () => {
  it("says nothing about a single look", () => {
    const log = logWith([{ name: "screenshot_native", bytes: 900000 }]);
    expect(screenshotAdvice(log).sinceProof).toBe(1);
  });

  it("counts the captures taken since the last assertion, and what they cost", () => {
    const log = logWith([
      { name: "screenshot_native", bytes: 1000 },
      { name: "assert", bytes: 200 },
      { name: "ui_act", bytes: 300 },
      { name: "screenshot_native", bytes: 2000 },
      { name: "screenshot_native", bytes: 3000 },
    ]);
    // The assert resets it: what matters is pixels used INSTEAD of proof
    expect(screenshotAdvice(log)).toEqual({ sinceProof: 2, bytes: 5000 });
  });

  it("forgets the loop as soon as something was actually proven", () => {
    const log = logWith([
      { name: "screenshot_native", bytes: 1000 },
      { name: "screenshot_native", bytes: 1000 },
      { name: "assert", bytes: 100 },
    ]);
    expect(screenshotAdvice(log)).toEqual({ sinceProof: 0, bytes: 0 });
  });
});

describe("pixel accounting", () => {
  it("counts pixel calls outside the ring, so a budget survives the window", () => {
    const log = createToolLog(2);
    for (const call of [
      { name: "screenshot_native", bytes: 10 },
      { name: "screenshot_native", bytes: 20 },
      { name: "query_ui", bytes: 5 },
      { name: "query_ui", bytes: 5 },
    ]) recordToolCall(log, call);
    expect(log.calls.length).toBe(2);
    expect(log.pixelCalls).toBe(2);
    expect(log.pixelBytes).toBe(30);
  });

  it("reports the pixel share of the context in the summary", () => {
    const log = logWith([
      { name: "screenshot_native", bytes: 900 },
      { name: "query_ui", bytes: 100 },
    ]);
    const summary = summarizeTools(log);
    expect(summary.totals.pixelCalls).toBe(1);
    expect(summary.totals.pixelBytes).toBe(900);
    expect(summary.totals.bytes).toBe(1000);
  });
});
