import { describe, expect, it } from "vitest";
// @ts-expect-error - plain ESM module, no types
import { BROKEN_IDB_HINT, isBrokenIdb } from "../server/native.mjs";

describe("isBrokenIdb", () => {
  it("recognises the Python 3.12+ event loop removal", () => {
    // What idb actually prints on a machine whose default Python is 3.12+.
    const output = [
      "Traceback (most recent call last):",
      '  File "/Library/Frameworks/Python.framework/Versions/3.14/bin/idb", line 7, in <module>',
      "    sys.exit(main())",
      "    raise RuntimeError('There is no current event loop in thread %r.'",
      "RuntimeError: There is no current event loop in thread 'MainThread'.",
    ].join("\n");
    expect(isBrokenIdb(output)).toBe(true);
  });

  it("recognises a missing dependency", () => {
    expect(isBrokenIdb("ModuleNotFoundError: No module named 'idb.common'")).toBe(true);
  });

  it("leaves genuine tap failures alone", () => {
    // These must keep their own error, otherwise a real problem is reported as
    // a toolchain one and the user goes and installs AXe for nothing.
    expect(isBrokenIdb("idb: error: no companion for udid ABC-123")).toBe(false);
    expect(isBrokenIdb("Tap failed: target out of bounds")).toBe(false);
    expect(isBrokenIdb("")).toBe(false);
    expect(isBrokenIdb(null)).toBe(false);
    expect(isBrokenIdb(undefined)).toBe(false);
  });

  it("points at AXe, which needs no Python at all", () => {
    expect(BROKEN_IDB_HINT).toContain("brew install cameroncooke/axe/axe");
    expect(BROKEN_IDB_HINT).toContain("Python 3.11");
  });
});
