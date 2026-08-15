/**
 * Control of the development overlays drawn ON TOP of the app.
 *
 * The expo-dev-menu floating action button sits in its own window, above
 * everything the app renders. Two consequences for an agent: no UI tree
 * ever shows it, because it belongs to no React root, and it swallows the
 * taps meant for whatever is underneath it. A native modal presented in
 * the top right corner, the iOS photo picker being the usual one, has its
 * button covered by a bubble the agent cannot see, cannot describe and,
 * until now, could not move.
 *
 * The preference behind it is readable and writable at RUNTIME through
 * the DevMenuPreferences native module, whose setter asks the dev menu to
 * update the button immediately. No relaunch, no rebuild, and it works
 * inside Expo Go, which embeds the same module.
 *
 * Reached through the global module registry rather than an import: the
 * SDK depends on nothing, and an app without expo-dev-menu must degrade
 * to an explanation instead of a crash.
 */

interface OverlayHost {
  onCommand: (command: string, handler: (payload: unknown) => Promise<unknown> | unknown) => void;
}

/** The key expo-dev-menu stores the button under, on both platforms */
const FAB_PREFERENCE = "showFloatingActionButton";

/**
 * A native module by name, without importing expo-modules-core.
 *
 * Mirrors what requireOptionalNativeModule does: the modern Expo registry
 * first, then the legacy proxies, so this keeps working across the
 * versions an app in the wild may be on.
 */
export const findNativeModule = (name: string): Record<string, any> | null => {
  const globalAny = globalThis as Record<string, any>;
  const candidates: unknown[] = [
    globalAny.expo?.modules?.[name],
    globalAny.expo?.NativeModulesProxy?.[name],
    globalAny.nativeModuleProxy?.[name],
  ];
  const turbo = globalAny.__turboModuleProxy;
  if (typeof turbo === "function") {
    try { candidates.push(turbo(name)); } catch { /* not a turbo module */ }
  }
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object") return candidate as Record<string, any>;
  }
  return null;
};

const MISSING =
  "expo-dev-menu does not expose its preferences to JavaScript here. The runtime switch is " +
  "iOS only: on Android set the EXDevMenuShowFloatingActionButton meta-data in the manifest, " +
  "or drag the bubble out of the way. On a dev build the hub can also write the preference " +
  "before launch, with launch_app hideDevMenuFab.";

const readPreferences = async (
  module: Record<string, any>,
): Promise<Record<string, unknown> | null> => {
  if (typeof module.getPreferencesAsync !== "function") return null;
  try {
    const preferences = await module.getPreferencesAsync();
    return preferences && typeof preferences === "object"
      ? (preferences as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

/** Registers the overlay.get / overlay.set command handlers */
export const installOverlayControl = (host: OverlayHost): void => {
  const preferencesModule = (): Record<string, any> | null =>
    findNativeModule("DevMenuPreferences");

  host.onCommand("overlay.get", async () => {
    const module = preferencesModule();
    if (!module) return { ok: false, reason: "dev-menu-unavailable", note: MISSING };
    const preferences = await readPreferences(module);
    if (!preferences) {
      return { ok: false, reason: "dev-menu-unavailable", note: MISSING };
    }
    return {
      ok: true,
      visible: preferences[FAB_PREFERENCE] === true,
      preferences,
    };
  });

  host.onCommand("overlay.set", async (rawPayload) => {
    const payload = (rawPayload ?? {}) as Record<string, unknown>;
    if (typeof payload.visible !== "boolean") {
      throw new Error("overlay.set needs visible: true or false");
    }
    const module = preferencesModule();
    if (!module || typeof module.setPreferencesAsync !== "function") {
      return { ok: false, reason: "dev-menu-unavailable", note: MISSING };
    }
    try {
      await module.setPreferencesAsync({ [FAB_PREFERENCE]: payload.visible });
    } catch (error) {
      return {
        ok: false,
        reason: "set-failed",
        note: `The dev menu refused the change: ${String((error as Error)?.message ?? error)}`,
      };
    }
    /**
     * Read it back rather than claim it. A write that the module accepted
     * and did not apply would otherwise be another action reporting a
     * success it cannot prove.
     */
    const preferences = await readPreferences(module);
    const now = preferences ? preferences[FAB_PREFERENCE] === true : null;
    if (now !== null && now !== payload.visible) {
      return {
        ok: false,
        reason: "unchanged",
        visible: now,
        note:
          "The preference was written and the button is still in the other state. The dev menu " +
          "may be running a version that only applies it at launch.",
      };
    }
    return {
      ok: true,
      visible: payload.visible,
      verified: now === null ? "unverifiable" : "exact",
      ...(now === null
        ? { note: "The preference was written; this version does not report it back." }
        : {}),
    };
  });
};
