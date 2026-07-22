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
 * Zero dependencies: uses Bun's native WebSocket server.
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve, sep, extname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Host project root (the hub is launched from the root: bun run devtools)
const PROJECT_ROOT = process.cwd();

const PORT = (() => {
  const index = process.argv.indexOf("--port");
  return index > -1 ? Number(process.argv[index + 1]) : 8973;
})();

const HISTORY_LIMIT_PER_DEVICE = 3000;
const MCP_PROTOCOL_VERSION = "2025-11-25";
const MCP_COMMAND_TIMEOUT_MS = 8000;
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
    if (waiter.deviceId !== deviceId) continue;
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

const isLocalRequest = (request, bunServer) => {
  const address = bunServer.requestIP(request)?.address;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
};

const hasValidToken = (url) => url.searchParams.get("token") === HUB_TOKEN;

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

const runCommand = async (argv, timeoutMs = 6000) => {
  try {
    const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
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

const listMirrorSources = async (quick = false) => {
  const sources = [];
  const adbPath = Bun.which("adb");
  const simctlAvailable = process.platform === "darwin" && !!Bun.which("xcrun");

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
    hint: !adbPath && !simctlAvailable
      ? "Install adb (Android) or the Xcode tools (iOS simulator) to enable the mirror"
      : null,
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

const sendDeviceCommand = (deviceId, command, payload) => new Promise((resolve) => {
  const device = devices.get(deviceId);
  if (!device || device.ws.readyState !== 1) {
    resolve({ error: "Device not connected" });
    return;
  }
  const requestId = `mcp-${crypto.randomUUID()}`;
  const timer = setTimeout(() => {
    pendingMcpCommands.delete(requestId);
    resolve({ error: "Timed out" });
  }, MCP_COMMAND_TIMEOUT_MS);
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
    description: "Returns the recent network events captured by the hub.",
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
    description: "Computes calls, errors and p50/p95 latencies per endpoint from the captured requests.",
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
    description: "Runs an action declared by the app, for example reload or cache invalidation. Dangerous actions must be confirmed in the MCP client.",
    inputSchema: { type: "object", required: ["name"], properties: { deviceId: { type: "string" }, name: { type: "string" } }, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: "get_ui_tree",
    description: "Returns the semantic tree of the components currently mounted (types, testID, text, inputs), read from the React runtime. The app must call devtools.attachUiAutomation().",
    inputSchema: { type: "object", properties: { deviceId: { type: "string" }, maxDepth: { type: "integer", minimum: 1, maximum: 200 }, maxNodes: { type: "integer", minimum: 10, maximum: 10000 } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "query_ui",
    description: "Finds on-screen elements by testID, text, accessibility label or type. Returns their text, props and measured rect (points).",
    inputSchema: { type: "object", required: ["by", "value"], properties: { deviceId: { type: "string" }, by: { type: "string", enum: ["testID", "text", "label", "type"] }, value: { type: "string" }, exact: { type: "boolean" }, limit: { type: "integer", minimum: 1, maximum: 50 } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "ui_act",
    description: "Acts on an element through the JS runtime: tap, longPress, type (exact text, no autocapitalize), clear, submit, scrollTo, scrollToEnd. Target by testID, text, label or type; pass index when several elements match.",
    inputSchema: { type: "object", required: ["action", "by", "value"], properties: { deviceId: { type: "string" }, action: { type: "string", enum: ["tap", "longPress", "type", "clear", "submit", "scrollTo", "scrollToEnd"] }, by: { type: "string", enum: ["testID", "text", "label", "type"] }, value: { type: "string" }, text: { type: "string" }, clear: { type: "boolean" }, index: { type: "integer", minimum: 0 }, x: { type: "number" }, y: { type: "number" } }, additionalProperties: false },
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
];

const handleMcpTool = async (name, args = {}) => {
  if (name === "list_devices") return Array.from(devices.entries()).map(deviceSummary);
  const entry = args.deviceId
    ? [String(args.deviceId), devices.get(String(args.deviceId))]
    : Array.from(devices.entries()).find(([, device]) => device.ws.readyState === 1) ?? Array.from(devices.entries())[0];
  const [deviceId, device] = entry ?? [];
  if (!device) throw new Error("No device available");
  if (name === "get_app_info") {
    const info = eventsOfType(device, ["app.info", "net.info"], 100);
    return { device: deviceSummary([deviceId, device]), events: info };
  }
  if (name === "get_recent_network") {
    return eventsOfType(device, ["network.request", "network.response", "network.error"], args.limit);
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
    return Array.from(groups.entries()).map(([endpoint, calls]) => {
      const durations = calls.map((call) => call.durationMs).filter(Number.isFinite);
      return {
        endpoint,
        calls: calls.length,
        errors: calls.filter((call) => call.error || call.status >= 400).length,
        p50Ms: percentile(durations, 0.5),
        p95Ms: percentile(durations, 0.95),
      };
    }).sort((a, b) => (b.p95Ms ?? 0) - (a.p95Ms ?? 0));
  }
  if (name === "query_sqlite") {
    if (!/^\s*(select|pragma)\b/i.test(String(args.sql ?? ""))) throw new Error("Read-only: SELECT or PRAGMA only");
    const response = await sendDeviceCommand(deviceId, "sqlite.query", { sql: args.sql });
    if (response.error) throw new Error(response.error);
    return response.result;
  }
  if (name === "run_action") {
    const response = await sendDeviceCommand(deviceId, "action.run", { name: args.name });
    if (response.error) throw new Error(response.error);
    return response.result;
  }
  if (name === "get_ui_tree" || name === "query_ui" || name === "ui_act") {
    const command = { get_ui_tree: "ui.tree", query_ui: "ui.query", ui_act: "ui.act" }[name];
    const { deviceId: _ignored, ...payload } = args;
    const response = await sendDeviceCommand(deviceId, command, payload);
    if (response.error) throw new Error(response.error);
    return response.result;
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
    return jsonResponse(mcpResult(id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "rn-devtools-hub", version: "0.1.0" },
    }));
  }
  if (method === "notifications/initialized") return new Response(null, { status: 202 });
  if (method === "ping") return jsonResponse(mcpResult(id, {}));
  if (method === "tools/list") return jsonResponse(mcpResult(id, { tools: MCP_TOOLS }));
  if (method === "tools/call") {
    try {
      const result = await handleMcpTool(params?.name, params?.arguments ?? {});
      return jsonResponse(mcpResult(id, mcpText(result)));
    } catch (error) {
      return jsonResponse(mcpResult(id, mcpText(error instanceof Error ? error.message : String(error), true)));
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

const startServer = () => Bun.serve({
  port: PORT,
  async fetch(request, bunServer) {
    const url = new URL(request.url);
    if (url.pathname === "/mcp") return handleMcpRequest(request, bunServer);

    // Design and Mirror endpoints: protected by the hub token
    if (url.pathname.startsWith("/design/") || url.pathname.startsWith("/mirror/")) {
      if (!hasValidToken(url)) return jsonResponse({ error: "Invalid token" }, 401);

      if (url.pathname === "/design/manifest") return jsonResponse(designManifest());
      if (url.pathname === "/design/asset") return serveProjectAsset(url.searchParams.get("path"));
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
            console.log(`[hub] device reconnected: ${existing.deviceName} (session ${existing.sessions})`);
          } else {
            devices.set(deviceId, {
              ws,
              appName: message.appName ?? "app",
              deviceName: message.deviceName ?? "device",
              connectedAt: Date.now(),
              sessions: 1,
              history: [],
              lastSeq: 0,
            });
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

let server;
try {
  server = startServer();
} catch (error) {
  if (/in use|EADDRINUSE/i.test(String(error))) {
    console.error("");
    console.error(`  Port ${PORT} is already taken: another hub is probably running`);
    console.error("  (for example for another project).");
    console.error("");
    console.error("  Launch this project's hub on its own port:");
    console.error(`    bun server/server.mjs --port ${PORT + 1}`);
    console.error("  and point the app's serverUrl at that port.");
    console.error("");
    process.exit(1);
  }
  throw error;
}

console.log("");
console.log("  rn-devtools-hub");
console.log("  ---------------");
console.log(`  Dashboard : http://localhost:${server.port}/?token=${HUB_TOKEN}`);
console.log(`  WebSocket : ws://<local-ip>:${server.port}`);
console.log(`  Local MCP : http://127.0.0.1:${server.port}/mcp`);
console.log("");
console.log("  The app connects automatically via the Metro server IP.");
console.log("");
