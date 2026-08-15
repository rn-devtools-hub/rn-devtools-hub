/**
 * Proof primitives.
 *
 * Verifying a result by taking a screenshot and looking at it is slow,
 * expensive in tokens, and blind to everything that has no pixel. A
 * screenshot will never say that a request failed silently, that a
 * console error appeared, or that a promise rejected unhandled.
 *
 * One tool, several kinds, rather than one tool per kind: an agent picks
 * better from a short list, and the tool surface stays readable.
 *
 * Two families, deliberately different in behaviour:
 * - element assertions RETRY until their deadline, because the UI is
 *   asynchronous and a first miss means nothing
 * - event assertions LOOK BACK over a window, because "nothing bad
 *   happened" cannot be established by waiting longer
 */

const EVIDENCE_LIMIT = 10;
const DEFAULT_WINDOW_MS = 5000;
const DEFAULT_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 250;

export const EVENT_KINDS = new Set(["network_ok", "no_console_error", "no_crash"]);
export const ELEMENT_KINDS = new Set(["visible", "absent", "text"]);

/**
 * Events to judge: everything after `since` when the agent passes a
 * cursor, otherwise the trailing time window. The cursor is the precise
 * form (it starts exactly where the previous step ended); the window is
 * the convenient one.
 */
export const selectWindow = (history, { since, windowMs, now } = {}) => {
  const events = Array.isArray(history) ? history : [];
  if (Number.isFinite(Number(since))) {
    const cursor = Number(since);
    return events.filter((event) => (event.seq ?? 0) > cursor);
  }
  const span = Math.max(100, Math.min(Number(windowMs) || DEFAULT_WINDOW_MS, 300000));
  const floor = (Number.isFinite(Number(now)) ? Number(now) : Date.now()) - span;
  return events.filter((event) => (event.ts ?? 0) >= floor);
};

const matchesAny = (text, needles) =>
  Array.isArray(needles) && needles.some((needle) => String(text).includes(String(needle)));

const summarize = (event) => ({
  seq: event.seq ?? null,
  ts: event.ts ?? null,
  type: event.type,
  payload: event.payload,
});

/** Pure verdict over a set of events. The evidence IS the failure report:
 * an agent must never have to run a second tool to learn what broke. */
export const evaluateEventAssertion = (kind, events, options = {}) => {
  const list = Array.isArray(events) ? events : [];

  if (kind === "network_ok") {
    const scope = options.urlContains ? String(options.urlContains) : null;
    const inScope = (payload) =>
      !scope || String(payload?.url ?? "").includes(scope);
    const offenders = list.filter((event) => {
      if (event.type === "network.error") return inScope(event.payload);
      if (event.type !== "network.response") return false;
      const status = Number(event.payload?.status);
      return Number.isFinite(status) && status >= 400 && inScope(event.payload);
    });
    return {
      ok: offenders.length === 0,
      evidence: offenders.slice(0, EVIDENCE_LIMIT).map(summarize),
      checked: {
        kind,
        events: list.filter((event) => String(event.type).startsWith("network.")).length,
        urlContains: scope,
      },
    };
  }

  if (kind === "no_console_error") {
    const offenders = list.filter((event) => {
      if (event.type !== "console" || event.payload?.level !== "error") return false;
      if (!options.ignore?.length) return true;
      return !matchesAny(JSON.stringify(event.payload?.args ?? ""), options.ignore);
    });
    return {
      ok: offenders.length === 0,
      evidence: offenders.slice(0, EVIDENCE_LIMIT).map(summarize),
      checked: {
        kind,
        events: list.filter((event) => event.type === "console").length,
        ignored: options.ignore ?? null,
      },
    };
  }

  if (kind === "no_crash") {
    const offenders = list.filter((event) => event.type === "crash");
    return {
      ok: offenders.length === 0,
      evidence: offenders.slice(0, EVIDENCE_LIMIT).map(summarize),
      checked: { kind, events: list.length },
    };
  }

  throw new Error(`Unknown event assertion kind: ${kind}`);
};

/** Pure verdict over the result of one ui.query round */
export const evaluateElementAssertion = (kind, queryResult, options = {}) => {
  const matches = Array.isArray(queryResult?.matches) ? queryResult.matches : [];
  if (kind === "visible") {
    return { ok: matches.length > 0, matches };
  }
  if (kind === "absent") {
    return { ok: matches.length === 0, matches };
  }
  if (kind === "text") {
    const needle = String(options.value ?? "");
    // An input's content is `value`, a Text's is `text`. Checking only one
    // makes the assertion silently unusable on half the elements.
    const contentOf = (match) => [match.text, match.value].filter((part) => typeof part === "string");
    const found = matches.filter((match) =>
      contentOf(match).some((content) =>
        options.exact ? content === needle : content.includes(needle)
      )
    );
    return { ok: found.length > 0, matches: found.length ? found : matches };
  }
  throw new Error(`Unknown element assertion kind: ${kind}`);
};

const FAILURE_HINTS = {
  network_ok: "A request failed in the window. The evidence carries the offending request; widen with urlContains: null to see whether it is unrelated to the step under test.",
  no_console_error: "A console.error was emitted. Pass ignore to allow known noise, or fix the cause.",
  no_crash: "A crash or an unhandled rejection occurred. The stack is in the evidence.",
  visible: "No element matched before the deadline. Check the selector with query_ui, or wait on the event that renders it with wait_for_event.",
  absent: "The element is still on screen at the deadline. It may be a hidden navigator screen: pass includeHidden: false is the default, so this one is genuinely visible.",
  text: "The text was not found on any matching element before the deadline.",
};

