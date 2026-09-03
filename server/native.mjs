/**
 * Native adapter: host-side simctl/adb bridge for the MCP server.
 *
 * Fills the gap between the JS bridge (which sees inside the app) and
 * the OS (app lifecycle, permissions, deep links, pixels). Everything
 * here shells out to `xcrun simctl` and `adb` with validated argv
 * arrays; no shell interpolation on the host. Every capability is
 * probed and degrades with an explanatory message.
 *
 * Targets are OS-level identities ("sim:<udid>" or "adb:<serial>"),
 * deliberately DISTINCT from the hub's JS deviceId: the runtime cannot
 * know which simulator it runs on, so pretending to unify them would
 * produce false mappings. list_targets is the source of truth.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, which } from "./runtime.mjs";

const SAFE_ID = /^[A-Za-z0-9._:-]+$/;
const APP_ID = /^[A-Za-z0-9._-]+$/;

export const runCommand = async (argv, timeoutMs = 6000, stdinText = null) => {
  try {
    const proc = spawn(argv, {
      stdout: "pipe",
      stderr: "pipe",
      ...(stdinText !== null ? { stdin: stdinText } : {}),
    });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const [bytes, errText, exitCode] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    return { ok: exitCode === 0, bytes: new Uint8Array(bytes), error: errText.trim() };
  } catch (error) {
    return { ok: false, bytes: new Uint8Array(), error: String(error) };
  }
};

const textOf = (result) => new TextDecoder().decode(result.bytes).trim();

const parseTarget = (raw) => {
  const [kind, id] = String(raw ?? "").split(":");
  if (!id || !SAFE_ID.test(id) || !["sim", "adb"].includes(kind)) {
    throw new Error(`Invalid target "${raw}": use "sim:<udid>" or "adb:<serial>" from list_targets`);
  }
  return { kind, id };
};

const requireAppId = (raw) => {
  const appId = String(raw ?? "");
  if (!APP_ID.test(appId)) throw new Error(`Invalid app id: ${raw}`);
  return appId;
};

// The device-side shell re-parses `adb shell` arguments: quote every
// user-supplied string and refuse embedded single quotes outright
const shellQuote = (value) => {
  const raw = String(value);
  if (raw.includes("'")) throw new Error("Single quotes are not allowed in this value");
  return `'${raw}'`;
};

const requireUrl = (raw) => {
  const url = String(raw ?? "");
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/\S+$/.test(url) || /['\s]/.test(url)) {
    throw new Error(`Invalid URL: ${raw}`);
  }
  return url;
};

/** Reads the development-client scheme without evaluating app.config.js.
 * Static app.json covers the common case and keeps this adapter dependency
 * free. Expo's default exp+slug scheme is deterministic when no custom one
 * was declared. */
export const expoSchemeFromProject = (projectRoot) => {
  if (!projectRoot) return null;
  try {
    const config = JSON.parse(readFileSync(join(projectRoot, "app.json"), "utf-8"));
    const expo = config?.expo ?? config;
    const declared = Array.isArray(expo?.scheme) ? expo.scheme[0] : expo?.scheme;
    if (typeof declared === "string" && /^[A-Za-z][A-Za-z0-9+.-]*$/.test(declared)) return declared;
    if (typeof expo?.slug === "string") {
      const slug = expo.slug.toLowerCase().replace(/[^a-z0-9+.-]/g, "");
      if (slug) return `exp+${slug}`;
    }
  } catch { /* no static Expo config: the caller explains the fallback */ }
  return null;
};

const simctlAvailable = () => process.platform === "darwin" && !!which("xcrun");
const adbAvailable = () => !!which("adb");

const requireTool = (kind) => {
  if (kind === "sim" && !simctlAvailable()) {
    throw new Error("simctl unavailable: install the Xcode command line tools (macOS only)");
  }
  if (kind === "adb" && !adbAvailable()) {
    throw new Error("adb unavailable: install the Android platform-tools");
  }
};

/** Reinstalls adb reverse mappings after a USB transport reconnect. adb
 * forgets these mappings independently of the emulator process, so checking
 * them only once when Metro starts is insufficient. */
export const repairAdbRoutes = async ({ target, ports }, runner = runCommand) => {
  const { kind, id } = await resolveTarget(target, "android");
  if (kind !== "adb") throw new Error("ADB routes require an Android target");
  requireTool(kind);
  const unique = [...new Set((ports ?? []).map(Number))].filter(
    (port) => Number.isInteger(port) && port > 0 && port < 65536
  );
  if (!unique.length) throw new Error("Pass at least one valid TCP port");
  const routes = [];
  for (const port of unique) {
    const result = await runner(adbReverseArgv(id, port));
    routes.push({ port, ok: result.ok, ...(result.ok ? {} : { error: result.error || textOf(result) }) });
  }
  return {
    ok: routes.every((route) => route.ok),
    target: `adb:${id}`,
    routes,
  };
};

export const adbReverseArgv = (id, port) => [
  "adb", "-s", id, "reverse", `tcp:${port}`, `tcp:${port}`,
];

const fail = (result, action) => {
  throw new Error(`${action} failed: ${result.error || textOf(result) || "unknown error"}`);
};

export const BROKEN_IDB_HINT =
  "idb is installed but cannot run: it needs Python 3.11 or older " +
  "(3.12 removed the asyncio API it relies on). Install AXe instead, a single " +
  "binary with no runtime: brew install cameroncooke/axe/axe";

/**
 * True when idb failed because its Python runtime is unusable, not because the
 * tap itself went wrong.
 *
 * Being on PATH says nothing about whether idb can run: installed under Python
 * 3.12+ it dies importing asyncio's removed `get_event_loop`, long before it
 * reaches the simulator. Surfacing the raw traceback sends people debugging
 * their device when the fault is in their toolchain.
 */
export const isBrokenIdb = (output) =>
  /get_event_loop|no current event loop|ModuleNotFoundError|Traceback \(most recent call last\)/i.test(
    String(output ?? "")
  );

// ====================================================================
// Targets
// ====================================================================

export const listTargets = async () => {
  const targets = [];
  if (adbAvailable()) {
    const result = await runCommand(["adb", "devices"]);
    for (const line of textOf(result).split("\n").slice(1)) {
      const [serial, state] = line.trim().split(/\s+/);
      if (!serial || !SAFE_ID.test(serial)) continue;
      targets.push({
        target: `adb:${serial}`,
        platform: "android",
        state: state === "device" ? "ready" : state,
        emulator: serial.startsWith("emulator-"),
      });
    }
  }
  if (simctlAvailable()) {
    const result = await runCommand(["xcrun", "simctl", "list", "devices", "-j"]);
    try {
      const parsed = JSON.parse(textOf(result));
      for (const [runtime, sims] of Object.entries(parsed.devices ?? {})) {
        for (const sim of sims) {
          if (!sim.isAvailable || !SAFE_ID.test(sim.udid)) continue;
          targets.push({
            target: `sim:${sim.udid}`,
            platform: "ios",
            name: sim.name,
            runtime: runtime.split(".").pop(),
            state: sim.state === "Booted" ? "ready" : sim.state.toLowerCase(),
          });
        }
      }
    } catch { /* unreadable simctl output */ }
  }
  return {
    simctlAvailable: simctlAvailable(),
    adbAvailable: adbAvailable(),
    targets,
    hint: targets.some((t) => t.state === "ready")
      ? null
      : "No booted target: boot a simulator (boot_device) or start an emulator/device",
  };
};

