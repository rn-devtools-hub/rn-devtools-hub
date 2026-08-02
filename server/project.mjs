/**
 * Project context: what the project DECLARES, and what that contradicts.
 *
 * The declared half is read from disk by the hub (package.json, the
 * installed node_modules, app.json, the native config files). The runtime
 * half is reported by the SDK from inside the running app. Neither half is
 * interesting alone: the value is the third block, the contradictions
 * between the two.
 *
 * "The project declares the New Architecture, the runtime does not have
 * it" is a stale native build, and it is the single most common way to
 * lose an afternoon in this ecosystem. No tool that only reads files can
 * say it, and no tool outside the runtime can either.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
};

/** Version actually installed on disk, which is what Metro will bundle.
 * Reading node_modules beats parsing a lockfile: same answer for npm,
 * yarn, pnpm and bun, and it reflects the tree as it really is. */
export const installedVersion = (projectRoot, packageName) => {
  const manifest = readJson(join(projectRoot, "node_modules", packageName, "package.json"));
  return typeof manifest?.version === "string" ? manifest.version : null;
};

const KEY_PACKAGES = [
  "react",
  "react-native",
  "expo",
  "expo-router",
  "react-native-reanimated",
  "react-native-screens",
  "react-native-gesture-handler",
  "@react-navigation/native",
  "@tanstack/react-query",
];

const detectPackageManager = (projectRoot) => {
  const candidates = [
    ["bun.lockb", "bun"],
    ["bun.lock", "bun"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
  ];
  for (const [file, name] of candidates) {
    if (existsSync(join(projectRoot, file))) return name;
  }
  return null;
};

/** gradle.properties style: key=value, one per line */
const readGradleFlag = (path, key) => {
  try {
    const line = readFileSync(path, "utf-8")
      .split("\n")
      .map((entry) => entry.trim())
      .find((entry) => entry.startsWith(`${key}=`));
    if (!line) return null;
    const value = line.slice(key.length + 1).trim();
    return value === "true" ? true : value === "false" ? false : null;
  } catch {
    return null;
  }
};

const majorOf = (version) => {
  const match = /^\D*(\d+)/.exec(String(version ?? ""));
  return match ? Number(match[1]) : null;
};

/**
 * The New Architecture is declared in four different places depending on
 * the era of the project, and defaults to on from Expo SDK 52.
 */
const declaredNewArchitecture = (projectRoot, expoConfig, expoVersion) => {
  if (typeof expoConfig?.newArchEnabled === "boolean") {
    return { value: expoConfig.newArchEnabled, from: "app.json" };
  }
  const gradle = readGradleFlag(join(projectRoot, "android", "gradle.properties"), "newArchEnabled");
  if (gradle !== null) return { value: gradle, from: "android/gradle.properties" };

  const podfile = readJson(join(projectRoot, "ios", "Podfile.properties.json"));
  if (podfile && typeof podfile.newArchEnabled === "string") {
    return { value: podfile.newArchEnabled === "true", from: "ios/Podfile.properties.json" };
  }
  const expoMajor = majorOf(expoVersion);
  if (expoMajor !== null && expoMajor >= 52) {
    return { value: true, from: `expo sdk ${expoMajor} default` };
  }
  return { value: null, from: null };
};

export const declaredContext = (projectRoot) => {
  const manifest = readJson(join(projectRoot, "package.json")) ?? {};
  const appJson = readJson(join(projectRoot, "app.json"));
  const expoConfig = appJson?.expo ?? null;
  const dependencies = { ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) };

  const packages = {};
  for (const name of KEY_PACKAGES) {
    const range = dependencies[name] ?? null;
    const installed = installedVersion(projectRoot, name);
    if (range || installed) packages[name] = { range, installed };
  }

  const expoVersion = packages.expo?.installed ?? packages.expo?.range ?? null;
  const newArchitecture = declaredNewArchitecture(projectRoot, expoConfig, expoVersion);

  return {
    projectDir: projectRoot,
    name: manifest.name ?? null,
    expoName: expoConfig?.name ?? null,
    slug: expoConfig?.slug ?? null,
    version: manifest.version ?? null,
    packageManager: detectPackageManager(projectRoot),
    packages,
    expoSdkMajor: majorOf(expoVersion),
    // Hermes has been the Expo default since SDK 45; an explicit jsEngine wins
    jsEngine: expoConfig?.jsEngine ?? (expoConfig ? "hermes" : null),
    newArchEnabled: newArchitecture.value,
    newArchDeclaredIn: newArchitecture.from,
    plugins: Array.isArray(expoConfig?.plugins)
      ? expoConfig.plugins.map((plugin) => (Array.isArray(plugin) ? plugin[0] : plugin))
      : [],
    scheme: expoConfig?.scheme ?? null,
    hasNativeProjects: {
      ios: existsSync(join(projectRoot, "ios")),
      android: existsSync(join(projectRoot, "android")),
    },
  };
};

/** ^0.81.4, ~0.81.4 and 0.81.4 all describe the same installed build */
const sameVersion = (a, b) => {
  const normalize = (value) => String(value ?? "").replace(/^[\^~>=<\s]+/, "").split("-")[0];
  const left = normalize(a);
  const right = normalize(b);
  return !!left && !!right && left === right;
};

/**
 * The whole point of the tool. Every entry is a statement an agent can act
 * on without further investigation.
 */
