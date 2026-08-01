import { describe, expect, it } from "vitest";
// @ts-expect-error untyped hub module
import * as flowModule from "../server/flow.mjs";

interface Consequence {
  kind: string;
  type: string;
  method?: string | null;
  path?: string | null;
  status?: number | null;
  screen?: string | null;
  message?: string | null;
  failed: boolean;
}

interface Step {
  action: string;
  selector: Record<string, unknown>;
  text: string | null;
  source: Record<string, unknown> | null;
  consequences: Consequence[];
  failed: boolean;
}

interface Flow {
  name: string;
  recordedAt: number | null;
  steps: Step[];
  clean: boolean;
}

const {
  createRecorder,
  startRecording,
  stopRecording,
  recordAct,
  buildFlow,
  renderFlowText,
  renderFlowMcp,
} = flowModule as {
  createRecorder: () => Record<string, any>;
  startRecording: (recorder: unknown, options?: Record<string, unknown>) => Record<string, unknown>;
  stopRecording: (recorder: unknown) => Record<string, unknown>;
  recordAct: (recorder: unknown, entry: Record<string, unknown>) => void;
  buildFlow: (recorder: unknown, events: unknown) => Flow;
  renderFlowText: (flow: Flow) => string;
  renderFlowMcp: (flow: Flow) => Array<{ tool: string; arguments: Record<string, unknown> }>;
};

const event = (type: string, payload: unknown, seq: number) => ({ type, payload, seq, ts: seq * 100 });

const recorded = () => {
  const recorder = createRecorder();
  startRecording(recorder, { name: "order", cursor: 0 });
  recordAct(recorder, {
    action: "tap",
    selector: { by: "role", value: "button", name: "Commander" },
    target: { source: { file: "src/screens/Cart.tsx", line: 88 } },
    cursor: 0,
  });
  recordAct(recorder, {
    action: "type",
    selector: { by: "testID", value: "promo" },
    text: "SUMMER",
    cursor: 4,
  });
  return recorder;
};

const events = [
  event("network.request", { requestId: 1, method: "POST", url: "https://api.shop.test/orders" }, 1),
  event("ui.change", { generation: 4 }, 2),
  event("network.response", { requestId: 1, status: 201, durationMs: 90 }, 3),
  event("screen.ready", { screen: "Confirmation" }, 4),
  event("network.request", { requestId: 2, method: "GET", url: "https://api.shop.test/promo" }, 5),
  event("network.response", { requestId: 2, status: 200 }, 6),
];

describe("recording lifecycle", () => {
  it("starts empty and collects acts only while active", () => {
    const recorder = createRecorder();
    recordAct(recorder, { action: "tap", selector: { by: "testID", value: "a" }, cursor: 0 });
    expect(recorder.acts).toHaveLength(0);

    startRecording(recorder, { name: "flow", cursor: 3 });
    recordAct(recorder, { action: "tap", selector: { by: "testID", value: "a" }, cursor: 3 });
    expect(recorder.acts).toHaveLength(1);

    stopRecording(recorder);
    recordAct(recorder, { action: "tap", selector: { by: "testID", value: "b" }, cursor: 5 });
    expect(recorder.acts).toHaveLength(1);
  });

  it("discards a previous recording when a new one starts", () => {
    const recorder = recorded();
    startRecording(recorder, { name: "second", cursor: 10 });
    expect(recorder.acts).toHaveLength(0);
    expect(recorder.name).toBe("second");
  });
});

