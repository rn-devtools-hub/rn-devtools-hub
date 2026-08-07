/**
 * Empty answers must say WHY they are empty.
 *
 * The three cases that look identical from outside the runtime: nothing
 * wrapped, wrapped too early to count, and genuinely quiet.
 */

import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS module, no types
import { readInstrumentation, explainEmptyNetwork, explainEmptyRegistry } from "../server/instrumentation.mjs";

const stateOf = (report: unknown) => ({ report, supported: true });

describe("readInstrumentation", () => {
  it("reads the report a current SDK answers", async () => {
    const state = await readInstrumentation(async () => ({ result: { network: { wraps: [] } } }));
    expect(state.supported).toBe(true);
    expect(state.report.network.wraps).toEqual([]);
  });

  it("degrades on an SDK that does not know the command", async () => {
    const state = await readInstrumentation(async () => ({ error: "Unknown command: context.instrumentation" }));
    expect(state.supported).toBe(false);
    expect(explainEmptyNetwork(state).instrumented).toBeNull();
  });

  it("degrades on a device that never answers", async () => {
    const state = await readInstrumentation(async () => { throw new Error("timeout"); });
    expect(explainEmptyNetwork(state).note).toMatch(/timeout/);
  });
});

describe("explainEmptyNetwork", () => {
  it("says nothing is watching when no client was ever wrapped", () => {
    const capture = explainEmptyNetwork(stateOf({ network: { instrumented: false, wraps: [] } }));
    expect(capture.instrumented).toBe(false);
    expect(capture.note).toMatch(/never called devtools\.wrapFetch/);
  });

  it("names the before-init trap when every wrap no-opped", () => {
    const capture = explainEmptyNetwork(stateOf({
      network: { instrumented: false, wraps: [{ kind: "fetch", label: "api", active: false }] },
    }));
    expect(capture.instrumented).toBe(false);
    expect(capture.note).toMatch(/BEFORE devtools\.init\(\)/);
    expect(capture.note).toMatch(/fetch:api/);
  });

  it("confirms the app is really quiet when a live wrapper exists", () => {
    const capture = explainEmptyNetwork(stateOf({
      network: { instrumented: true, wraps: [{ kind: "fetch", label: "api", active: true }] },
    }));
    expect(capture.instrumented).toBe(true);
    expect(capture.wrappedClients).toEqual(["fetch:api"]);
    expect(capture.note).toMatch(/really sent nothing/);
  });
});

describe("explainEmptyRegistry", () => {
  it("names the call that fills an empty registry", () => {
    expect(explainEmptyRegistry(stateOf({ stores: [] }), "stores")).toMatch(/registerStore/);
    expect(explainEmptyRegistry(stateOf({ actions: [] }), "actions")).toMatch(/registerAction/);
  });

  it("stays silent when the registry is not empty", () => {
    expect(explainEmptyRegistry(stateOf({ stores: [{ name: "auth" }] }), "stores")).toBeNull();
  });
});