export const compareContexts = (declared, runtime) => {
  const divergences = [];
  if (!declared || !runtime) return divergences;

  const declaredRn = declared.packages?.["react-native"]?.installed ?? null;
  if (declaredRn && runtime.reactNativeVersion && !sameVersion(declaredRn, runtime.reactNativeVersion)) {
    divergences.push({
      field: "reactNativeVersion",
      declared: declaredRn,
      runtime: runtime.reactNativeVersion,
      severity: "high",
      hint: "The running binary was built against another React Native version. Rebuild the native app before trusting anything else.",
    });
  }

  if (declared.newArchEnabled === true && runtime.newArchitecture === false) {
    divergences.push({
      field: "newArchitecture",
      declared: true,
      runtime: false,
      severity: "high",
      hint: `The project enables the New Architecture (${declared.newArchDeclaredIn ?? "config"}) but Fabric is not mounted: the native build predates the change. Rebuild.`,
    });
  }
  if (declared.newArchEnabled === false && runtime.newArchitecture === true) {
    divergences.push({
      field: "newArchitecture",
      declared: false,
      runtime: true,
      severity: "medium",
      hint: "Fabric is mounted although the project declares the old architecture: the binary is ahead of the config.",
    });
  }

  if (declared.jsEngine === "hermes" && runtime.jsEngine !== null && runtime.jsEngine !== "hermes") {
    divergences.push({
      field: "jsEngine",
      declared: "hermes",
      runtime: runtime.jsEngine,
      severity: "medium",
      hint: "The project declares Hermes but another engine is running: stale build, or jsEngine changed without a rebuild.",
    });
  }
  if (declared.jsEngine === "hermes" && runtime.jsEngine === null) {
    divergences.push({
      field: "jsEngine",
      declared: "hermes",
      runtime: null,
      severity: "low",
      hint: "HermesInternal is absent: JSC, or a runtime without Hermes such as react-native-web.",
    });
  }

  const declaredReact = declared.packages?.react?.installed ?? null;
  const renderer = runtime.renderers?.find((entry) => entry.version) ?? null;
  if (declaredReact && renderer?.version && !sameVersion(declaredReact, renderer.version)) {
    divergences.push({
      field: "react",
      declared: declaredReact,
      runtime: renderer.version,
      severity: "medium",
      hint: "The mounted React renderer does not match the installed react package: check for a duplicated React in the dependency tree.",
    });
  }

  if (runtime.dev === false) {
    divergences.push({
      field: "dev",
      declared: "development",
      runtime: "production",
      severity: "high",
      hint: "__DEV__ is false: this is a release bundle. UI automation needs the React DevTools hook, which release builds strip.",
    });
  }

  /**
   * The hub reads the project from its own working directory while the
   * device announces whatever app it runs. With several apps on several
   * ports, connecting to the wrong hub reads another project entirely and
   * nothing in the answer would say so.
   */
  if (runtime.appName && declared.name) {
    const normalize = (value) => String(value).toLowerCase().replace(/[^a-z0-9]/g, "");
    const known = [declared.name, declared.expoName, declared.slug].filter(Boolean).map(normalize);
    if (known.length && !known.includes(normalize(runtime.appName))) {
      divergences.push({
        field: "app",
        declared: declared.name,
        runtime: runtime.appName,
        severity: "high",
        hint: `This hub serves ${declared.projectDir}, but the connected device runs "${runtime.appName}". Everything it reports is about another project. Launch one hub per project, each on its own port.`,
      });
    }
  }

  if (runtime.appOwnership === "expo" && declared.plugins?.length) {
    divergences.push({
      field: "appOwnership",
      declared: `${declared.plugins.length} config plugin(s)`,
      runtime: "expo-go",
      severity: "medium",
      hint: "Running in Expo Go while the project declares config plugins: any native module they add is absent. Use a development build.",
    });
  }

  return divergences;
};

/**
 * Capabilities the project has not enabled, with the command that enables
 * each one.
 *
 * An agent already has a shell: it does not need a tool to install a
 * package, it needs to know that a package is missing and why that limits
 * it. Owning the mutation would mean owning a change to someone's
 * package.json, lockfile and native build, which is not this tool's to
 * make. Naming the gap is.
 */
export const missingCapabilities = (declared) => {
  const installed = (name) => Boolean(declared.packages?.[name]?.installed);
  const gaps = [];
  if (!installed("react-native-view-shot")) {
    gaps.push({
      capability: "in-app screen capture",
      missing: "react-native-view-shot",
      install: "npx expo install react-native-view-shot",
      affects: ["mirror panel over the network"],
      note: "Only needed for a device the host cannot reach with adb or simctl, which is the usual case for a physical phone on Wi-Fi. Bundled into Expo Go, so installing it and reloading is enough: no native build.",
    });
  }
  return gaps;
};

export const projectContext = (projectRoot, runtime) => {
  const declared = declaredContext(projectRoot);
  return {
    declared,
    missingCapabilities: missingCapabilities(declared),
    runtime: runtime ?? null,
    divergence: compareContexts(declared, runtime),
    note: runtime
      ? null
      : "No device connected: the runtime half is missing, so no contradiction can be detected. Connect the app and call again.",
  };
};

export const PROJECT_TOOL = {
  name: "get_project_context",
  description:
    "Returns what the project DECLARES (installed versions, Expo SDK, New Architecture, JS engine, plugins), what the app ACTUALLY runs (engine, Fabric, bridgeless, TurboModules, native React Native version, mounted React renderer), and the contradictions between the two. The divergence block catches stale native builds, Expo Go running a plugin project and release bundles before any other debugging.",
  inputSchema: {
    type: "object",
    properties: { deviceId: { type: "string" } },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
};
