import { describe, expect, it } from "vitest";
// @ts-expect-error untyped CLI module
import { parseRunFlowArgs, runFlowCommand } from "../src/cli/run-flow.mjs";

describe("hubflow CLI", () => {
  it("parses the scenario and optional targets", () => {
    expect(parseRunFlowArgs(["tests/hub/checkout.hubflow", "--device", "phone", "--target", "sim:1", "--port", "8974"]))
      .toEqual({ path: "tests/hub/checkout.hubflow", deviceId: "phone", target: "sim:1", port: 8974 });
  });

  it("rejects a missing or invalid scenario", () => {
    expect(() => parseRunFlowArgs([])).toThrow("Pass a .hubflow file");
    expect(() => parseRunFlowArgs(["checkout.json"])).toThrow("must end in .hubflow");
  });

  it("returns a failing process status when MCP marks the run as an error", async () => {
    const writes: string[] = [];
    let calls = 0;
    const fetchImpl = async (_url: string, init: any) => {
      calls += 1;
      if (calls === 1) {
        return { ok: true, json: async () => ({ result: { content: [{ type: "text", text: JSON.stringify({ project: { directory: "/project" } }) }] } }) };
      }
      expect(JSON.parse(init.body).params).toMatchObject({ name: "run_flow", arguments: { path: "tests/hub/fail.hubflow" } });
      return { ok: true, json: async () => ({ result: { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, name: "fail", status: "failed", failedStep: 1, reason: "expectation-failed" }) }] } }) };
    };
    const status = await runFlowCommand(["tests/hub/fail.hubflow", "--port", "8973"], {
      cwd: "/project", fetchImpl, write: (line: string) => writes.push(line),
    });
    expect(status).toBe(1);
    expect(writes).toContain("Failed step: 2");
  });
});
