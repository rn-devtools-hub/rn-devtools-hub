/**
 * Session persistence and correlated export.
 *
 * The event bus was in memory and capped at 3000 events per device, so
 * anything older than the last few minutes was already gone by the time
 * an agent went looking for it. An export built on that is lossy by
 * construction, which is why persistence comes first here.
 *
 * The artifact is the point: network, logs, crashes, navigation and UI
 * changes on ONE timeline. An agent investigating a bug after the fact
 * never has to replay the scenario, and the output pastes into an issue
 * as it is.
 *
 * Storage is JSONL, one file per session, appended as batches arrive. No
 * database, no dependency, and a half-written file costs one truncated
 * line instead of the whole session.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SESSION_DIR = join(".rn-devtools", "sessions");
const DEFAULT_KEEP_SESSIONS = 20;
const MAX_EXPORT_EVENTS = 20000;
const SUMMARY_LIMIT = 20;

/** Events that would bloat the file without helping a post-hoc read */
const SKIPPED_TYPES = new Set(["screen.frame", "perf.sample"]);

export const sessionRoot = (projectRoot) => join(projectRoot, SESSION_DIR);

/**
 * Creates the directory and makes it ignore itself.
 *
 * The hub writes sessions and visual baselines into the HOST project. A
 * user who never runs `init`, or who upgraded into the feature, would
 * otherwise find them in `git status` and some would commit a folder of
 * JSONL and PNGs. Dropping a `.gitignore` containing `*` inside the
 * directory needs no cooperation from the project and cannot go stale.
 */
export const ensureArtifactDir = (path) => {
  try {
    mkdirSync(path, { recursive: true });
    const marker = join(path, "..", ".gitignore");
    if (!existsSync(marker)) {
      writeFileSync(marker, "# Local devtools artifacts, never committed\n*\n");
    }
    return true;
  } catch {
    return false;
  }
};

const ensureDir = ensureArtifactDir;

/** Filesystem-safe and sortable: the timestamp leads so a directory
 * listing is already in chronological order */
export const sessionIdFor = (deviceId, startedAt) =>
  `${new Date(startedAt).toISOString().replace(/[:.]/g, "-")}_${String(deviceId).replace(/[^A-Za-z0-9_-]/g, "")}`;

export const openSession = (projectRoot, deviceId, meta = {}) => {
  const root = sessionRoot(projectRoot);
  if (!ensureDir(root)) return null;
  const startedAt = meta.startedAt ?? Date.now();
  const id = sessionIdFor(deviceId, startedAt);
  const file = join(root, `${id}.jsonl`);
  const header = { kind: "meta", id, deviceId, startedAt, ...meta };
  try {
    appendFileSync(file, `${JSON.stringify(header)}\n`);
  } catch {
    return null;
  }
  return { id, file, startedAt };
};

export const appendEvents = (file, events) => {
  if (!file || !Array.isArray(events) || !events.length) return 0;
  const lines = events
    .filter((event) => !SKIPPED_TYPES.has(event?.type))
    .map((event) => JSON.stringify({ kind: "event", ...event }));
  if (!lines.length) return 0;
  try {
    appendFileSync(file, `${lines.join("\n")}\n`);
    return lines.length;
  } catch {
    // A full or read-only disk must never take the hub down
    return 0;
  }
};

export const listSessions = (projectRoot) => {
  const root = sessionRoot(projectRoot);
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => {
        const file = join(root, name);
        const stats = statSync(file);
        return { id: name.replace(/\.jsonl$/, ""), file, sizeBytes: stats.size, modifiedAt: stats.mtimeMs };
      })
      .sort((a, b) => b.modifiedAt - a.modifiedAt);
  } catch {
    return [];
  }
};

export const pruneSessions = (projectRoot, keep = DEFAULT_KEEP_SESSIONS) => {
  const sessions = listSessions(projectRoot);
  const doomed = sessions.slice(Math.max(0, keep));
  for (const session of doomed) {
    try {
      unlinkSync(session.file);
    } catch {
      // already gone
    }
  }
  return doomed.length;
};

/** A truncated last line is expected on a session still being written:
 * drop it rather than failing the whole read */
export const parseSessionFile = (raw) => {
  const meta = {};
  const events = [];
  for (const line of String(raw ?? "").split("\n")) {
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed.kind === "meta") Object.assign(meta, parsed);
    else if (parsed.kind === "event") events.push(parsed);
  }
  return { meta, events };
};

