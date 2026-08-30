import { describe, expect, it } from "vitest";
// @ts-expect-error untyped hub module
import * as assertModule from "../server/assert.mjs";

interface Verdict {
  ok: boolean;
  reason: string | null;
  kind: string;
  checked: Record<string, unknown>;
  evidence: Array<Record<string, unknown>>;
  elapsedMs: number;
  hint: string | null;
}

const { selectWindow, evaluateEventAssertion, evaluateElementAssertion, runAssert } =
  assertModule as {
    selectWindow: (history: unknown[], options?: Record<string, unknown>) => Array<Record<string, any>>;
    evaluateEventAssertion: (
      kind: string,
      events: unknown[],
      options?: Record<string, unknown>
    ) => { ok: boolean; evidence: Array<Record<string, unknown>>; checked: Record<string, unknown> };
    evaluateElementAssertion: (
      kind: string,
      result: unknown,
      options?: Record<string, unknown>
    ) => {
      ok: boolean;
      matches: Array<Record<string, unknown>>;
      // kind:count only
      count?: number;
      expected?: { equals: number | null; min: number | null; max: number | null };
    };
    runAssert: (args: Record<string, unknown>, deps: Record<string, unknown>) => Promise<Verdict>;
  };

const event = (type: string, payload: unknown, seq: number, ts = 1000) => ({ type, payload, seq, ts });

describe("selectWindow", () => {
  const history = [
    event("console", { level: "log" }, 1, 1000),
    event("network.response", { status: 200 }, 2, 2000),
    event("crash", { message: "boom" }, 3, 3000),
  ];

  it("takes everything after a cursor when one is given", () => {
    expect(selectWindow(history, { since: 1 }).map((entry) => entry.seq)).toEqual([2, 3]);
  });

  it("treats cursor 0 as a cursor, not as absent", () => {
    expect(selectWindow(history, { since: 0 })).toHaveLength(3);
  });

  it("falls back to a trailing time window without a cursor", () => {
    expect(selectWindow(history, { windowMs: 1500, now: 3000 }).map((entry) => entry.seq)).toEqual([2, 3]);
  });

  it("tolerates a missing history", () => {
    expect(selectWindow(undefined as unknown as unknown[], { since: 0 })).toEqual([]);
  });
});

describe("evaluateEventAssertion", () => {
  it("passes network_ok when every response is under 400", () => {
    const verdict = evaluateEventAssertion("network_ok", [
      event("network.response", { status: 200, url: "https://api/x" }, 1),
      event("network.response", { status: 304, url: "https://api/y" }, 2),
    ]);
    expect(verdict.ok).toBe(true);
    expect(verdict.evidence).toEqual([]);
  });

  it("fails network_ok on a 500 and carries the request as evidence", () => {
    const verdict = evaluateEventAssertion("network_ok", [
      event("network.response", { status: 500, url: "https://api/orders" }, 7),
    ]);
    expect(verdict.ok).toBe(false);
    expect(verdict.evidence[0]).toMatchObject({ seq: 7 });
  });

  it("fails network_ok on a transport error with no status at all", () => {
    const verdict = evaluateEventAssertion("network_ok", [
      event("network.error", { url: "https://api/orders", message: "offline" }, 3),
    ]);
    expect(verdict.ok).toBe(false);
  });

  it("scopes network_ok to matching URLs", () => {
    const events = [
      event("network.response", { status: 500, url: "https://analytics/beacon" }, 1),
      event("network.response", { status: 200, url: "https://api/orders" }, 2),
    ];
    expect(evaluateEventAssertion("network_ok", events, { urlContains: "api/orders" }).ok).toBe(true);
    expect(evaluateEventAssertion("network_ok", events).ok).toBe(false);
  });

  it("counts only console events for no_console_error", () => {
    const verdict = evaluateEventAssertion("no_console_error", [
      event("console", { level: "warn", args: ["careful"] }, 1),
      event("crash", { message: "unrelated" }, 2),
    ]);
    expect(verdict.ok).toBe(true);
    expect(verdict.checked.events).toBe(1);
  });

  it("fails no_console_error on an error level", () => {
    const verdict = evaluateEventAssertion("no_console_error", [
      event("console", { level: "error", args: ["render failed"] }, 4),
    ]);
    expect(verdict.ok).toBe(false);
    expect(verdict.evidence).toHaveLength(1);
  });

  it("tolerates known noise through ignore", () => {
    const events = [event("console", { level: "error", args: ["VirtualizedList: warned"] }, 1)];
    expect(evaluateEventAssertion("no_console_error", events, { ignore: ["VirtualizedList"] }).ok).toBe(true);
  });

  it("fails no_crash on an unhandled rejection", () => {
    const verdict = evaluateEventAssertion("no_crash", [
      event("crash", { kind: "unhandledRejection", message: "nope" }, 9),
    ]);
    expect(verdict.ok).toBe(false);
    expect(verdict.evidence[0]).toMatchObject({ seq: 9 });
  });

  it("caps the evidence instead of returning the whole history", () => {
    const many = Array.from({ length: 40 }, (_, index) =>
      event("crash", { message: `boom ${index}` }, index)
    );
    expect(evaluateEventAssertion("no_crash", many).evidence).toHaveLength(10);
  });

  it("rejects an unknown kind", () => {
    expect(() => evaluateEventAssertion("no_such_kind", [])).toThrow(/Unknown event assertion/);
  });
});

