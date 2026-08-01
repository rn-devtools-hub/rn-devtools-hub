/**
 * Runtime context: what is ACTUALLY running.
 *
 * A package.json states an intention. A native binary built three weeks
 * ago states a fact. Only code inside the runtime can tell them apart,
 * which is why this file exists on the SDK side and not on the hub side.
 *
 * Everything is read from globalThis. No import, not even react-native:
 * the zero-external-import invariant of src/client holds, and the module
 * degrades to nulls on any runtime that lacks a given global (Expo Go,
 * react-native-web, a release bundle) instead of throwing.
 */

export interface RendererInfo {
  version: string | null;
  rendererPackageName: string | null;
}

export interface RuntimeContext {
  /** "hermes" when HermesInternal is present, else null (JSC or web) */
  jsEngine: string | null;
  jsEngineVersion: string | null;
  hermesBytecodeVersion: string | null;
  /** Fabric renderer mounted: the New Architecture is actually on */
  newArchitecture: boolean;
  bridgeless: boolean;
  turboModules: boolean;
  dev: boolean | null;
  platform: string | null;
  osVersion: string | null;
  /** React Native version reported by the NATIVE binary, not by the lockfile */
  reactNativeVersion: string | null;
  renderers: RendererInfo[];
  reactDevtoolsHook: boolean;
  /** "expo" in Expo Go, "standalone"/"guest" in a dev or release build */
  appOwnership: string | null;
  isTesting: boolean | null;
}

const globalAny = (): Record<string, any> => globalThis as Record<string, any>;

/**
 * PlatformConstants is the only place the native side publishes the React
 * Native version it was COMPILED with. Reachable through the TurboModule
 * proxy on the New Architecture, through the legacy bridge otherwise.
 */
const readPlatformConstants = (): Record<string, unknown> | null => {
  const global = globalAny();
  try {
    const turbo = global.__turboModuleProxy;
    if (typeof turbo === "function") {
      const module = turbo("PlatformConstants");
      if (module) {
        return typeof module.getConstants === "function"
          ? module.getConstants()
          : (module as Record<string, unknown>);
      }
    }
  } catch {
    // module absent on this runtime
  }
  try {
    const legacy = global.nativeModuleProxy?.PlatformConstants;
    if (legacy) {
      return typeof legacy.getConstants === "function"
        ? legacy.getConstants()
        : (legacy as Record<string, unknown>);
    }
  } catch {
    // legacy bridge absent
  }
  return null;
};

const stringify = (value: unknown): string | null => {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number") return String(value);
  return null;
};

/** "0.81.4" from { major: 0, minor: 81, patch: 4 } */
const formatVersion = (value: unknown): string | null => {
  if (!value || typeof value !== "object") return null;
  const parts = value as Record<string, unknown>;
  const numbers = [parts.major, parts.minor, parts.patch].map((part) =>
    typeof part === "number" ? part : null
  );
  if (numbers.some((part) => part === null)) return null;
  const suffix = typeof parts.prerelease === "string" ? `-${parts.prerelease}` : "";
  return `${numbers.join(".")}${suffix}`;
};

const platformOf = (constants: Record<string, unknown> | null): string | null => {
  if (!constants) return null;
  // Android publishes Release/Brand, iOS publishes systemName
  if (typeof constants.Release === "string" || typeof constants.Brand === "string") {
    return "android";
  }
  const systemName = stringify(constants.systemName);
  if (systemName) return systemName.toLowerCase().includes("ios") ? "ios" : systemName.toLowerCase();
  return null;
};

const osVersionOf = (constants: Record<string, unknown> | null): string | null => {
  if (!constants) return null;
  return stringify(constants.osVersion) ?? stringify(constants.Release) ?? stringify(constants.Version);
};

/** Renderer identity straight from the DevTools hook: the React version
 * actually mounted, without importing React */
export const readRenderers = (): RendererInfo[] => {
  const hook = globalAny().__REACT_DEVTOOLS_GLOBAL_HOOK__;
  const out: RendererInfo[] = [];
  if (!hook || typeof hook !== "object" || !hook.renderers) return out;
  try {
    const values = typeof hook.renderers.values === "function"
      ? hook.renderers.values()
      : [];
    for (const renderer of values) {
      out.push({
        version: stringify(renderer?.version),
        rendererPackageName: stringify(renderer?.rendererPackageName),
      });
    }
  } catch {
    // hook variant without an iterable renderers map
  }
  return out;
};

const readHermes = (): Pick<RuntimeContext, "jsEngine" | "jsEngineVersion" | "hermesBytecodeVersion"> => {
  const hermes = globalAny().HermesInternal;
  if (!hermes) return { jsEngine: null, jsEngineVersion: null, hermesBytecodeVersion: null };
  let properties: Record<string, unknown> = {};
  try {
    if (typeof hermes.getRuntimeProperties === "function") {
      properties = hermes.getRuntimeProperties() ?? {};
    }
  } catch {
    // older Hermes without runtime properties
  }
  return {
    jsEngine: "hermes",
    jsEngineVersion: stringify(properties["OSS Release Version"]),
    hermesBytecodeVersion: stringify(properties["Bytecode Version"]),
  };
};

/** Expo Go reports appOwnership "expo"; a dev or release build does not */
const readAppOwnership = (): string | null => {
  try {
    const constants = globalAny().expo?.modules?.ExponentConstants;
    return stringify(constants?.appOwnership);
  } catch {
    return null;
  }
};

export const collectRuntimeContext = (): RuntimeContext => {
  const global = globalAny();
  const constants = readPlatformConstants();
  return {
    ...readHermes(),
    // Fabric is the honest signal: a flag in a config file says what the
    // project wants, this says what the binary does
    newArchitecture: !!global.nativeFabricUIManager,
    bridgeless: !!global.RN$Bridgeless,
    turboModules: typeof global.__turboModuleProxy === "function",
    dev: typeof global.__DEV__ === "boolean" ? global.__DEV__ : null,
    platform: platformOf(constants),
    osVersion: osVersionOf(constants),
    reactNativeVersion: formatVersion(constants?.reactNativeVersion),
    renderers: readRenderers(),
    reactDevtoolsHook: !!global.__REACT_DEVTOOLS_GLOBAL_HOOK__,
    appOwnership: readAppOwnership(),
    isTesting: typeof constants?.isTesting === "boolean" ? constants.isTesting : null,
  };
};

interface ContextHost {
  onCommand: (command: string, handler: (payload: unknown) => unknown) => void;
}

export const installRuntimeContext = (host: ContextHost): void => {
  host.onCommand("context.runtime", () => collectRuntimeContext());
};