// Resolves an omitted target to the single ready one, or fails clearly
const resolveTarget = async (raw, platform = null) => {
  if (raw) return parseTarget(raw);
  const { targets } = await listTargets();
  const ready = targets.filter((t) => t.state === "ready" &&
    (!platform || t.platform === platform));
  if (ready.length === 1) return parseTarget(ready[0].target);
  throw new Error(ready.length === 0
    ? "No booted target available: pass target from list_targets or boot one"
    : `${ready.length} booted targets: pass target explicitly (${ready.map((t) => t.target).join(", ")})`);
};

// ====================================================================
// Permissions
// ====================================================================

// simctl privacy services, verified against Xcode 16.3 help output.
// Notably ABSENT: notifications and camera cannot be pre-granted on iOS
const IOS_SERVICES = new Set([
  "all", "calendar", "contacts", "contacts-limited", "location",
  "location-always", "media-library", "microphone", "motion",
  "photos", "photos-add", "reminders", "siri",
]);

const IOS_UNGRANTABLE = {
  notifications: "iOS simulators cannot pre-grant notification permission (simctl privacy has no such service; applesimutils can, if installed). The dialog must be tapped once, or the feature tested on Android.",
  camera: "simctl privacy has no camera service on current Xcode versions: the camera dialog must be tapped once, or the feature tested on Android.",
};

// Android runtime permissions per service; each is granted best-effort
// because pm rejects permissions missing from the manifest
const ANDROID_PERMISSIONS = {
  location: ["android.permission.ACCESS_FINE_LOCATION", "android.permission.ACCESS_COARSE_LOCATION"],
  "location-always": [
    "android.permission.ACCESS_FINE_LOCATION",
    "android.permission.ACCESS_COARSE_LOCATION",
    "android.permission.ACCESS_BACKGROUND_LOCATION",
  ],
  camera: ["android.permission.CAMERA"],
  microphone: ["android.permission.RECORD_AUDIO"],
  photos: [
    "android.permission.READ_MEDIA_IMAGES",
    "android.permission.READ_MEDIA_VIDEO",
    "android.permission.READ_EXTERNAL_STORAGE",
  ],
  "media-library": [
    "android.permission.READ_MEDIA_IMAGES",
    "android.permission.READ_MEDIA_VIDEO",
    "android.permission.READ_MEDIA_AUDIO",
    "android.permission.READ_EXTERNAL_STORAGE",
  ],
  contacts: ["android.permission.READ_CONTACTS", "android.permission.WRITE_CONTACTS"],
  calendar: ["android.permission.READ_CALENDAR", "android.permission.WRITE_CALENDAR"],
  notifications: ["android.permission.POST_NOTIFICATIONS"],
};

export const setPermission = async ({ target, appId, service, grant = true }) => {
  const { kind, id } = await resolveTarget(target);
  requireTool(kind);
  const app = requireAppId(appId);
  const serviceName = String(service ?? "");

  if (kind === "sim") {
    if (IOS_UNGRANTABLE[serviceName]) throw new Error(IOS_UNGRANTABLE[serviceName]);
    if (!IOS_SERVICES.has(serviceName)) {
      throw new Error(`Unknown iOS service "${serviceName}". Available: ${[...IOS_SERVICES].join(", ")}`);
    }
    const mode = grant === null ? "reset" : grant ? "grant" : "revoke";
    const result = await runCommand(["xcrun", "simctl", "privacy", id, mode, serviceName, app]);
    if (!result.ok) fail(result, `simctl privacy ${mode} ${serviceName}`);
    return { ok: true, target: `sim:${id}`, service: serviceName, mode };
  }

  const permissions = ANDROID_PERMISSIONS[serviceName];
  if (!permissions) {
    throw new Error(`Unknown Android service "${serviceName}". Available: ${Object.keys(ANDROID_PERMISSIONS).join(", ")}`);
  }
  const mode = grant === false ? "revoke" : "grant";
  const results = [];
  for (const permission of permissions) {
    const result = await runCommand(["adb", "-s", id, "shell", "pm", mode, app, permission]);
    const output = `${textOf(result)} ${result.error}`;
    // "has not requested permission" only means the manifest does not
    // declare this API-level variant: expected, not an error
    const notDeclared = /has not requested permission/i.test(output);
    results.push({
      permission,
      granted: result.ok,
      skipped: notDeclared,
      error: result.ok || notDeclared ? null : output.trim() || null,
    });
  }
  const effective = results.filter((r) => r.granted);
  if (!effective.length && results.every((r) => !r.skipped)) {
    throw new Error(`pm ${mode} failed for every permission: ${results.map((r) => r.error).filter(Boolean).join(" | ")}`);
  }
  return { ok: true, target: `adb:${id}`, service: serviceName, mode, results };
};

// ====================================================================
// Lifecycle: launch / terminate / open_url
// ====================================================================

const resolveAndroidActivity = async (serial, appId) => {
  const result = await runCommand(["adb", "-s", serial, "shell", "cmd", "package", "resolve-activity", "--brief", appId]);
  const lines = textOf(result).split("\n").map((l) => l.trim()).filter(Boolean);
  const component = lines[lines.length - 1];
  return component && component.includes("/") && SAFE_ID.test(component.replace("/", "")) ? component : null;
};

/**
 * The app's OWN preferences plist inside the simulator container.
 *
 * "defaults write <bundleId>" would hit the DEVICE-level domain, not the
 * app sandbox, so the write lands somewhere the app never reads. The
 * container path has to be resolved first, and it does not exist until
 * the app is installed.
 */
export const appContainerArgv = (id, app) => ["xcrun", "simctl", "get_app_container", id, app, "data"];

/** Where the app's preferences live inside a resolved data container */
export const prefsPlistPath = (containerPath, app) =>
  `${String(containerPath).trim()}/Library/Preferences/${app}.plist`;

const simulatorPrefsPlist = async (id, app) => {
  const container = await runCommand(appContainerArgv(id, app));
  return container.ok ? prefsPlistPath(textOf(container), app) : null;
};

/**
 * The argv of a preference write, built by itself so both directions are
 * verifiable without a simulator. This writes a PERSISTENT file into
 * someone's app sandbox and does so by default, which is precisely the
 * kind of change that must not rest on "it looked right": a wrong domain
 * writes to the device instead of the app, and a value that never flips
 * back leaves the bubble hidden forever on a machine nobody debugs again.
 */
export const simulatorFlagArgv = (id, plist, key, value) =>
  ["xcrun", "simctl", "spawn", id, "defaults", "write", plist, key, "-bool", value ? "true" : "false"];

const writeSimulatorFlag = (id, plist, key, value) =>
  runCommand(simulatorFlagArgv(id, plist, key, value));

