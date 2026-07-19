/**
 * Transport tests: ring buffer, batching, commands, no-op before init
 */
import { describe, it, expect, beforeEach } from "vitest";
import { DevtoolsTransport } from "../src/client/transport";
import { devtools } from "../src/client/index";
import { truncateForWire, redactHeaders } from "../src/client/types";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(raw: string) {
    if (this.readyState !== 1) throw new Error("not open");
    this.sent.push(raw);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  simulateOpen() {
    this.readyState = 1;
    this.onopen?.();
  }
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  (globalThis as any).WebSocket = FakeWebSocket;
});

const makeTransport = () =>
  new DevtoolsTransport({
    serverUrl: "ws://test:1",
    appName: "test-app",
    maxBufferSize: 5,
    flushIntervalMs: 999999,
  });

describe("DevtoolsTransport", () => {
  it("buffers events before connection", () => {
    const transport = makeTransport();
    transport.enqueue("a", { n: 1 });
    transport.enqueue("b", { n: 2 });
    expect(transport.bufferedCount).toBe(2);
  });

  it("ring buffer: evicts the oldest beyond capacity", () => {
    const transport = makeTransport();
    for (let i = 0; i < 10; i++) transport.enqueue("event", { i });
    expect(transport.bufferedCount).toBe(5);
  });

  it("event ids are increasing", () => {
    const transport = makeTransport();
    const first = transport.enqueue("a", {});
    const second = transport.enqueue("b", {});
    expect(second.id).toBeGreaterThan(first.id);
  });

  it("sends the hello (with stableId) then flushes the batch", () => {
    const transport = new DevtoolsTransport({
      serverUrl: "ws://test:1",
      appName: "test-app",
      stableId: "abc123",
      maxBufferSize: 5,
      flushIntervalMs: 999999,
    });
    transport.enqueue("early", { n: 1 });
    transport.start();

    const ws = FakeWebSocket.instances[0];
    ws.simulateOpen();

    expect(ws.sent.length).toBe(2);
    const hello = JSON.parse(ws.sent[0]);
    expect(hello.kind).toBe("hello");
    expect(hello.role).toBe("device");
    expect(hello.stableId).toBe("abc123");

    const batch = JSON.parse(ws.sent[1]);
    expect(batch.kind).toBe("events");
    expect(batch.events[0].type).toBe("early");
    transport.stop();
  });

  it("the buffer empties after flush", () => {
    const transport = makeTransport();
    transport.start();
    FakeWebSocket.instances[0].simulateOpen();
    transport.enqueue("x", {});
    transport.flush();
    expect(transport.bufferedCount).toBe(0);
    transport.stop();
  });

  it("responds to dashboard commands", async () => {
    const transport = makeTransport();
    transport.onCommand("echo", (payload) => ({ echoed: payload }));
    transport.start();
    const ws = FakeWebSocket.instances[0];
    ws.simulateOpen();
    ws.sent = [];

    ws.onmessage?.({
      data: JSON.stringify({
        type: "command",
        command: "echo",
        requestId: "r1",
        payload: { hello: true },
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const response = JSON.parse(ws.sent[0]);
    expect(response.kind).toBe("commandResult");
    expect(response.result).toEqual({ echoed: { hello: true } });
    transport.stop();
  });

  it("unknown command: returns an error, not a crash", async () => {
    const transport = makeTransport();
    transport.start();
    const ws = FakeWebSocket.instances[0];
    ws.simulateOpen();
    ws.sent = [];

    ws.onmessage?.({
      data: JSON.stringify({ type: "command", command: "nope", requestId: "r2" }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(JSON.parse(ws.sent[0]).error).toContain("nope");
    transport.stop();
  });
});

describe("devtools (singleton)", () => {
  it("is completely inert before init", () => {
    expect(devtools.enabled).toBe(false);
    expect(() => devtools.emit("x", {})).not.toThrow();
    expect(() => devtools.emitRaw("x", {})).not.toThrow();
    expect(() => devtools.attachConsole()).not.toThrow();
    expect(() => devtools.startPerformanceSampler()).not.toThrow();
    expect(() => devtools.attachCrashReporting()).not.toThrow();
  });

  it("wrapFetch without init returns the original function", () => {
    const original = async () => ({ status: 200 });
    expect(devtools.wrapFetch(original as any, "test")).toBe(original);
  });
});

describe("truncateForWire", () => {
  it("truncates long strings", () => {
    const result = truncateForWire("x".repeat(30000)) as string;
    expect(result.length).toBeLessThan(30000);
    expect(result).toContain("truncated");
  });

  it("handles circular references", () => {
    const obj: any = { a: 1 };
    obj.self = obj;
    expect(() => truncateForWire(obj)).not.toThrow();
  });
});

describe("redactHeaders", () => {
  it("redacts sensitive headers", () => {
    const result = redactHeaders({
      Authorization: "Bearer secret",
      "x-api-key": "key",
      Accept: "application/json",
    });
    expect(result.Authorization).toBe("•••redacted•••");
    expect(result["x-api-key"]).toBe("•••redacted•••");
    expect(result.Accept).toBe("application/json");
  });
});
