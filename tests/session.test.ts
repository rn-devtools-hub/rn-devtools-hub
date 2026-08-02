import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error untyped hub module
import * as sessionModule from "../server/session.mjs";

interface TimelineEntry {
  t: number | null;
  seq: number | null;
  type: string;
  summary: string;
}

interface SessionExport {
  session: Record<string, unknown>;
  summary: {
    requests: number;
    failedRequests: number;
    crashes: number;
    consoleErrors: number;
    screens: string[];
  };
  crashes: Array<Record<string, unknown>>;
  failedRequests: Array<Record<string, unknown>>;
  consoleErrors: Array<Record<string, unknown>>;
  timeline: TimelineEntry[];
}

const { openSession, parseSessionFile, summarizeEvent, buildSessionExport, renderSessionMarkdown, sessionIdFor } =
  sessionModule as {
    openSession: (root: string, deviceId: string, meta?: Record<string, unknown>) => { id: string; file: string } | null;
    parseSessionFile: (raw: string) => { meta: Record<string, unknown>; events: Array<Record<string, any>> };
    summarizeEvent: (event: Record<string, unknown>) => string;
    buildSessionExport: (meta: unknown, events: unknown) => SessionExport;
    renderSessionMarkdown: (exported: SessionExport) => string;
    sessionIdFor: (deviceId: string, startedAt: number) => string;
  };

const event = (type: string, payload: unknown, seq: number, ts: number) => ({
  kind: "event",
  type,
  payload,
  seq,
  ts,
});

describe("sessionIdFor", () => {
  it("leads with a sortable timestamp and strips unsafe characters", () => {
    const id = sessionIdFor("s-abc:def/../x", Date.UTC(2026, 7, 1, 12, 30, 0));
    expect(id.startsWith("2026-08-01T12-30-00")).toBe(true);
    expect(id).not.toMatch(/[:/.]/);
  });
});

describe("parseSessionFile", () => {
  it("separates the header from the events", () => {
    const raw = [
      JSON.stringify({ kind: "meta", id: "s1", appName: "shop" }),
      JSON.stringify(event("console", { level: "log" }, 1, 100)),
    ].join("\n");
    const parsed = parseSessionFile(raw);
    expect(parsed.meta.appName).toBe("shop");
    expect(parsed.events).toHaveLength(1);
  });

  it("drops a truncated trailing line instead of failing the read", () => {
    const raw = `${JSON.stringify({ kind: "meta", id: "s1" })}\n{"kind":"event","type":"cra`;
    expect(parseSessionFile(raw).events).toEqual([]);
    expect(parseSessionFile(raw).meta.id).toBe("s1");
  });

  it("tolerates an empty or absent file", () => {
    expect(parseSessionFile("")).toEqual({ meta: {}, events: [] });
    expect(parseSessionFile(undefined as unknown as string).events).toEqual([]);
  });
});

describe("summarizeEvent", () => {
  it("renders one scannable line per event type", () => {
    expect(summarizeEvent(event("network.request", { method: "POST", url: "/orders" }, 1, 0))).toBe(
      "POST /orders"
    );
    expect(summarizeEvent(event("network.response", { status: 201, durationMs: 42, requestId: 3 }, 2, 0))).toContain(
      "201 in 42 ms"
    );
    expect(summarizeEvent(event("crash", { kind: "fatal", message: "boom" }, 3, 0))).toBe("fatal: boom");
    expect(summarizeEvent(event("screen.ready", { screen: "Orders" }, 4, 0))).toBe("screen ready: Orders");
  });

  it("truncates a long URL rather than blowing up the timeline", () => {
    const long = `https://api.example.com/${"x".repeat(400)}`;
    expect(summarizeEvent(event("network.request", { method: "GET", url: long }, 1, 0))).toContain("…");
  });

  it("falls back to a bounded payload dump for unknown types", () => {
    expect(summarizeEvent(event("custom.thing", { a: 1 }, 1, 0))).toContain("\"a\":1");
  });
});

