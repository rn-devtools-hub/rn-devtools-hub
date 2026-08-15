import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error untyped CLI module
import { createFramer, createBridge, isHubReachable, discoverHubPort, hubServesProject } from "../src/cli/stdio.mjs";

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

/**
 * The bridge knew exactly one port, the default, so a hub that had to fall
 * back to another one was invisible to its own bridge: a SECOND hub got
 * started for the same project, and the agent then drove a hub with no
 * device attached while the real one sat next to it.
 */
describe("discoverHubPort", () => {
  const discover = discoverHubPort as (cwd: string) => number | null;

  const projectWith = (contents: string | null): string => {
    const root = mkdtempSync(join(tmpdir(), "rn-devtools-discovery-"));
    if (contents !== null) {
      mkdirSync(join(root, ".rn-devtools"), { recursive: true });
      writeFileSync(join(root, ".rn-devtools", "hub.json"), contents);
    }
    return root;
  };

  it("reads the port the hub recorded for this project", () => {
    expect(discover(projectWith(JSON.stringify({ port: 8975, pid: 42 })))).toBe(8975);
  });

  it("answers null when no hub has ever run here", () => {
    expect(discover(projectWith(null))).toBeNull();
  });

  it("answers null rather than throwing on a truncated file", () => {
    expect(discover(projectWith('{"port": 89'))).toBeNull();
  });

  it("refuses a port that is not one", () => {
    expect(discover(projectWith(JSON.stringify({ port: "eight" })))).toBeNull();
    expect(discover(projectWith(JSON.stringify({ port: 0 })))).toBeNull();
    expect(discover(projectWith(JSON.stringify({ port: 99999 })))).toBeNull();
  });
});

/**
 * "Something answered on that port" and "my project's hub answered" are
 * two different facts, and treating them as one is an agent driving the
 * wrong app while every answer looks perfectly normal. Two ordinary ways
 * in: project A is killed with -9 and leaves its hub.json behind while
 * project B's hub falls back onto that exact port, or A's hub is simply
 * off and the bridge falls back to 8973 where B has been sitting.
 */
describe("hubServesProject", () => {
  const serves = hubServesProject as (
    port: number,
    cwd: string,
    fetchImpl?: any
  ) => Promise<boolean>;

  const hubAnswering = (directory: string | null, ok = true) => async () => ({
    ok,
    json: async () => ({
      jsonrpc: "2.0",
      id: "whoami",
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              project: { name: "app", directory, port: 8973 },
              devices: [],
            }),
          },
        ],
      },
    }),
  });

  it("accepts the hub launched from this very directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "rn-devtools-identity-"));
    expect(await serves(8973, root, hubAnswering(root))).toBe(true);
  });

  it("refuses a hub serving another project on the same port", async () => {
    const mine = mkdtempSync(join(tmpdir(), "rn-devtools-mine-"));
    const other = mkdtempSync(join(tmpdir(), "rn-devtools-other-"));
    expect(await serves(8973, mine, hubAnswering(other))).toBe(false);
  });

  it("sees through a symlinked or unnormalised spelling of the same directory", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "rn-devtools-path-")));
    // The hub reports its resolved cwd; the bridge may be started with a
    // path that resolves to it, which on macOS is /tmp against /private/tmp
    expect(await serves(8973, `${root}/.`, hubAnswering(root))).toBe(true);
  });

  it("refuses when the answer names no project at all", async () => {
    const root = mkdtempSync(join(tmpdir(), "rn-devtools-empty-"));
    expect(await serves(8973, root, hubAnswering(null))).toBe(false);
  });

  it("refuses a non-ok status and something that is not a hub", async () => {
    const root = mkdtempSync(join(tmpdir(), "rn-devtools-noise-"));
    expect(await serves(8973, root, hubAnswering(root, false))).toBe(false);
    expect(
      await serves(8973, root, async () => ({ ok: true, json: async () => ({ result: {} }) }))
    ).toBe(false);
  });

  it("refuses a refused connection rather than throwing", async () => {
    const root = mkdtempSync(join(tmpdir(), "rn-devtools-down-"));
    expect(
      await serves(8973, root, async () => {
        throw new Error("ECONNREFUSED");
      })
    ).toBe(false);
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
