/**
 * The dev-menu bubble sits in its own window, above every React root, so
 * it is invisible to the UI tree and it eats the taps meant for the native
 * controls underneath it. These cover the runtime switch that moves it.
 */

import { afterEach, describe, expect, it } from "vitest";
import { findNativeModule, installOverlayControl } from "../src/client/overlay";

type Handler = (payload: unknown) => Promise<unknown> | unknown;

const install = () => {
  const handlers = new Map<string, Handler>();
  installOverlayControl({ onCommand: (command, handler) => handlers.set(command, handler) });
  return handlers;
};

const globalAny = globalThis as Record<string, any>;

/** A dev menu whose setter really applies, as expo-dev-menu does on iOS */
const devMenu = (visible: boolean) => {
  const state = { showFloatingActionButton: visible };
  return {
    state,
    module: {
      getPreferencesAsync: async () => ({ ...state }),
      setPreferencesAsync: async (settings: Record<string, unknown>) => {
        if (typeof settings.showFloatingActionButton === "boolean") {
          state.showFloatingActionButton = settings.showFloatingActionButton;
        }
      },
    },
  };
};

afterEach(() => {
  delete globalAny.expo;
  delete globalAny.nativeModuleProxy;
  delete globalAny.__turboModuleProxy;
});

describe("findNativeModule", () => {
  it("reads the modern Expo registry without importing expo-modules-core", () => {
    const module = { getPreferencesAsync: () => {} };
    globalAny.expo = { modules: { DevMenuPreferences: module } };
    expect(findNativeModule("DevMenuPreferences")).toBe(module);
  });

  it("falls back to the legacy proxies an older app still exposes", () => {
    const module = { getPreferencesAsync: () => {} };
    globalAny.nativeModuleProxy = { DevMenuPreferences: module };
    expect(findNativeModule("DevMenuPreferences")).toBe(module);
  });

  it("answers null rather than throwing when nothing exposes it", () => {
    expect(findNativeModule("DevMenuPreferences")).toBeNull();
  });
});

describe("overlay control", () => {
  it("hides the bubble and proves it by reading the preference back", async () => {
    const { state, module } = devMenu(true);
    globalAny.expo = { modules: { DevMenuPreferences: module } };
    const handlers = install();

    const result = await handlers.get("overlay.set")!({ visible: false }) as Record<string, unknown>;
    expect(state.showFloatingActionButton).toBe(false);
    expect(result).toMatchObject({ ok: true, visible: false, verified: "exact" });
  });

  it("puts it back", async () => {
    const { state, module } = devMenu(false);
    globalAny.expo = { modules: { DevMenuPreferences: module } };
    const handlers = install();

    await handlers.get("overlay.set")!({ visible: true });
    expect(state.showFloatingActionButton).toBe(true);
  });

  it("reports the current state", async () => {
    globalAny.expo = { modules: { DevMenuPreferences: devMenu(true).module } };
    const handlers = install();
    expect(await handlers.get("overlay.get")!({})).toMatchObject({ ok: true, visible: true });
  });

  // The defect this whole family exists to avoid: claiming an effect
  it("refuses to call it hidden when the preference did not move", async () => {
    globalAny.expo = {
      modules: {
        DevMenuPreferences: {
          getPreferencesAsync: async () => ({ showFloatingActionButton: true }),
          setPreferencesAsync: async () => {}, // accepts and applies nothing
        },
      },
    };
    const handlers = install();
    const result = await handlers.get("overlay.set")!({ visible: false }) as Record<string, unknown>;
    expect(result).toMatchObject({ ok: false, reason: "unchanged", visible: true });
  });

  it("explains itself instead of failing when expo-dev-menu is not there", async () => {
    const handlers = install();
    const result = await handlers.get("overlay.set")!({ visible: false }) as Record<string, unknown>;
    expect(result).toMatchObject({ ok: false, reason: "dev-menu-unavailable" });
    expect(String(result.note)).toMatch(/Android|manifest/);
  });

  it("needs a boolean, not a guess", async () => {
    const handlers = install();
    await expect(handlers.get("overlay.set")!({})).rejects.toThrow(/visible: true or false/);
  });
});
