import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error untyped server module
import * as hubflow from "../server/hubflow.mjs";

const sample = (extra: Record<string, unknown> = {}) => ({
  format: "rn-devtools-hub/flow", version: 1, name: "checkout", setup: [],
  steps: [{ name: "Order", act: { tool: "ui_act", arguments: { action: "tap", by: "testID", value: "order" } }, expect: [{ tool: "assert", arguments: { kind: "visible", by: "text", value: "Done" } }], capture: true }],
  teardown: [], visualEvidence: { screenshots: "important-and-failure", final: true }, ...extra,
});

const project = async () => mkdtemp(join(tmpdir(), "hubflow-"));

describe("hubflow storage and validation", () => {
  it("round trips versioned flows and discovers nested files", async () => {
    const root = await project();
    await hubflow.writeHubflow(root, "checkout.hubflow", sample());
    await hubflow.writeHubflow(root, "tests/hub/auth/login.hubflow", sample({ name: "login" }));
    expect((await hubflow.readHubflow(root, "checkout.hubflow")).name).toBe("checkout");
    expect(await hubflow.listHubflows(root)).toEqual(["tests/hub/auth/login.hubflow", "tests/hub/checkout.hubflow"]);
  });

  it("rejects traversal, absolute and non-hubflow paths", async () => {
    const root = await project();
    expect(() => hubflow.resolveHubflowPath(root, "../escape.hubflow")).toThrow(/escapes/);
    expect(() => hubflow.resolveHubflowPath(root, "/tmp/a.hubflow")).toThrow(/project-relative/);
    expect(() => hubflow.resolveHubflowPath(root, "test.json")).toThrow(/\.hubflow/);
  });

  it("rejects symlink escapes", async () => {
    const root = await project();
    const outside = await project();
    await mkdir(join(root, "tests"), { recursive: true });
    await symlink(outside, join(root, "tests", "hub"));
    await expect(hubflow.writeHubflow(root, "escape.hubflow", sample())).rejects.toThrow(/symlink/);
    await expect(hubflow.listHubflows(root)).rejects.toThrow(/symlink/);
  });

  it("allows replay primitives but rejects plugin, release and arbitrary tools", () => {
    expect(() => hubflow.validateHubflow(sample())).not.toThrow();
    for (const tool of ["asc_release_version", "gplay_update_track", "screenshot_native", "shell_exec"]) {
      expect(() => hubflow.validateHubflow(sample({ steps: [{ act: { tool, arguments: {} }, expect: [] }] }))).toThrow(/disallowed/);
    }
  });
});

describe("recorded flow conversion", () => {
  it("creates a durable causal v1 scenario and preserves index zero", () => {
    const result = hubflow.durableFlowFromRecorded({ name: "rows", finalCursor: 42, steps: [{ action: "tap", selector: { by: "text", value: "Delete" }, index: 0, source: { file: "Rows.tsx", line: 4 }, consequences: [{ kind: "wait", type: "screen.ready", screen: "Empty", failed: false }] }] });
    expect(result).toMatchObject({ format: "rn-devtools-hub/flow", version: 1 });
    expect(result.recording.finalCursor).toBe(42);
    expect(result.steps[0].act.arguments.index).toBe(0);
    expect(result.steps[0].expect[0]).toMatchObject({ tool: "wait_for_event", arguments: { payloadContains: "Empty" } });
  });
});

