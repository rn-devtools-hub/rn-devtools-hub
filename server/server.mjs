/**
 * Devtools hub: WebSocket server + web dashboard.
 *
 * Launch:  bun devtools/server/server.mjs  [--port 8973]
 *
 * Roles:
 * - Devices (client SDK) connect and stream their events
 * - Dashboards (browser) connect and receive the live stream
 * - The hub keeps a per-device history for dashboards that join late
 * - Dashboard commands (e.g. SQLite query) are relayed to the device
 *
 * Zero dependencies. Runs on Bun or on Node: server/runtime.mjs papers
 * over the difference, including the WebSocket server Node does not have.
 */

import { readFileSync, readdirSync, existsSync, statSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve, sep, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { serve, spawn, which } from "./runtime.mjs";
import { NATIVE_TOOLS, handleNativeTool, runCommand, listTargets, getNativeLogs, screenshotNative } from "./native.mjs";
import { PROJECT_TOOL, projectContext } from "./project.mjs";
import { A11Y_TOOLS, parseAndroidA11y, parseIosA11y, crossCheck } from "./a11y.mjs";
import { BUILD_TOOL, runBuild } from "./build.mjs";
import { upgradeTreeSources, upgradeSource, isLocalNetwork } from "./symbolicate.mjs";
import { ASSERT_TOOL, runAssert } from "./assert.mjs";
import { SESSION_TOOLS, handleSessionTool, openSession, appendEvents, pruneSessions } from "./session.mjs";
import { VISUAL_TOOLS, writeBaseline, readBaseline, baselineTakenAt, decodePng, diffImages, explainDiff, changesSince } from "./visual.mjs";
import { FLOW_TOOLS, createRecorder, startRecording, stopRecording, recordAct, buildFlow, renderFlowText, renderFlowMcp } from "./flow.mjs";
import { readInstrumentation, explainEmptyNetwork, explainEmptyRegistry } from "./instrumentation.mjs";
import { createToolLog, recordToolCall, summarizeTools, readEmptiness } from "./tools.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Host project root (the hub is launched from the root: bun run devtools)
const PROJECT_ROOT = process.cwd();
/** Read once: it names the project every answer from this hub is about */
const PROJECT_NAME = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf-8"));
    return pkg.name ?? PROJECT_ROOT.split(sep).pop() ?? null;
  } catch {
    return PROJECT_ROOT.split(sep).pop() ?? null;
  }
})();

const DEFAULT_PORT = 8973;
/** Last port the automatic search will try before giving up */
const LAST_FALLBACK_PORT = 8982;

/**
 * An explicit --port is an instruction, not a preference.
 *
 * When the user names a port, a hub that quietly moves elsewhere is worse
 * than one that refuses to start: the app is configured for THAT port. The
 * two cases are therefore kept apart, and the port actually bound is
 * announced either way.
 */
const EXPLICIT_PORT = (() => {
  const index = process.argv.indexOf("--port");
  if (index === -1) return null;
  const raw = process.argv[index + 1];
  const value = Number(raw);
  if (Number.isInteger(value) && value > 0 && value < 65536) return value;
  /**
   * A malformed --port used to fall back to "no explicit port at all",
   * which turned an instruction into a preference: the hub took 8973, and
   * the automatic fallback with it, while the user believed they had
   * pinned a port and the app was configured for one. Refusing is the only
   * answer that cannot be misread.
   */
  console.error("");
  console.error(`  rn-devtools-hub: --port needs a number between 1 and 65535 (got ${raw === undefined ? "nothing" : `"${raw}"`}).`);
  console.error("  Omit --port to take 8973, or the next free port up to 8982.");
  console.error("");
  process.exit(1);
})();
const PORT = EXPLICIT_PORT ?? DEFAULT_PORT;
/** The port the hub really bound, which is what every answer must report */
let activePort = PORT;

/**
 * Where this project's hub is listening, for whoever comes looking.
 *
 * The stdio bridge, and anything else started from the project root, knew
 * exactly one port: the default. A hub that fell back to another one was
 * therefore invisible to its own bridge, which would start a SECOND hub,
 * on a third port, against the same project. A file in the project says
 * where the hub really is; `.rn-devtools/` is already gitignored and
 * already holds the sessions.
 *
 * The token is deliberately NOT written: it is the only thing protecting
 * the dashboard, and a file readable by every process on the machine is
 * not where it belongs.
 */
const DISCOVERY_DIR = join(PROJECT_ROOT, ".rn-devtools");
const DISCOVERY_FILE = join(DISCOVERY_DIR, "hub.json");

/** Signal 0 asks the OS whether a pid exists without touching it. EPERM
 * means it exists and belongs to someone else, which is still alive. */
const pidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
};

/** The hub already registered for this project, if it is still running */
const registeredHub = () => {
  try {
    const written = JSON.parse(readFileSync(DISCOVERY_FILE, "utf-8"));
    return written.pid !== process.pid && pidAlive(written.pid) ? written : null;
  } catch {
    return null; // no file, or a half-written one
  }
};

const writeDiscoveryFile = (port) => {
  /**
   * Two hubs on the SAME project: the second one used to take the file
   * over, and the stdio bridge then went to the hub the app is not
   * connected to. The device is attached to one process, not to a
   * directory, so the first hub keeps the registration until it exits.
   */
  const incumbent = registeredHub();
  if (incumbent) return { written: false, pid: incumbent.pid, port: incumbent.port };
  try {
    mkdirSync(DISCOVERY_DIR, { recursive: true });
    // Same self-ignoring marker the sessions use: the directory must never
    // reach a commit, with or without the project's cooperation
    const marker = join(DISCOVERY_DIR, ".gitignore");
    if (!existsSync(marker)) {
      writeFileSync(marker, "# Local devtools artifacts, never committed\n*\n");
    }
    writeFileSync(
      DISCOVERY_FILE,
      `${JSON.stringify({ port, pid: process.pid, project: PROJECT_NAME, startedAt: Date.now() }, null, 2)}\n`
    );
    return { written: true, pid: process.pid, port };
  } catch {
    // Discovery is a convenience: an unwritable project must not stop the hub
    return { written: false, pid: null, port: null };
  }
};

const removeDiscoveryFile = () => {
  try {
    const written = JSON.parse(readFileSync(DISCOVERY_FILE, "utf-8"));
    // Only remove our own: another hub may have taken the port since
    if (written.pid === process.pid) unlinkSync(DISCOVERY_FILE);
  } catch {
    // already gone, or never written
  }
};

process.on("exit", removeDiscoveryFile);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    removeDiscoveryFile();
    process.exit(0);
  });
}

const HISTORY_LIMIT_PER_DEVICE = 3000;
const MCP_PROTOCOL_VERSION = "2025-11-25";
const MCP_COMMAND_TIMEOUT_MS = 8000;
// Some device commands are structurally slower than reading a prop:
// mounting a preview under the app's providers, measuring a whole
// subtree, restoring a store. A single ceiling for every command caps
// the feature instead of protecting the hub, so the slow ones declare
// their own budget.
const COMMAND_TIMEOUT_MS = {
  "ui.tree": 20000,
  "ui.query": 15000,
  "ui.act": 15000,
  "preview.render": 30000,
  "preview.unmount": 10000,
  "state.get": 15000,
  "state.set": 15000,
  "context.runtime": 10000,
  "time.control": 10000,
  "network.mock": 10000,
};
const MAX_COMMAND_TIMEOUT_MS = 120000;
const HUB_TOKEN = process.env.RN_DEVTOOLS_TOKEN || crypto.randomUUID().replaceAll("-", "");

/** @type {Map<string, {ws: any, appName: string, deviceName: string, connectedAt: number, history: any[]}>} */
const devices = new Map();
/** @type {Set<any>} */
const dashboards = new Set();
/** @type {Map<string, {resolve: (value: any) => void, timer: ReturnType<typeof setTimeout>}>} */
const pendingMcpCommands = new Map();
/** Long-poll waiters for wait_for_event (agents waiting on a device event)
 * @type {Set<{deviceId: string, match: (event: any) => boolean, resolve: (event: any) => void, timer: ReturnType<typeof setTimeout>}>} */
const eventWaiters = new Set();

const notifyEventWaiters = (deviceId, events) => {
  for (const waiter of eventWaiters) {
    // deviceId null = any device (used by session_start, which waits
    // for the app it just launched to connect)
    if (waiter.deviceId !== null && waiter.deviceId !== deviceId) continue;
    const hit = events.find((event) => {
      try { return waiter.match(event); } catch { return false; }
    });
    if (hit) {
      clearTimeout(waiter.timer);
      eventWaiters.delete(waiter);
      waiter.resolve(hit);
    }
  }
};

let nextDeviceId = 1;

// One recorder per hub: an agent records one flow at a time, and a
// second concurrent recording would interleave two intents into one
// unusable script
const recorder = createRecorder();

// Re-read on every request: UI changes are visible with a simple
// browser refresh, without restarting the hub
const readDashboard = () => readFileSync(join(__dirname, "dashboard.html"), "utf-8");

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8" },
});

const mcpResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const mcpError = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const mcpText = (value, isError = false) => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

/** Bounded, in memory, wiped on restart: the interesting window is the
 * session an agent is driving right now */
const toolLog = createToolLog();

/**
 * What this answer bills the agent in context.
 *
 * An image counts its base64, which is the whole reason to measure: a
 * tool that succeeds every time and returns 200 KB is a product problem
 * that no success rate will ever show.
 */
const sizeOfResult = (result) => {
  try {
    if (result && typeof result === "object" && result.__mcpImage) {
      const { __mcpImage, ...rest } = result;
      return (__mcpImage.data?.length ?? 0) + JSON.stringify(rest).length;
    }
    return JSON.stringify(result ?? null)?.length ?? 0;
  } catch {
    return 0;
  }
};

const isLocalRequest = (request, bunServer) => {
  const address = bunServer.requestIP(request)?.address;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
};

const hasValidToken = (url) => url.searchParams.get("token") === HUB_TOKEN;

/**
 * Who may open the device WebSocket.
 *
 * WebSocket is not subject to CORS, so any page the developer happens to
 * visit while the hub runs can connect and announce itself as a device. It
 * then joins the device table, and an MCP call without an explicit
 * deviceId picks the first connected one. The consequence is not just fake
 * readings: `ui_act` is routed to it WITH its payload, so text the agent
 * types into a password field is delivered to the page.
 *
 * A browser always sends Origin. React Native does too on Android, but the
 * value it sends is derived from the hub's own URL (WebSocketModule
 * getDefaultOrigin), so it is a local-network origin. Refusing a non-local
 * Origin therefore blocks pages without touching real devices.
 *
 * Residual: a page served from localhost still passes. Blocking it would
 * break legitimate local dashboards, and a local page is a much narrower
 * threat than an arbitrary site.
 */
const allowDeviceUpgrade = (origin) => {
  if (!origin) return true; // native clients that send no Origin at all
  return isLocalNetwork(origin);
};

// ====================================================================
// DESIGN module: reads app.json + host project assets (icons, splash,
// fonts, sounds) for the dashboard's Design panel
// ====================================================================

const ASSET_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg",
  ".ttf", ".otf", ".woff", ".woff2",
  ".wav", ".mp3", ".m4a",
]);
const ASSET_CONTENT_TYPES = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".ttf": "font/ttf", ".otf": "font/otf", ".woff": "font/woff",
  ".woff2": "font/woff2", ".wav": "audio/wav", ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
};

const findFontFiles = (dir, base = dir, depth = 0, out = []) => {
  if (depth > 3 || !existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    try {
      if (statSync(full).isDirectory()) {
        findFontFiles(full, base, depth + 1, out);
      } else if ([".ttf", ".otf"].includes(extname(entry).toLowerCase())) {
        out.push(full.slice(PROJECT_ROOT.length + 1));
      }
    } catch { /* unreadable file */ }
  }
  return out;
};

const designManifest = () => {
  let expo = {};
  try {
    expo = JSON.parse(readFileSync(join(PROJECT_ROOT, "app.json"), "utf-8")).expo ?? {};
  } catch { /* no app.json: partial manifest */ }

  const plugins = Array.isArray(expo.plugins) ? expo.plugins : [];
  const pluginConfig = (name) => {
    const found = plugins.find((p) => (Array.isArray(p) ? p[0] : p) === name);
    return Array.isArray(found) ? (found[1] ?? {}) : found ? {} : null;
  };

  const splash = expo.splash ?? pluginConfig("expo-splash-screen") ?? null;
  const notifications = pluginConfig("expo-notifications");

  return {
    // The manifest always comes from the hub's launch folder: the
    // dashboard uses these fields to flag a mismatch with the selected
    // device when several projects share the same hub
    projectDir: PROJECT_ROOT,
    projectName: PROJECT_ROOT.split(sep).pop() ?? null,
    name: expo.name ?? null,
    slug: expo.slug ?? null,
    version: expo.version ?? null,
    scheme: expo.scheme ?? null,
    orientation: expo.orientation ?? null,
    userInterfaceStyle: expo.userInterfaceStyle ?? null,
    ios: {
      bundleIdentifier: expo.ios?.bundleIdentifier ?? null,
      appStoreUrl: expo.ios?.appStoreUrl ?? null,
    },
    android: {
      package: expo.android?.package ?? null,
      playStoreUrl: expo.android?.playStoreUrl ?? null,
      adaptiveIcon: expo.android?.adaptiveIcon ?? null,
    },
    icon: expo.icon ?? null,
    notificationIcon: notifications?.icon ?? null,
    splash,
    notificationSounds: notifications?.sounds ?? [],
    fonts: findFontFiles(join(PROJECT_ROOT, "assets", "fonts")),
    runtimeVersion: expo.runtimeVersion ?? null,
    updatesUrl: expo.updates?.url ?? null,
  };
};