/**
 * Runs one assertion. IO is injected so the decision logic stays testable
 * without a device: `history` returns the event list, `queryUi` performs
 * one ui.query round, `sleep` and `now` make the retry loop deterministic.
 */
export const runAssert = async (args = {}, deps = {}) => {
  const kind = String(args.kind ?? "");
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();

  if (EVENT_KINDS.has(kind)) {
    // A look-back needs the in-flight work to have landed: settleMs is
    // the honest way to say "wait, then judge", instead of pretending a
    // negative assertion can be retried into success
    if (Number(args.settleMs) > 0) {
      await (deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(
        Math.min(Number(args.settleMs), 30000)
      );
    }
    const events = selectWindow(await deps.history(), {
      since: args.since,
      windowMs: args.windowMs,
      now: now(),
    });
    const verdict = evaluateEventAssertion(kind, events, {
      urlContains: args.urlContains,
      ignore: args.ignore,
    });
    return {
      ok: verdict.ok,
      /**
       * A failed assertion is an MCP failure, and failures are grouped by
       * this field. The hint is written for a human and differs per kind,
       * so leaning on it turned one fact ("something did not hold") into
       * as many buckets as there are kinds of advice. The kind is already
       * next to it for whoever wants the detail.
       */
      reason: verdict.ok ? null : "assertion-failed",
      kind,
      checked: verdict.checked,
      evidence: verdict.ok ? [] : verdict.evidence,
      elapsedMs: now() - startedAt,
      hint: verdict.ok ? null : FAILURE_HINTS[kind],
    };
  }

  if (!ELEMENT_KINDS.has(kind)) {
    throw new Error(
      `Unknown assertion kind "${kind}". Use one of: ${[...EVENT_KINDS, ...ELEMENT_KINDS].join(", ")}`
    );
  }

  if (!args.by || !args.value) {
    throw new Error(`Assertion "${kind}" needs a selector: by and value`);
  }

  const deadline = startedAt + Math.max(0, Math.min(Number(args.timeoutMs) || DEFAULT_TIMEOUT_MS, 120000));
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const selector = {
    by: args.by,
    value: args.value,
    name: args.name,
    exact: args.exact,
    within: args.within,
    includeHidden: args.includeHidden,
    limit: 10,
  };

  let attempts = 0;
  let last = { ok: false, matches: [] };
  // A UI is asynchronous: a first miss means nothing, so retry until the
  // deadline rather than reporting a false negative
  for (;;) {
    attempts += 1;
    const queryResult = await deps.queryUi(selector);
    last = evaluateElementAssertion(kind, queryResult, {
      value: args.text ?? args.value,
      exact: args.exact,
    });
    if (last.ok || now() >= deadline) break;
    await sleep(POLL_INTERVAL_MS);
  }

  return {
    ok: last.ok,
    reason: last.ok ? null : "assertion-failed",
    kind,
    checked: { kind, selector: { by: selector.by, value: selector.value, name: selector.name ?? null }, attempts },
    evidence: last.ok ? [] : last.matches.slice(0, EVIDENCE_LIMIT),
    elapsedMs: now() - startedAt,
    hint: last.ok ? null : FAILURE_HINTS[kind],
  };
};

const selectorProps = {
  by: { type: "string", enum: ["testID", "text", "label", "placeholder", "type", "role"] },
  value: { type: "string" },
  name: { type: "string", description: "Accessible name filter, used with by:role" },
  exact: { type: "boolean" },
  within: {
    type: "object",
    properties: {
      by: { type: "string", enum: ["testID", "text", "label", "placeholder", "type", "role"] },
      value: { type: "string" },
      name: { type: "string" },
    },
    required: ["by", "value"],
    additionalProperties: false,
  },
  includeHidden: { type: "boolean" },
};

export const ASSERT_TOOL = {
  name: "assert",
  description:
    "Proves a result and returns a structured verdict with the evidence attached on failure. Element kinds (visible, absent, text) RETRY until timeoutMs, because a UI is asynchronous. Event kinds (network_ok, no_console_error, no_crash) LOOK BACK over a window and prove what a screenshot cannot show: a request that failed silently, a console error, an unhandled rejection. Scope the window with since (a cursor from get_events_since, the precise form) or windowMs. Use settleMs to let in-flight work land before judging.",
  inputSchema: {
    type: "object",
    required: ["kind"],
    properties: {
      deviceId: { type: "string" },
      kind: {
        type: "string",
        enum: ["visible", "absent", "text", "network_ok", "no_console_error", "no_crash"],
      },
      ...selectorProps,
      text: { type: "string", description: "kind:text, the expected text when it differs from value" },
      timeoutMs: { type: "integer", minimum: 0, maximum: 120000, description: "Element kinds: retry deadline (default 5000)" },
      since: { type: "integer", minimum: 0, description: "Event kinds: judge everything after this cursor" },
      windowMs: { type: "integer", minimum: 100, maximum: 300000, description: "Event kinds: trailing window when no cursor is given (default 5000)" },
      settleMs: { type: "integer", minimum: 0, maximum: 30000, description: "Event kinds: wait before judging, to let in-flight requests land" },
      urlContains: { type: "string", description: "kind:network_ok, restrict to matching URLs" },
      ignore: { type: "array", items: { type: "string" }, description: "kind:no_console_error, substrings to tolerate" },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
};