export const readSession = (projectRoot, sessionId) => {
  const file = join(sessionRoot(projectRoot), `${String(sessionId).replace(/[^A-Za-z0-9_.-]/g, "")}.jsonl`);
  if (!existsSync(file)) throw new Error(`Unknown session: ${sessionId}`);
  const { meta, events } = parseSessionFile(readFileSync(file, "utf-8"));
  return { meta, events: events.slice(-MAX_EXPORT_EVENTS) };
};

// ====================================================================
// Export: correlation, not a dump
// ====================================================================

const truncate = (value, max = 200) => {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return text && text.length > max ? `${text.slice(0, max)}…` : text;
};

/** One readable line per event: the timeline has to be scannable */
export const summarizeEvent = (event) => {
  const payload = event.payload ?? {};
  switch (event.type) {
    case "network.request":
      return `${payload.method ?? "GET"} ${truncate(payload.url, 120)}`;
    case "network.response":
      return `${payload.status ?? "?"} in ${payload.durationMs ?? "?"} ms (#${payload.requestId ?? "?"})`;
    case "network.error":
      return `failed (#${payload.requestId ?? "?"}): ${truncate(payload.message, 120)}`;
    case "console":
      return `${payload.level ?? "log"}: ${truncate(payload.args, 160)}`;
    case "crash":
      return `${payload.kind ?? "error"}: ${truncate(payload.message, 160)}`;
    case "screen.ready":
      return `screen ready: ${payload.screen ?? "?"}`;
    case "nav":
      return `navigate: ${truncate(payload.screen ?? payload.route, 80)}`;
    case "ui.change":
      return `ui generation ${payload.generation ?? "?"}`;
    case "app.info":
      return `${payload.appName ?? "app"} on ${payload.deviceName ?? "device"}`;
    default:
      return truncate(payload, 160);
  }
};

/**
 * Builds the artifact. Pure on purpose: the correlation logic is what
 * matters and it must be testable without touching a disk.
 */
export const buildSessionExport = (meta, events) => {
  const list = Array.isArray(events) ? events : [];
  const startedAt = meta?.startedAt ?? list[0]?.ts ?? null;
  const endedAt = list.length ? list[list.length - 1].ts : startedAt;
  // Truthiness would drop a session starting at 0 and, worse, silently
  // null every offset on it: the origin of a clock is a valid value
  const offset = (ts) =>
    startedAt === null || typeof ts !== "number" ? null : ts - startedAt;

  const requests = new Map();
  for (const event of list) {
    const payload = event.payload ?? {};
    if (event.type === "network.request") {
      requests.set(payload.requestId, { method: payload.method, url: payload.url, ts: event.ts, origin: payload.origin ?? null });
    } else if (event.type === "network.response" || event.type === "network.error") {
      const request = requests.get(payload.requestId);
      if (request) {
        request.status = payload.status ?? null;
        request.durationMs = payload.durationMs ?? null;
        request.failed = event.type === "network.error" || Number(payload.status) >= 400;
        request.message = payload.message ?? null;
      }
    }
  }
  const allRequests = [...requests.values()];
  const failedRequests = allRequests.filter((request) => request.failed);
  const crashes = list.filter((event) => event.type === "crash");
  const consoleErrors = list.filter(
    (event) => event.type === "console" && event.payload?.level === "error"
  );
  const screens = list
    .filter((event) => event.type === "screen.ready" || event.type === "nav")
    .map((event) => event.payload?.screen ?? event.payload?.route ?? null)
    .filter(Boolean);

  return {
    session: {
      id: meta?.id ?? null,
      deviceId: meta?.deviceId ?? null,
      appName: meta?.appName ?? null,
      deviceName: meta?.deviceName ?? null,
      startedAt,
      endedAt,
      durationMs: startedAt === null || endedAt === null ? null : endedAt - startedAt,
      eventCount: list.length,
    },
    summary: {
      requests: allRequests.length,
      failedRequests: failedRequests.length,
      crashes: crashes.length,
      consoleErrors: consoleErrors.length,
      screens: [...new Set(screens)],
    },
    // The three sections an investigation actually opens first
    crashes: crashes.slice(-SUMMARY_LIMIT).map((event) => ({
      t: offset(event.ts),
      seq: event.seq ?? null,
      kind: event.payload?.kind ?? null,
      message: event.payload?.message ?? null,
      stack: event.payload?.stack ?? null,
    })),
    failedRequests: failedRequests.slice(-SUMMARY_LIMIT).map((request) => ({
      t: offset(request.ts),
      method: request.method ?? null,
      url: request.url ?? null,
      status: request.status ?? null,
      durationMs: request.durationMs ?? null,
      message: request.message ?? null,
      origin: request.origin,
    })),
    consoleErrors: consoleErrors.slice(-SUMMARY_LIMIT).map((event) => ({
      t: offset(event.ts),
      args: event.payload?.args ?? null,
    })),
    // Everything, on one clock, relative to the session start
    timeline: list.map((event) => ({
      t: offset(event.ts),
      seq: event.seq ?? null,
      type: event.type,
      summary: summarizeEvent(event),
    })),
  };
};