describe("buildSessionExport", () => {
  const meta = { id: "s1", deviceId: "d1", appName: "shop", deviceName: "iPhone", startedAt: 1000 };
  const events = [
    event("app.info", { appName: "shop", deviceName: "iPhone" }, 1, 1000),
    event("screen.ready", { screen: "Home" }, 2, 1500),
    event("network.request", { requestId: 1, method: "POST", url: "https://api/orders", origin: ["at useOrders (src/hooks/useOrders.ts:31)"] }, 3, 2000),
    event("network.response", { requestId: 1, status: 500, durationMs: 120 }, 4, 2120),
    event("console", { level: "error", args: ["render failed"] }, 5, 2200),
    event("crash", { kind: "fatal", message: "undefined is not an object", stack: "at Foo\nat Bar" }, 6, 2500),
  ];

  it("correlates requests with their responses across events", () => {
    const exported = buildSessionExport(meta, events);
    expect(exported.summary.requests).toBe(1);
    expect(exported.summary.failedRequests).toBe(1);
    expect(exported.failedRequests[0]).toMatchObject({ status: 500, method: "POST" });
  });

  it("keeps the call site that fired a failed request", () => {
    const exported = buildSessionExport(meta, events);
    expect(exported.failedRequests[0].origin).toEqual([
      "at useOrders (src/hooks/useOrders.ts:31)",
    ]);
  });

  it("puts everything on one clock relative to the session start", () => {
    const exported = buildSessionExport(meta, events);
    expect(exported.timeline[0].t).toBe(0);
    expect(exported.timeline[exported.timeline.length - 1].t).toBe(1500);
  });

  it("counts crashes and console errors separately", () => {
    const exported = buildSessionExport(meta, events);
    expect(exported.summary.crashes).toBe(1);
    expect(exported.summary.consoleErrors).toBe(1);
    expect(exported.crashes[0].stack).toContain("at Foo");
  });

  it("collects the screens the run went through, without duplicates", () => {
    const exported = buildSessionExport(meta, [
      ...events,
      event("screen.ready", { screen: "Home" }, 7, 3000),
      event("screen.ready", { screen: "Orders" }, 8, 3200),
    ]);
    expect(exported.summary.screens).toEqual(["Home", "Orders"]);
  });

  it("treats a 4xx as a failure and a 3xx as a success", () => {
    const exported = buildSessionExport(meta, [
      event("network.request", { requestId: 1, method: "GET", url: "/a" }, 1, 1000),
      event("network.response", { requestId: 1, status: 404 }, 2, 1100),
      event("network.request", { requestId: 2, method: "GET", url: "/b" }, 3, 1200),
      event("network.response", { requestId: 2, status: 304 }, 4, 1300),
    ]);
    expect(exported.summary.failedRequests).toBe(1);
  });

  it("counts a transport error with no status as a failure", () => {
    const exported = buildSessionExport(meta, [
      event("network.request", { requestId: 1, method: "GET", url: "/a" }, 1, 1000),
      event("network.error", { requestId: 1, message: "offline" }, 2, 1100),
    ]);
    expect(exported.summary.failedRequests).toBe(1);
    expect(exported.failedRequests[0].message).toBe("offline");
  });

  it("survives an empty session", () => {
    const exported = buildSessionExport({ id: "s0" }, []);
    expect(exported.session.eventCount).toBe(0);
    expect(exported.timeline).toEqual([]);
    expect(exported.summary.failedRequests).toBe(0);
  });

  it("derives the start from the first event when the header has none", () => {
    const exported = buildSessionExport({}, events);
    expect(exported.session.startedAt).toBe(1000);
    expect(exported.session.durationMs).toBe(1500);
  });
});

describe("renderSessionMarkdown", () => {
  const exported = buildSessionExport(
    { id: "s1", appName: "shop", deviceName: "iPhone", startedAt: 0 },
    [
      event("network.request", { requestId: 1, method: "POST", url: "/orders", origin: ["at useOrders (src/hooks/useOrders.ts:31)"] }, 1, 0),
      event("network.error", { requestId: 1, message: "offline" }, 2, 500),
      event("crash", { kind: "fatal", message: "boom", stack: "at Foo" }, 3, 1000),
    ]
  );

  it("opens with the facts an issue needs", () => {
    const markdown = renderSessionMarkdown(exported);
    expect(markdown).toContain("# Session s1");
    expect(markdown).toContain("shop on iPhone");
    expect(markdown).toContain("Requests: 1 (1 failed)");
  });

  it("shows the crash stack in a fenced block", () => {
    const markdown = renderSessionMarkdown(exported);
    expect(markdown).toContain("## Crashes");
    expect(markdown).toContain("at Foo");
  });

  it("names the call site of a failed request", () => {
    expect(renderSessionMarkdown(exported)).toContain("fired from: at useOrders");
  });

  it("renders the timeline as an aligned block", () => {
    const markdown = renderSessionMarkdown(exported);
    expect(markdown).toContain("## Timeline");
    expect(markdown).toMatch(/0\.0s\s+network\.request/);
  });

  it("omits empty sections instead of printing empty headers", () => {
    const clean = renderSessionMarkdown(buildSessionExport({ id: "s2", startedAt: 0 }, []));
    expect(clean).not.toContain("## Crashes");
    expect(clean).not.toContain("## Failed requests");
  });
});

/**
 * The hub writes into the HOST project. A user who never runs init, or
 * who upgraded into persistence, would find sessions and PNG baselines in
 * git status, and some would commit them. The directory has to ignore
 * itself, because that needs no cooperation and cannot go stale.
 */
describe("artifact directory", () => {
  it("makes itself invisible to git on creation", () => {
    const root = mkdtempSync(join(tmpdir(), "rn-devtools-test-"));
    try {
      const opened = openSession(root, "d1", { appName: "test" });
      expect(opened).not.toBeNull();
      const marker = join(root, ".rn-devtools", ".gitignore");
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, "utf-8")).toContain("*");
      expect(existsSync(opened!.file)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
