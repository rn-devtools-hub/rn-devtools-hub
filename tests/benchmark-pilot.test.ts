import { describe, expect, it } from "vitest";

// The benchmark runner is shipped as plain Node ESM, like the rest of server/.
// @ts-expect-error no declaration file for the private server module
const modulePromise = import("../server/benchmark-pilot.mjs") as Promise<{
  validatePilotManifest: (manifest: unknown) => unknown;
  buildPilotPlan: (manifest: unknown) => { manifestSha256: string; attempts: AttemptPlan[] };
  exactMcNemar: (hubOnly: number, controlOnly: number) => number;
  analyzePilot: (manifest: unknown, rows: AttemptResult[]) => Analysis;
}>;

type AttemptPlan = { attemptId: string; bugId: string; repetition: number; arm: "hub" | "control" };
type AttemptResult = {
  attemptId: string;
  resolved: boolean;
  durationMs: number;
  toolCalls: number;
  tokens: number;
  falseDiagnosis: boolean;
  falseClaim: boolean;
  targetTestPassed: boolean;
  regressionPassed: boolean;
  declaredSuccess: boolean;
  termination: "final" | "tool-call-cap" | "wall-clock-cap";
  regressions: number;
};
type Analysis = {
  bugResolution: { hub: number; control: number; hubOnly: number; controlOnly: number; exactMcNemarP: number; resolutionRateDifference: { estimate: number; lower: number; upper: number } };
  attempts: { hub: { resolutionRate: number }; control: { resolutionRate: number } };
};

const manifest = () => ({
  format: "rn-devtools-bugfix-pilot",
  version: 1,
  frozenAt: "2026-08-30T10:00:00Z",
  seed: "public-seed",
  reference: { repository: "https://example.test/app.git", revision: "a".repeat(40) },
  client: { name: "Claude Code", version: "2.1.251", model: "claude-opus-5" },
  repetitions: 3,
  budget: { toolCalls: 40, wallClockMs: 1_200_000 },
  bugs: Array.from({ length: 8 }, (_, index) => ({
    id: `bug-${index + 1}`,
    category: index >= 6 ? "control" : "network",
    fixCommit: `${index + 1}`.repeat(40),
    prompt: `Symptom ${index + 1}`,
    reproductionCommand: "npm run reproduce",
    targetTestCommand: "npm run hidden-test",
    regressionCommand: "npm test",
    targetTestSha256: "b".repeat(64),
    expectedHubHelp: index < 6,
  })),
});

describe("bug-fix benchmark pilot", async () => {
  const { validatePilotManifest, buildPilotPlan, exactMcNemar, analyzePilot } = await modulePromise;

  it("builds the same balanced 48-attempt plan from the same public seed", () => {
    const first = buildPilotPlan(manifest());
    const second = buildPilotPlan(manifest());
    expect(first).toEqual(second);
    expect(first.attempts).toHaveLength(48);
    expect(first.attempts.filter((attempt) => attempt.arm === "hub")).toHaveLength(24);
    expect(new Set(first.attempts.map((attempt) => attempt.attemptId)).size).toBe(48);
  });

  it("refuses a suite selected entirely for the hub's strengths", () => {
    const input = manifest();
    input.bugs.forEach((bug) => { bug.expectedHubHelp = true; });
    expect(() => validatePilotManifest(input)).toThrow(/at least 2 negative controls/);
  });

  it("computes the preregistered exact two-sided McNemar test", () => {
    expect(exactMcNemar(6, 0)).toBeCloseTo(0.03125);
    expect(exactMcNemar(4, 4)).toBe(1);
    expect(exactMcNemar(0, 0)).toBe(1);
  });

  it("uses majority resolution per bug and reports attempt metrics separately", () => {
    const input = manifest();
    const plan = buildPilotPlan(input);
    const rows = plan.attempts.map((attempt) => ({
      attemptId: attempt.attemptId,
      resolved: attempt.arm === "hub",
      durationMs: attempt.arm === "hub" ? 100 : 200,
      toolCalls: attempt.arm === "hub" ? 10 : 20,
      tokens: attempt.arm === "hub" ? 1_000 : 2_000,
      falseDiagnosis: attempt.arm === "control",
      falseClaim: attempt.arm === "control",
      targetTestPassed: attempt.arm === "hub",
      regressionPassed: true,
      declaredSuccess: true,
      termination: "final" as const,
      regressions: 0,
    }));
    const result = analyzePilot(input, rows);
    expect(result.bugResolution).toMatchObject({ hub: 8, control: 0, hubOnly: 8, controlOnly: 0 });
    expect(result.bugResolution.exactMcNemarP).toBeCloseTo(0.0078125);
    expect(result.bugResolution.resolutionRateDifference).toMatchObject({ estimate: 1, lower: 1, upper: 1 });
    expect(result.attempts.hub.resolutionRate).toBe(1);
    expect(result.attempts.control.resolutionRate).toBe(0);
  });

  it("refuses incomplete and duplicate result sets", () => {
    const input = manifest();
    const plan = buildPilotPlan(input);
    const row = (attemptId: string): AttemptResult => ({
      attemptId, resolved: false, durationMs: 1, toolCalls: 1, tokens: 1,
      falseDiagnosis: false, falseClaim: false, targetTestPassed: false,
      regressionPassed: true, declaredSuccess: false, termination: "final", regressions: 0,
    });
    expect(() => analyzePilot(input, plan.attempts.slice(1).map((attempt) => row(attempt.attemptId))))
      .toThrow(/attempt set mismatch/);
    const duplicated = plan.attempts.map((attempt) => row(attempt.attemptId));
    duplicated.push(row(plan.attempts[0].attemptId));
    expect(() => analyzePilot(input, duplicated)).toThrow(/duplicate attempt/);
  });
});