const serveProjectAsset = (relativePath) => {
  const cleaned = String(relativePath ?? "").replace(/^\.?\//, "");
  const full = resolve(PROJECT_ROOT, cleaned);
  // Strict confinement to the project root + extension whitelist
  if (!full.startsWith(PROJECT_ROOT + sep)) return new Response("Forbidden", { status: 403 });
  const ext = extname(full).toLowerCase();
  if (!ASSET_EXTENSIONS.has(ext)) return new Response("Type not allowed", { status: 403 });
  if (!existsSync(full)) return new Response("Not found", { status: 404 });
  return new Response(readFileSync(full), {
    headers: { "Content-Type": ASSET_CONTENT_TYPES[ext] ?? "application/octet-stream" },
  });
};

// ====================================================================
// MIRROR module: screenshots of Android devices (adb) and iOS
// simulators (xcrun simctl) + Android touch injection.
// No dependency in the app: everything happens on the hub side.
// ====================================================================

const SAFE_ID = /^[A-Za-z0-9._:-]+$/;
const KEYEVENTS = {
  back: "4", home: "3", menu: "82", power: "26",
  volume_up: "24", volume_down: "25",
  recents: "187", enter: "66", delete: "67", tab: "61", escape: "111",
};

/**
 * Why there is nothing to mirror.
 *
 * The old hint only fired when BOTH binaries were missing, so the common
 * case said nothing at all: a phone connected over the network, in Expo Go,
 * with adb installed but no cable. The panel stayed empty and silent, and
 * there was no way to learn that a device can be attached to the hub and
 * still be unmirrorable.
 */
const mirrorHint = (sources, adbPath, simctlAvailable) => {
  if (sources.length) return null;
  if (!adbPath && !simctlAvailable) {
    return "Install adb (Android) or the Xcode command line tools (iOS simulator) to enable the mirror.";
  }
  const connected = Array.from(devices.values()).filter((d) => d.ws.readyState === 1);
  if (!connected.length) return "No device is attached to this machine, and none is connected to the hub.";
  const names = connected.map((d) => d.deviceName).join(", ");
  return (
    `${names} reached the hub over the network, so its screen cannot be captured from here. ` +
    "Add react-native-view-shot to the app and it captures itself: `npx expo install " +
    "react-native-view-shot`, then reload. It is bundled into Expo Go, so no native build and no " +
    "cable are needed. Attaching the device with adb (a cable, or `adb connect` over Wi-Fi) also " +
    "works and additionally enables native taps."
  );
};

const listMirrorSources = async (quick = false) => {
  const sources = [];
  const adbPath = which("adb");
  const simctlAvailable = process.platform === "darwin" && !!which("xcrun");

  if (adbPath) {
    const result = await runCommand(["adb", "devices"]);
    const lines = new TextDecoder().decode(result.bytes).split("\n").slice(1);
    for (const line of lines) {
      const [serial, state] = line.trim().split(/\s+/);
      if (!serial || state !== "device" || !SAFE_ID.test(serial)) continue;
      // Screen resolution for touch injection
      // (quick mode: this step is skipped, used by the badge polling)
      let match = null;
      if (!quick) {
        const sizeResult = await runCommand(["adb", "-s", serial, "shell", "wm", "size"]);
        match = new TextDecoder().decode(sizeResult.bytes).match(/(\d+)x(\d+)/);
      }
      sources.push({
        id: `adb:${serial}`,
        label: `Android ${serial}`,
        kind: "android",
        controllable: true,
        width: match ? Number(match[1]) : null,
        height: match ? Number(match[2]) : null,
      });
    }
  }

  if (simctlAvailable) {
    const result = await runCommand(["xcrun", "simctl", "list", "devices", "booted", "-j"]);
    try {
      const parsed = JSON.parse(new TextDecoder().decode(result.bytes));
      for (const runtime of Object.values(parsed.devices ?? {})) {
        for (const sim of runtime) {
          if (sim.state === "Booted" && SAFE_ID.test(sim.udid)) {
            sources.push({
              id: `sim:${sim.udid}`,
              label: `iOS Simulator ${sim.name}`,
              kind: "ios-simulator",
              controllable: false,
              width: null,
              height: null,
            });
          }
        }
      }
    } catch { /* unreadable simctl output */ }
  }

  return {
    adbAvailable: !!adbPath,
    simctlAvailable,
    sources,
    hint: mirrorHint(sources, adbPath, simctlAvailable),
  };
};

const captureMirrorFrame = async (sourceId) => {
  const [kind, id] = String(sourceId ?? "").split(":");
  if (!id || !SAFE_ID.test(id)) return new Response("Invalid source", { status: 400 });

  const result = kind === "adb"
    ? await runCommand(["adb", "-s", id, "exec-out", "screencap", "-p"], 8000)
    : kind === "sim"
      ? await runCommand(["xcrun", "simctl", "io", id, "screenshot", "--type=png", "-"], 8000)
      : { ok: false, error: "Unknown source type" };

  if (!result.ok || result.bytes.length < 8) {
    return jsonResponse({ error: result.error || "Capture failed" }, 502);
  }
  return new Response(result.bytes, {
    headers: { "Content-Type": "image/png", "Cache-Control": "no-store" },
  });
};

const sendMirrorInput = async (body) => {
  const [kind, id] = String(body?.source ?? "").split(":");
  if (kind !== "adb" || !id || !SAFE_ID.test(id)) {
    return jsonResponse({ error: "Touch injection is only available on Android (adb)" }, 400);
  }
  if (body.type === "tap") {
    const x = Math.round(Number(body.x)), y = Math.round(Number(body.y));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return jsonResponse({ error: "Invalid coordinates" }, 400);
    const result = await runCommand(["adb", "-s", id, "shell", "input", "tap", String(x), String(y)]);
    return jsonResponse(result.ok ? { ok: true } : { error: result.error }, result.ok ? 200 : 502);
  }
  if (body.type === "swipe") {
    // Swipe: same device screen coordinates, plus a duration in ms.
    // Duration matters: a fast swipe produces inertia (fling), a slow one
    // performs a tracked drag.
    const coords = [body.x1, body.y1, body.x2, body.y2].map((value) => Math.round(Number(value)));
    if (coords.some((value) => !Number.isFinite(value))) {
      return jsonResponse({ error: "Invalid coordinates" }, 400);
    }
    const duration = Math.min(Math.max(Math.round(Number(body.durationMs) || 200), 20), 3000);
    const result = await runCommand([
      "adb", "-s", id, "shell", "input", "swipe",
      ...coords.map(String), String(duration),
    ]);
    return jsonResponse(result.ok ? { ok: true } : { error: result.error }, result.ok ? 200 : 502);
  }
  if (body.type === "text") {
    // Keyboard input: adb expects spaces escaped as %s
    const text = String(body.text ?? "");
    if (!text || text.length > 500) return jsonResponse({ error: "Invalid text" }, 400);
    const result = await runCommand([
      "adb", "-s", id, "shell", "input", "text", text.replace(/ /g, "%s"),
    ]);
    return jsonResponse(result.ok ? { ok: true } : { error: result.error }, result.ok ? 200 : 502);
  }
  if (body.type === "key") {
    const code = KEYEVENTS[String(body.key)];
    if (!code) return jsonResponse({ error: `Unknown key: ${body.key}` }, 400);
    const result = await runCommand(["adb", "-s", id, "shell", "input", "keyevent", code]);
    return jsonResponse(result.ok ? { ok: true } : { error: result.error }, result.ok ? 200 : 502);
  }
  return jsonResponse({ error: "Unknown input type" }, 400);
};

const deviceSummary = ([id, device]) => ({
  id,
  appName: device.appName,
  deviceName: device.deviceName,
  connected: device.ws.readyState === 1,
  sessions: device.sessions ?? 1,
  eventCount: device.history.length,
  cursor: device.lastSeq ?? 0,
});

const eventsOfType = (device, types, limit = 100) => device.history
  .filter((event) => types.includes(event.type))
  .slice(-Math.max(1, Math.min(Number(limit) || 100, 1000)));

const commandTimeout = (command, override) => {
  const requested = Number(override);
  if (Number.isFinite(requested) && requested > 0) {
    return Math.min(requested, MAX_COMMAND_TIMEOUT_MS);
  }
  return COMMAND_TIMEOUT_MS[command] ?? MCP_COMMAND_TIMEOUT_MS;
};

const sendDeviceCommand = (deviceId, command, payload, timeoutOverride) => new Promise((resolve) => {
  const device = devices.get(deviceId);
  if (!device || device.ws.readyState !== 1) {
    resolve({ error: "Device not connected" });
    return;
  }
  const requestId = `mcp-${crypto.randomUUID()}`;
  const budget = commandTimeout(command, timeoutOverride);
  const timer = setTimeout(() => {
    pendingMcpCommands.delete(requestId);
    resolve({ error: `Timed out after ${budget} ms` });
  }, budget);
  pendingMcpCommands.set(requestId, { resolve, timer });
  device.ws.send(JSON.stringify({ type: "command", command, requestId, payload }));
});

const MCP_TOOLS = [
  {
    name: "list_devices",
    description: "Lists the React Native devices known to the hub and their connection state.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_app_info",
    description: "Returns app, device, OS, development mode and network connection information.",
    inputSchema: { type: "object", properties: { deviceId: { type: "string" } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_recent_network",
    description: "Returns the recent network events captured by the hub, as {count, events}. When nothing was captured it also returns capture{instrumented, note}, which states whether anything is watching the network at all: an app that never called wrapFetch answers zero forever, and that is not the same fact as an app that sent no request.",
    inputSchema: { type: "object", properties: { deviceId: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 1000 } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_crashes",
    description: "Returns recent crashes and unhandled errors.",
    inputSchema: { type: "object", properties: { deviceId: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 1000 } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_endpoint_stats",
    description: "Computes calls, errors and p50/p95 latencies per endpoint from the captured requests. With nothing captured it returns {endpoints: [], capture} instead, where capture says whether the network is instrumented at all.",
    inputSchema: { type: "object", properties: { deviceId: { type: "string" } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "query_sqlite",
    description: "Runs a SQLite SELECT or PRAGMA query on the connected device.",
    inputSchema: { type: "object", required: ["sql"], properties: { deviceId: { type: "string" }, sql: { type: "string" } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "run_action",
    description: "Runs an action declared by the app with optional typed args (e.g. nav:packageDetail {id}). Discover actions and their schemas with list_actions. Dangerous actions must be confirmed in the MCP client.",
    inputSchema: { type: "object", required: ["name"], properties: { deviceId: { type: "string" }, name: { type: "string" }, args: { type: "object" } }, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: "list_actions",
    description: "Lists the dev actions the app registered (name, label, description, argsSchema, danger). Conventions: nav:* navigate directly to a screen, auth:* instant sessions, seed:* fixtures, reset:* deterministic state.",
    inputSchema: { type: "object", properties: { deviceId: { type: "string" } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_ui_tree",
    description: "Returns the semantic tree of the VISIBLE components (types, testID, text, inputs), read from the React runtime. Every node carries source {file, line, column, componentName, via} when React still knows where it was written, so editing does not start with a repo-wide grep; via states how the location was resolved and via:\"stack\" means bundle coordinates, not source ones. Screens kept mounted but hidden by the navigator (previous stack cards, inactive tabs) are excluded unless includeHidden. The app must call devtools.attachUiAutomation().",
    inputSchema: { type: "object", properties: { deviceId: { type: "string" }, maxDepth: { type: "integer", minimum: 1, maximum: 200 }, maxNodes: { type: "integer", minimum: 10, maximum: 10000 }, includeHidden: { type: "boolean" }, includeSource: { type: "boolean", description: "Attach the source location to every node (default true); set false to shrink the payload" }, metroUrl: { type: "string", description: "Metro server used to map bundle positions back to source (default: read from the stack, else http://localhost:8081)" } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "query_ui",
    description: "Finds VISIBLE on-screen elements by testID, text, accessibility label, placeholder, type, or role plus accessible name (preferred, Testing Library style). placeholder is the one that reaches an ordinary form field: a TextInput with no testID and no accessibilityLabel is the norm, and selecting it by position is exactly the fragile path. Scope with within to disambiguate. Returns text, the current value of an input, props, measured rect (points) and the source location of each match {file, line, column, componentName, via}. Retries while nothing matches (timeoutMs, default 1000) so a screen transition is not mistaken for a regression. An empty answer carries absence{reason, exposedBy, present, note}: it distinguishes an app that exposes no role or testID at all (every such query will answer zero) from a value that is genuinely not on screen, and lists what IS exposed to select on instead. truncated says the search stopped at limit rather than at the last match, so count is not read as a total. Hidden navigator screens are skipped unless includeHidden.",
    inputSchema: { type: "object", required: ["by", "value"], properties: { deviceId: { type: "string" }, timeoutMs: { type: "integer", minimum: 0, maximum: 30000, description: "Retry while nothing matches, up to this deadline (default 1000). A UI is asynchronous and an empty answer during a transition reads like a regression. Pass 0 for a single immediate look." }, by: { type: "string", enum: ["testID", "text", "label", "placeholder", "type", "role"] }, value: { type: "string" }, name: { type: "string" }, exact: { type: "boolean" }, within: { type: "object", properties: { by: { type: "string", enum: ["testID", "text", "label", "placeholder", "type", "role"] }, value: { type: "string" }, name: { type: "string" } }, required: ["by", "value"], additionalProperties: false }, limit: { type: "integer", minimum: 1, maximum: 50 }, includeHidden: { type: "boolean" } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "ui_act",
    description: "Acts on a VISIBLE element through the JS runtime: tap, longPress, type (exact text, no autocapitalize), clear, submit, scrollTo, scrollToEnd, scrollBy (dx/dy in points, relative to the current offset), focus and blur. focus opens the keyboard, which is what makes anything depending on it (KeyboardAvoidingView, insets) verifiable without touching the device. Target by testID, text, label, placeholder, type or role plus name; scope with within. placeholder is how a form field with no testID is reached without counting positions. When several elements match, the result lists the candidates with rects so you can pass index; an index beyond the last match is REFUSED (ok:false, reason:\"index-out-of-range\") instead of falling back to the last element, because acting on another element and reporting success is the one failure an automation tool must never produce. A typed value that does not come back is reported the same way (reason:\"value-unchanged\"), and verified/note say whether the text truly reached the field. Hidden navigator screens are skipped unless includeHidden.",
    inputSchema: { type: "object", required: ["action", "by", "value"], properties: { deviceId: { type: "string" }, action: { type: "string", enum: ["tap", "longPress", "type", "clear", "submit", "scrollTo", "scrollToEnd", "scrollBy", "focus", "blur"] }, by: { type: "string", enum: ["testID", "text", "label", "placeholder", "type", "role"] }, value: { type: "string" }, name: { type: "string" }, text: { type: "string" }, clear: { type: "boolean" }, index: { type: "integer", minimum: 0 }, x: { type: "number" }, y: { type: "number" }, dx: { type: "number", description: "action:scrollBy, horizontal distance in points from the current offset" }, dy: { type: "number", description: "action:scrollBy, vertical distance in points from the current offset (positive scrolls down)" }, within: { type: "object", properties: { by: { type: "string", enum: ["testID", "text", "label", "placeholder", "type", "role"] }, value: { type: "string" }, name: { type: "string" } }, required: ["by", "value"], additionalProperties: false }, includeHidden: { type: "boolean" } }, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: "get_events_since",
    description: "Returns device events after a cursor (monotonic seq). Poll with the returned cursor to follow network, console, crash, nav, screen.ready and ui.change without missing anything. Omit cursor for the most recent events.",
    inputSchema: { type: "object", properties: { deviceId: { type: "string" }, cursor: { type: "integer", minimum: 0 }, types: { type: "array", items: { type: "string" } }, limit: { type: "integer", minimum: 1, maximum: 1000 } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "wait_for_event",
    description: "Blocks until the device emits a matching event, or until timeoutMs. type is a substring of the event type (e.g. 'screen.ready', 'network.'), payloadContains a substring of the JSON payload. Replaces sleeps after a reload, a tap or a request.",
    inputSchema: { type: "object", properties: { deviceId: { type: "string" }, type: { type: "string" }, payloadContains: { type: "string" }, timeoutMs: { type: "integer", minimum: 500, maximum: 120000 } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  PROJECT_TOOL,
  ASSERT_TOOL,
  ...SESSION_TOOLS,
  ...FLOW_TOOLS,
  ...VISUAL_TOOLS,
  ...A11Y_TOOLS,
  BUILD_TOOL,
  {
    name: "set_overlay",
    description: "Shows or hides the expo-dev-menu floating button, immediately and without relaunching the app. That bubble lives in its own window above everything the app renders, so no UI tree can show it and it swallows the taps meant for whatever is underneath, the button in the top corner of the iOS photo picker being the usual casualty. Hide it before driving a native modal, put it back afterwards. Runtime switch on iOS, Expo Go included; on Android use the EXDevMenuShowFloatingActionButton manifest meta-data, or launch_app hideDevMenuFab on a dev build.",
    inputSchema: { type: "object", required: ["visible"], properties: { deviceId: { type: "string" }, visible: { type: "boolean" } }, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "get_overlay",
    description: "Says whether the expo-dev-menu floating button is currently shown, and returns the dev-menu preferences behind it.",
    inputSchema: { type: "object", properties: { deviceId: { type: "string" } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "list_previews",
    description: "Lists the components the app registered with devtools.registerPreview, and whether the preview outlet is mounted.",
    inputSchema: { type: "object", properties: { deviceId: { type: "string" } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "render_component",
    description: "Mounts a registered component INSIDE the running app, under its real providers, session and cache: nothing to mock, unlike an isolated preview. Returns the measured rect and the rendered subtree. Verifying a component no longer means navigating to the screen that contains it.",
    inputSchema: { type: "object", required: ["name"], properties: { deviceId: { type: "string" }, name: { type: "string" }, props: { type: "object" } }, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "unmount_component",
    description: "Clears the preview outlet and gives the screen back to the app.",
    inputSchema: { type: "object", properties: { deviceId: { type: "string" } }, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "freeze_time",
    description: "Freezes the app's JS clock at an ISO instant (or now), so relative dates and time-dependent rendering stop drifting between runs. Deterministic at the JS level only: Date, new Date() and Date.now(). Native animations and Reanimated read native clocks and are unaffected.",
    inputSchema: { type: "object", properties: { deviceId: { type: "string" }, iso: { type: "string" } }, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "advance_time",
    description: "Moves the frozen clock forward by ms. It moves the clock, it does NOT fire pending timers: driving the scheduler would mean replacing setTimeout under a running app.",
    inputSchema: { type: "object", required: ["ms"], properties: { deviceId: { type: "string" }, ms: { type: "integer" } }, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "restore_time",
    description: "Gives the app its real clock back.",
    inputSchema: { type: "object", properties: { deviceId: { type: "string" } }, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "mock_network",
    description: "Controls the requests going through the instrumented fetch: rules to stub a status and a body, or a condition among normal, offline, 3g and flaky. Failures are spaced deterministically rather than randomly, so a flaky profile stays reproducible. Mocked responses are flagged on the bus so an agent never mistakes a fixture for the backend. Only covers wrapFetch; an axios instance keeps its own adapter.",
    inputSchema: { type: "object", properties: { deviceId: { type: "string" }, action: { type: "string", enum: ["rules", "condition", "reset", "state"] }, rules: { type: "array", items: { type: "object", properties: { urlContains: { type: "string" }, method: { type: "string" }, status: { type: "integer" }, body: {}, delayMs: { type: "integer" }, fail: { type: "string" } }, additionalProperties: false } }, condition: { type: "string", enum: ["normal", "offline", "3g", "flaky"] } }, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: "get_state",
    description: "Reads a store the app registered with devtools.registerStore (Zustand, Redux, React Query or a custom adapter). Omit store to list what is available. path drills in with dots; for React Query it is the JSON query key.",
    inputSchema: { type: "object", properties: { deviceId: { type: "string" }, store: { type: "string" }, path: { type: "string" } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "set_state",
    description: "Writes a store (the store name may be given as \"store\" or \"name\", the payload as \"value\" or \"patch\"), putting the app into an exact state without walking through ten screens. Only possible from inside the runtime, and what makes a recorded flow hermetic: start from an injected session instead of replaying a login. Redux is written by dispatching an action, React Query by query key.",
    inputSchema: { type: "object", required: ["store"], properties: { deviceId: { type: "string" }, store: { type: "string" }, path: { type: "string" }, value: {} }, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
];

// Waits for an event from ANY device: session_start launches the app
// and needs its first hello/app.info without knowing its deviceId yet
const waitForAnyDeviceEvent = ({ type, timeoutMs }) => new Promise((resolve) => {
  const waiter = {
    deviceId: null,
    match: (event) => String(event.type).includes(String(type)),
    resolve: (event) => resolve({ timedOut: false, event }),
    timer: setTimeout(() => {
      eventWaiters.delete(waiter);
      resolve({ timedOut: true, event: null });
    }, timeoutMs),
  };
  eventWaiters.add(waiter);
});

/**
 * Which device a tool acts on.
 *
 * Silently taking the first connected one is wrong as soon as two are
 * attached, which happens the moment a simulator and an Expo Go session
 * are both up: the agent's taps land on whichever registered first, and
 * nothing says so. Ambiguity is refused with the list instead, the same
 * way ui_act refuses an ambiguous selector.
 */
const pickDevice = (deviceId) => {
  if (deviceId) return [String(deviceId), devices.get(String(deviceId))];
  const connected = Array.from(devices.entries()).filter(([, d]) => d.ws.readyState === 1);
  if (connected.length > 1) {
    const list = connected
      .map(([id, d]) => `${id} (${d.appName} on ${d.deviceName})`)
      .join(", ");
    throw new Error(
      `${connected.length} devices are connected, so the target is ambiguous: pass deviceId. Connected: ${list}`
    );
  }
  return connected[0] ?? Array.from(devices.entries())[0] ?? [];
};

/** Bus position at the time of a tool call, for the Tools timeline. Never
 * throws: an ambiguous or absent device must not break the call it is
 * only annotating. */
const cursorFor = (deviceId) => {
  try {
    return pickDevice(deviceId)[1]?.lastSeq ?? null;
  } catch {
    return null;
  }
};

/** Android exposes uiautomator; iOS needs AXe, and its absence is
 * reported rather than silently returning an empty tree */
const captureAccessibilityTree = async (target) => {
  const { targets } = await listTargets();
  const chosen = target ?? targets.find((entry) => entry.state === "ready")?.target;
  if (!chosen) throw new Error("No booted target: pass target from list_targets");
  const [kind, id] = String(chosen).split(":");

  if (kind === "adb") {
    const dumped = await runCommand(["adb", "-s", id, "exec-out", "uiautomator", "dump", "/dev/tty"], 20000);
    const xml = new TextDecoder().decode(dumped.bytes);
    if (!xml.includes("<node")) {
      throw new Error(`uiautomator returned no tree: ${dumped.error || "unknown error"}`);
    }
    return { platform: "android", via: "uiautomator", nodes: parseAndroidA11y(xml) };
  }
  if (!which("axe")) {
    throw new Error(
      "Reading the iOS accessibility tree needs AXe (brew install cameroncooke/axe/axe). On Android it works out of the box through uiautomator."
    );
  }
  const described = await runCommand(["axe", "describe-ui", "--udid", id], 30000);
  if (!described.ok) throw new Error(`axe describe-ui failed: ${described.error}`);
  return { platform: "ios", via: "axe", nodes: parseIosA11y(new TextDecoder().decode(described.bytes)) };
};

const handleMcpTool = async (name, args = {}) => {
  if (name === "list_devices") {
    // An agent talking to a port has no other way to learn which project
    // this hub serves. With several apps on several ports, that is the
    // difference between reading the right project and another one.
    return {
      project: { name: PROJECT_NAME, directory: PROJECT_ROOT, port: activePort },
      devices: Array.from(devices.entries()).map(deviceSummary),
    };
  }
  // Host-side native tools (simctl/adb): no connected JS device needed
  if (NATIVE_TOOLS.some((tool) => tool.name === name)) {
    return handleNativeTool(name, args, { waitForEvent: waitForAnyDeviceEvent });
  }
  if (SESSION_TOOLS.some((tool) => tool.name === name)) {
    return handleSessionTool(name, args, PROJECT_ROOT);
  }
  if (name === "get_accessibility_tree" || name === "audit_accessibility") {
    const nodes = await captureAccessibilityTree(args.target);
    if (name === "get_accessibility_tree") return nodes;
    const [a11yDeviceId, a11yDevice] = pickDevice(args.deviceId);
    if (!a11yDevice) throw new Error("audit_accessibility needs a connected app to read the React tree");
    const tree = await sendDeviceCommand(a11yDeviceId, "ui.tree", { maxNodes: 1500 });
    if (tree.error) throw new Error(tree.error);
    const reactNodes = (tree.result?.roots ?? []).flat();
    return { ...crossCheck(reactNodes, nodes.nodes), platform: nodes.platform, via: nodes.via };
  }
  if (name === "build_app") {
    const [buildDeviceId, buildDevice] = pickDevice(args.deviceId);
    return runBuild(args, {
      spawn: (argv) => spawn(argv, { cwd: PROJECT_ROOT, stdout: "pipe", stderr: "pipe" }),
      // Build events join the device's own stream: that shared clock is
      // the entire reason for delegating the build from here
      emit: (type, payload) => {
        const event = { id: 0, type, ts: Date.now(), payload };
        if (buildDevice) {
          event.seq = ++buildDevice.lastSeq;
          buildDevice.history.push(event);
          appendEvents(buildDevice.sessionFile, [event]);
          notifyEventWaiters(buildDeviceId, [event]);
        }
        broadcastToDashboards({ kind: "events", deviceId: buildDeviceId ?? null, events: [event] });
      },
    });
  }
  if (name === "snapshot_baseline") {
    const shot = await screenshotNative({ target: args.target });
    const bytes = Buffer.from(shot.__mcpImage.data, "base64");
    const decoded = decodePng(bytes);
    const file = writeBaseline(PROJECT_ROOT, args.name, bytes);
    return { ok: true, name: args.name, file, width: decoded.width, height: decoded.height };
  }
  if (name === "get_project_context") {
    // The declared half is always available; the runtime half needs a
    // device, and its absence is reported instead of failing the call
    const [contextDeviceId, contextDevice] = pickDevice(args.deviceId);
    let runtime = null;
    if (contextDevice && contextDevice.ws.readyState === 1) {
      const response = await sendDeviceCommand(contextDeviceId, "context.runtime", {});
      // appName comes from the hub's own registry, not from the runtime:
      // it is what the device announced when it connected
      if (!response.error) runtime = { ...(response.result ?? {}), appName: contextDevice.appName };
    }
    return projectContext(PROJECT_ROOT, runtime);
  }
  const [deviceId, device] = pickDevice(args.deviceId);
  if (!device) throw new Error("No device available");
  if (name === "get_app_info") {
    const info = eventsOfType(device, ["app.info", "net.info"], 100);
    return { device: deviceSummary([deviceId, device]), events: info };
  }
  if (name === "get_recent_network") {
    const events = eventsOfType(device, ["network.request", "network.response", "network.error"], args.limit);
    // An empty array is the answer an agent misreads: it looks like "the
    // app sent nothing" when it usually means "nothing was wrapped". The
    // device is only asked on that path, so a normal call stays one hop.
    if (events.length) return { count: events.length, events };
    const state = await readInstrumentation((command, payload) => sendDeviceCommand(deviceId, command, payload));
    return { count: 0, events, capture: explainEmptyNetwork(state) };
  }
  if (name === "get_crashes") return eventsOfType(device, ["crash"], args.limit);
  if (name === "get_endpoint_stats") {
    const requests = new Map();
    for (const event of eventsOfType(device, ["network.request", "network.response", "network.error"], 1000)) {
      const payload = event.payload ?? {};
      if (event.type === "network.request") {
        requests.set(payload.requestId, { method: payload.method, url: payload.url });
      } else {
        const request = requests.get(payload.requestId);
        if (request) Object.assign(request, {
          status: payload.status,
          durationMs: payload.durationMs,
          error: event.type === "network.error",
        });
      }
    }
    const groups = new Map();
    for (const request of requests.values()) {
      let path = request.url;
      try { path = new URL(request.url).pathname; } catch { /* relative URL */ }
      const key = `${request.method ?? "GET"} ${path}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(request);
    }
    const percentile = (values, ratio) => {
      if (!values.length) return null;
      const sorted = values.slice().sort((a, b) => a - b);
      return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
    };
    const stats = Array.from(groups.entries()).map(([endpoint, calls]) => {
      const durations = calls.map((call) => call.durationMs).filter(Number.isFinite);
      return {
        endpoint,
        calls: calls.length,
        errors: calls.filter((call) => call.error || call.status >= 400).length,
        p50Ms: percentile(durations, 0.5),
        p95Ms: percentile(durations, 0.95),
      };
    }).sort((a, b) => (b.p95Ms ?? 0) - (a.p95Ms ?? 0));
    if (stats.length) return stats;
    const state = await readInstrumentation((command, payload) => sendDeviceCommand(deviceId, command, payload));
    return { endpoints: [], capture: explainEmptyNetwork(state) };
  }
  if (name === "query_sqlite") {
    if (!/^\s*(select|pragma)\b/i.test(String(args.sql ?? ""))) throw new Error("Read-only: SELECT or PRAGMA only");
    const response = await sendDeviceCommand(deviceId, "sqlite.query", { sql: args.sql });
    if (response.error) throw new Error(response.error);
    return response.result;
  }
  if (name === "run_action") {
    const response = await sendDeviceCommand(deviceId, "action.run", { name: args.name, args: args.args });
    if (response.error) throw new Error(response.error);
    return response.result;
  }
  if (name === "list_actions") {
    const registrations = eventsOfType(device, ["actions.register"], 1000);
    const latest = registrations[registrations.length - 1];
    const actions = latest?.payload?.actions ?? [];
    if (actions.length) return { actions };
    const state = await readInstrumentation((command, payload) => sendDeviceCommand(deviceId, command, payload));
    return { actions, note: explainEmptyRegistry(state, "actions") };
  }
  if (name === "get_ui_tree" || name === "query_ui" || name === "ui_act") {
    const command = { get_ui_tree: "ui.tree", query_ui: "ui.query", ui_act: "ui.act" }[name];
    const { deviceId: _ignored, ...payload } = args;

    /**
     * A UI is asynchronous. query_ui answering "nothing matched" during a
     * screen transition reads exactly like a regression, and reporting one
     * that does not exist costs more than the wait. It now retries on an
     * empty result, like assert does; pass timeoutMs: 0 to opt out.
     */
    if (name === "query_ui") {
      const deadline = Date.now() + Math.min(Number(args.timeoutMs ?? 1000) || 0, 30000);
      for (;;) {
        const attempt = await sendDeviceCommand(deviceId, command, payload);
        if (attempt.error) throw new Error(attempt.error);
        if (attempt.result?.count > 0 || Date.now() >= deadline) {
          for (const match of attempt.result?.matches ?? []) {
            if (match.source) match.source = await upgradeSource(match.source, args.metroUrl ? { metroUrl: String(args.metroUrl) } : {});
          }
          return attempt.result;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    // The cursor is read BEFORE the action: everything after it is a
    // consequence of the action, which is the whole pairing rule
    const cursorBefore = device.lastSeq ?? 0;
    const response = await sendDeviceCommand(deviceId, command, payload);
    if (response.error) throw new Error(response.error);
    // React 19 dropped _debugSource, so the cascade lands on owner stacks,
    // which are BUNDLE positions. Only Metro can map them back to a file
    // and a line, so the upgrade happens here rather than shipping
    // coordinates no agent can use.
    const metro = args.metroUrl ? { metroUrl: String(args.metroUrl) } : {};
    if (name === "get_ui_tree" && Array.isArray(response.result?.roots)) {
      for (const root of response.result.roots) await upgradeTreeSources(root, metro);
    }
    if (name === "query_ui" && Array.isArray(response.result?.matches)) {
      for (const match of response.result.matches) {
        if (match.source) match.source = await upgradeSource(match.source, metro);
      }
    }
    if (name === "ui_act" && response.result) {
      /**
       * Every element ui_act names, not just the one the selector matched.
       *
       * `actedOn` is the element the action REALLY reached (the input
       * inside the container, the Pressable above the view), so it is the
       * location an agent goes to edit, and the candidate lists are what a
       * refusal is for. Upgrading only `target` shipped those as raw
       * bundle coordinates, which is the one thing symbolication exists to
       * prevent, and it was silent about it.
       */
      const described = [
        response.result.target,
        response.result.actedOn,
        ...(Array.isArray(response.result.candidates) ? response.result.candidates : []),
      ];
      for (const entry of described) {
        if (entry?.source) entry.source = await upgradeSource(entry.source, metro);
      }
    }
    if (name === "ui_act" && response.result?.ok) {
      recordAct(recorder, {
        action: payload.action,
        selector: { by: payload.by, value: payload.value, name: payload.name, within: payload.within },
        text: payload.text,
        // Without the index the replay runs the SAME selector on ANOTHER
        // element: a flow recorded on the third row of a list came back
        // as a flow on the first one, and nothing in the export said so
        index: payload.index,
        target: response.result.target,
        cursor: cursorBefore,
      });
    }
    return response.result;
  }
  if (name === "freeze_time" || name === "advance_time" || name === "restore_time") {
    const action = { freeze_time: "freeze", advance_time: "advance", restore_time: "restore" }[name];
    const response = await sendDeviceCommand(deviceId, "time.control", { action, iso: args.iso, ms: args.ms });
    if (response.error) throw new Error(response.error);
    return response.result;
  }
  if (name === "mock_network") {
    const { deviceId: _dropped, ...payload } = args;
    const response = await sendDeviceCommand(deviceId, "network.mock", payload);
    if (response.error) throw new Error(response.error);
    return response.result;
  }
  const DEVICE_COMMANDS = {
    list_previews: "preview.list",
    render_component: "preview.render",
    unmount_component: "preview.unmount",
    get_state: "state.get",
    set_state: "state.set",
    set_overlay: "overlay.set",
    get_overlay: "overlay.get",
  };
  if (DEVICE_COMMANDS[name]) {
    const { deviceId: _unused, ...payload } = args;
    const response = await sendDeviceCommand(deviceId, DEVICE_COMMANDS[name], payload);
    if (response.error) throw new Error(response.error);
    // Listing an empty registry: same trap as the network. "No store" and
    // "no registerStore call" read identically and mean opposite things.
    const registry = name === "get_state" ? "stores" : name === "list_previews" ? "previews" : null;
    if (registry && Array.isArray(response.result?.[registry]) && !response.result[registry].length) {
      const state = await readInstrumentation((command, load) => sendDeviceCommand(deviceId, command, load));
      const note = explainEmptyRegistry(state, registry);
      if (note) return { ...response.result, note };
    }
    return response.result;
  }
  if (name === "compare_snapshot") {
    const takenAt = baselineTakenAt(PROJECT_ROOT, args.name);
    const baseline = readBaseline(PROJECT_ROOT, args.name);
    const shot = await screenshotNative({ target: args.target });
    const current = decodePng(Buffer.from(shot.__mcpImage.data, "base64"));
    const diff = diffImages(baseline, current, { withImage: args.withImage === true });
    // The runtime measures in points while the screenshot is in device
    // pixels. Asking the runtime for its own viewport beats reading a
    // screen width the app may never have emitted: on a retina device a
    // missing scale sends the hit test to the wrong element entirely.
    const viewport = await sendDeviceCommand(deviceId, "ui.viewport", {});
    const explained = await explainDiff(diff, {
      maxRatio: args.maxRatio,
      screenWidthPoints: Number(viewport.result?.width) || null,
      changes: changesSince(device.history, takenAt ?? 0),
      hitTest: async (x, y) => {
        const response = await sendDeviceCommand(deviceId, "ui.at", { x, y });
        if (response.error) throw new Error(response.error);
        // Same upgrade as the tree: an owner named without a file turns
        // the explanation back into a guess
        const deepest = response.result?.deepest;
        if (deepest?.source) deepest.source = await upgradeSource(deepest.source, {});
        return response.result;
      },
    });
    if (args.withImage && diff.image) {
      return { __mcpImage: { data: diff.image.toString("base64"), mimeType: "image/png" }, ...explained };
    }
    return explained;
  }
  if (name === "start_recording") {
    return startRecording(recorder, { name: args.name, cursor: device.lastSeq ?? 0 });
  }
  if (name === "stop_recording") return stopRecording(recorder);
  if (name === "export_flow") {
    if (!recorder.acts.length) {
      throw new Error("Nothing recorded: call start_recording, drive the app with ui_act, then export");
    }
    const flow = buildFlow(recorder, device.history);
    if (args.format === "text") return renderFlowText(flow);
    if (args.format === "mcp") return { name: flow.name, clean: flow.clean, calls: renderFlowMcp(flow) };
    return flow;
  }
  if (name === "assert") {
    return runAssert(args, {
      history: () => device.history,
      queryUi: async (selector) => {
        const response = await sendDeviceCommand(deviceId, "ui.query", selector);
        if (response.error) throw new Error(response.error);
        return response.result;
      },
    });
  }
  if (name === "get_events_since") {
    const limit = Math.max(1, Math.min(Number(args.limit) || 200, 1000));
    const types = Array.isArray(args.types) && args.types.length ? args.types : null;
    let events = device.history;
    if (Number.isFinite(Number(args.cursor))) {
      const cursor = Number(args.cursor);
      events = events.filter((event) => (event.seq ?? 0) > cursor);
    }
    if (types) events = events.filter((event) => types.some((t) => event.type.includes(t)));
    events = events.slice(-limit);
    return { cursor: device.lastSeq ?? 0, count: events.length, events };
  }
  if (name === "wait_for_event") {
    const timeoutMs = Math.max(500, Math.min(Number(args.timeoutMs) || 30000, 120000));
    const typePattern = args.type ? String(args.type) : null;
    const payloadPattern = args.payloadContains ? String(args.payloadContains) : null;
    if (!typePattern && !payloadPattern) throw new Error("Pass at least type or payloadContains");
    const match = (event) => {
      if (typePattern && !String(event.type).includes(typePattern)) return false;
      if (payloadPattern) {
        try {
          if (!JSON.stringify(event.payload ?? "").includes(payloadPattern)) return false;
        } catch { return false; }
      }
      return true;
    };
    return await new Promise((resolve) => {
      const waiter = {
        deviceId,
        match,
        resolve: (event) => resolve({ timedOut: false, cursor: device.lastSeq ?? 0, event }),
        timer: setTimeout(() => {
          eventWaiters.delete(waiter);
          resolve({ timedOut: true, cursor: device.lastSeq ?? 0, event: null });
        }, timeoutMs),
      };
      eventWaiters.add(waiter);
    });
  }
  throw new Error(`Unknown MCP tool: ${name}`);
};

const handleMcpRequest = async (request, bunServer) => {
  if (!isLocalRequest(request, bunServer)) return jsonResponse(mcpError(null, -32000, "MCP is only reachable locally"), 403);
  const origin = request.headers.get("origin");
  if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) {
    return jsonResponse(mcpError(null, -32000, "Origin rejected"), 403);
  }
  if (request.method === "GET") {
    if (request.headers.get("accept")?.includes("text/html")) {
      return Response.redirect(new URL("/", request.url), 302);
    }
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  }
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "GET, POST" } });
  let message;
  try { message = await request.json(); } catch { return jsonResponse(mcpError(null, -32700, "Invalid JSON"), 400); }
  const { id, method, params } = message;
  if (method === "initialize") {
    // Which agent is driving: Claude Code, Codex, Cursor. The Tools panel
    // reads it, and it is the only place the client ever names itself.
    const client = params?.clientInfo?.name;
    if (typeof client === "string" && client) toolLog.clients.add(client.slice(0, 60));
    return jsonResponse(mcpResult(id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "rn-devtools-hub", version: "0.1.0" },
    }));
  }
  if (method === "notifications/initialized") return new Response(null, { status: 202 });
  if (method === "ping") return jsonResponse(mcpResult(id, {}));
  if (method === "tools/list") return jsonResponse(mcpResult(id, { tools: [...MCP_TOOLS, ...NATIVE_TOOLS] }));
  if (method === "tools/call") {
    const startedAt = Date.now();
    const args = params?.arguments ?? {};
    // Everything an agent does passes here, so this is the one place that
    // can measure the loop without asking anyone to instrument anything
    const finish = (outcome) => recordToolCall(toolLog, {
      name: params?.name,
      at: startedAt,
      durationMs: Date.now() - startedAt,
      client: [...toolLog.clients].slice(-1)[0] ?? null,
      selector: args.by ? { by: String(args.by), value: String(args.value ?? "") } : null,
      cursor: cursorFor(args.deviceId),
      ...outcome,
    });
    try {
      const result = await handleMcpTool(params?.name, args);
      /**
       * A tool that says ok:false has failed, and MCP has one field for
       * that. Returning it as a plain success made every declared refusal
       * invisible to a client that only reads isError: an ambiguous
       * selector, an index out of range, a typed value that never landed
       * and a failed assertion all arrived looking exactly like a result.
       * The payload is unchanged, only its status is now truthful, and
       * the telemetry counts it with the other failures instead of
       * inflating the success rate.
       */
      const declaredFailure =
        result && typeof result === "object" && !Array.isArray(result) && result.ok === false;
      if (declaredFailure) {
        finish({
          ok: false,
          error: String(result.reason ?? result.hint ?? "the tool reported ok:false"),
          bytes: sizeOfResult(result),
        });
      } else {
        const emptiness = readEmptiness(result);
        finish({ ok: true, bytes: sizeOfResult(result), empty: emptiness.empty, emptyReason: emptiness.reason });
      }
      if (result && typeof result === "object" && result.__mcpImage) {
        const { __mcpImage, ...rest } = result;
        return jsonResponse(mcpResult(id, {
          content: [
            { type: "image", data: __mcpImage.data, mimeType: __mcpImage.mimeType },
            { type: "text", text: JSON.stringify(rest) },
          ],
          ...(declaredFailure ? { isError: true } : {}),
        }));
      }
      return jsonResponse(mcpResult(id, mcpText(result, declaredFailure)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      finish({ ok: false, error: message, bytes: message.length });
      return jsonResponse(mcpResult(id, mcpText(message, true)));
    }
  }
  return jsonResponse(mcpError(id, -32601, `Unknown method: ${method}`), 404);
};

const broadcastToDashboards = (message) => {
  const raw = JSON.stringify(message);
  for (const ws of dashboards) {
    try {
      ws.send(raw);
    } catch {
      // dashboard gone
    }
  }
};

const deviceListPayload = () =>
  Array.from(devices.entries()).map(([id, device]) => ({
    id,
    appName: device.appName,
    deviceName: device.deviceName,
    connectedAt: device.connectedAt,
    connected: device.ws.readyState === 1,
    sessions: device.sessions ?? 1,
    eventCount: device.history.length,
  }));

const startServer = (port) => serve({
  port,
  allowUpgrade: allowDeviceUpgrade,
  // Bun kills idle requests after 10 s by default: wait_for_event
  // long-polls (up to 120 s) and native log dumps need much more
  idleTimeout: 240,
  async fetch(request, bunServer) {
    const url = new URL(request.url);
    if (url.pathname === "/mcp") return handleMcpRequest(request, bunServer);

    // Design, Mirror, Native, Project and Tools endpoints: protected by the hub token
    if (url.pathname.startsWith("/design/") || url.pathname.startsWith("/mirror/") || url.pathname.startsWith("/native/") || url.pathname.startsWith("/project/") || url.pathname.startsWith("/tools/")) {
      if (!hasValidToken(url)) return jsonResponse({ error: "Invalid token" }, 401);

      if (url.pathname === "/native/targets") return jsonResponse(await listTargets());
      if (url.pathname === "/native/logs") {
        try {
          return jsonResponse(await getNativeLogs({
            target: url.searchParams.get("target") || undefined,
            lines: url.searchParams.get("lines") || undefined,
            filter: url.searchParams.get("filter") || undefined,
            process: url.searchParams.get("process") || undefined,
            sinceMinutes: url.searchParams.get("sinceMinutes") || undefined,
          }));
        } catch (error) {
          return jsonResponse({ error: String(error?.message ?? error) }, 502);
        }
      }
      if (url.pathname === "/project/context") {
        // Same answer as the MCP tool. A stale native build is the most
        // common way to lose an afternoon here, and a developer opening
        // the dashboard will not think to ask an agent about it.
        const [contextDeviceId, contextDevice] = pickDevice(url.searchParams.get("deviceId"));
        let runtime = null;
        if (contextDevice && contextDevice.ws.readyState === 1) {
          const response = await sendDeviceCommand(contextDeviceId, "context.runtime", {});
          if (!response.error) runtime = response.result ?? null;
        }
        return jsonResponse(projectContext(PROJECT_ROOT, runtime));
      }
      if (url.pathname === "/design/manifest") return jsonResponse(designManifest());
      if (url.pathname === "/design/asset") return serveProjectAsset(url.searchParams.get("path"));
      if (url.pathname === "/tools/stats") return jsonResponse(summarizeTools(toolLog));
      if (url.pathname === "/mirror/sources") {
        return jsonResponse(await listMirrorSources(url.searchParams.get("quick") === "1"));
      }
      if (url.pathname === "/mirror/adb-pair" && request.method === "POST") {
        // "Wireless debugging" pairing (Android 11+): ip:port + code shown
        // on the phone under "Pair device with pairing code"
        try {
          const { host, code } = await request.json();
          if (!/^[A-Za-z0-9.:\[\]-]+$/.test(String(host ?? "")) || !/^\d{6}$/.test(String(code ?? ""))) {
            return jsonResponse({ error: "Invalid pairing address or code" }, 400);
          }
          const result = await runCommand(["adb", "pair", String(host), String(code)], 15000);
          const output = new TextDecoder().decode(result.bytes).trim();
          return jsonResponse({ ok: /successfully paired/i.test(output), output: output || result.error });
        } catch {
          return jsonResponse({ error: "Invalid JSON body" }, 400);
        }
      }
      if (url.pathname === "/mirror/adb-connect" && request.method === "POST") {
        // adb connection over Wi-Fi: the phone must have wireless
        // debugging enabled (or have run "adb tcpip 5555" over USB first)
        try {
          const { host } = await request.json();
          if (!/^[A-Za-z0-9.:\[\]-]+$/.test(String(host ?? ""))) {
            return jsonResponse({ error: "Invalid address" }, 400);
          }
          const result = await runCommand(["adb", "connect", String(host)], 10000);
          const output = new TextDecoder().decode(result.bytes).trim();
          return jsonResponse({ ok: /connected/i.test(output), output: output || result.error });
        } catch {
          return jsonResponse({ error: "Invalid JSON body" }, 400);
        }
      }
      if (url.pathname === "/mirror/frame") return captureMirrorFrame(url.searchParams.get("source"));
      if (url.pathname === "/mirror/input" && request.method === "POST") {
        try {
          return await sendMirrorInput(await request.json());
        } catch {
          return jsonResponse({ error: "Invalid JSON body" }, 400);
        }
      }
      return jsonResponse({ error: "Unknown route" }, 404);
    }

    // Upgrade WebSocket
    if (!allowDeviceUpgrade(request.headers.get("origin"))) {
      return new Response("Forbidden origin", { status: 403 });
    }
    if (bunServer.upgrade(request, { data: { role: null, deviceId: null } })) {
      return undefined;
    }
    // Static dashboard
    return new Response(readDashboard(), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  },

  websocket: {
    open() {
      // The role is determined by the first "hello" message
    },

    message(ws, raw) {
      let message;
      try {
        message = JSON.parse(String(raw));
      } catch {
        return;
      }

      // --- Handshake ---
      if (message.kind === "hello") {
        if (message.role === "device") {
          // Stable identifier: an app reload reconnects under the same
          // entry (no ghost sessions, history preserved)
          const deviceId = message.stableId
            ? `s-${message.stableId}`
            : `d${nextDeviceId++}`;
          ws.data.role = "device";
          ws.data.deviceId = deviceId;

          const existing = devices.get(deviceId);
          if (existing) {
            // Close the old socket if still open
            try { if (existing.ws !== ws) existing.ws.close(); } catch { /* already closed */ }
            existing.ws = ws;
            existing.appName = message.appName ?? existing.appName;
            existing.deviceName = message.deviceName ?? existing.deviceName;
            existing.connectedAt = Date.now();
            existing.sessions = (existing.sessions ?? 1) + 1;
            // A reload is a new run: give it its own session file so an
            // investigation reads one run rather than a merged blur
            const reopened = openSession(PROJECT_ROOT, deviceId, {
              appName: existing.appName,
              deviceName: existing.deviceName,
              startedAt: Date.now(),
              run: existing.sessions,
            });
            existing.sessionFile = reopened?.file ?? existing.sessionFile ?? null;
            existing.sessionId = reopened?.id ?? existing.sessionId ?? null;
            pruneSessions(PROJECT_ROOT);
            console.log(`[hub] device reconnected: ${existing.deviceName} (session ${existing.sessions})`);
          } else {
            const opened = openSession(PROJECT_ROOT, deviceId, {
              appName: message.appName ?? "app",
              deviceName: message.deviceName ?? "device",
              startedAt: Date.now(),
            });
            devices.set(deviceId, {
              ws,
              appName: message.appName ?? "app",
              deviceName: message.deviceName ?? "device",
              connectedAt: Date.now(),
              sessions: 1,
              history: [],
              lastSeq: 0,
              sessionFile: opened?.file ?? null,
              sessionId: opened?.id ?? null,
            });
            pruneSessions(PROJECT_ROOT);
            console.log(`[hub] device connected: ${message.deviceName} (${deviceId})`);
          }
          broadcastToDashboards({ kind: "devices", devices: deviceListPayload() });
        } else if (message.role === "dashboard") {
          if (message.token !== HUB_TOKEN) {
            ws.close(1008, "Invalid hub token");
            return;
          }
          ws.data.role = "dashboard";
          dashboards.add(ws);
          console.log("[hub] dashboard connected");
          // Initial snapshot: device list + history
          ws.send(JSON.stringify({ kind: "devices", devices: deviceListPayload() }));
          for (const [deviceId, device] of devices) {
            ws.send(
              JSON.stringify({ kind: "events", deviceId, events: device.history })
            );
          }
        }
        return;
      }

      // --- Events coming from a device ---
      if (message.kind === "events" && ws.data.role === "device") {
        const device = devices.get(ws.data.deviceId);
        if (!device) return;
        // Screen frames do not go into the history (too heavy):
        // they are broadcast live, only the most recent one is kept
        const frames = message.events.filter((e) => e.type === "screen.frame");
        const others = message.events.filter((e) => e.type !== "screen.frame");
        // Monotonic per-device cursor: lets agents poll with
        // get_events_since without missing or re-reading events
        device.lastSeq = device.lastSeq ?? 0;
        for (const event of others) event.seq = ++device.lastSeq;
        device.history.push(...others);
        // The in-memory history stays capped for the dashboard; the file
        // is what makes an investigation possible hours later
        appendEvents(device.sessionFile, others);
        notifyEventWaiters(ws.data.deviceId, others);
        if (frames.length) device.lastFrame = frames[frames.length - 1];
        if (device.history.length > HISTORY_LIMIT_PER_DEVICE) {
          device.history.splice(0, device.history.length - HISTORY_LIMIT_PER_DEVICE);
        }
        broadcastToDashboards({
          kind: "events",
          deviceId: ws.data.deviceId,
          events: message.events,
        });
        return;
      }

      // --- Command result coming from a device ---
      if (message.kind === "commandResult" && ws.data.role === "device") {
        const pendingMcp = pendingMcpCommands.get(message.requestId);
        if (pendingMcp) {
          clearTimeout(pendingMcp.timer);
          pendingMcpCommands.delete(message.requestId);
          pendingMcp.resolve({ result: message.result, error: message.error });
        }
        broadcastToDashboards({
          kind: "commandResult",
          deviceId: ws.data.deviceId,
          requestId: message.requestId,
          command: message.command,
          result: message.result,
          error: message.error,
        });
        return;
      }

      // --- Command from a dashboard to a device ---
      if (message.kind === "command" && ws.data.role === "dashboard") {
        const device = devices.get(message.deviceId);
        if (!device || device.ws.readyState !== 1) {
          ws.send(
            JSON.stringify({
              kind: "commandResult",
              deviceId: message.deviceId,
              requestId: message.requestId,
              command: message.command,
              error: "Device not connected",
            })
          );
          return;
        }
        device.ws.send(
          JSON.stringify({
            type: "command",
            command: message.command,
            requestId: message.requestId,
            payload: message.payload,
          })
        );
        return;
      }

      // --- History purge requested by a dashboard ---
      if (message.kind === "clearHistory" && ws.data.role === "dashboard") {
        for (const device of devices.values()) {
          device.history = [];
        }
        broadcastToDashboards({ kind: "historyCleared" });
      }
    },

    close(ws) {
      if (ws.data.role === "dashboard") {
        dashboards.delete(ws);
        console.log("[hub] dashboard disconnected");
      } else if (ws.data.role === "device" && ws.data.deviceId) {
        const device = devices.get(ws.data.deviceId);
        if (device) {
          console.log(`[hub] device disconnected: ${device.deviceName}`);
          // Keep the history but mark as disconnected
          broadcastToDashboards({ kind: "devices", devices: deviceListPayload() });
        }
      }
    },
  },
});

const isPortTaken = (error) => /in use|EADDRINUSE/i.test(String(error?.message ?? error));

/**
 * Binds a port, and says which one.
 *
 * With one hub per project (which the product asks for as soon as two apps
 * are open), the second one used to die on the default port and leave the
 * developer to pick another by hand. Trying the next few is the obvious
 * fix, and the dangerous one: a hub silently listening somewhere else is a
 * device that never connects and an agent that reports an app problem. So
 * the fallback exists, and it is announced loudly, with the line to copy.
 */
const listen = async () => {
  const candidates = EXPLICIT_PORT !== null
    ? [EXPLICIT_PORT]
    : Array.from({ length: LAST_FALLBACK_PORT - DEFAULT_PORT + 1 }, (_, step) => DEFAULT_PORT + step);

  for (const candidate of candidates) {
    try {
      return await startServer(candidate);
    } catch (error) {
      if (!isPortTaken(error)) throw error;
    }
  }

  console.error("");
  if (EXPLICIT_PORT !== null) {
    console.error(`  Port ${EXPLICIT_PORT} is already taken: another hub is probably running`);
    console.error("  (for example for another project).");
    console.error("");
    console.error("  It was asked for explicitly, so this hub will not move elsewhere:");
    console.error("  the app is configured for that port. Free it, or pick another:");
    console.error(`    npx rn-devtools-hub --port ${EXPLICIT_PORT + 1}`);
    console.error("  and point the app's serverUrl at that port.");
  } else {
    console.error(`  Ports ${DEFAULT_PORT} to ${LAST_FALLBACK_PORT} are all taken.`);
    console.error("");
    console.error("  Stop a hub you are no longer using, or name a free port:");
    console.error(`    npx rn-devtools-hub --port ${LAST_FALLBACK_PORT + 1}`);
  }
  console.error("");
  process.exit(1);
};

const server = await listen();
activePort = server.port ?? PORT;
const discovery = writeDiscoveryFile(activePort);

console.log("");
console.log("  rn-devtools-hub");
console.log("  ---------------");
if (!discovery.written && discovery.pid) {
  // Say which hub owns the project, because the stdio bridge follows the
  // file and an agent would otherwise drive the hub with no device on it
  console.log(`  Another hub for this project is already running (pid ${discovery.pid} on port ${discovery.port}).`);
  console.log("  It keeps .rn-devtools/hub.json, so `npx rn-devtools-hub mcp` keeps using it.");
  console.log("");
}
if (EXPLICIT_PORT === null && activePort !== DEFAULT_PORT) {
  // Loud on purpose: a hub on an unexpected port looks exactly like an app
  // that fails to connect, and the developer has no reason to suspect it
  console.log(`  Port ${DEFAULT_PORT} is taken, this hub is on ${activePort}`);
  console.log("  The app will not find it on the default port. Set this in the app,");
  console.log("  then restart Metro so it is inlined into the bundle:");
  console.log(`    EXPO_PUBLIC_RN_DEVTOOLS_PORT=${activePort}`);
  console.log(`  or point serverUrl at ws://<metro-ip>:${activePort} yourself.`);
  console.log("");
}
console.log(`  Dashboard : http://localhost:${activePort}/?token=${HUB_TOKEN}`);
console.log(`  WebSocket : ws://<local-ip>:${activePort}`);
console.log(`  Local MCP : http://127.0.0.1:${activePort}/mcp`);
console.log("");
console.log("  The app connects automatically via the Metro server IP.");
console.log("");
