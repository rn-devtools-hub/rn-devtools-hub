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

const SAFE_ID = /^[A-Za-z0-9._:-]+$/;
const APP_ID = /^[A-Za-z0-9._-]+$/;

export const runCommand = async (argv, timeoutMs = 6000, stdinText = null) => {
  try {
    const proc = Bun.spawn(argv, {
      stdout: "pipe",
      stderr: "pipe",
      ...(stdinText !== null ? { stdin: new TextEncoder().encode(stdinText) } : {}),
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

const simctlAvailable = () => process.platform === "darwin" && !!Bun.which("xcrun");
const adbAvailable = () => !!Bun.which("adb");

const requireTool = (kind) => {
  if (kind === "sim" && !simctlAvailable()) {
    throw new Error("simctl unavailable: install the Xcode command line tools (macOS only)");
  }
  if (kind === "adb" && !adbAvailable()) {
    throw new Error("adb unavailable: install the Android platform-tools");
  }
};

const fail = (result, action) => {
  throw new Error(`${action} failed: ${result.error || textOf(result) || "unknown error"}`);
};

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

export const launchApp = async ({ target, appId, url, coldStart = true, suppressDevMenuIntro = true }) => {
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
    if (suppressDevMenuIntro) {
      // Key verified in expo-dev-menu source (DevMenuPreferences.swift).
      // "defaults write <bundleId>" would hit the DEVICE-level plist, not
      // the app sandbox: the app container path must be used instead
      const container = await runCommand(["xcrun", "simctl", "get_app_container", id, app, "data"]);
      if (container.ok) {
        const plist = `${textOf(container)}/Library/Preferences/${app}.plist`;
        const prefs = await runCommand(["xcrun", "simctl", "spawn", id, "defaults", "write", plist, "EXDevMenuIsOnboardingFinished", "-bool", "true"]);
        steps.push(prefs.ok ? "onboarding-skipped" : "onboarding-skip-failed");
      } else {
        steps.push("onboarding-skip-unavailable"); // app not installed yet
      }
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
  if (Bun.which("axe")) {
    const argv = label
      ? ["axe", "tap", "--label", String(label), "--udid", id]
      : ["axe", "tap", "-x", String(px), "-y", String(py), "--udid", id];
    const result = await runCommand(argv, 15000);
    if (!result.ok) fail(result, "axe tap");
    return { ok: true, target: `sim:${id}`, via: "axe", label: label ?? null };
  }
  if (Bun.which("idb") && hasPoint) {
    const result = await runCommand(["idb", "ui", "tap", "--udid", id, String(px), String(py)], 10000);
    if (!result.ok) fail(result, "idb ui tap");
    return { ok: true, target: `sim:${id}`, x: px, y: py, via: "idb" };
  }
  throw new Error(
    "Native taps on iOS simulators need AXe (brew install cameroncooke/axe/axe) or idb. Prefer ui_act (element-based) or set_permission/launch_app, which remove the dialogs entirely."
  );
};

// ====================================================================
// Device state helpers
// ====================================================================

export const bootDevice = async ({ target }) => {
  const { kind, id } = parseTarget(target);
  requireTool(kind);
  if (kind === "sim") {
    const result = await runCommand(["xcrun", "simctl", "boot", id], 30000);
    if (!result.ok && !/already booted|current state: Booted/i.test(result.error)) {
      fail(result, "simctl boot");
    }
    await runCommand(["open", "-a", "Simulator"]); // show the window
    return { ok: true, target: `sim:${id}` };
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

// ====================================================================
// session_start orchestration
// ====================================================================

export const sessionStart = async (args, { waitForEvent }) => {
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
    try {
      const port = new URL(url).port || "8081";
      await runCommand(["adb", "-s", id, "reverse", `tcp:${port}`, `tcp:${port}`]);
      steps.push({ step: `adb-reverse:${port}`, ok: true });
    } catch { /* reverse is best effort */ }
    // Android has no --initialUrl equivalent: build the dev-client deep
    // link, which needs the app scheme (exp+<slug> by default)
    if (args.scheme) {
      const encoded = encodeURIComponent(`${url}/?disableOnboarding=1`);
      url = `${args.scheme}://expo-development-client/?url=${encoded}&disableOnboarding=1`;
    } else {
      url = null; // plain launch reconnects to the last used server
      steps.push({ step: "no-scheme", ok: true, note: "pass scheme for a deterministic first connection" });
    }
  }

  const launch = await launchApp({ target, appId, url, coldStart: args.coldStart !== false });
  steps.push({ step: "launch", ok: true, detail: launch.steps });

  const waitType = typeof args.waitFor === "string" && args.waitFor.length ? args.waitFor : "app.info";
  const timeoutMs = Math.max(5000, Math.min(Number(args.timeoutMs) || 60000, 120000));
  const waited = await waitForEvent({ type: waitType, timeoutMs });
  steps.push({ step: `wait:${waitType}`, ok: !waited.timedOut });

  return {
    ok: !waited.timedOut,
    target,
    appId,
    steps,
    event: waited.event,
    hint: waited.timedOut
      ? `The app did not emit "${waitType}" in ${timeoutMs} ms: check that devtools.init() runs and points at this hub`
      : null,
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
    name: "set_permission",
    description: "Pre-grants or revokes an app permission so the popup never appears: location, location-always, camera, microphone, photos, media-library, contacts, calendar, notifications (Android 13+ only; iOS cannot pre-grant notifications), motion/reminders/photos-add (iOS). Grant BEFORE launching.",
    inputSchema: { type: "object", required: ["appId", "service"], properties: { ...targetProp, appId: { type: "string" }, service: { type: "string" }, grant: { type: ["boolean", "null"], description: "true=grant, false=revoke, null=reset (iOS)" } }, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "launch_app",
    description: "Launches the app with zero dialogs. iOS: simctl launch with --initialUrl (dev-client loads the given Metro URL directly, no deep link). Android: explicit-component am start with the URL as VIEW data. coldStart terminates first; the expo dev-menu onboarding is skipped automatically.",
    inputSchema: { type: "object", required: ["appId"], properties: { ...targetProp, appId: { type: "string" }, url: { type: "string", description: "Metro server URL (http://host:8081) or deep link" }, coldStart: { type: "boolean" }, suppressDevMenuIntro: { type: "boolean" } }, additionalProperties: false },
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
    name: "session_start",
    description: "One-call bootstrap: resolve target, pre-grant permissions, launch the dev build on the given Metro server (cold start, no dialogs, onboarding skipped), then wait until the app connects to the hub (waitFor event, default app.info). Android: pass scheme (e.g. exp+myapp) for a deterministic first connection.",
    inputSchema: { type: "object", required: ["platform", "appId"], properties: { platform: { type: "string", enum: ["ios", "android"] }, target: { type: "string" }, appId: { type: "string" }, serverUrl: { type: "string" }, scheme: { type: "string" }, permissions: { type: "object", additionalProperties: { type: "boolean" } }, coldStart: { type: "boolean" }, waitFor: { type: "string" }, timeoutMs: { type: "integer", minimum: 5000, maximum: 120000 } }, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
];

export const handleNativeTool = async (name, args, helpers) => {
  switch (name) {
    case "list_targets": return listTargets();
    case "set_permission": return setPermission(args);
    case "launch_app": return launchApp(args);
    case "terminate_app": return terminateApp(args);
    case "open_url": return openUrl(args);
    case "screenshot_native": return screenshotNative(args);
    case "tap_native": return tapNative(args);
    case "boot_device": return bootDevice(args);
    case "shutdown_device": return shutdownDevice(args);
    case "set_location": return setLocation(args);
    case "set_animations": return setAnimations(args);
    case "send_push": return sendPush(args);
    case "set_appearance": return setAppearance(args);
    case "session_start": return sessionStart(args, helpers);
    default: return undefined;
  }
};
