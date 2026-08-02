import { describe, expect, it } from "vitest";
// @ts-expect-error untyped CLI module
import { createFramer, createBridge, isHubReachable } from "../src/cli/stdio.mjs";

const framer = createFramer as () => (chunk: string) => Array<Record<string, any>>;
const bridge = createBridge as (io: {
  post: (message: any) => Promise<any>;
  write: (value: any) => void;
}) => (chunk: string) => Promise<void>;
const reachable = isHubReachable as (port: number, fetchImpl?: any) => Promise<boolean>;

const request = (id: number | string, method = "tools/list") =>
  JSON.stringify({ jsonrpc: "2.0", id, method });

describe("createFramer", () => {
  it("reads several messages out of one chunk", () => {
    const frame = framer();
    expect(frame(`${request(1)}\n${request(2)}\n`)).toHaveLength(2);
  });

  it("holds a message split across chunks until it is complete", () => {
    const frame = framer();
    const whole = request(1);
    expect(frame(whole.slice(0, 12))).toEqual([]);
    expect(frame(`${whole.slice(12)}\n`)).toHaveLength(1);
  });

  it("keeps the remainder after a complete message", () => {
    const frame = framer();
    expect(frame(`${request(1)}\n{"jsonrpc":"2.0"`)).toHaveLength(1);
    expect(frame(`,"id":2,"method":"ping"}\n`)[0].id).toBe(2);
  });

  it("drops a malformed line without desynchronising the stream", () => {
    const frame = framer();
    const messages = frame(`not json\n${request(7)}\n`);
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe(7);
  });

  it("ignores blank lines", () => {
    expect(framer()("\n\n")).toEqual([]);
  });
});

describe("createBridge", () => {
  it("forwards a request and writes the answer back", async () => {
    const written: any[] = [];
    const handle = bridge({
      post: async (message) => ({ jsonrpc: "2.0", id: message.id, result: { tools: [] } }),
      write: (value) => written.push(value),
    });
    await handle(`${request(1)}\n`);
    expect(written).toEqual([{ jsonrpc: "2.0", id: 1, result: { tools: [] } }]);
  });

  it("answers nothing to a notification, as the protocol requires", async () => {
    const written: any[] = [];
    const handle = bridge({
      post: async () => undefined,
      write: (value) => written.push(value),
    });
    await handle(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    expect(written).toEqual([]);
  });

  it("still writes nothing for a notification the hub answered anyway", async () => {
    const written: any[] = [];
    const handle = bridge({
      post: async () => ({ jsonrpc: "2.0", result: {} }),
      write: (value) => written.push(value),
    });
    await handle(`${JSON.stringify({ jsonrpc: "2.0", method: "ping" })}\n`);
    expect(written).toEqual([]);
  });

  it("turns a transport failure into a JSON-RPC error, not a crash", async () => {
    const written: any[] = [];
    const handle = bridge({
      post: async () => {
        throw new Error("ECONNREFUSED");
      },
      write: (value) => written.push(value),
    });
    await handle(`${request(3)}\n`);
    expect(written[0]).toMatchObject({ id: 3, error: { code: -32603 } });
    expect(written[0].error.message).toContain("ECONNREFUSED");
  });

  it("stays silent when a notification fails", async () => {
    const written: any[] = [];
    const handle = bridge({
      post: async () => {
        throw new Error("gone");
      },
      write: (value) => written.push(value),
    });
    await handle(`${JSON.stringify({ jsonrpc: "2.0", method: "ping" })}\n`);
    expect(written).toEqual([]);
  });

  it("handles a batch arriving in a single chunk, in order", async () => {
    const written: any[] = [];
    const handle = bridge({
      post: async (message) => ({ jsonrpc: "2.0", id: message.id, result: message.method }),
      write: (value) => written.push(value),
    });
    await handle(`${request(1, "a")}\n${request(2, "b")}\n`);
    expect(written.map((entry) => entry.id)).toEqual([1, 2]);
  });
});

describe("isHubReachable", () => {
  it("is true when the hub answers a ping", async () => {
    expect(await reachable(8973, async () => ({ ok: true }))).toBe(true);
  });

  it("is false on a refused connection rather than throwing", async () => {
    expect(
      await reachable(8973, async () => {
        throw new Error("ECONNREFUSED");
      })
    ).toBe(false);
  });

  it("is false on a non-ok status", async () => {
    expect(await reachable(8973, async () => ({ ok: false }))).toBe(false);
  });
});