describe("hubflow execution", () => {
  it("keeps homonymous scenario reports in separate directories", async () => {
    const root = await project();
    const flow = sample({ visualEvidence: { screenshots: "off" } });
    const first = await hubflow.runHubflow(flow, { projectRoot: root, flowPath: "tests/hub/a.hubflow", runId: "same", invoke: async () => ({ ok: true }) });
    const second = await hubflow.runHubflow(flow, { projectRoot: root, flowPath: "tests/hub/b.hubflow", runId: "same", invoke: async () => ({ ok: true }) });
    expect(first.storageKey).not.toBe(second.storageKey);
  });

  it("runs setup, action, expectations and teardown with readable reports and selected captures", async () => {
    const root = await project();
    const calls: string[] = [];
    const captures: string[] = [];
    const flow = sample({ setup: [{ tool: "freeze_time", arguments: {} }], teardown: [{ tool: "restore_time", arguments: {} }] });
    const report = await hubflow.runHubflow(flow, { projectRoot: root, runId: "run-1", invoke: async (tool: string) => { calls.push(tool); return { ok: true }; }, capture: async ({ kind, path }: any) => { captures.push(kind); await writeFile(path, "png"); return { width: 100 }; } });
    expect(calls).toEqual(["freeze_time", "ui_act", "assert", "restore_time"]);
    expect(report.status).toBe("passed");
    expect(report.steps[0].status).toBe("passed");
    expect(captures).toEqual(["start", "step", "final"]);
    expect(JSON.parse(await readFile(join(root, ".rn-devtools/flows/runs", report.storageKey, "run-1/report.json"), "utf8")).status).toBe("passed");
  });

  it("captures failures, classifies selector drift, records previous successful evidence and always tears down", async () => {
    const root = await project();
    const flow = sample({
      steps: [sample().steps[0], { name: "Again", act: { tool: "ui_act", arguments: { action: "tap", by: "text", value: "Old label" } }, expect: [] }],
      teardown: [{ tool: "restore_time", arguments: {} }], visualEvidence: { screenshots: "every-step", final: true },
    });
    const seen: string[] = [];
    const report = await hubflow.runHubflow(flow, { projectRoot: root, runId: "run-2", invoke: async (tool: string, args: any) => { seen.push(tool); if (args.value === "Old label") throw new Error("selector not found"); return { ok: true }; }, capture: async ({ path }: any) => { await writeFile(path, "png"); } });
    expect(report.status).toBe("failed");
    expect(report.ok).toBe(false);
    expect(report.reason).toBe("target-mismatch");
    expect(report.failedStep).toBe(1);
    expect(report.steps[1].failure.classification).toBe("target-mismatch");
    expect(report.steps[1].previousSuccessfulCapture.path).toBe("step-01.png");
    expect(report.steps[1].screenshot.path).toBe("failure-step-02.png");
    expect(seen[seen.length - 1]).toBe("restore_time");
  });

  it("does not turn a missing screenshot adapter into a functional failure", async () => {
    const root = await project();
    const report = await hubflow.runHubflow(sample(), {
      projectRoot: root,
      invoke: async () => ({ ok: true }),
      capture: async () => { throw new Error("native capture unavailable"); },
    });
    expect(report.ok).toBe(true);
    expect(report.evidenceErrors.length).toBeGreaterThan(0);
  });

  it("writes a repair candidate only for a strongly identified target", async () => {
    const root = await project();
    const flow = sample({
      steps: [{
        name: "Order",
        act: { tool: "ui_act", arguments: { action: "tap", by: "role", value: "button", name: "Old label" } },
        expect: [],
        targetEvidence: { source: { file: "Checkout.tsx", componentName: "CheckoutButton" } },
      }],
      visualEvidence: { screenshots: "off" },
    });
    await hubflow.writeHubflow(root, "checkout.hubflow", flow);
    await hubflow.runHubflow(flow, {
      projectRoot: root,
      flowPath: "checkout.hubflow",
      runId: "repair-run",
      invoke: async () => ({
        ok: false,
        message: "selector not found",
        candidates: [{
          testID: "checkout-submit",
          role: "button",
          name: "Confirm order",
          source: { file: "Checkout.tsx", componentName: "CheckoutButton" },
        }],
      }),
    });
    const proposal = await hubflow.proposeHubflowRepair(root, "checkout.hubflow", { stepIndex: 0, candidateIndex: 0 });
    expect(proposal.candidate).toBe("checkout.candidate.hubflow");
    const repaired = await hubflow.readHubflow(root, proposal.candidate);
    expect(repaired.steps[0].act.arguments).toMatchObject({ by: "testID", value: "checkout-submit" });
    expect((await hubflow.readHubflow(root, "checkout.hubflow")).steps[0].act.arguments.name).toBe("Old label");
  });

  it("honors failure-only and off screenshot policies", async () => {
    for (const policy of ["failure-only", "off"]) {
      const root = await project();
      let captures = 0;
      const report = await hubflow.runHubflow(sample({ visualEvidence: { screenshots: policy, final: true } }), { projectRoot: root, invoke: async (tool: string) => { if (tool === "assert") throw new Error("expected visible"); return { ok: true }; }, capture: async () => { captures += 1; } });
      expect(report.status).toBe("failed");
      expect(captures).toBe(policy === "failure-only" ? 1 : 0);
    }
  });

  it("takes no screenshot for a successful failure-only run", async () => {
    const root = await project();
    let captures = 0;
    const report = await hubflow.runHubflow(sample({ visualEvidence: { screenshots: "failure-only", final: true } }), {
      projectRoot: root,
      invoke: async () => ({ ok: true }),
      capture: async () => { captures += 1; },
    });
    expect(report.ok).toBe(true);
    expect(captures).toBe(0);
  });

  it("fails and captures when teardown cannot restore the environment", async () => {
    const root = await project();
    const captures: string[] = [];
    const report = await hubflow.runHubflow(sample({
      teardown: [{ tool: "restore_time", arguments: {} }],
      visualEvidence: { screenshots: "failure-only", final: true },
    }), {
      projectRoot: root,
      invoke: async (tool: string) => {
        if (tool === "restore_time") throw new Error("restore failed");
        return { ok: true };
      },
      capture: async ({ kind }: any) => { captures.push(kind); },
    });
    expect(report.ok).toBe(false);
    expect(report.reason).toBe("teardown-failed");
    expect(captures).toEqual(["failure"]);
  });

  it("prunes older run directories according to retention", async () => {
    const root = await project();
    let storageKey = "";
    for (const runId of ["one", "two", "three"]) {
      const report = await hubflow.runHubflow(sample({ visualEvidence: { screenshots: "off" }, retention: { runs: 2 } }), { projectRoot: root, runId, invoke: async () => ({ ok: true }) });
      storageKey = report.storageKey;
    }
    const entries = await hubflow.listHubflows(root);
    expect(entries).toEqual([]);
    const dirs = await import("node:fs/promises").then((fs) => fs.readdir(join(root, ".rn-devtools/flows/runs", storageKey)));
    expect(dirs).toHaveLength(2);
  });
});