describe("evaluateElementAssertion", () => {
  const result = { matches: [{ text: "Commande confirmée", testID: "confirm" }] };

  it("passes visible on a match and fails absent on the same match", () => {
    expect(evaluateElementAssertion("visible", result).ok).toBe(true);
    expect(evaluateElementAssertion("absent", result).ok).toBe(false);
  });

  it("passes absent on an empty result", () => {
    expect(evaluateElementAssertion("absent", { matches: [] }).ok).toBe(true);
  });

  it("matches text on a substring by default and exactly on demand", () => {
    expect(evaluateElementAssertion("text", result, { value: "confirmée" }).ok).toBe(true);
    expect(evaluateElementAssertion("text", result, { value: "confirmée", exact: true }).ok).toBe(false);
    expect(
      evaluateElementAssertion("text", result, { value: "Commande confirmée", exact: true }).ok
    ).toBe(true);
  });

  it("returns the candidates as evidence when the text does not match", () => {
    const verdict = evaluateElementAssertion("text", result, { value: "absent" });
    expect(verdict.ok).toBe(false);
    expect(verdict.matches).toHaveLength(1);
  });
});

describe("evaluateElementAssertion, kind count", () => {
  const list = (n: number) => ({ matches: Array.from({ length: n }, (_, i) => ({ testID: `zone-${i}` })) });

  it("compares against equals, and reports the observed count either way", () => {
    expect(evaluateElementAssertion("count", list(5), { equals: 5 }).ok).toBe(true);
    const missed = evaluateElementAssertion("count", list(4), { equals: 5 });
    expect(missed.ok).toBe(false);
    expect(missed.count).toBe(4);
  });

  it("composes min and max, and holds on the bounds", () => {
    expect(evaluateElementAssertion("count", list(3), { min: 1, max: 5 }).ok).toBe(true);
    expect(evaluateElementAssertion("count", list(1), { min: 1, max: 5 }).ok).toBe(true);
    expect(evaluateElementAssertion("count", list(5), { min: 1, max: 5 }).ok).toBe(true);
    expect(evaluateElementAssertion("count", list(6), { min: 1, max: 5 }).ok).toBe(false);
    expect(evaluateElementAssertion("count", list(0), { min: 1 }).ok).toBe(false);
  });

  it("lets equals win over min and max rather than intersecting them", () => {
    // A caller that sends all three means the exact number; silently
    // ANDing a stale min would fail an assertion that is actually right
    expect(evaluateElementAssertion("count", list(2), { equals: 2, min: 5, max: 9 }).ok).toBe(true);
  });

  it("proves an empty list with equals zero, which absent cannot express per item", () => {
    expect(evaluateElementAssertion("count", list(0), { equals: 0 }).ok).toBe(true);
  });
});

