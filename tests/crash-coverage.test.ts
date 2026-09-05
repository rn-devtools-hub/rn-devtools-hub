import { afterEach, describe, expect, it, vi } from "vitest";

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const sdk = async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubGlobal("__DEV__", true);
  vi.stubGlobal("WebSocket", class { close() {} });
  const { devtools } = await import("../src/client/index");
  devtools.init({ serverUrl: "ws://localhost:1", appName: "coverage-test" });
  stop = () => devtools.__transport?.stop();
  return devtools;
};

describe("crash observer coverage", () => {
  it("does not claim capture when native observer APIs are missing", async () => {
    vi.stubGlobal("ErrorUtils", undefined);
    vi.stubGlobal("HermesInternal", undefined);
    const devtools = await sdk();
    devtools.attachCrashReporting();
    expect(devtools.instrumentation().crashes).toEqual({ errors: false, rejections: false });
  });

  it("reports actual coverage and avoids installing duplicate handlers", async () => {
    const errors = vi.fn();
    const rejections = vi.fn();
    vi.stubGlobal("ErrorUtils", { setGlobalHandler: errors });
    vi.stubGlobal("HermesInternal", { enablePromiseRejectionTracker: rejections });
    const devtools = await sdk();
    devtools.attachCrashReporting();
    devtools.attachCrashReporting();
    expect(devtools.instrumentation().crashes).toEqual({ errors: true, rejections: true });
    expect(errors).toHaveBeenCalledTimes(1);
    expect(rejections).toHaveBeenCalledTimes(1);
  });

  it("leaves rejection coverage false if Hermes refuses the observer", async () => {
    vi.stubGlobal("ErrorUtils", { setGlobalHandler: vi.fn() });
    vi.stubGlobal("HermesInternal", { enablePromiseRejectionTracker: () => { throw new Error("unsupported"); } });
    const devtools = await sdk();
    devtools.attachCrashReporting();
    expect(devtools.instrumentation().crashes).toEqual({ errors: true, rejections: false });
  });
});