// Both keys come from the expo-dev-menu source (DevMenuPreferences.swift)
// and live in the same app plist
export const DEV_MENU_ONBOARDING_KEY = "EXDevMenuIsOnboardingFinished";
export const DEV_MENU_FAB_KEY = "EXDevMenuShowFloatingActionButton";

/**
 * What gets written to the FAB key for a given option.
 *
 * The option is stated as "hide", the preference as "show", and the
 * default is to hide: one inversion, in one place, so the reversal cannot
 * drift from the request. Getting this backwards would leave the bubble
 * on by default and put the bug straight back.
 */
export const devMenuFabValue = (hideDevMenuFab) => hideDevMenuFab === false;

export const launchApp = async ({ target, appId, url, coldStart = true, suppressDevMenuIntro = true, hideDevMenuFab = true }) => {
  const { kind, id } = await resolveTarget(target);
  requireTool(kind);
  const app = requireAppId(appId);
  const link = url ? requireUrl(url) : null;
  const steps = [];

  if (kind === "sim") {
    if (coldStart) {
      await runCommand(["xcrun", "simctl", "terminate", id, app]); // may not be running
      steps.push("terminate");
    }
    const plist = await simulatorPrefsPlist(id, app);
    if (suppressDevMenuIntro) {
      if (plist) {
        const prefs = await writeSimulatorFlag(id, plist, DEV_MENU_ONBOARDING_KEY, true);
        steps.push(prefs.ok ? "onboarding-skipped" : "onboarding-skip-failed");
      } else {
        steps.push("onboarding-skip-unavailable"); // app not installed yet
      }
    }
    /**
     * The floating bubble expo-dev-menu draws over the app.
     *
     * It lives in its OWN UIWindow, above everything, so it appears in no
     * UI tree the hub can read and get_ui_tree cannot even report that it
     * is there. What it does show up in is the touch stream: it sits over
     * the bottom-right corner and swallows the taps meant for whatever is
     * under it, typically the "Add" button of the iOS photo picker. A tap
     * that lands on an invisible obstacle looks exactly like an app that
     * ignores its own button. Hiding it is one preference key, and it is
     * reversible: pass hideDevMenuFab:false to put the bubble back.
     */
    if (plist) {
      const show = devMenuFabValue(hideDevMenuFab);
      const written = await writeSimulatorFlag(id, plist, DEV_MENU_FAB_KEY, show);
      steps.push(written.ok ? (show ? "fab-shown" : "fab-hidden") : "fab-hide-failed");
    } else {
      steps.push("fab-hide-unavailable");
    }
    if (link && /^https?:\/\//.test(link)) {
      // expo-dev-launcher --initialUrl: loads the server directly, no
      // URL open, no scheme resolution, no dialog possible
      const result = await runCommand(["xcrun", "simctl", "launch", id, app, "--initialUrl", link]);
      if (!result.ok) fail(result, "simctl launch --initialUrl");
      steps.push("launch-initialUrl");
    } else if (link) {
      const result = await runCommand(["xcrun", "simctl", "openurl", id, link]);
      if (!result.ok) fail(result, "simctl openurl");
      steps.push("openurl");
    } else {
      const result = await runCommand(["xcrun", "simctl", "launch", id, app]);
      if (!result.ok) fail(result, "simctl launch");
      steps.push("launch");
    }
    return { ok: true, target: `sim:${id}`, appId: app, steps };
  }

  if (coldStart) {
    await runCommand(["adb", "-s", id, "shell", "am", "force-stop", app]);
    steps.push("force-stop");
  }
  const component = await resolveAndroidActivity(id, app);
  const argv = ["adb", "-s", id, "shell", "am", "start", "-W"];
  if (component) {
    argv.push("-f", "0x20000000", "-n", component);
  }
  if (link) {
    argv.push("-a", "android.intent.action.VIEW");
    if (suppressDevMenuIntro) argv.push("--ez", "EXDevMenuDisableAutoLaunch", "true");
    argv.push("-d", shellQuote(link));
    if (!component) argv.push(app);
  } else if (!component) {
    // Last resort launcher intent when the activity cannot be resolved
    const monkey = await runCommand(["adb", "-s", id, "shell", "monkey", "-p", app, "-c", "android.intent.category.LAUNCHER", "1"]);
    if (!monkey.ok) fail(monkey, "monkey launch");
    return { ok: true, target: `adb:${id}`, appId: app, steps: [...steps, "monkey-launch"] };
  }
  const result = await runCommand(argv, 15000);
  const output = `${textOf(result)} ${result.error}`;
  if (!result.ok || /Error:|Exception/i.test(output)) fail(result, "am start");
  steps.push(component ? "am-start-explicit" : "am-start-package");
  return { ok: true, target: `adb:${id}`, appId: app, steps };
};

export const terminateApp = async ({ target, appId }) => {
  const { kind, id } = await resolveTarget(target);
  requireTool(kind);
  const app = requireAppId(appId);
  const result = kind === "sim"
    ? await runCommand(["xcrun", "simctl", "terminate", id, app])
    : await runCommand(["adb", "-s", id, "shell", "am", "force-stop", app]);
  if (!result.ok && kind === "sim" && !/found nothing to terminate|not currently running/i.test(result.error)) {
    fail(result, "terminate");
  }
  return { ok: true, target: `${kind}:${id}`, appId: app };
};

export const openUrl = async ({ target, url, appId }) => {
  const { kind, id } = await resolveTarget(target);
  requireTool(kind);
  const link = requireUrl(url);
  if (kind === "sim") {
    const result = await runCommand(["xcrun", "simctl", "openurl", id, link]);
    if (!result.ok) fail(result, "simctl openurl");
    return { ok: true, target: `sim:${id}` };
  }
  const argv = ["adb", "-s", id, "shell", "am", "start", "-W", "-a", "android.intent.action.VIEW", "-d", shellQuote(link)];
  if (appId) argv.push(requireAppId(appId));
  const result = await runCommand(argv, 15000);
  const output = `${textOf(result)} ${result.error}`;
  if (!result.ok || /Error:|Exception/i.test(output)) fail(result, "am start VIEW");
  return { ok: true, target: `adb:${id}` };
};

// ====================================================================
// Perception and input
// ====================================================================

export const screenshotNative = async ({ target }) => {
  const { kind, id } = await resolveTarget(target);
  requireTool(kind);
  const result = kind === "sim"
    ? await runCommand(["xcrun", "simctl", "io", id, "screenshot", "--type=png", "-"], 10000)
    : await runCommand(["adb", "-s", id, "exec-out", "screencap", "-p"], 10000);
  if (!result.ok || result.bytes.length < 8) fail(result, "screenshot");
  return {
    __mcpImage: {
      data: Buffer.from(result.bytes).toString("base64"),
      mimeType: "image/png",
    },
    target: `${kind}:${id}`,
  };
};

