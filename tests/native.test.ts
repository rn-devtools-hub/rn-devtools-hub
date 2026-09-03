import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error - plain ESM module, no types
import { BROKEN_IDB_HINT, isBrokenIdb, swipeArgv, adbReverseArgv, appContainerArgv, prefsPlistPath, simulatorFlagArgv, devMenuFabValue, expoSchemeFromProject, DEV_MENU_FAB_KEY, DEV_MENU_ONBOARDING_KEY } from "../server/native.mjs";

const argvOf = swipeArgv as (gesture: Record<string, unknown>) => string[];
const containerArgv = appContainerArgv as (id: string, app: string) => string[];
const plistPath = prefsPlistPath as (container: string, app: string) => string;
const flagArgv = simulatorFlagArgv as (
  id: string,
  plist: string,
  key: string,
  value: boolean
) => string[];
const fabValue = devMenuFabValue as (hideDevMenuFab?: boolean) => boolean;

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

/**
 * The three binaries take the same gesture in three different shapes, and
 * a wrong unit is invisible: adb counts milliseconds, AXe and idb count
 * seconds, so a duration passed straight through produces a 200-second
 * drag that reports success and does nothing an app would recognise.
 * Building the argv separately is what makes that checkable without a
 * simulator and without any of the three installed.
 */
describe("swipeArgv", () => {
  const gesture = { id: "DEV-1", x1: 100, y1: 600, x2: 100, y2: 200, durationMs: 300 };

  it("gives adb its coordinates bare and its duration in milliseconds", () => {
    expect(argvOf({ ...gesture, kind: "adb" })).toEqual([
      "adb", "-s", "DEV-1", "shell", "input", "swipe", "100", "600", "100", "200", "300",
    ]);
  });

  it("gives AXe named endpoints and a duration in seconds", () => {
    expect(argvOf({ ...gesture, kind: "sim", tool: "axe" })).toEqual([
      "axe", "swipe",
      "--start-x", "100", "--start-y", "600",
      "--end-x", "100", "--end-y", "200",
      "--duration", "0.3",
      "--udid", "DEV-1",
    ]);
  });

  it("gives idb its coordinates positionally, like idb ui tap", () => {
    expect(argvOf({ ...gesture, kind: "sim", tool: "idb" })).toEqual([
      "idb", "ui", "swipe", "100", "600", "100", "200", "--duration", "0.3", "--udid", "DEV-1",
    ]);
  });

  it("defaults to AXe, the one that needs no Python", () => {
    expect(argvOf({ ...gesture, kind: "sim" })[0]).toBe("axe");
  });

  it("rounds coordinates: a measured rect gives fractional points", () => {
    expect(argvOf({ ...gesture, kind: "adb", x1: 99.6, y1: 600.4 }).slice(6, 8)).toEqual(["100", "600"]);
  });

  it("treats zero as the floor, not as no duration at all", () => {
    // The falsy zero trap: `Number(0) || 200` answered 200, so the
    // documented 20 ms floor was unreachable and the gesture silently
    // became a slow one
    const argv = argvOf({ ...gesture, kind: "adb", durationMs: 0 });
    expect(argv[argv.length - 1]).toBe("20");
  });

  it("clamps the duration on both ends, and defaults it when absent", () => {
    const durationOf = (durationMs: unknown) => {
      const argv = argvOf({ ...gesture, kind: "adb", durationMs });
      return argv[argv.length - 1];
    };
    expect(durationOf(5)).toBe("20");
    expect(durationOf(99999)).toBe("3000");
    expect(durationOf(undefined)).toBe("200");
    // Clamped for iOS too, where the unit changes but the bounds do not
    expect(argvOf({ ...gesture, kind: "sim", durationMs: 99999 })).toContain("3");
  });
});

/**
 * launch_app writes a PERSISTENT preference into the user's app sandbox,
 * by default, on every iOS launch. Two things there are silent when wrong:
 * the domain (a bare bundle id writes to the DEVICE preferences, which the
 * app never reads, and the launch still reports success) and the direction
 * of the flag, since the option says "hide" while the preference says
 * "show". Both are checkable without a simulator.
 */
describe("expo-dev-menu preferences", () => {
  it("asks simctl for the app's DATA container, not the bundle", () => {
    expect(containerArgv("DEV-1", "com.acme.app")).toEqual([
      "xcrun", "simctl", "get_app_container", "DEV-1", "com.acme.app", "data",
    ]);
  });

  it("writes into the app's own plist inside that container", () => {
    // simctl prints the path with a trailing newline, which would produce
    // a path with a line break in the middle of the argv
    expect(plistPath("/Users/x/data/Containers/Data/Application/ABC\n", "com.acme.app")).toBe(
      "/Users/x/data/Containers/Data/Application/ABC/Library/Preferences/com.acme.app.plist"
    );
  });

  it("spawns defaults inside the simulator with a boolean", () => {
    expect(flagArgv("DEV-1", "/tmp/app.plist", DEV_MENU_ONBOARDING_KEY, true)).toEqual([
      "xcrun", "simctl", "spawn", "DEV-1", "defaults", "write",
      "/tmp/app.plist", "EXDevMenuIsOnboardingFinished", "-bool", "true",
    ]);
  });

  it("hides the floating button by default, and puts it back on request", () => {
    expect(fabValue(undefined)).toBe(false); // show:false, the bubble is hidden
    expect(fabValue(true)).toBe(false);
    expect(fabValue(false)).toBe(true); // explicitly asked for it back
  });

  it("names the key expo-dev-menu actually reads", () => {
    // A typo here is invisible: defaults write succeeds on any key at all
    expect(DEV_MENU_FAB_KEY).toBe("EXDevMenuShowFloatingActionButton");
    expect(flagArgv("DEV-1", "/tmp/app.plist", DEV_MENU_FAB_KEY, fabValue(undefined))).toEqual([
      "xcrun", "simctl", "spawn", "DEV-1", "defaults", "write",
      "/tmp/app.plist", "EXDevMenuShowFloatingActionButton", "-bool", "false",
    ]);
    expect(flagArgv("DEV-1", "/tmp/app.plist", DEV_MENU_FAB_KEY, fabValue(false))).toEqual([
      "xcrun", "simctl", "spawn", "DEV-1", "defaults", "write",
      "/tmp/app.plist", "EXDevMenuShowFloatingActionButton", "-bool", "true",
    ]);
  });
});

describe("expoSchemeFromProject", () => {
  const withAppJson = (value: unknown, run: (root: string) => void) => {
    const root = mkdtempSync(join(tmpdir(), "rn-devtools-scheme-"));
    try {
      writeFileSync(join(root, "app.json"), JSON.stringify(value));
      run(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  it("uses an explicitly configured Expo scheme", () => {
    withAppJson({ expo: { scheme: "shippex-driver", slug: "driver" } }, (root) => {
      expect(expoSchemeFromProject(root)).toBe("shippex-driver");
    });
  });

  it("derives Expo's development-client scheme from the slug", () => {
    withAppJson({ expo: { slug: "Shippex Driver" } }, (root) => {
      expect(expoSchemeFromProject(root)).toBe("exp+shippexdriver");
    });
  });

  it("degrades when the project has no static Expo config", () => {
    expect(expoSchemeFromProject("/path/that/does/not/exist")).toBeNull();
  });
});

describe("adb route recovery", () => {
  it("pins the reverse mapping to the selected device", () => {
    expect(adbReverseArgv("emulator-5554", 8973)).toEqual([
      "adb", "-s", "emulator-5554", "reverse", "tcp:8973", "tcp:8973",
    ]);
  });
});
