import { afterEach, describe, expect, it } from "vitest";
import {
  createClock,
  createNetworkControl,
  conditionProfile,
  matchRule,
} from "../src/client/determinism";

const RealDate = Date;

afterEach(() => {
  globalThis.Date = RealDate;
});

describe("controlled clock", () => {
  it("pins Date.now and new Date() to the frozen instant", () => {
    const clock = createClock();
    clock.freeze("2026-08-01T12:00:00.000Z");
    expect(Date.now()).toBe(RealDate.parse("2026-08-01T12:00:00.000Z"));
    expect(new Date().toISOString()).toBe("2026-08-01T12:00:00.000Z");
  });

  it("keeps explicit dates, parse and UTC working", () => {
    const clock = createClock();
    clock.freeze("2026-08-01T12:00:00.000Z");
    expect(new Date("2020-01-02T03:04:05.000Z").toISOString()).toBe("2020-01-02T03:04:05.000Z");
    expect(Date.parse("2020-01-01T00:00:00.000Z")).toBe(RealDate.parse("2020-01-01T00:00:00.000Z"));
    expect(Date.UTC(2020, 0, 1)).toBe(RealDate.UTC(2020, 0, 1));
  });

  it("still produces real Date instances", () => {
    const clock = createClock();
    clock.freeze("2026-08-01T12:00:00.000Z");
    expect(new Date() instanceof RealDate).toBe(true);
  });

  it("advances only when frozen, and says so otherwise", () => {
    const clock = createClock();
    expect(() => clock.advance(1000)).toThrow(/not frozen/);
    clock.freeze("2026-08-01T12:00:00.000Z");
    const state = clock.advance(3600_000);
    expect(new Date(state.now!).toISOString()).toBe("2026-08-01T13:00:00.000Z");
    expect(Date.now()).toBe(state.now);
  });

  it("rejects an unparseable instant instead of freezing at NaN", () => {
    expect(() => createClock().freeze("last tuesday")).toThrow(/Unparseable/);
  });

  it("rejects a non-numeric advance", () => {
    const clock = createClock();
    clock.freeze();
    expect(() => clock.advance(Number.NaN)).toThrow(/milliseconds/);
  });

  it("gives the real clock back on restore", () => {
    const clock = createClock();
    clock.freeze("2026-08-01T12:00:00.000Z");
    clock.restore();
    expect(clock.state().frozen).toBe(false);
    expect(Math.abs(Date.now() - RealDate.now())).toBeLessThan(1000);
  });

  it("freezes at the current instant when given no argument", () => {
    const clock = createClock();
    const before = RealDate.now();
    const state = clock.freeze();
    expect(state.now).toBeGreaterThanOrEqual(before);
  });
});

describe("conditionProfile", () => {
  it("makes offline fail everything and normal fail nothing", () => {
    expect(conditionProfile("offline")).toEqual({ delayMs: 0, failureRate: 1 });
    expect(conditionProfile("normal")).toEqual({ delayMs: 0, failureRate: 0 });
  });

  it("slows 3g without failing, and makes flaky do both", () => {
    expect(conditionProfile("3g").failureRate).toBe(0);
    expect(conditionProfile("3g").delayMs).toBeGreaterThan(0);
    expect(conditionProfile("flaky").failureRate).toBeGreaterThan(0);
  });
});

describe("matchRule", () => {
  const rules = [
    { urlContains: "/orders", method: "POST", status: 500 },
    { urlContains: "/orders", status: 200 },
  ];

  it("returns the first match, so specific rules must come first", () => {
    expect(matchRule(rules, "https://api/orders", "POST")?.status).toBe(500);
    expect(matchRule(rules, "https://api/orders", "GET")?.status).toBe(200);
  });

  it("treats the method case-insensitively", () => {
    expect(matchRule(rules, "https://api/orders", "post")?.status).toBe(500);
  });

  it("matches every URL when no filter is given", () => {
    expect(matchRule([{ status: 204 }], "https://anything", "GET")?.status).toBe(204);
  });

  it("returns null when nothing matches", () => {
    expect(matchRule(rules, "https://api/users", "GET")).toBeNull();
  });
});

describe("network control", () => {
  it("stubs a status and a body through a rule", () => {
    const network = createNetworkControl();
    network.setRules([{ urlContains: "/orders", status: 201, body: { id: 1 } }]);
    const plan = network.plan("https://api/orders", "POST");
    expect(plan.mock).toEqual({ status: 201, body: { id: 1 } });
    expect(plan.fail).toBeNull();
  });

  it("fails everything while offline", () => {
    const network = createNetworkControl();
    network.setCondition("offline");
    expect(network.plan("https://api/a", "GET").fail).toContain("offline");
    expect(network.plan("https://api/b", "GET").fail).toContain("offline");
  });

  it("spaces flaky failures deterministically rather than randomly", () => {
    const first = createNetworkControl();
    const second = createNetworkControl();
    first.setCondition("flaky");
    second.setCondition("flaky");
    const run = (control: ReturnType<typeof createNetworkControl>): boolean[] =>
      Array.from({ length: 12 }, () => control.plan("https://api/x", "GET").fail !== null);
    // Two independent controls must fail on the same calls: a random rate
    // would make the "flaky" profile impossible to reproduce
    expect(run(first)).toEqual(run(second));
    expect(run(first).some(Boolean)).toBe(true);
  });

  it("adds the rule delay to the condition delay", () => {
    const network = createNetworkControl();
    network.setCondition("3g");
    network.setRules([{ urlContains: "/slow", delayMs: 600 }]);
    expect(network.plan("https://api/slow", "GET").delayMs).toBe(1000);
  });

  it("lets a rule fail a single endpoint on an otherwise healthy network", () => {
    const network = createNetworkControl();
    network.setRules([{ urlContains: "/orders", fail: "backend down" }]);
    expect(network.plan("https://api/orders", "POST").fail).toBe("backend down");
    expect(network.plan("https://api/users", "GET").fail).toBeNull();
  });

  it("clears rules and condition on reset", () => {
    const network = createNetworkControl();
    network.setRules([{ status: 500 }]);
    network.setCondition("offline");
    network.reset();
    expect(network.state().condition).toBe("normal");
    expect(network.plan("https://api/a", "GET").fail).toBeNull();
  });
});
