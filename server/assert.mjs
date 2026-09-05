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
/**
 * Count bounds are public up to 200. Query one element beyond that boundary so
 * equals:200 and max:200 can distinguish exactly 200 matches from 201 or more.
 */
const MAX_COUNT_BOUND = 200;
const COUNT_QUERY_LIMIT = MAX_COUNT_BOUND + 1;

export const EVENT_KINDS = new Set(["network_ok", "network_response", "no_console_error", "no_crash"]);
export const ELEMENT_KINDS = new Set(["visible", "absent", "text", "count"]);

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

/** Responses carry requestId, not necessarily the URL or method. Join before
 * selecting the window: a request may have started before its cursor. */
export const withRequestContext = (events) => {
  const requests = new Map();
  return (Array.isArray(events) ? events : []).map((event) => {
    const payload = event.payload ?? {};
    if (event.type === "network.request" && payload.requestId != null) {
      requests.set(payload.requestId, payload);
    }
    if (event.type !== "network.response" && event.type !== "network.error") return event;
    const request = requests.get(payload.requestId);
    return { ...event, payload: {
      ...payload,
      url: payload.url ?? request?.url,
      method: payload.method ?? request?.method,
    } };
  });
};

/** Pure verdict over a set of events. The evidence IS the failure report:
 * an agent must never have to run a second tool to learn what broke. */
