/**
 * What the agents actually do with this hub.
 *
 * Every MCP call passes through one function, so measuring costs nothing
 * and answers questions no other panel can: which tools carry the work,
 * which ones fail and with what message, which ones come back EMPTY (the
 * most expensive answer a tool can give, see instrumentation.mjs), how
 * much context each one bills the agent, and what the agent's loop looks
 * like once the individual calls are put back in order.
 *
 * In memory, bounded, wiped on restart. Persisting it would mean writing
 * a file nobody asked for; the interesting window is the session anyway.
 */

const RING = 500;

/**
 * The tools whose answer is pixels.
 *
 * A screenshot is the most expensive thing an agent can put in its
 * context and the weakest proof it can get back: it cannot show a request
 * that failed silently, a promise that rejected, or a value that never
 * reached the field. The hub has `assert` for all three, and a visual
 * diff (compare_snapshot) for the one question pixels genuinely answer.
 *
 * So the pixels are counted separately, on purpose. "Half the context
 * this session bought was images, and none of it was followed by an
 * assertion" is a fact about how the agent works, and no other panel can
 * state it.
 */
export const PIXEL_TOOLS = new Set(["screenshot_native"]);

const OFF = new Set(["off", "0", "false", "no", "none"]);

/**
 * How many pixel captures this hub will serve.
 *
 * Advice in a skill file is advice: an agent that ignores it screenshots
 * every step and bills the context for it. This is the switch, and it
 * follows the same rule as the plugin writes switch: off REMOVES the
 * tool rather than making it refuse, because an agent never plans a step
 * that does not exist. A budget keeps it for the cases pixels are the
 * only answer (a native dialog, an OEM rendering bug) while making the
 * loop impossible.
 */
export const readScreenshotPolicy = (env = {}) => {
  const raw = String(env.RN_DEVTOOLS_SCREENSHOTS ?? "").trim().toLowerCase();
  if (!raw) return { mode: "on", budget: null, raw: null, warning: null };
  if (OFF.has(raw)) return { mode: "off", budget: 0, raw, warning: null };
  const match = /^(?:budget:)?(\d+)$/.exec(raw);
  if (match) return { mode: "budget", budget: Number(match[1]), raw, warning: null };
  // An unreadable value must not silently take a capability away
  return {
    mode: "on",
    budget: null,
    raw,
    warning: `RN_DEVTOOLS_SCREENSHOTS="${raw}" is not off or a number, so screenshots stay enabled`,
  };
};

/**
 * Whether the agent is using pixels as proof.
 *
 * The signal is not "it took a screenshot", it is "it took another one
 * without asserting anything in between". One capture is a look; the
 * second one with no assertion between them is a verification loop, and
 * that is the moment to say assert answers it cheaper.
 */
export const screenshotAdvice = (log) => {
  let sinceProof = 0;
  let bytes = 0;
  for (let index = log.calls.length - 1; index >= 0; index -= 1) {
    const call = log.calls[index];
    if (call.name === "assert") break;
    if (PIXEL_TOOLS.has(call.name)) {
      sinceProof += 1;
      bytes += call.bytes;
    }
  }
  return { sinceProof, bytes };
};

/** Fields a tool uses to return "here is what I found" */
const LIST_FIELDS = [
  "events", "matches", "actions", "stores", "previews", "rows", "endpoints",
  "targets", "sessions", "devices", "candidates", "roots", "nodes", "logs",
];

/**
 * Empty, and why.
 *
 * The reason comes from the answer itself: `absence` on a UI query,
 * `capture` on a network read, `note` on a registry. That is the whole
 * point of those fields, and it makes the panel a map of what this app
 * does not expose rather than a list of zeros.
 */
export const readEmptiness = (result) => {
  if (result === null || result === undefined) return { empty: true, reason: null };
  if (Array.isArray(result)) return { empty: result.length === 0, reason: null };
  if (typeof result !== "object") return { empty: false, reason: null };

  const reason =
    result.absence?.reason ??
    (result.capture ? (result.capture.instrumented === false ? "not-instrumented" : "instrumented-but-quiet") : null) ??
    (result.note ? "nothing-registered" : null);

  if (typeof result.count === "number") return { empty: result.count === 0, reason };
  for (const field of LIST_FIELDS) {
    if (Array.isArray(result[field])) return { empty: result[field].length === 0, reason };
  }
  return { empty: false, reason: reason ?? null };
};

/** One line, bounded, with the volatile parts folded so two calls of the
 * same failure land in the same bucket instead of two singletons */
export const normalizeError = (message) => {
  const first = String(message ?? "").split("\n")[0].trim();
  return first
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
    .replace(/\b\d{3,}\b/g, "<n>")
    .slice(0, 160);
};

export const createToolLog = (limit = RING) => ({
  limit,
  seq: 0,
  startedAt: Date.now(),
  calls: [],
  /** Counted outside the ring, because a budget must survive the window
   * scrolling past the calls it is counting */
  pixelCalls: 0,
  pixelBytes: 0,
  /** Client names seen at initialize: Claude Code, Codex, Cursor... */
  clients: new Set(),
});

