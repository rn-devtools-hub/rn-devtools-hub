/**
 * Flow recording: actions and their consequences.
 *
 * From inside, an action can be paired with observed requests, ready
 * screens and crashes. The pairing is temporal: background work can emit
 * events in the same window, so it does not establish causality.
 *
 *   tap    role=button name="Commander"
 *   wait   network.response POST /orders 201
 *   wait   screen.ready Confirmation
 *   assert network_ok
 *
 * Review the captured expectations before adopting a flow as a test.
 */

const NOTABLE_TYPES = new Set([
  "network.response",
  "network.error",
  "screen.ready",
  "nav",
  "crash",
]);

const MAX_CONSEQUENCES_PER_STEP = 8;

export const createRecorder = () => ({
  active: false,
  name: null,
  startedAt: null,
  startCursor: 0,
  endCursor: null,
  acts: [],
});

export const startRecording = (recorder, { name, cursor } = {}) => {
  recorder.active = true;
  recorder.name = name ?? "recorded-flow";
  recorder.startedAt = Date.now();
  recorder.startCursor = Number(cursor) || 0;
  recorder.endCursor = null;
  recorder.acts = [];
  return { ok: true, name: recorder.name, startCursor: recorder.startCursor };
};

export const stopRecording = (recorder, { cursor } = {}) => {
  recorder.active = false;
  recorder.endCursor = Number.isFinite(Number(cursor)) ? Number(cursor) : null;
  return {
    ok: true,
    name: recorder.name,
    acts: recorder.acts.length,
    endCursor: recorder.endCursor,
  };
};

/**
 * The index of a recorded action, or null when none was given.
 *
 * Zero is a legitimate index and a falsy number, so the usual `|| null`
 * would drop precisely the case an agent writes most often.
 */
const recordedIndex = (raw) => {
  const index = Number(raw);
  return Number.isInteger(index) && index >= 0 ? index : null;
};

const recordedText = (entry) => {
  if (!entry.recordAs) return entry.text ?? null;
  const name = String(entry.recordAs);
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(name)) {
    throw new Error("recordAs must be an uppercase environment variable name");
  }
  return `\${${name}}`;
};

const SENSITIVE_TARGET = /pass(word|code)?|otp|one.?time|secret|token|pin|cvv|cvc/i;

export const needsRecordedVariable = (entry) => {
  if (entry?.action !== "type" || entry.recordAs) return false;
  const selector = entry.selector ?? {};
  const target = entry.target ?? {};
  if (target.secureTextEntry === true || target.props?.secureTextEntry === true) return true;
  return [
    selector.value, selector.name, selector.within?.value, selector.within?.name,
    target.testID, target.name, target.placeholder, target.props?.testID,
    target.props?.placeholder, target.props?.accessibilityLabel,
  ]
    .some((value) => typeof value === "string" && SENSITIVE_TARGET.test(value));
};

/** Called by the hub after every successful ui_act while recording */
export const recordAct = (recorder, entry) => {
  if (!recorder.active) return;
  if (needsRecordedVariable(entry)) {
    throw new Error("Sensitive type actions require recordAs while recording");
  }
  recorder.acts.push({
    action: entry.action,
    selector: entry.selector,
    // A caller can send the literal value to the live input while keeping
    // only an environment placeholder at every durable boundary.
    text: recordedText(entry),
    // A selector matching several elements is disambiguated by the index,
    // so a flow that forgets it replays on a DIFFERENT element while
    // reading as the same script
    index: recordedIndex(entry.index),
    target: entry.target ?? null,
    cursor: Number(entry.cursor) || 0,
    ts: entry.ts ?? Date.now(),
  });
};

const pathOf = (url) => {
  try {
    return new URL(String(url)).pathname;
  } catch {
    return String(url ?? "?");
  }
};

/** Maps requestId to method and URL, so a response can name its request */
const indexRequests = (events) => {
  const index = new Map();
  for (const event of events) {
    if (event.type !== "network.request") continue;
    index.set(event.payload?.requestId, {
      method: event.payload?.method ?? "GET",
      url: event.payload?.url ?? null,
    });
  }
  return index;
};

const describeConsequence = (event, requests) => {
  const payload = event.payload ?? {};
  if (event.type === "network.response" || event.type === "network.error") {
    const request = requests.get(payload.requestId) ?? {};
    return {
      kind: "wait",
      type: event.type,
      method: request.method ?? null,
      path: request.url ? pathOf(request.url) : null,
      status: payload.status ?? null,
      mocked: payload.mocked === true,
      failed: event.type === "network.error" || Number(payload.status) >= 400,
    };
  }
  if (event.type === "screen.ready" || event.type === "nav") {
    return {
      kind: "wait",
      type: event.type,
      screen: payload.screen ?? payload.route ?? null,
      failed: false,
    };
  }
  return {
    kind: "problem",
    type: event.type,
    message: payload.message ?? null,
    failed: true,
  };
};

/**
 * Pairs each recorded action with the events that followed it, up to the
 * next action. Pure: the pairing is the whole value of the feature and it
 * must be verifiable without a device.
 */
