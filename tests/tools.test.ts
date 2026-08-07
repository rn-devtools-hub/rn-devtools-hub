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
import { createToolLog, recordToolCall, summarizeTools, readEmptiness, normalizeError } from "../server/tools.mjs";

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
