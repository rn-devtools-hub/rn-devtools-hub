/**
 * Determinism at the JS level: the clock and the network.
 *
 * An agent cannot run the same scenario twice today. Relative dates drift,
 * fixtures change, latency varies. Nothing outside the app can fix that,
 * because Date and fetch live in the runtime.
 *
 * The promise is deliberately narrow, and stated rather than implied:
 *
 *   DETERMINISTIC: Date, new Date(), Date.now(), and every request going
 *   through the instrumented fetch.
 *   NOT DETERMINISTIC: native animations, Reanimated on the UI thread,
 *   and any native clock. They do not read the JS Date.
 *
 * Selling "reproducible" wholesale would be denied by the first demo with
 * a transition. The narrow version is still out of reach of anything
 * outside the runtime, permanently.
 *
 * advance_time moves the clock, it does not fire pending timers: driving
 * the scheduler would mean replacing setTimeout under a running app,
 * including the transport's own, and a devtool must not do that.
 */

export interface ClockState {
  frozen: boolean;
  now: number | null;
}

const RealDate = Date;

export const createClock = () => {
  let frozenAt: number | null = null;

  const install = (): void => {
    if (typeof globalThis.Date !== "function") return;
    // Extending the real Date keeps parse, UTC and the prototype intact:
    // only "what time is it" is answered differently
    class FrozenDate extends RealDate {
      constructor(...args: unknown[]) {
        if (args.length === 0 && frozenAt !== null) {
          super(frozenAt);
        } else {
          // @ts-expect-error forwarding the real constructor overloads
          super(...args);
        }
      }

      static now(): number {
        return frozenAt ?? RealDate.now();
      }
    }
    globalThis.Date = FrozenDate as unknown as DateConstructor;
  };

  return {
    freeze: (iso?: string): ClockState => {
      const parsed = iso ? RealDate.parse(iso) : RealDate.now();
      if (Number.isNaN(parsed)) throw new Error(`Unparseable date: ${iso}`);
      frozenAt = parsed;
      install();
      return { frozen: true, now: frozenAt };
    },
    advance: (ms: number): ClockState => {
      if (frozenAt === null) throw new Error("The clock is not frozen: call freeze_time first");
      const delta = Number(ms);
      if (!Number.isFinite(delta)) throw new Error("advance_time needs a number of milliseconds");
      frozenAt += delta;
      return { frozen: true, now: frozenAt };
    },
    restore: (): ClockState => {
      frozenAt = null;
      globalThis.Date = RealDate;
      return { frozen: false, now: null };
    },
    state: (): ClockState => ({ frozen: frozenAt !== null, now: frozenAt }),
  };
};

// ====================================================================
// Network: rules and conditions
// ====================================================================

export interface NetworkRule {
  urlContains?: string;
  method?: string;
  status?: number;
  body?: unknown;
  delayMs?: number;
  fail?: string;
}

export type NetworkCondition = "normal" | "offline" | "3g" | "flaky";

export interface ConditionProfile {
  delayMs: number;
  failureRate: number;
}

/** Latencies chosen to be felt, not to be accurate: the point is to make
 * a race condition reproducible, not to emulate a radio */
export const conditionProfile = (condition: NetworkCondition): ConditionProfile => {
  switch (condition) {
    case "offline":
      return { delayMs: 0, failureRate: 1 };
    case "3g":
      return { delayMs: 400, failureRate: 0 };
    case "flaky":
      return { delayMs: 200, failureRate: 0.3 };
    default:
      return { delayMs: 0, failureRate: 0 };
  }
};

/** First matching rule wins, so the most specific must be registered
 * first, exactly like a routing table */
export const matchRule = (
  rules: NetworkRule[],
  url: string,
  method: string
): NetworkRule | null => {
  for (const rule of rules) {
    if (rule.method && rule.method.toUpperCase() !== String(method).toUpperCase()) continue;
    if (rule.urlContains && !String(url).includes(rule.urlContains)) continue;
    return rule;
  }
  return null;
};

export const createNetworkControl = () => {
  let rules: NetworkRule[] = [];
  let condition: NetworkCondition = "normal";
  // Deterministic by construction: a random failure rate would make the
  // "flaky" profile unreproducible, which is the opposite of the point
  let counter = 0;

  return {
    setRules: (next: NetworkRule[]): number => {
      rules = Array.isArray(next) ? next : [];
      return rules.length;
    },
    setCondition: (next: NetworkCondition): NetworkCondition => {
      condition = next;
      return condition;
    },
    reset: (): void => {
      rules = [];
      condition = "normal";
      counter = 0;
    },
    state: () => ({ rules, condition, profile: conditionProfile(condition) }),
    /** Decides what should happen to one request */
    plan: (url: string, method: string) => {
      const profile = conditionProfile(condition);
      const rule = matchRule(rules, url, method);
      const index = counter++;
      const failByCondition =
        profile.failureRate > 0 &&
        (profile.failureRate >= 1 || index % Math.round(1 / profile.failureRate) === 0);
      return {
        delayMs: (rule?.delayMs ?? 0) + profile.delayMs,
        fail: rule?.fail ?? (failByCondition ? `Simulated ${condition} network` : null),
        mock: rule && rule.status !== undefined ? { status: rule.status, body: rule.body } : null,
      };
    },
  };
};

interface DeterminismHost {
  onCommand: (command: string, handler: (payload: unknown) => unknown) => void;
}

export const installDeterminism = (
  host: DeterminismHost,
  clock = createClock(),
  network = createNetworkControl()
) => {
  host.onCommand("time.control", (rawPayload) => {
    const payload = (rawPayload ?? {}) as Record<string, unknown>;
    const action = String(payload.action ?? "state");
    if (action === "freeze") return clock.freeze(payload.iso ? String(payload.iso) : undefined);
    if (action === "advance") return clock.advance(Number(payload.ms));
    if (action === "restore") return clock.restore();
    return clock.state();
  });

  host.onCommand("network.mock", (rawPayload) => {
    const payload = (rawPayload ?? {}) as Record<string, unknown>;
    const action = String(payload.action ?? "state");
    if (action === "rules") {
      return { rules: network.setRules(payload.rules as NetworkRule[]) };
    }
    if (action === "condition") {
      return { condition: network.setCondition(String(payload.condition) as NetworkCondition) };
    }
    if (action === "reset") {
      network.reset();
      return { reset: true };
    }
    return network.state();
  });

  return { clock, network };
};