describe("runAssert", () => {
  const clock = (start = 0) => {
    let value = start;
    return {
      now: () => value,
      sleep: async (ms: number) => {
        value += ms;
      },
      advance: (ms: number) => {
        value += ms;
      },
    };
  };

  it("retries an element assertion until it succeeds", async () => {
    const time = clock();
    let calls = 0;
    const verdict = await runAssert(
      { kind: "visible", by: "testID", value: "confirm" },
      {
        now: time.now,
        sleep: time.sleep,
        history: () => [],
        queryUi: async () => {
          calls += 1;
          return { matches: calls >= 3 ? [{ testID: "confirm" }] : [] };
        },
      }
    );
    expect(verdict.ok).toBe(true);
    expect(verdict.checked.attempts).toBe(3);
  });

  it("retries a count until the list has finished rendering", async () => {
    const time = clock();
    let calls = 0;
    const verdict = await runAssert(
      { kind: "count", by: "testID", value: "zone", equals: 5 },
      {
        now: time.now,
        sleep: time.sleep,
        history: () => [],
        queryUi: async () => {
          calls += 1;
          // the list streams in: 2 rows, then 5
          return { matches: Array.from({ length: calls >= 3 ? 5 : 2 }, () => ({ testID: "zone" })) };
        },
      }
    );
    expect(verdict.ok).toBe(true);
    expect(verdict.checked.count).toBe(5);
    expect(verdict.checked.attempts).toBe(3);
  });

  it("carries the observed count in the failed verdict, so no second call is needed", async () => {
    const time = clock();
    const verdict = await runAssert(
      { kind: "count", by: "testID", value: "zone", equals: 5, timeoutMs: 600 },
      {
        now: time.now,
        sleep: time.sleep,
        history: () => [],
        queryUi: async () => ({ matches: [{ testID: "zone" }, { testID: "zone" }] }),
      }
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.checked.count).toBe(2);
    expect(verdict.checked.expected).toEqual({ equals: 5, min: null, max: null });
    expect(verdict.hint).toMatch(/checked\.count/);
  });

  it("refuses a count with no bound, which would pass on any number", async () => {
    await expect(
      runAssert(
        { kind: "count", by: "testID", value: "zone" },
        { history: () => [], queryUi: async () => ({ matches: [] }) }
      )
    ).rejects.toThrow(/equals, min, max/);
  });

  it("queries far beyond ten, so a long list is not counted as ten", async () => {
    const time = clock();
    let asked = 0;
    await runAssert(
      { kind: "count", by: "testID", value: "zone", min: 40 },
      {
        now: time.now,
        sleep: time.sleep,
        history: () => [],
        queryUi: async (selector: { limit: number }) => {
          asked = selector.limit;
          return { matches: Array.from({ length: 40 }, () => ({ testID: "zone" })) };
        },
      }
    );
    expect(asked).toBeGreaterThan(40);
  });

  it("gives up at the deadline and attaches a hint", async () => {
    const time = clock();
    const verdict = await runAssert(
      { kind: "visible", by: "testID", value: "never", timeoutMs: 600 },
      { now: time.now, sleep: time.sleep, history: () => [], queryUi: async () => ({ matches: [] }) }
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.hint).toMatch(/query_ui/);
    expect(verdict.elapsedMs).toBeGreaterThanOrEqual(600);
  });

  /**
   * A failed assertion is a failed tool call, and the hub groups failures
   * by their reason. The hint is written for a human and differs per kind,
   * so without a stable reason one fact turned into as many buckets as
   * there are kinds of advice.
   */
  it("names its failure the same way whatever the kind, and stays quiet on success", async () => {
    const time = clock();
    const failed = await runAssert(
      { kind: "visible", by: "testID", value: "never", timeoutMs: 0 },
      { now: time.now, sleep: time.sleep, history: () => [], queryUi: async () => ({ matches: [] }) }
    );
    const failedEvent = await runAssert(
      { kind: "no_crash", since: 0 },
      { now: time.now, sleep: time.sleep, history: () => [event("crash", { message: "boom" }, 1)], queryUi: async () => ({ matches: [] }) }
    );
    const passed = await runAssert(
      { kind: "visible", by: "testID", value: "ok", timeoutMs: 0 },
      { now: time.now, sleep: time.sleep, history: () => [], queryUi: async () => ({ matches: [{ testID: "ok" }] }) }
    );
    expect(failed.reason).toBe("assertion-failed");
    expect(failedEvent.reason).toBe("assertion-failed");
    expect(passed.reason).toBeNull();
  });

  it("tries an element assertion at least once even with a zero deadline", async () => {
    const time = clock();
    const verdict = await runAssert(
      { kind: "visible", by: "testID", value: "confirm", timeoutMs: 0 },
      {
        now: time.now,
        sleep: time.sleep,
        history: () => [],
        queryUi: async () => ({ matches: [{ testID: "confirm" }] }),
      }
    );
    expect(verdict.ok).toBe(true);
    expect(verdict.checked.attempts).toBe(1);
  });

  it("does not retry an event assertion", async () => {
    const time = clock();
    let reads = 0;
    const verdict = await runAssert(
      { kind: "no_crash", since: 0 },
      {
        now: time.now,
        sleep: time.sleep,
        history: () => {
          reads += 1;
          return [event("crash", { message: "boom" }, 1)];
        },
        queryUi: async () => ({ matches: [] }),
      }
    );
    expect(reads).toBe(1);
    expect(verdict.ok).toBe(false);
  });

  it("waits settleMs before judging an event assertion", async () => {
    const time = clock();
    const verdict = await runAssert(
      { kind: "network_ok", since: 0, settleMs: 1200 },
      { now: time.now, sleep: time.sleep, history: () => [], queryUi: async () => ({ matches: [] }) }
    );
    expect(verdict.ok).toBe(true);
    expect(verdict.elapsedMs).toBe(1200);
  });

  it("requires a selector for element kinds", async () => {
    await expect(
      runAssert({ kind: "visible" }, { history: () => [], queryUi: async () => ({ matches: [] }) })
    ).rejects.toThrow(/needs a selector/);
  });

  it("rejects an unknown kind with the list of valid ones", async () => {
    await expect(
      runAssert({ kind: "teleports" }, { history: () => [], queryUi: async () => ({ matches: [] }) })
    ).rejects.toThrow(/no_crash/);
  });

  it("returns no evidence when the assertion passes", async () => {
    const verdict = await runAssert(
      { kind: "no_console_error", since: 0 },
      { history: () => [event("console", { level: "log" }, 1)], queryUi: async () => ({ matches: [] }) }
    );
    expect(verdict.ok).toBe(true);
    expect(verdict.evidence).toEqual([]);
    expect(verdict.hint).toBeNull();
  });
});
