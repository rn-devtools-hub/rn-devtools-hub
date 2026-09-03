/**
 * Transport tests: ring buffer, batching, commands, no-op before init
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { DevtoolsTransport } from "../src/client/transport";
import { devtools } from "../src/client/index";
import {
  truncateForWire,
  redactHeaders,
  redactBody,
  redactSecrets,
  isSensitiveKey,
} from "../src/client/types";

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

  it("heartbeats an open socket and reconnects a half-open one", () => {
    const now = 2_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const transport = makeTransport();
    transport.start();
    const ws = FakeWebSocket.instances[0];
    ws.simulateOpen();
    ws.sent = [];

    (transport as any).checkConnection();
    expect(JSON.parse(ws.sent[0])).toMatchObject({ kind: "ping", ts: now });

    ws.onmessage?.({ data: JSON.stringify({ kind: "pong", ts: now }) });
    (transport as any).lastServerActivity = now - 16_000;
    (transport as any).checkConnection();
    expect(ws.readyState).toBe(3);
    expect(transport.isConnected).toBe(false);
    transport.stop();
    vi.restoreAllMocks();
  });

  it("treats a pong as server activity after returning from suspension", () => {
    const transport = makeTransport();
    transport.start();
    const ws = FakeWebSocket.instances[0];
    ws.simulateOpen();
    (transport as any).lastServerActivity = 1;
    ws.onmessage?.({ data: JSON.stringify({ kind: "pong", ts: Date.now() }) });
    expect((transport as any).heartbeatConfirmed).toBe(true);
    expect((transport as any).lastServerActivity).toBeGreaterThan(1);
    transport.stop();
  });

  it("keeps compatibility with an older hub that ignores heartbeats", () => {
    const now = 3_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const transport = makeTransport();
    transport.start();
    const ws = FakeWebSocket.instances[0];
    ws.simulateOpen();
    (transport as any).lastServerActivity = now - 60_000;
    (transport as any).checkConnection();
    expect(ws.readyState).toBe(1);
    transport.stop();
    vi.restoreAllMocks();
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

/**
 * The buffer was bounded by a count, so a thousand small events and a
 * thousand twenty-kilobyte network responses were both "one batch": after
 * a disconnection the whole backlog was serialized in a single call on
 * the JS thread.
 */
