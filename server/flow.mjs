/**
 * Flow recording: actions and their consequences.
 *
 * A recorder outside the app can only capture gestures: a tap at these
 * coordinates, a tap on that testID. It cannot state what the tap CAUSED,
 * because it never sees inside. Replaying such a script proves that the
 * taps still land, not that the feature still works.
 *
 * From inside, an action can be paired with what followed it: the request
 * it fired and its status, the screen that became ready, the crash it
 * triggered. What comes out is a causality test, not a gesture replay.
 *
 *   tap    role=button name="Commander"
 *   wait   network.response POST /orders 201
 *   wait   screen.ready Confirmation
 *   assert network_ok
 *
 * The second line is the one no external recorder can write.
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
  acts: [],
});

export const startRecording = (recorder, { name, cursor } = {}) => {
  recorder.active = true;
  recorder.name = name ?? "recorded-flow";
  recorder.startedAt = Date.now();
  recorder.startCursor = Number(cursor) || 0;
  recorder.acts = [];
  return { ok: true, name: recorder.name, startCursor: recorder.startCursor };
};

export const stopRecording = (recorder) => {
  recorder.active = false;
  return { ok: true, name: recorder.name, acts: recorder.acts.length };
};

/** Called by the hub after every successful ui_act while recording */
export const recordAct = (recorder, entry) => {
  if (!recorder.active) return;
  recorder.acts.push({
    action: entry.action,
    selector: entry.selector,
    text: entry.text ?? null,
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
    const to = index + 1 < acts.length ? acts[index + 1].cursor : Number.POSITIVE_INFINITY;
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
      // The source is what turns a failing step into an edit
      source: act.target?.source ?? null,
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
  const lines = [`# ${flow.name}`, ""];
  for (const step of flow.steps) {
    lines.push(`${step.action.padEnd(6)} ${selectorText(step.selector)}${step.text ? ` text=${JSON.stringify(step.text)}` : ""}`);
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
        ...(step.text ? { text: step.text } : {}),
      },
    });
    for (const consequence of step.consequences) {
      if (consequence.kind !== "wait") continue;
      calls.push({
        tool: "wait_for_event",
        arguments: {
          type: consequence.type,
          ...(consequence.path ? { payloadContains: consequence.path } : {}),
          ...(consequence.screen ? { payloadContains: consequence.screen } : {}),
        },
      });
    }
    calls.push({ tool: "assert", arguments: { kind: "network_ok", windowMs: 5000 } });
  }
  return calls;
};

export const FLOW_TOOLS = [
  {
    name: "start_recording",
    description:
      "Starts recording the actions performed through ui_act and the events they cause. Everything between this call and stop_recording becomes an exportable flow.",
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
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "export_flow",
    description:
      "Exports the recorded flow as an action/consequence sequence: each action is paired with what it CAUSED (the request it fired and its status, the screen that became ready), which an external recorder cannot know. format:\"mcp\" returns the exact tool calls to replay it, \"text\" a readable script, \"json\" the structure. A flow that recorded a failure is reported as not clean rather than exported as if it passed.",
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