export const tapNative = async ({ target, x, y, label }) => {
  const { kind, id } = await resolveTarget(target);
  requireTool(kind);
  const hasPoint = x !== undefined || y !== undefined;
  const px = Math.round(Number(x)), py = Math.round(Number(y));
  if (hasPoint && (!Number.isFinite(px) || !Number.isFinite(py))) {
    throw new Error("Invalid coordinates");
  }
  if (!hasPoint && !label) throw new Error("Pass x/y coordinates or a label");

  if (kind === "adb") {
    if (!hasPoint) throw new Error("Label taps are iOS-only (AXe); pass x/y on Android");
    const result = await runCommand(["adb", "-s", id, "shell", "input", "tap", String(px), String(py)]);
    if (!result.ok) fail(result, "input tap");
    return { ok: true, target: `adb:${id}`, x: px, y: py };
  }

  // iOS: simctl cannot tap. AXe (single binary, maintained) first,
  // then idb (needs companion + Python <= 3.11), else a clear message.
  if (which("axe")) {
    const argv = label
      ? ["axe", "tap", "--label", String(label), "--udid", id]
      : ["axe", "tap", "-x", String(px), "-y", String(py), "--udid", id];
    const result = await runCommand(argv, 15000);
    if (!result.ok) fail(result, "axe tap");
    return { ok: true, target: `sim:${id}`, via: "axe", label: label ?? null };
  }
  if (which("idb") && hasPoint) {
    const result = await runCommand(["idb", "ui", "tap", "--udid", id, String(px), String(py)], 10000);
    if (!result.ok) {
      if (isBrokenIdb(textOf(result) || result.error || "")) throw new Error(BROKEN_IDB_HINT);
      fail(result, "idb ui tap");
    }
    return { ok: true, target: `sim:${id}`, x: px, y: py, via: "idb" };
  }
  throw new Error(
    "Native taps on iOS simulators need AXe (brew install cameroncooke/axe/axe) or idb. Prefer ui_act (element-based) or set_permission/launch_app, which remove the dialogs entirely."
  );
};

/**
 * Swipe duration bounds, the same ones the dashboard mirror uses.
 *
 * The duration is not cosmetic: a fast swipe hands the list an inertial
 * fling, a slow one a tracked drag, and a gesture recognizer distinguishes
 * the two. Below 20 ms nothing tracks the movement at all, and above 3 s
 * the OS has usually given up on the gesture.
 */
const clampSwipeDuration = (raw) => {
  // `Number(raw) || 200` swallowed a legitimate 0, which then came back as
  // the default rather than as the documented 20 ms floor: the same falsy
  // zero trap the flow recorder avoids for index
  const value = Number(raw);
  if (!Number.isFinite(value)) return 200;
  return Math.min(Math.max(Math.round(value), 20), 3000);
};

/**
 * The argv of a swipe, built by itself so it can be verified without a
 * simulator and without any of the three binaries being installed. The
 * three tools take the same gesture in three different shapes: adb wants
 * milliseconds and bare coordinates, AXe named flags and seconds, idb the
 * coordinates positionally and seconds.
 */
export const swipeArgv = ({ kind, id, x1, y1, x2, y2, durationMs, tool = "axe" }) => {
  const durationMsClamped = clampSwipeDuration(durationMs);
  const seconds = String(durationMsClamped / 1000);
  const [sx, sy, ex, ey] = [x1, y1, x2, y2].map((value) => String(Math.round(Number(value))));
  if (kind === "adb") {
    return ["adb", "-s", id, "shell", "input", "swipe", sx, sy, ex, ey, String(durationMsClamped)];
  }
  if (tool === "idb") {
    return ["idb", "ui", "swipe", sx, sy, ex, ey, "--duration", seconds, "--udid", id];
  }
  return [
    "axe", "swipe",
    "--start-x", sx, "--start-y", sy,
    "--end-x", ex, "--end-y", ey,
    "--duration", seconds,
    "--udid", id,
  ];
};

/**
 * The gesture ui_act structurally cannot perform.
 *
 * ui_act drives the app through its JS props, so it can call onPress and
 * onChangeText, and it can call scrollTo on a list. It cannot produce a
 * touch that MOVES: a Swipeable row, a pan handler, a carousel and every
 * react-native-gesture-handler recognizer read the native touch stream,
 * which no prop exposes. Scrolling a long form to bring a field into view
 * is the same story on a plain View. Hence a real drag on the OS.
 */
export const swipeNative = async ({ target, x1, y1, x2, y2, durationMs }) => {
  const { kind, id } = await resolveTarget(target);
  requireTool(kind);
  const points = [x1, y1, x2, y2].map((value) => Math.round(Number(value)));
  if (points.some((value) => !Number.isFinite(value))) {
    throw new Error("Invalid coordinates: pass x1, y1, x2 and y2");
  }
  const duration = clampSwipeDuration(durationMs);
  const gesture = { kind, id, x1, y1, x2, y2, durationMs: duration };

  if (kind === "adb") {
    const result = await runCommand(swipeArgv(gesture), Math.max(6000, duration + 5000));
    if (!result.ok) fail(result, "input swipe");
    return {
      ok: true, target: `adb:${id}`,
      from: { x: points[0], y: points[1] }, to: { x: points[2], y: points[3] },
      durationMs: duration,
    };
  }

  // iOS: simctl cannot touch the screen. AXe (single binary, maintained)
  // first, then idb (needs companion + Python <= 3.11), else a clear message.
  if (which("axe")) {
    const result = await runCommand(swipeArgv({ ...gesture, tool: "axe" }), 15000);
    if (!result.ok) fail(result, "axe swipe");
    return {
      ok: true, target: `sim:${id}`, via: "axe",
      from: { x: points[0], y: points[1] }, to: { x: points[2], y: points[3] },
      durationMs: duration,
    };
  }
  if (which("idb")) {
    const result = await runCommand(swipeArgv({ ...gesture, tool: "idb" }), 15000);
    if (!result.ok) {
      if (isBrokenIdb(textOf(result) || result.error || "")) throw new Error(BROKEN_IDB_HINT);
      fail(result, "idb ui swipe");
    }
    return {
      ok: true, target: `sim:${id}`, via: "idb",
      from: { x: points[0], y: points[1] }, to: { x: points[2], y: points[3] },
      durationMs: duration,
    };
  }
  throw new Error(
    "Native swipes on iOS simulators need AXe (brew install cameroncooke/axe/axe) or idb. For a plain list, ui_act with scrollTo/scrollBy/scrollToEnd needs no binary at all; a swipe is for what scrolling cannot do (Swipeable rows, pan gestures)."
  );
};

// ====================================================================
// Device state helpers
// ====================================================================

/** Authoritative answer, unlike an exit code: ask simctl what state it is in */
const simulatorState = async (udid) => {
  const result = await runCommand(["xcrun", "simctl", "list", "devices", "-j"], 15000);
  try {
    const parsed = JSON.parse(textOf(result));
    for (const runtime of Object.values(parsed.devices ?? {})) {
      for (const sim of runtime) if (sim.udid === udid) return sim.state;
    }
  } catch {
    // unreadable output, treat as unknown
  }
  return null;
};