describe("batch size", () => {
  const big = (bytes: number) => "x".repeat(bytes);

  it("splits a backlog over several sends instead of one burst", () => {
    const transport = new DevtoolsTransport({
      serverUrl: "ws://test:1",
      appName: "test-app",
      maxBufferSize: 50,
      flushIntervalMs: 999999,
      maxBatchBytes: 4096,
    });
    transport.start();
    FakeWebSocket.instances[0].simulateOpen();
    FakeWebSocket.instances[0].sent.length = 0;

    for (let index = 0; index < 10; index += 1) transport.enqueue("network.response", { body: big(2000) });
    transport.flush();

    const sent = FakeWebSocket.instances[0].sent;
    expect(sent).toHaveLength(1);
    expect(sent[0].length).toBeLessThan(8000);
    expect(transport.bufferedCount).toBeGreaterThan(0);
    expect(JSON.parse(sent[0]).events.length).toBeLessThan(10);
  });

  it("sends a single oversized event rather than stalling on it forever", () => {
    const transport = new DevtoolsTransport({
      serverUrl: "ws://test:1",
      appName: "test-app",
      maxBufferSize: 50,
      flushIntervalMs: 999999,
      maxBatchBytes: 1024,
    });
    transport.start();
    FakeWebSocket.instances[0].simulateOpen();
    FakeWebSocket.instances[0].sent.length = 0;

    transport.enqueue("screen.frame", { data: big(5000) });
    transport.flush();
    expect(JSON.parse(FakeWebSocket.instances[0].sent[0]).events).toHaveLength(1);
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

/**
 * Only four header names were ever redacted, and the bodies went out
 * whole: a login response carrying an access token reached the hub, the
 * dashboard and, through MCP, a model's context window. Truncating a
 * payload is not redacting it.
 */
describe("redacting credentials", () => {
  it("names a credential by the words in the key, not by substring", () => {
    for (const key of ["password", "accessToken", "client_secret", "x-api-key", "apiKey", "Cookie"]) {
      expect(isSensitiveKey(key)).toBe(true);
    }
    // The false positives that would blind the network panel
    for (const key of ["author", "authority", "key", "name", "keyboard", "tokenizer_version"]) {
      expect(isSensitiveKey(key)).toBe(false);
    }
  });

  it("takes a project's own field names on top of the built-in list", () => {
    expect(isSensitiveKey("kontakCode")).toBe(false);
    expect(isSensitiveKey("kontakCode", ["kontakCode"])).toBe(true);
  });

  it("redacts nested credentials and says which paths it took out", () => {
    const { value, redacted } = redactSecrets({
      user: { id: 7, name: "Ana", password: "hunter2" },
      auth: { accessToken: "abc", expiresIn: 3600 },
      items: [{ label: "ok" }, { apiKey: "sk_live_0123456789" }],
    });
    const out = value as any;
    expect(out.user.name).toBe("Ana");
    expect(out.user.id).toBe(7);
    expect(out.user.password).toBe("•••redacted•••");
    expect(out.auth.accessToken).toBe("•••redacted•••");
    expect(out.auth.expiresIn).toBe(3600);
    expect(out.items[1].apiKey).toBe("•••redacted•••");
    expect(redacted).toContain("user.password");
    expect(redacted).toContain("items[1].apiKey");
  });

  it("redacts a token whatever the field is called", () => {
    const { value } = redactSecrets({
      data: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature",
      note: "a plain sentence",
    });
    expect((value as any).data).toBe("•••redacted•••");
    expect((value as any).note).toBe("a plain sentence");
  });

  it("redacts a JSON body that arrived as a string, and keeps it JSON", () => {
    const body = JSON.stringify({ email: "a@b.c", password: "hunter2" });
    const { value, redacted } = redactBody(body);
    expect(redacted).toEqual(["password"]);
    const parsed = JSON.parse(value as string);
    expect(parsed.email).toBe("a@b.c");
    expect(parsed.password).toBe("•••redacted•••");
  });

  it("redacts a form-encoded body", () => {
    const { value } = redactBody("grant_type=password&username=ana&password=hunter2");
    expect(value).toBe("grant_type=password&username=ana&password=•••redacted•••");
  });

  it("leaves a body that holds no credential untouched", () => {
    const body = JSON.stringify({ items: [1, 2, 3] });
    expect(redactBody(body)).toEqual({ value: body, redacted: [] });
  });

  it("survives a circular payload", () => {
    const payload: any = { password: "x" };
    payload.self = payload;
    expect(() => redactSecrets(payload)).not.toThrow();
  });
});

/**
 * Silent corruption is the failure this prevents.
 *
 * A base64 frame sent with emit was truncated at 20 KB, which yields an
 * undecodable JPEG and a blank mirror with no error anywhere. Asking every
 * caller to remember emitRaw is a rule that gets forgotten, by a person or
 * by an agent, so the SDK keeps protocol binary types whole and says so
 * when it truncates anything else unexpectedly.
 */
describe("emit and binary payloads", () => {
  const bigBase64 = "A".repeat(60000);

  it("keeps a screen frame whole", () => {
    devtools.stop();
    devtools.init({ serverUrl: "ws://127.0.0.1:1", appName: "test" });
    devtools.emit("screen.frame", { base64: bigBase64 });
    const queued = devtools.__transport!["buffer" as never] as unknown as Array<{
      type: string;
      payload: { base64: string };
    }>;
    const frame = queued.find((event) => event.type === "screen.frame");
    expect(frame!.payload.base64.length).toBe(60000);
    expect(frame!.payload.base64).not.toContain("[truncated");
    devtools.stop();
  });

  it("warns once, with the fix, when it truncates something else", () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (message: string) => warnings.push(String(message));
    try {
      devtools.stop();
      devtools.init({ serverUrl: "ws://127.0.0.1:1", appName: "test" });
      devtools.emit("my.custom", { blob: bigBase64 });
      devtools.emit("my.custom", { blob: bigBase64 });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("emitRaw");
      expect(warnings[0]).toContain("my.custom");
    } finally {
      console.warn = original;
      devtools.stop();
    }
  });
});