const asSeconds = (ms) => (typeof ms === "number" ? `${(ms / 1000).toFixed(1)}s` : "?");

/** Markdown that pastes into an issue without editing */
export const renderSessionMarkdown = (exported) => {
  const { session, summary } = exported;
  const lines = [
    `# Session ${session.id ?? "(unnamed)"}`,
    "",
    `- App: ${session.appName ?? "?"} on ${session.deviceName ?? "?"}`,
    `- Duration: ${asSeconds(session.durationMs)}, ${session.eventCount} events`,
    `- Requests: ${summary.requests} (${summary.failedRequests} failed)`,
    `- Crashes: ${summary.crashes}, console errors: ${summary.consoleErrors}`,
    `- Screens: ${summary.screens.length ? summary.screens.join(" > ") : "none recorded"}`,
  ];

  if (exported.crashes.length) {
    lines.push("", "## Crashes", "");
    for (const crash of exported.crashes) {
      lines.push(`- \`${asSeconds(crash.t)}\` ${crash.kind ?? "error"}: ${crash.message ?? "?"}`);
      if (crash.stack) lines.push("", "```", String(crash.stack).split("\n").slice(0, 12).join("\n"), "```", "");
    }
  }

  if (exported.failedRequests.length) {
    lines.push("", "## Failed requests", "");
    for (const request of exported.failedRequests) {
      lines.push(
        `- \`${asSeconds(request.t)}\` ${request.method ?? "GET"} ${request.url ?? "?"} -> ${request.status ?? request.message ?? "error"}`
      );
      if (request.origin?.length) lines.push(`  - fired from: ${request.origin[0]}`);
    }
  }

  if (exported.consoleErrors.length) {
    lines.push("", "## Console errors", "");
    for (const entry of exported.consoleErrors) {
      lines.push(`- \`${asSeconds(entry.t)}\` ${truncate(entry.args, 200)}`);
    }
  }

  lines.push("", "## Timeline", "", "```");
  for (const entry of exported.timeline) {
    lines.push(`${asSeconds(entry.t).padStart(7)}  ${String(entry.type).padEnd(18)} ${entry.summary ?? ""}`);
  }
  lines.push("```", "");
  return lines.join("\n");
};

export const SESSION_TOOLS = [
  {
    name: "list_sessions",
    description:
      "Lists the persisted sessions, most recent first. Sessions survive hub restarts and app reloads, so an investigation can start long after the run it is about.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "export_session",
    description:
      "Exports one session as a single correlated artifact: network, console, crashes, navigation and UI changes on ONE timeline relative to the session start, plus the crash, failed-request and console-error sections an investigation opens first. Omit sessionId for the most recent session. format:\"markdown\" pastes into a GitHub issue as it is; format:\"json\" is for further processing.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        format: { type: "string", enum: ["json", "markdown"] },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
];

export const handleSessionTool = (name, args, projectRoot) => {
  if (name === "list_sessions") {
    return {
      directory: sessionRoot(projectRoot),
      sessions: listSessions(projectRoot).map(({ id, sizeBytes, modifiedAt }) => ({
        id,
        sizeBytes,
        modifiedAt,
      })),
    };
  }
  if (name === "export_session") {
    const sessions = listSessions(projectRoot);
    const id = args.sessionId ?? sessions[0]?.id;
    if (!id) throw new Error("No session recorded yet: connect an app and act on it first");
    const { meta, events } = readSession(projectRoot, id);
    const exported = buildSessionExport(meta, events);
    return args.format === "markdown" ? renderSessionMarkdown(exported) : exported;
  }
  return undefined;
};