export const bootDevice = async ({ target }) => {
  const { kind, id } = parseTarget(target);
  requireTool(kind);
  if (kind === "sim") {
    const result = await runCommand(["xcrun", "simctl", "boot", id], 60000);
    // A cold boot regularly outlives the command timeout, which kills the
    // process and leaves a non-zero exit while the simulator carries on and
    // finishes booting. Reporting that as a failure is simply wrong, so the
    // device's own state decides.
    if (!result.ok && !/already booted|current state: Booted/i.test(result.error)) {
      let state = await simulatorState(id);
      for (let waited = 0; state !== "Booted" && waited < 30000; waited += 1000) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        state = await simulatorState(id);
      }
      if (state !== "Booted") {
        throw new Error(
          `simctl boot failed and the device is still ${state ?? "unknown"}: ${result.error || textOf(result) || "no output"}`
        );
      }
    }
    await runCommand(["open", "-a", "Simulator"]); // show the window
    return { ok: true, target: `sim:${id}`, state: "Booted" };
  }
  throw new Error(
    "Booting an Android emulator needs the emulator binary and an AVD name; start it manually (emulator -avd <name>) or use an already-running device"
  );
};

export const shutdownDevice = async ({ target }) => {
  const { kind, id } = parseTarget(target);
  requireTool(kind);
  if (kind === "sim") {
    const result = await runCommand(["xcrun", "simctl", "shutdown", id], 30000);
    if (!result.ok && !/already shutdown|current state: Shutdown/i.test(result.error)) {
      fail(result, "simctl shutdown");
    }
    return { ok: true, target: `sim:${id}` };
  }
  const result = await runCommand(["adb", "-s", id, "emu", "kill"]);
  if (!result.ok) fail(result, "adb emu kill (emulators only)");
  return { ok: true, target: `adb:${id}` };
};

export const setLocation = async ({ target, latitude, longitude }) => {
  const { kind, id } = await resolveTarget(target);
  requireTool(kind);
  const lat = Number(latitude), lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error("Invalid coordinates");
  if (kind === "sim") {
    const result = await runCommand(["xcrun", "simctl", "location", id, "set", `${lat},${lng}`]);
    if (!result.ok) fail(result, "simctl location set");
    return { ok: true, target: `sim:${id}`, latitude: lat, longitude: lng };
  }
  // Emulator console wants LONGITUDE FIRST; physical devices unsupported
  if (!id.startsWith("emulator-")) {
    throw new Error("set_location only works on Android emulators (adb emu geo fix), not physical devices");
  }
  const result = await runCommand(["adb", "-s", id, "emu", "geo", "fix", String(lng), String(lat)]);
  if (!result.ok) fail(result, "adb emu geo fix");
  return { ok: true, target: `adb:${id}`, latitude: lat, longitude: lng };
};

export const setAnimations = async ({ target, enabled }) => {
  const { kind, id } = await resolveTarget(target);
  requireTool(kind);
  if (kind !== "adb") {
    throw new Error("Animation scales are only scriptable on Android (adb settings); on iOS use test.control hooks in the app");
  }
  const value = enabled === false ? "0" : "1";
  for (const key of ["window_animation_scale", "transition_animation_scale", "animator_duration_scale"]) {
    const result = await runCommand(["adb", "-s", id, "shell", "settings", "put", "global", key, value]);
    if (!result.ok) fail(result, `settings put ${key}`);
  }
  return { ok: true, target: `adb:${id}`, animations: value === "1" };
};

export const sendPush = async ({ target, appId, payload }) => {
  const { kind, id } = await resolveTarget(target);
  if (kind !== "sim") {
    throw new Error("send_push only works on iOS simulators (simctl push); on Android use a real push provider or cmd notification");
  }
  requireTool(kind);
  const app = requireAppId(appId);
  if (!payload || typeof payload !== "object" || !payload.aps) {
    throw new Error('payload must be a JSON object with a top-level "aps" key, e.g. {"aps":{"alert":{"title":"...","body":"..."}}}');
  }
  const json = JSON.stringify(payload);
  if (json.length > 4096) throw new Error("Payload too large: simctl push caps at 4096 bytes");
  const result = await runCommand(["xcrun", "simctl", "push", id, app, "-"], 10000, json);
  if (!result.ok) fail(result, "simctl push");
  // simctl exits 0 even for a non-installed bundle: surface its message
  return { ok: true, target: `sim:${id}`, output: textOf(result) || result.error };
};

export const setAppearance = async ({ target, appearance }) => {
  const { kind, id } = await resolveTarget(target);
  requireTool(kind);
  const mode = String(appearance ?? "");
  if (!["light", "dark"].includes(mode)) throw new Error('appearance must be "light" or "dark"');
  const result = kind === "sim"
    ? await runCommand(["xcrun", "simctl", "ui", id, "appearance", mode])
    : await runCommand(["adb", "-s", id, "shell", "cmd", "uimode", "night", mode === "dark" ? "yes" : "no"]);
  if (!result.ok) fail(result, "set appearance");
  return { ok: true, target: `${kind}:${id}`, appearance: mode };
};

/** Collapses log lines repeated in a loop: identical messages (once
 * timestamps and pids are stripped) within a short window are folded
 * into one line with a repeat count. */
const dedupeLogLines = (lines) => {
  const keyOf = (line) => line
    .replace(/^\d{2}-\d{2}\s[\d:.]+\s+\d+\s+\d+\s+/, "")   // logcat: date time pid tid
    .replace(/^[\d-]+\s[\d:.+]+\s+/, "")                    // iOS compact: date time
    .replace(/\[\d+:\d+\]/, "[pid]");
  const out = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const key = keyOf(line);
    // Window of 4: also catches A,B,A,B alternating loops
    const recent = out.slice(-4).find((entry) => entry.key === key);
    if (recent) { recent.count += 1; continue; }
    out.push({ line, key, count: 1 });
  }
  return out.map((entry) => entry.count > 1
    ? `${entry.line}   (repeated x${entry.count})`
    : entry.line);
};

/**
 * Native device logs: everything the JS console cannot see (crashes
 * before the bundle loads, Expo Go / dev-client startup, OS messages).
 * Android: bounded logcat dump (fast). iOS: unified log dump via
 * log show; reading the archive is slow (roughly 10-30 s per minute of
 * window), so the default window is 1 minute. Looping duplicates are
 * collapsed with a repeat count.
 */