export const buildFlow = (recorder, events) => {
  const list = Array.isArray(events) ? events : [];
  const requests = indexRequests(list);
  const acts = recorder.acts ?? [];

  const steps = acts.map((act, index) => {
    const from = act.cursor;
    const to = index + 1 < acts.length
      ? acts[index + 1].cursor
      : recorder.endCursor ?? Number.POSITIVE_INFINITY;
    const window = list.filter((event) => {
      const seq = event.seq ?? 0;
      return seq > from && seq <= to && NOTABLE_TYPES.has(event.type);
    });
    const consequences = window
      .slice(0, MAX_CONSEQUENCES_PER_STEP)
      .map((event) => describeConsequence(event, requests));
    return {
      action: act.action,
      selector: act.selector,
      text: act.text,
      index: act.index ?? null,
      // The source is what turns a failing step into an edit
      source: act.target?.source ?? null,
      attribution: "temporal",
      consequences,
      failed: consequences.some((entry) => entry.failed),
    };
  });

  return {
    name: recorder.name ?? "recorded-flow",
    recordedAt: recorder.startedAt ?? null,
    steps,
    // A flow that recorded a failure is a bug report, not a regression
    // test: say so instead of exporting it as if it passed
    clean: steps.every((step) => !step.failed),
  };
};

const selectorText = (selector = {}) => {
  const parts = [`${selector.by ?? "testID"}=${JSON.stringify(String(selector.value ?? ""))}`];
  if (selector.name) parts.push(`name=${JSON.stringify(selector.name)}`);
  if (selector.within) parts.push(`within=${selector.within.by}:${selector.within.value}`);
  return parts.join(" ");
};

export const renderFlowText = (flow) => {
  const lines = [`# ${flow.name}`, "# Events are associated by time; background work may be included.", ""];
  for (const step of flow.steps) {
    // The index belongs on the line: read without it, the script says it
    // acts on "the button", when it acted on the third one
    const position = step.index === null || step.index === undefined ? "" : ` index=${step.index}`;
    lines.push(`${step.action.padEnd(6)} ${selectorText(step.selector)}${position}${step.text ? ` text=${JSON.stringify(step.text)}` : ""}`);
    if (step.source?.file) {
      lines.push(`       # ${step.source.file}${step.source.line ? `:${step.source.line}` : ""}`);
    }
    for (const consequence of step.consequences) {
      if (consequence.type === "network.response" || consequence.type === "network.error") {
        lines.push(`wait   ${consequence.type} ${consequence.method ?? ""} ${consequence.path ?? ""} ${consequence.status ?? "error"}`.replace(/\s+/g, " "));
      } else if (consequence.kind === "wait") {
        lines.push(`wait   ${consequence.type} ${consequence.screen ?? ""}`.trimEnd());
      } else {
        lines.push(`# FAILED here: ${consequence.type} ${consequence.message ?? ""}`.trimEnd());
      }
    }
    lines.push("assert network_ok");
    lines.push("");
  }
  if (!flow.clean) {
    lines.push("# This flow recorded a failure: fix it before using it as a regression test.");
  }
  return lines.join("\n");
};

/** The replayable form: the exact MCP calls, in order, for an agent to
 * run again without translating anything */
export const renderFlowMcp = (flow) => {
  const calls = [];
  for (const step of flow.steps) {
    calls.push({
      tool: "ui_act",
      arguments: {
        action: step.action,
        ...step.selector,
        ...(step.index === null || step.index === undefined ? {} : { index: step.index }),
        ...(step.text ? { text: step.text } : {}),
      },
    });
    for (const consequence of step.consequences) {
      if (consequence.kind !== "wait") continue;
      calls.push(expectationForEvent(consequence));
    }
    calls.push({ tool: "assert", arguments: { kind: "network_ok", windowMs: 5000 } });
  }
  return calls;
};

export const expectationForEvent = (event) => {
  if (event.type === "network.response" && event.path && event.method && Number.isInteger(event.status)) {
    return { tool: "assert", arguments: { kind: "network_response",
      urlContains: event.path, method: event.method, status: event.status,
      ...(event.mocked ? { allowMocked: true } : {}),
    } };
  }
  return { tool: "wait_for_event", arguments: { type: event.type,
    ...(event.path ? { payloadContains: event.path } : {}),
    ...(event.screen ? { payloadContains: event.screen } : {}),
  } };
};

export const FLOW_TOOLS = [
  {
    name: "start_recording",
    description:
      "Records runtime actions and events observed between them. Association is temporal and may include background work. Everything up to stop_recording becomes an exportable flow.",
    inputSchema: {
      type: "object",
      properties: { deviceId: { type: "string" }, name: { type: "string" } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "stop_recording",
    description: "Stops the current recording. The flow stays available for export_flow.",
    inputSchema: { type: "object", properties: { deviceId: { type: "string" } }, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "export_flow",
    description:
      "Exports runtime actions and subsequent observed events. attribution:temporal means ordering, not proven causality; review background traffic before using the recording as a test. format:mcp returns replay calls, text a readable script, json the structure. Recorded failures make clean:false.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string" },
        format: { type: "string", enum: ["text", "json", "mcp"] },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
];
