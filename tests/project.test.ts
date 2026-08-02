import { describe, expect, it } from "vitest";
// The hub is plain .mjs with no declarations: type the surface at the
// call site rather than duplicating the module in a .d.ts
// @ts-expect-error untyped hub module
import { compareContexts as rawCompareContexts, missingCapabilities as rawMissing } from "../server/project.mjs";

interface Gap {
  capability: string;
  missing: string;
  install: string;
  affects: string[];
  note: string;
}

const missingCapabilities = rawMissing as (declared: unknown) => Gap[];

interface Divergence {
  field: string;
  declared: unknown;
  runtime: unknown;
  severity: string;
  hint: string;
}

const compareContexts = rawCompareContexts as (
  declared: unknown,
  runtime: unknown
) => Divergence[];

const declared = (overrides = {}) => ({
  projectDir: "/tmp/app",
  packages: { "react-native": { range: "0.81.4", installed: "0.81.4" }, react: { range: "19.1.0", installed: "19.1.0" } },
  jsEngine: "hermes",
  newArchEnabled: true,
  newArchDeclaredIn: "app.json",
  plugins: [],
  ...overrides,
});

const runtime = (overrides = {}) => ({
  jsEngine: "hermes",
  newArchitecture: true,
  bridgeless: true,
  turboModules: true,
  dev: true,
  reactNativeVersion: "0.81.4",
  renderers: [{ version: "19.1.0", rendererPackageName: "react-native-renderer" }],
  appOwnership: null,
  ...overrides,
});

const fields = (list: Divergence[]): string[] => list.map((entry) => entry.field);

const find = (list: Divergence[], field: string): Divergence => {
  const entry = list.find((item) => item.field === field);
  if (!entry) throw new Error(`No divergence on "${field}"`);
  return entry;
};

describe("compareContexts", () => {
  it("finds nothing when the binary matches the project", () => {
    expect(compareContexts(declared(), runtime())).toEqual([]);
  });

  it("returns nothing when the runtime half is missing", () => {
    expect(compareContexts(declared(), null)).toEqual([]);
  });

  it("flags a native build compiled against another React Native version", () => {
    const found = compareContexts(declared(), runtime({ reactNativeVersion: "0.79.2" }));
    expect(fields(found)).toContain("reactNativeVersion");
    expect(found[0].severity).toBe("high");
    expect(found[0].hint).toMatch(/[Rr]ebuild/);
  });

  it("treats a caret range and its resolved version as the same build", () => {
    const context = declared({
      packages: { "react-native": { range: "^0.81.4", installed: "0.81.4" } },
    });
    expect(fields(compareContexts(context, runtime()))).not.toContain("reactNativeVersion");
  });

  it("ignores a prerelease suffix when comparing versions", () => {
    const context = declared({
      packages: { "react-native": { range: "0.82.0", installed: "0.82.0" } },
    });
    const found = compareContexts(context, runtime({ reactNativeVersion: "0.82.0-rc.1" }));
    expect(fields(found)).not.toContain("reactNativeVersion");
  });

  it("catches the stale build behind a New Architecture flag", () => {
    const found = compareContexts(declared(), runtime({ newArchitecture: false }));
    const entry = find(found, "newArchitecture");
    expect(entry.severity).toBe("high");
    expect(entry.hint).toContain("app.json");
  });

  it("reports a binary ahead of its config as lower severity", () => {
    const found = compareContexts(
      declared({ newArchEnabled: false }),
      runtime({ newArchitecture: true })
    );
    expect(find(found, "newArchitecture").severity).toBe("medium");
  });

  it("flags a release bundle, which no UI automation can drive", () => {
    const found = compareContexts(declared(), runtime({ dev: false }));
    const entry = find(found, "dev");
    expect(entry.severity).toBe("high");
    expect(entry.hint).toContain("DevTools hook");
  });

  it("flags Expo Go running a project that declares config plugins", () => {
    const found = compareContexts(
      declared({ plugins: ["expo-notifications", "expo-splash-screen"] }),
      runtime({ appOwnership: "expo" })
    );
    const entry = find(found, "appOwnership");
    expect(entry.declared).toContain("2");
    expect(entry.hint).toContain("development build");
  });

  it("stays quiet in Expo Go when the project declares no plugin", () => {
    const found = compareContexts(declared(), runtime({ appOwnership: "expo" }));
    expect(fields(found)).not.toContain("appOwnership");
  });

  it("reports a duplicated React through the renderer version", () => {
    const found = compareContexts(
      declared(),
      runtime({ renderers: [{ version: "18.3.1", rendererPackageName: "react-native-renderer" }] })
    );
    expect(find(found, "react").hint).toContain("duplicated React");
  });

  it("separates a missing Hermes from a different engine", () => {
    const absent = compareContexts(declared(), runtime({ jsEngine: null }));
    expect(find(absent, "jsEngine").severity).toBe("low");
    const other = compareContexts(declared(), runtime({ jsEngine: "jsc" }));
    expect(find(other, "jsEngine").severity).toBe("medium");
  });

  it("accumulates every contradiction rather than stopping at the first", () => {
    const found = compareContexts(
      declared({ plugins: ["expo-camera"] }),
      runtime({
        reactNativeVersion: "0.79.0",
        newArchitecture: false,
        dev: false,
        appOwnership: "expo",
      })
    );
    expect(fields(found)).toEqual(
      expect.arrayContaining(["reactNativeVersion", "newArchitecture", "dev", "appOwnership"])
    );
  });
});

/**
 * An agent already has a shell. What it lacks is knowing that a package is
 * missing and what that costs it. Owning the install would mean owning a
 * change to someone's package.json, lockfile and native build, which is
 * not this tool's to make; naming the gap is.
 */
describe("missingCapabilities", () => {
  it("names the gap and the command, without performing it", () => {
    const gaps = missingCapabilities({ packages: {} });
    const shot = gaps.find((gap) => gap.missing === "react-native-view-shot");
    expect(shot).toBeTruthy();
    expect(shot!.install).toBe("npx expo install react-native-view-shot");
    expect(shot!.affects.join(" ")).toContain("mirror");
  });

  it("stays quiet once the package is installed", () => {
    const gaps = missingCapabilities({
      packages: { "react-native-view-shot": { range: "^4.0.0", installed: "4.0.3" } },
    });
    expect(gaps.find((gap) => gap.missing === "react-native-view-shot")).toBeUndefined();
  });

  /**
   * The note has to say that installing is enough, because the reflex
   * otherwise is to assume a native rebuild and give up on a physical
   * phone. react-native-view-shot is bundled into Expo Go, so the package
   * plus a reload is the whole procedure.
   */
  it("says installing is enough, with no native build", () => {
    const gaps = missingCapabilities({ packages: {} });
    expect(gaps[0].note).toMatch(/Expo Go/);
    expect(gaps[0].note).toMatch(/no native build/i);
  });
});