export const evaluateEventAssertion = (kind, events, options = {}) => {
  const list = withRequestContext(events);

  if (kind === "network_response") {
    const candidates = list.filter((event) =>
      (event.type === "network.response" || event.type === "network.error") &&
      String(event.payload?.url ?? "").includes(options.urlContains) &&
      String(event.payload?.method ?? "").toUpperCase() === options.method.toUpperCase()
    );
    const matches = candidates.filter((event) => event.type === "network.response" &&
      Number(event.payload?.status) === options.status &&
      (options.allowMocked === true || event.payload?.mocked !== true));
    return {
      ok: matches.length > 0,
      evidence: (matches.length ? matches : candidates).slice(0, EVIDENCE_LIMIT).map(summarize),
      checked: { kind, events: candidates.length, matches: matches.length,
        urlContains: options.urlContains, method: options.method.toUpperCase(),
        status: options.status, allowMocked: options.allowMocked === true },
    };
  }

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
    const unresolved = scope ? list.filter((event) =>
      (event.type === "network.response" || event.type === "network.error") && !event.payload?.url
    ) : [];
    return {
      ok: offenders.length === 0,
      evidence: offenders.slice(0, EVIDENCE_LIMIT).map(summarize),
      checked: {
        kind,
        claim: "no-observed-network-error",
        unresolved: unresolved.length,
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
  if (kind === "count") {
    const found = matches.length;
    const bound = (name) => (Number.isInteger(options[name]) ? options[name] : null);
    const equals = bound("equals"), min = bound("min"), max = bound("max");
    // equals is the whole constraint when given; min/max compose otherwise
    const ok = equals !== null
      ? found === equals
      : (min === null || found >= min) && (max === null || found <= max);
    return { ok, matches, count: found, expected: { equals, min, max } };
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
  count: "The number of matching elements never satisfied the bound before the deadline. The observed count is in checked.count; widen the selector with query_ui if it is lower than expected.",
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

  if (kind === "network_response") {
    if (typeof args.urlContains !== "string" || !args.urlContains.trim() ||
        typeof args.method !== "string" || !/^[A-Za-z]+$/.test(args.method) ||
        !Number.isInteger(args.status) || args.status < 100 || args.status > 599) {
      throw new Error('Assertion "network_response" needs urlContains, method and an integer status from 100 to 599');
    }
    const timeout = args.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : Number(args.timeoutMs);
    if (!Number.isFinite(timeout) || timeout < 0 || timeout > 120000) throw new Error("Invalid timeoutMs");
    const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    // Freeze the start of the observation window while waiting.
    const floor = startedAt - Math.max(100, Math.min(Number(args.windowMs) || DEFAULT_WINDOW_MS, 300000));
    for (;;) {
      const history = withRequestContext(await deps.history());
      const events = args.since != null ? selectWindow(history, { since: args.since }) :
        history.filter((event) => (event.ts ?? 0) >= floor);
      const verdict = evaluateEventAssertion(kind, events, args);
      if (verdict.ok) return { ...verdict, reason: null, kind, conclusive: true,
        observation: "response-observed", elapsedMs: now() - startedAt, hint: null };
      if (now() >= startedAt + timeout) {
        const capture = deps.capture ? await deps.capture(kind) : { instrumented: null };
        const conclusive = capture.instrumented === true;
        return { ...verdict, reason: conclusive ? "assertion-failed" : "observation-unavailable",
          kind, conclusive, capture, observation: "expected-response-not-observed",
          elapsedMs: now() - startedAt,
          hint: conclusive ? "No matching response was observed. Check the method, URL, status and cursor. Mocked responses require allowMocked:true." :
            "Network observation is unavailable or unknown. Instrument the client, then reproduce the action." };
      }
      await sleep(Math.min(POLL_INTERVAL_MS, startedAt + timeout - now()));
    }
  }

  if (EVENT_KINDS.has(kind)) {
    // A look-back needs the in-flight work to have landed: settleMs is
    // the honest way to say "wait, then judge", instead of pretending a
    // negative assertion can be retried into success
    if (Number(args.settleMs) > 0) {
      await (deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(
        Math.min(Number(args.settleMs), 30000)
      );
    }
    const capture = deps.capture ? await deps.capture(kind) : null;
    const events = selectWindow(withRequestContext(await deps.history()), {
      since: args.since,
      windowMs: args.windowMs,
      now: now(),
    });
    const verdict = evaluateEventAssertion(kind, events, {
      urlContains: args.urlContains,
      ignore: args.ignore,
    });
    if (verdict.ok && verdict.checked.unresolved > 0) return {
      ok: false, conclusive: false, kind, reason: "observation-unavailable",
      checked: verdict.checked, evidence: [], elapsedMs: now() - startedAt,
      hint: "Some network outcomes have no URL and their request is no longer retained. Reproduce with a fresh cursor before checking this URL scope.",
    };
    if (verdict.ok && capture && capture.instrumented !== true) {
      return { ok: false, reason: "observation-unavailable", kind, conclusive: false,
        checked: verdict.checked, evidence: [], capture, elapsedMs: now() - startedAt,
        hint: "The required instrumentation is unavailable or unknown. Enable it and reproduce the action before asserting absence of errors." };
    }
    return {
      ok: verdict.ok,
      conclusive: !verdict.ok || capture?.instrumented === true,
      ...(capture ? { capture } : {}),
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

  if (kind === "count") {
    const supplied = ["equals", "min", "max"].filter((name) => args[name] !== undefined);
    if (!supplied.length) {
      throw new Error('Assertion "count" needs at least one of: equals, min, max');
    }
    for (const name of supplied) {
      const bound = args[name];
      if (!Number.isInteger(bound) || bound < 0 || bound > MAX_COUNT_BOUND) {
        throw new Error(`Assertion "count" ${name} must be an integer from 0 to ${MAX_COUNT_BOUND}`);
      }
    }
    if (args.min !== undefined && args.max !== undefined && args.min > args.max) {
      throw new Error('Assertion "count" min cannot be greater than max');
    }
  }

  const deadline = startedAt + Math.max(0, Math.min(Number(args.timeoutMs ?? DEFAULT_TIMEOUT_MS), 120000));
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const selector = {
    by: args.by,
    value: args.value,
    name: args.name,
    exact: args.exact,
    within: args.within,
    includeHidden: args.includeHidden,
    // Counting through a limit of 10 would report 10 for a list of 40 and
    // silently fail every equals above it
    limit: kind === "count" ? COUNT_QUERY_LIMIT : 10,
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
      equals: args.equals,
      min: args.min,
      max: args.max,
    });
    if (last.ok || now() >= deadline) break;
    await sleep(POLL_INTERVAL_MS);
  }

  return {
    ok: last.ok,
    reason: last.ok ? null : "assertion-failed",
    kind,
    checked: {
      kind,
      selector: { by: selector.by, value: selector.value, name: selector.name ?? null },
      attempts,
      ...(kind === "count" ? {
        count: last.count,
        expected: last.expected,
        saturated: last.count >= COUNT_QUERY_LIMIT,
      } : {}),
    },
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
    "Checks runtime evidence. network_response RETRIES until timeoutMs for an observed response matching required urlContains, method and status; mocked responses require allowMocked:true. Success carries the response evidence. network_ok means only no observed network error, never that a request completed. Negative event assertions require current capture coverage; unavailable coverage returns ok:false, conclusive:false. no_crash covers captured JS errors and rejections, not native crashes. Element kinds (visible, absent, text, count) retry until timeoutMs. Scope events with since from before the action, or windowMs; settleMs delays negative checks.",
  inputSchema: {
    type: "object",
    required: ["kind"],
    properties: {
      deviceId: { type: "string" },
      kind: {
        type: "string",
        enum: ["visible", "absent", "text", "count", "network_ok", "network_response", "no_console_error", "no_crash"],
      },
      ...selectorProps,
      text: { type: "string", description: "kind:text, the expected text when it differs from value" },
      equals: { type: "integer", minimum: 0, maximum: 200, description: "kind:count, the exact number of matching elements expected" },
      min: { type: "integer", minimum: 0, maximum: 200, description: "kind:count, lowest acceptable number of matches" },
      max: { type: "integer", minimum: 0, maximum: 200, description: "kind:count, highest acceptable number of matches" },
      timeoutMs: { type: "integer", minimum: 0, maximum: 120000, description: "Element kinds and network_response: retry deadline (default 5000, 0 checks once)" },
      since: { type: "integer", minimum: 0, description: "Event kinds: judge everything after this cursor" },
      windowMs: { type: "integer", minimum: 100, maximum: 300000, description: "Event kinds: trailing window when no cursor is given (default 5000)" },
      settleMs: { type: "integer", minimum: 0, maximum: 30000, description: "Event kinds: wait before judging, to let in-flight requests land" },
      urlContains: { type: "string", description: "Network assertions: URL substring, required for network_response" },
      method: { type: "string", pattern: "^[A-Za-z]+$", description: "network_response: required HTTP method" },
      status: { type: "integer", minimum: 100, maximum: 599, description: "network_response: required response status" },
      allowMocked: { type: "boolean", description: "network_response: accept instrumented mocked responses (default false)" },
      ignore: { type: "array", items: { type: "string" }, description: "kind:no_console_error, substrings to tolerate" },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
};