export const recordToolCall = (log, entry) => {
  log.seq += 1;
  const call = {
    seq: log.seq,
    name: entry.name ?? "unknown",
    at: entry.at ?? Date.now(),
    durationMs: entry.durationMs ?? 0,
    ok: entry.ok !== false,
    error: entry.ok === false ? normalizeError(entry.error) : null,
    bytes: entry.bytes ?? 0,
    empty: entry.empty === true,
    emptyReason: entry.emptyReason ?? null,
    selector: entry.selector ?? null,
    client: entry.client ?? null,
    /** Device bus position, so the timeline can line the call up with
     * what the app did in response */
    cursor: entry.cursor ?? null,
  };
  if (PIXEL_TOOLS.has(call.name)) {
    log.pixelCalls += 1;
    log.pixelBytes += call.bytes;
  }
  log.calls.push(call);
  if (log.calls.length > log.limit) log.calls.splice(0, log.calls.length - log.limit);
  return call;
};

const percentile = (sorted, ratio) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)] : null;

const countInto = (map, key, bump = 1) => map.set(key, (map.get(key) ?? 0) + bump);

/** The selector families, only meaningful on the tools that take one */
const SELECTOR_TOOLS = new Set(["query_ui", "ui_act", "assert"]);

export const summarizeTools = (log) => {
  const calls = log.calls;
  const perTool = new Map();
  const errors = new Map();
  const selectors = new Map();
  const pairs = new Map();
  let repeats = 0;

  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index];
    if (!perTool.has(call.name)) {
      perTool.set(call.name, {
        name: call.name, calls: 0, errors: 0, empty: 0, bytes: 0,
        durations: [], lastAt: 0, reasons: new Map(),
      });
    }
    const tool = perTool.get(call.name);
    tool.calls += 1;
    tool.bytes += call.bytes;
    tool.durations.push(call.durationMs);
    tool.lastAt = Math.max(tool.lastAt, call.at);
    if (!call.ok) {
      tool.errors += 1;
      const key = call.error ?? "unknown";
      if (!errors.has(key)) errors.set(key, { message: key, count: 0, tools: new Set() });
      errors.get(key).count += 1;
      errors.get(key).tools.add(call.name);
    }
    if (call.empty) {
      tool.empty += 1;
      if (call.emptyReason) countInto(tool.reasons, call.emptyReason);
    }

    if (call.selector?.by && SELECTOR_TOOLS.has(call.name)) {
      const key = call.selector.by;
      if (!selectors.has(key)) selectors.set(key, { by: key, calls: 0, empty: 0, errors: 0 });
      const bucket = selectors.get(key);
      bucket.calls += 1;
      if (call.empty) bucket.empty += 1;
      if (!call.ok) bucket.errors += 1;
    }

    const previous = calls[index - 1];
    // A gap means a new intent, not a step in the same loop
    if (previous && call.at - previous.at < 60000) {
      if (previous.name === call.name) repeats += 1;
      else countInto(pairs, `${previous.name} → ${call.name}`);
    }
  }

  const tools = [...perTool.values()].map((tool) => {
    const sorted = tool.durations.slice().sort((a, b) => a - b);
    return {
      name: tool.name,
      calls: tool.calls,
      errors: tool.errors,
      empty: tool.empty,
      emptyReasons: [...tool.reasons.entries()].map(([reason, count]) => ({ reason, count })),
      p50Ms: percentile(sorted, 0.5),
      p95Ms: percentile(sorted, 0.95),
      bytes: tool.bytes,
      avgBytes: Math.round(tool.bytes / tool.calls),
      lastAt: tool.lastAt,
    };
  }).sort((a, b) => b.calls - a.calls);

  const allDurations = calls.map((call) => call.durationMs).sort((a, b) => a - b);
  return {
    since: log.startedAt,
    clients: [...log.clients],
    totals: {
      calls: calls.length,
      errors: calls.filter((call) => !call.ok).length,
      empty: calls.filter((call) => call.empty).length,
      bytes: calls.reduce((sum, call) => sum + call.bytes, 0),
      p50Ms: percentile(allDurations, 0.5),
      p95Ms: percentile(allDurations, 0.95),
      distinctTools: perTool.size,
      // Pixels, separately: the panel shows what share of the context an
      // agent bought was images rather than answers
      pixelCalls: log.pixelCalls ?? 0,
      pixelBytes: log.pixelBytes ?? 0,
    },
    tools,
    errors: [...errors.values()]
      .map((entry) => ({ ...entry, tools: [...entry.tools] }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 12),
    selectors: [...selectors.values()].sort((a, b) => b.calls - a.calls),
    loop: {
      repeats,
      pairs: [...pairs.entries()]
        .map(([pair, count]) => ({ pair, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8),
    },
    // The dashboard overlays these on the device events it already holds
    timeline: calls.slice(-120).map((call) => ({
      seq: call.seq, name: call.name, at: call.at, durationMs: call.durationMs,
      ok: call.ok, empty: call.empty, bytes: call.bytes,
    })),
  };
};