describe("buildFlow", () => {
  it("pairs each action with what it caused, up to the next action", () => {
    const flow = buildFlow(recorded(), events);
    expect(flow.steps).toHaveLength(2);
    expect(flow.steps[0].consequences.map((entry) => entry.type)).toEqual([
      "network.response",
      "screen.ready",
    ]);
    expect(flow.steps[1].consequences.map((entry) => entry.type)).toEqual(["network.response"]);
  });

  it("names the request behind a response, which needs the whole event list", () => {
    const flow = buildFlow(recorded(), events);
    expect(flow.steps[0].consequences[0]).toMatchObject({
      method: "POST",
      path: "/orders",
      status: 201,
    });
  });

  it("ignores events that are not consequences worth replaying", () => {
    const flow = buildFlow(recorded(), events);
    expect(flow.steps[0].consequences.some((entry) => entry.type === "ui.change")).toBe(false);
  });

  it("keeps the source of the tapped element, so a failure becomes an edit", () => {
    const flow = buildFlow(recorded(), events);
    expect(flow.steps[0].source).toMatchObject({ file: "src/screens/Cart.tsx", line: 88 });
  });

  it("marks a flow that recorded a failed request as not clean", () => {
    const failing = [
      event("network.request", { requestId: 1, method: "POST", url: "https://api/orders" }, 1),
      event("network.response", { requestId: 1, status: 500 }, 2),
    ];
    const flow = buildFlow(recorded(), failing);
    expect(flow.steps[0].failed).toBe(true);
    expect(flow.clean).toBe(false);
  });

  it("marks a crash as a problem rather than as something to wait for", () => {
    const flow = buildFlow(recorded(), [event("crash", { message: "boom" }, 1)]);
    expect(flow.steps[0].consequences[0]).toMatchObject({ kind: "problem", failed: true });
  });

  it("gives the last action every event after it", () => {
    const recorder = createRecorder();
    startRecording(recorder, { cursor: 0 });
    recordAct(recorder, { action: "tap", selector: { by: "testID", value: "go" }, cursor: 0 });
    const flow = buildFlow(recorder, events);
    expect(flow.steps[0].consequences).toHaveLength(3);
  });

  it("produces a clean empty flow when nothing happened after an action", () => {
    const recorder = createRecorder();
    startRecording(recorder, { cursor: 0 });
    recordAct(recorder, { action: "tap", selector: { by: "testID", value: "noop" }, cursor: 0 });
    const flow = buildFlow(recorder, []);
    expect(flow.steps[0].consequences).toEqual([]);
    expect(flow.clean).toBe(true);
  });

  it("keeps a relative URL readable when it cannot be parsed", () => {
    const flow = buildFlow(recorded(), [
      event("network.request", { requestId: 1, method: "GET", url: "/relative/path" }, 1),
      event("network.response", { requestId: 1, status: 200 }, 2),
    ]);
    expect(flow.steps[0].consequences[0].path).toBe("/relative/path");
  });
});

describe("renderFlowText", () => {
  it("writes the causality line an external recorder cannot produce", () => {
    const text = renderFlowText(buildFlow(recorded(), events));
    expect(text).toContain('tap    role="button" name="Commander"');
    expect(text).toContain("wait network.response POST /orders 201");
    expect(text).toContain("wait   screen.ready Confirmation");
    expect(text).toContain("assert network_ok");
  });

  it("comments the source file next to the action", () => {
    expect(renderFlowText(buildFlow(recorded(), events))).toContain("src/screens/Cart.tsx:88");
  });

  it("warns instead of pretending a failing recording is a test", () => {
    const flow = buildFlow(recorded(), [
      event("network.request", { requestId: 1, method: "POST", url: "https://api/orders" }, 1),
      event("network.error", { requestId: 1, message: "offline" }, 2),
    ]);
    expect(renderFlowText(flow)).toContain("recorded a failure");
  });
});

describe("renderFlowMcp", () => {
  it("emits the exact calls needed to replay the flow", () => {
    const calls = renderFlowMcp(buildFlow(recorded(), events));
    expect(calls[0]).toMatchObject({ tool: "ui_act", arguments: { action: "tap", by: "role" } });
    expect(calls.some((call) => call.tool === "wait_for_event")).toBe(true);
    expect(calls.filter((call) => call.tool === "assert")).toHaveLength(2);
  });

  it("carries the typed text into the replay", () => {
    const calls = renderFlowMcp(buildFlow(recorded(), events));
    const typing = calls.find((call) => call.arguments.action === "type");
    expect(typing?.arguments.text).toBe("SUMMER");
  });
});