export const getNativeLogs = async ({ target, lines, filter, process: processName, sinceMinutes }) => {
  const { kind, id } = await resolveTarget(target);
  requireTool(kind);
  const limit = Math.max(10, Math.min(Number(lines) || 200, 2000));
  const needle = filter ? String(filter) : null;

  if (kind === "adb") {
    const argv = ["adb", "-s", id, "logcat", "-d", "-t", String(limit)];
    if (processName) {
      const app = requireAppId(processName);
      const pid = await runCommand(["adb", "-s", id, "shell", "pidof", "-s", app]);
      const pidText = textOf(pid);
      if (pid.ok && /^\d+$/.test(pidText)) {
        argv.push("--pid", pidText);
      } else {
        return { target: `adb:${id}`, count: 0, lines: [], note: `Process ${app} is not running` };
      }
    }
    const raw = await runCommand(argv, 15000);
    if (!raw.ok) fail(raw, "adb logcat");
    let all = textOf(raw).split("\n");
    if (needle) all = all.filter((line) => line.toLowerCase().includes(needle.toLowerCase()));
    const out = dedupeLogLines(all).slice(-limit)
      .map((line) => line.length > 500 ? `${line.slice(0, 500)}…` : line);
    return { target: `adb:${id}`, count: out.length, lines: out };
  }

  // iOS simulator: unified log via the sim runtime's log binary
  const predicates = [];
  if (processName) {
    if (!/^[A-Za-z0-9 ._-]+$/.test(String(processName))) throw new Error("Invalid process name");
    predicates.push(`process == "${processName}"`);
  }
  if (needle) {
    if (!/^[^"\\]+$/.test(needle)) throw new Error("Invalid filter (no quotes or backslashes)");
    predicates.push(`eventMessage CONTAINS[c] "${needle}"`);
  }
  const isNoise = (line) =>
    !line.trim() || /^Filtering the log data|^Timestamp\s+Ty/.test(line);

  // log show reads the whole archive: expect ~10-30 s per minute of
  // window, hence the small default and the sized timeout
  const minutes = Math.max(1, Math.min(Number(sinceMinutes) || 1, 10));
  const argv = ["xcrun", "simctl", "spawn", id, "log", "show", "--last", `${minutes}m`, "--style", "compact"];
  if (predicates.length) argv.push("--predicate", predicates.join(" AND "));
  const raw = await runCommand(argv, 60000 + minutes * 30000);
  if (!raw.ok) fail(raw, "simctl log show");
  const out = dedupeLogLines(textOf(raw).split("\n").filter((l) => !isNoise(l))).slice(-limit)
    .map((line) => line.length > 500 ? `${line.slice(0, 500)}…` : line);
  return { target: `sim:${id}`, sinceMinutes: minutes, count: out.length, lines: out };
};

// ====================================================================
// session_start orchestration
// ====================================================================

export const sessionStart = async (args, { waitForEvent, projectRoot, hubPort }) => {
  const platform = String(args.platform ?? "");
  if (!["ios", "android"].includes(platform)) throw new Error('platform must be "ios" or "android"');
  const { kind, id } = await resolveTarget(args.target, platform);
  const target = `${kind}:${id}`;
  const appId = requireAppId(args.appId);
  const steps = [];

  for (const [service, grant] of Object.entries(args.permissions ?? {})) {
    try {
      await setPermission({ target, appId, service, grant });
      steps.push({ step: `permission:${service}`, ok: true });
    } catch (error) {
      steps.push({ step: `permission:${service}`, ok: false, error: String(error.message ?? error) });
    }
  }

  let url = args.serverUrl ? requireUrl(args.serverUrl) : null;
  if (url && kind === "adb") {
    const metroPort = Number(new URL(url).port || 8081);
    const repaired = await repairAdbRoutes({
      target,
      ports: [metroPort, hubPort, ...(args.adbPorts ?? [])],
    });
    steps.push({ step: "adb-routes", ok: repaired.ok, routes: repaired.routes });
    // Android has no --initialUrl equivalent: build the dev-client deep
    // link, which needs the app scheme (exp+<slug> by default)
    const scheme = args.scheme || expoSchemeFromProject(projectRoot);
    if (scheme) {
      const encoded = encodeURIComponent(`${url}/?disableOnboarding=1`);
      url = `${scheme}://expo-development-client/?url=${encoded}&disableOnboarding=1`;
      steps.push({
        step: "metro-route",
        ok: true,
        scheme,
        source: args.scheme ? "argument" : "project",
      });
    } else {
      url = null; // plain launch reconnects to the last used server
      steps.push({
        step: "no-scheme",
        ok: false,
        note: "No scheme found in app.json: pass scheme for a deterministic Metro connection",
      });
    }
  }

  const launch = await launchApp({
    target, appId, url,
    coldStart: args.coldStart !== false,
    hideDevMenuFab: args.hideDevMenuFab,
  });
  steps.push({ step: "launch", ok: true, detail: launch.steps });

  const waitType = typeof args.waitFor === "string" && args.waitFor.length ? args.waitFor : "app.info";
  const timeoutMs = Math.max(5000, Math.min(Number(args.timeoutMs) || 60000, 120000));
  const waited = await waitForEvent({ type: waitType, timeoutMs, appName: args.appName });
  steps.push({ step: `wait:${waitType}`, ok: !waited.timedOut });

  return {
    ok: !waited.timedOut,
    target,
    appId,
    steps,
    event: waited.event,
    hint: waited.timedOut
      ? `The${args.appName ? ` ${args.appName}` : ""} app did not emit "${waitType}" in ${timeoutMs} ms: check that devtools.init() runs and points at this hub`
      : null,
  };
};


// ====================================================================
// App lifecycle: install / uninstall
// ====================================================================

export const installApp = async ({ target, path }) => {
  const { kind, id } = await resolveTarget(target);
  requireTool(kind);
  const artifact = String(path ?? "");
  if (!artifact || /['"\s]/.test(artifact)) throw new Error(`Invalid app path: ${path}`);
  const result = kind === "sim"
    ? await runCommand(["xcrun", "simctl", "install", id, artifact], 120000)
    : await runCommand(["adb", "-s", id, "install", "-r", artifact], 180000);
  const output = `${textOf(result)} ${result.error}`;
  if (!result.ok || /Failure|Error/i.test(output)) fail(result, "install");
  return { ok: true, target: `${kind}:${id}`, path: artifact };
};

export const uninstallApp = async ({ target, appId }) => {
  const { kind, id } = await resolveTarget(target);
  requireTool(kind);
  const app = requireAppId(appId);
  const result = kind === "sim"
    ? await runCommand(["xcrun", "simctl", "uninstall", id, app], 60000)
    : await runCommand(["adb", "-s", id, "uninstall", app], 60000);
  if (!result.ok) fail(result, "uninstall");
  return { ok: true, target: `${kind}:${id}`, appId: app };
};

// ====================================================================
// Orientation
// ====================================================================

// Android stores a rotation index; iOS simulators expose no scriptable
// rotation at all, so the limit is reported instead of faked
const ROTATIONS = { portrait: "0", landscape: "1", "portrait-upside-down": "2", "landscape-left": "3" };
const ROTATION_NAMES = ["portrait", "landscape", "portrait-upside-down", "landscape-left"];

export const setOrientation = async ({ target, orientation }) => {
  const { kind, id } = await resolveTarget(target);
  requireTool(kind);
  if (kind !== "adb") {
    throw new Error(
      "iOS simulators expose no scriptable rotation (simctl has no orientation command). Rotate with Cmd+Left/Right in the Simulator, or test rotation on Android."
    );
  }
  const rotation = ROTATIONS[String(orientation)];
  if (rotation === undefined) {
    throw new Error(`Unknown orientation "${orientation}". Use: ${Object.keys(ROTATIONS).join(", ")}`);
  }
  await runCommand(["adb", "-s", id, "shell", "settings", "put", "system", "accelerometer_rotation", "0"]);
  const result = await runCommand(["adb", "-s", id, "shell", "settings", "put", "system", "user_rotation", rotation]);
  if (!result.ok) fail(result, "set orientation");
  return { ok: true, target: `adb:${id}`, orientation };
};

export const getOrientation = async ({ target }) => {
  const { kind, id } = await resolveTarget(target);
  requireTool(kind);
  if (kind !== "adb") {
    return { target: `sim:${id}`, orientation: null, note: "iOS simulators do not report orientation to simctl" };
  }
  const result = await runCommand(["adb", "-s", id, "shell", "settings", "get", "system", "user_rotation"]);
  const index = Number(textOf(result));
  return {
    target: `adb:${id}`,
    orientation: ROTATION_NAMES[index] ?? null,
    rotation: Number.isFinite(index) ? index : null,
  };
};

// ====================================================================
// Screen recording
// ====================================================================

// Recordings outlive a single command, so the process is kept and stopped
// by signal. One per target: a second would overwrite the first's file.
const recordings = new Map();

export const startScreenRecording = async ({ target, file }) => {
  const { kind, id } = await resolveTarget(target);
  requireTool(kind);
  const key = `${kind}:${id}`;
  if (recordings.has(key)) {
    throw new Error(`Already recording ${key}. Call stop_screen_recording first.`);
  }
  const output = String(file ?? `rn-devtools-${key.replace(":", "-")}.mp4`).replace(/['"\s]/g, "");
  const startedAt = Date.now();
  const argv = kind === "sim"
    ? ["xcrun", "simctl", "io", id, "recordVideo", "--codec", "h264", "--force", output]
    : ["adb", "-s", id, "shell", "screenrecord", "/sdcard/rn-devtools-recording.mp4"];
  const proc = spawn(argv, { stdout: "pipe", stderr: "pipe" });
  recordings.set(key, { proc, output, startedAt, kind, id });
  return {
    ok: true,
    target: key,
    file: output,
    startedAt,
    // The timeline offset is the whole point: an agent can map a frame
    // back to the event that produced it
    note: "startedAt is on the same clock as the event bus: subtract it from an event ts to get the video offset.",
  };
};

export const stopScreenRecording = async ({ target }) => {
  const { kind, id } = await resolveTarget(target);
  const key = `${kind}:${id}`;
  const recording = recordings.get(key);
  if (!recording) throw new Error(`No recording in progress on ${key}`);
  recordings.delete(key);
  try {
    recording.proc.kill("SIGINT");
    await recording.proc.exited;
  } catch { /* already gone */ }

  if (kind === "adb") {
    // screenrecord flushes its file after the signal
    await new Promise((resolve) => setTimeout(resolve, 800));
    const pulled = await runCommand(
      ["adb", "-s", id, "pull", "/sdcard/rn-devtools-recording.mp4", recording.output],
      60000
    );
    if (!pulled.ok) fail(pulled, "adb pull recording");
    await runCommand(["adb", "-s", id, "shell", "rm", "/sdcard/rn-devtools-recording.mp4"]);
  }
  const durationMs = Date.now() - recording.startedAt;
  return {
    ok: true,
    target: key,
    file: recording.output,
    startedAt: recording.startedAt,
    durationMs,
    note: "Video offset of an event = event.ts - startedAt.",
  };
};

// ====================================================================
// MCP tool definitions + dispatcher
// ====================================================================

const targetProp = { target: { type: "string", description: "sim:<udid> or adb:<serial> from list_targets; omitted = the single booted target" } };

export const NATIVE_TOOLS = [
  {
    name: "list_targets",
    description: "Lists OS-level targets: iOS simulators (simctl) and Android devices/emulators (adb), with their boot state. Native tools take these targets, distinct from the JS deviceId of list_devices.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "repair_adb_routes",
    description: "Restores adb reverse mappings lost after an emulator or USB reconnection. Defaults to Metro 8081 and the current Hub port. Omit target only when exactly one Android target is ready.",
    inputSchema: { type: "object", properties: { ...targetProp, ports: { type: "array", minItems: 1, items: { type: "integer", minimum: 1, maximum: 65535 } } }, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "set_permission",
    description: "Pre-grants or revokes an app permission so the popup never appears: location, location-always, camera, microphone, photos, media-library, contacts, calendar, notifications (Android 13+ only; iOS cannot pre-grant notifications), motion/reminders/photos-add (iOS). Grant BEFORE launching.",
    inputSchema: { type: "object", required: ["appId", "service"], properties: { ...targetProp, appId: { type: "string" }, service: { type: "string" }, grant: { type: ["boolean", "null"], description: "true=grant, false=revoke, null=reset (iOS)" } }, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "launch_app",
    description: "Launches the app with zero dialogs and nothing floating over the screen. iOS: simctl launch with --initialUrl (dev-client loads the given Metro URL directly, no deep link). Android: explicit-component am start with the URL as VIEW data. coldStart terminates first; the expo dev-menu onboarding is skipped automatically, and its floating action button is hidden (iOS), because it sits in its own window, is therefore invisible to get_ui_tree, and swallows taps meant for the buttons underneath it.",
    inputSchema: { type: "object", required: ["appId"], properties: { ...targetProp, appId: { type: "string" }, url: { type: "string", description: "Metro server URL (http://host:8081) or deep link" }, coldStart: { type: "boolean" }, suppressDevMenuIntro: { type: "boolean" }, hideDevMenuFab: { type: "boolean", description: "iOS: hide the expo-dev-menu floating bubble, which covers the bottom-right corner and intercepts taps (default true). Pass false to put it back. On Android the equivalent is a manifest meta-data, so the hub cannot set it." } }, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: "terminate_app",
    description: "Force-stops the app (simctl terminate / am force-stop).",
    inputSchema: { type: "object", required: ["appId"], properties: { ...targetProp, appId: { type: "string" } }, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: "open_url",
    description: "Opens a deep link on the target (simctl openurl / am start VIEW). On Android pass appId to pin the handler and avoid the chooser.",
    inputSchema: { type: "object", required: ["url"], properties: { ...targetProp, url: { type: "string" }, appId: { type: "string" } }, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: "screenshot_native",
    description: "Pixel screenshot of the target screen (PNG), complementing get_ui_tree: the tree gives structure, this gives the actual rendering.",
    inputSchema: { type: "object", properties: { ...targetProp }, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "tap_native",
    description: "LAST-RESORT tap for native dialogs the JS runtime cannot reach. Android: adb input tap (x/y). iOS: AXe if installed (tap by accessibility label, e.g. label='Allow', or x/y in points), else idb. Prefer ui_act and set_permission/launch_app, which make this unnecessary.",
    inputSchema: { type: "object", properties: { ...targetProp, x: { type: "number" }, y: { type: "number" }, label: { type: "string", description: "iOS/AXe only: tap the element with this accessibility label" } }, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: "swipe_native",
    description: "Drags a real finger across the screen, from x1,y1 to x2,y2 in device coordinates. This is the gesture ui_act cannot perform: it acts through the JS props, so it reaches onPress and scrollTo but never produces a MOVING touch. Use it to scroll a long form that exposes no scrollable instance, and to exercise anything reading the native touch stream: a Swipeable row, a pan handler, a carousel, any react-native-gesture-handler recognizer. durationMs shapes the gesture: short is an inertial fling, long a tracked drag. Android: adb input swipe. iOS: AXe if installed, else idb.",
    inputSchema: { type: "object", required: ["x1", "y1", "x2", "y2"], properties: { ...targetProp, x1: { type: "number" }, y1: { type: "number" }, x2: { type: "number" }, y2: { type: "number" }, durationMs: { type: "integer", description: "Gesture duration, clamped to 20-3000 ms (default 200). Short flings, long drags." } }, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: "boot_device",
    description: "Boots an iOS simulator by target id (sim:<udid>) and opens the Simulator app. Android emulators must be started externally.",
    inputSchema: { type: "object", required: ["target"], properties: { target: { type: "string" } }, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "shutdown_device",
    description: "Shuts down an iOS simulator, or kills an Android emulator (adb emu kill).",
    inputSchema: { type: "object", required: ["target"], properties: { target: { type: "string" } }, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: "set_location",
    description: "Sets the simulated GPS position: simctl location (iOS) or the emulator console geo fix (Android emulators only). Deterministic replacement for real GPS in dev.",
    inputSchema: { type: "object", required: ["latitude", "longitude"], properties: { ...targetProp, latitude: { type: "number" }, longitude: { type: "number" } }, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "set_animations",
    description: "Enables or disables system animations on Android (window/transition/animator scales) for deterministic captures. Remember to re-enable at session end.",
    inputSchema: { type: "object", required: ["enabled"], properties: { ...targetProp, enabled: { type: "boolean" } }, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "get_native_logs",
    description: "Native device logs the JS console cannot see, with looping duplicates collapsed. Android: bounded logcat dump, fast (filter by app package via process). iOS: unified log dump of the last sinceMinutes (default 1); SLOW, roughly 10-30 s per minute of window, so keep the window small and filter by process. Catches crashes before the bundle loads and dev-client startup issues.",
    inputSchema: { type: "object", properties: { ...targetProp, lines: { type: "integer", minimum: 10, maximum: 2000 }, filter: { type: "string", description: "Substring filter on the log lines" }, process: { type: "string", description: "Android: app package (pid filter). iOS: process name" }, sinceMinutes: { type: "integer", minimum: 1, maximum: 10 } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "send_push",
    description: "Simulates a remote push notification on an iOS simulator (simctl push). payload is the APNs JSON with a top-level aps key. Rendering still depends on the app having notification permission.",
    inputSchema: { type: "object", required: ["appId", "payload"], properties: { ...targetProp, appId: { type: "string" }, payload: { type: "object" } }, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "set_appearance",
    description: "Switches the target to light or dark mode (simctl ui appearance / adb cmd uimode night). Useful before screenshots.",
    inputSchema: { type: "object", required: ["appearance"], properties: { ...targetProp, appearance: { type: "string", enum: ["light", "dark"] } }, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "install_app",
    description: "Installs an app bundle on the target (simctl install / adb install -r).",
    inputSchema: { type: "object", required: ["path"], properties: { ...targetProp, path: { type: "string", description: "Path to the .app, .ipa or .apk" } }, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: "uninstall_app",
    description: "Removes the app from the target, wiping its data.",
    inputSchema: { type: "object", required: ["appId"], properties: { ...targetProp, appId: { type: "string" } }, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: "set_orientation",
    description: "Rotates the device. Android only: iOS simulators expose no scriptable rotation, and that limit is reported rather than faked.",
    inputSchema: { type: "object", required: ["orientation"], properties: { ...targetProp, orientation: { type: "string", enum: ["portrait", "landscape", "portrait-upside-down", "landscape-left"] } }, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "get_orientation",
    description: "Reads the current rotation (Android).",
    inputSchema: { type: "object", properties: { ...targetProp }, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "start_screen_recording",
    description: "Starts recording the screen. Returns startedAt on the SAME clock as the event bus, so a frame maps back to the event that produced it: video offset = event.ts - startedAt. Attaching a run's video to a bug report is what this is for.",
    inputSchema: { type: "object", properties: { ...targetProp, file: { type: "string" } }, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "stop_screen_recording",
    description: "Stops the recording and returns the file, its start instant and its duration.",
    inputSchema: { type: "object", properties: { ...targetProp }, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "session_start",
    description: "One-call bootstrap and app switch: resolve target, pre-grant permissions, launch the dev build on the given Metro server, then wait for the expected app to connect. Pass appName when several runtimes share the hub so an event from the wrong app cannot satisfy the wait. Android derives the development-client scheme from app.json when scheme is omitted.",
    inputSchema: { type: "object", required: ["platform", "appId"], properties: { platform: { type: "string", enum: ["ios", "android"] }, target: { type: "string" }, appId: { type: "string" }, appName: { type: "string", description: "Expected devtools appName. Filters connection events when switching between apps." }, serverUrl: { type: "string" }, scheme: { type: "string", description: "Android development-client scheme. Defaults to app.json expo.scheme or exp+slug." }, adbPorts: { type: "array", items: { type: "integer", minimum: 1, maximum: 65535 }, description: "Additional adb reverse ports to restore with Metro and the hub." }, permissions: { type: "object", additionalProperties: { type: "boolean" } }, coldStart: { type: "boolean" }, hideDevMenuFab: { type: "boolean", description: "iOS: hide the expo-dev-menu floating bubble, which intercepts taps meant for the elements under it (default true)" }, waitFor: { type: "string" }, timeoutMs: { type: "integer", minimum: 5000, maximum: 120000 } }, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
];

export const handleNativeTool = async (name, args, helpers) => {
  switch (name) {
    case "list_targets": return listTargets();
    case "repair_adb_routes": return repairAdbRoutes({
      ...args,
      ports: args.ports ?? [8081, helpers?.hubPort],
    });
    case "set_permission": return setPermission(args);
    case "launch_app": return launchApp(args);
    case "terminate_app": return terminateApp(args);
    case "open_url": return openUrl(args);
    case "screenshot_native": return screenshotNative(args);
    case "tap_native": return tapNative(args);
    case "swipe_native": return swipeNative(args);
    case "boot_device": return bootDevice(args);
    case "shutdown_device": return shutdownDevice(args);
    case "set_location": return setLocation(args);
    case "set_animations": return setAnimations(args);
    case "get_native_logs": return getNativeLogs(args);
    case "send_push": return sendPush(args);
    case "set_appearance": return setAppearance(args);
    case "install_app": return installApp(args);
    case "uninstall_app": return uninstallApp(args);
    case "set_orientation": return setOrientation(args);
    case "get_orientation": return getOrientation(args);
    case "start_screen_recording": return startScreenRecording(args);
    case "stop_screen_recording": return stopScreenRecording(args);
    case "session_start": return sessionStart(args, helpers);
    default: return undefined;
  }
};
