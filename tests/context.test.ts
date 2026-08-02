import { afterEach, describe, expect, it } from "vitest";
import { collectRuntimeContext, readRenderers } from "../src/client/context";

const GLOBAL_KEYS = [
  "HermesInternal",
  "nativeFabricUIManager",
  "RN$Bridgeless",
  "__turboModuleProxy",
  "__DEV__",
  "__REACT_DEVTOOLS_GLOBAL_HOOK__",
  "nativeModuleProxy",
  "expo",
] as const;

const scrub = (): void => {
  for (const key of GLOBAL_KEYS) delete (globalThis as Record<string, unknown>)[key];
};

const set = (key: string, value: unknown): void => {
  (globalThis as Record<string, unknown>)[key] = value;
};

afterEach(scrub);

describe("collectRuntimeContext", () => {
  it("degrades to nulls on a bare runtime instead of throwing", () => {
    scrub();
    const context = collectRuntimeContext();
    expect(context.jsEngine).toBeNull();
    expect(context.newArchitecture).toBe(false);
    expect(context.bridgeless).toBe(false);
    expect(context.turboModules).toBe(false);
    expect(context.reactNativeVersion).toBeNull();
    expect(context.renderers).toEqual([]);
    expect(context.reactDevtoolsHook).toBe(false);
  });

  it("reads the Hermes release and bytecode versions", () => {
    set("HermesInternal", {
      getRuntimeProperties: () => ({
        "OSS Release Version": "0.12.0",
        "Bytecode Version": "96",
      }),
    });
    const context = collectRuntimeContext();
    expect(context.jsEngine).toBe("hermes");
    expect(context.jsEngineVersion).toBe("0.12.0");
    expect(context.hermesBytecodeVersion).toBe("96");
  });

  it("survives a Hermes build without runtime properties", () => {
    set("HermesInternal", {});
    const context = collectRuntimeContext();
    expect(context.jsEngine).toBe("hermes");
    expect(context.jsEngineVersion).toBeNull();
  });

  it("survives getRuntimeProperties throwing", () => {
    set("HermesInternal", {
      getRuntimeProperties: () => {
        throw new Error("nope");
      },
    });
    expect(() => collectRuntimeContext()).not.toThrow();
    expect(collectRuntimeContext().jsEngine).toBe("hermes");
  });

  it("detects Fabric, bridgeless and TurboModules from the globals", () => {
    set("nativeFabricUIManager", {});
    set("RN$Bridgeless", true);
    set("__turboModuleProxy", () => null);
    const context = collectRuntimeContext();
    expect(context.newArchitecture).toBe(true);
    expect(context.bridgeless).toBe(true);
    expect(context.turboModules).toBe(true);
  });

  it("formats the native React Native version through the TurboModule proxy", () => {
    set("__turboModuleProxy", (name: string) =>
      name === "PlatformConstants"
        ? {
            getConstants: () => ({
              reactNativeVersion: { major: 0, minor: 81, patch: 4 },
              systemName: "iOS",
              osVersion: "18.2",
              isTesting: false,
            }),
          }
        : null
    );
    const context = collectRuntimeContext();
    expect(context.reactNativeVersion).toBe("0.81.4");
    expect(context.platform).toBe("ios");
    expect(context.osVersion).toBe("18.2");
    expect(context.isTesting).toBe(false);
  });

  it("falls back to the legacy bridge when there is no TurboModule proxy", () => {
    set("nativeModuleProxy", {
      PlatformConstants: {
        reactNativeVersion: { major: 0, minor: 74, patch: 5 },
        Release: "14",
        Brand: "google",
      },
    });
    const context = collectRuntimeContext();
    expect(context.reactNativeVersion).toBe("0.74.5");
    expect(context.platform).toBe("android");
    expect(context.osVersion).toBe("14");
  });

  it("keeps a prerelease suffix on the native version", () => {
    set("nativeModuleProxy", {
      PlatformConstants: {
        reactNativeVersion: { major: 0, minor: 82, patch: 0, prerelease: "rc.1" },
      },
    });
    expect(collectRuntimeContext().reactNativeVersion).toBe("0.82.0-rc.1");
  });

  it("survives a PlatformConstants proxy that throws", () => {
    set("__turboModuleProxy", () => {
      throw new Error("module not linked");
    });
    expect(() => collectRuntimeContext()).not.toThrow();
    expect(collectRuntimeContext().reactNativeVersion).toBeNull();
  });

  it("reports Expo Go through appOwnership", () => {
    set("expo", { modules: { ExponentConstants: { appOwnership: "expo" } } });
    expect(collectRuntimeContext().appOwnership).toBe("expo");
  });

  it("reports __DEV__ as a tri-state", () => {
    expect(collectRuntimeContext().dev).toBeNull();
    set("__DEV__", false);
    expect(collectRuntimeContext().dev).toBe(false);
    set("__DEV__", true);
    expect(collectRuntimeContext().dev).toBe(true);
  });
});

describe("readRenderers", () => {
  it("returns the mounted renderer identities without importing React", () => {
    set("__REACT_DEVTOOLS_GLOBAL_HOOK__", {
      renderers: new Map([
        [1, { version: "19.1.0", rendererPackageName: "react-native-renderer" }],
      ]),
    });
    expect(readRenderers()).toEqual([
      { version: "19.1.0", rendererPackageName: "react-native-renderer" },
    ]);
  });

  it("returns an empty list on a hook variant without a renderers map", () => {
    set("__REACT_DEVTOOLS_GLOBAL_HOOK__", {});
    expect(readRenderers()).toEqual([]);
  });

  it("nulls missing fields instead of dropping the renderer", () => {
    set("__REACT_DEVTOOLS_GLOBAL_HOOK__", { renderers: new Map([[1, {}]]) });
    expect(readRenderers()).toEqual([{ version: null, rendererPackageName: null }]);
  });
});
