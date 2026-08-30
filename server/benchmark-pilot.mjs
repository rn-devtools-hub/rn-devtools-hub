import { createHash } from "node:crypto";

export const PILOT_FORMAT = "rn-devtools-bugfix-pilot";
export const PILOT_VERSION = 1;

const fail = (message) => { throw new Error(message); };
const requiredString = (value, path) => {
  if (typeof value !== "string" || !value.trim()) fail(`${path} must be a non-empty string`);
  if (/REPLACE/i.test(value)) fail(`${path} still contains a template placeholder`);
  return value;
};
const requiredInteger = (value, path, min = 0) => {
  if (!Number.isInteger(value) || value < min) fail(`${path} must be an integer >= ${min}`);
  return value;
};

export const validatePilotManifest = (manifest) => {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) fail("manifest must be an object");
  if (manifest.format !== PILOT_FORMAT || manifest.version !== PILOT_VERSION) {
    fail(`manifest must use ${PILOT_FORMAT} version ${PILOT_VERSION}`);
  }
  requiredString(manifest.frozenAt, "frozenAt");
  if (!Number.isFinite(Date.parse(manifest.frozenAt))) fail("frozenAt must be an ISO timestamp");
  requiredString(manifest.seed, "seed");
  requiredString(manifest.reference?.repository, "reference.repository");
  const revision = requiredString(manifest.reference?.revision, "reference.revision");
  if (!/^[a-f0-9]{40}$/i.test(revision)) fail("reference.revision must be a full commit SHA");
  requiredString(manifest.client?.name, "client.name");
  requiredString(manifest.client?.version, "client.version");
  requiredString(manifest.client?.model, "client.model");
  if (manifest.repetitions !== 3) fail("repetitions must be exactly 3 for the preregistered pilot");
  requiredInteger(manifest.budget?.toolCalls, "budget.toolCalls", 1);
  requiredInteger(manifest.budget?.wallClockMs, "budget.wallClockMs", 1);
  if (!Array.isArray(manifest.bugs) || manifest.bugs.length !== 8) fail("bugs must contain exactly 8 entries");

  const ids = new Set();
  let negativeControls = 0;
  manifest.bugs.forEach((bug, index) => {
    const path = `bugs[${index}]`;
    const id = requiredString(bug?.id, `${path}.id`);
    if (ids.has(id)) fail(`${path}.id duplicates ${id}`);
    ids.add(id);
    requiredString(bug.category, `${path}.category`);
    const fixCommit = requiredString(bug.fixCommit, `${path}.fixCommit`);
    if (!/^[a-f0-9]{40}$/i.test(fixCommit)) fail(`${path}.fixCommit must be a full commit SHA`);
    requiredString(bug.prompt, `${path}.prompt`);
    requiredString(bug.reproductionCommand, `${path}.reproductionCommand`);
    requiredString(bug.targetTestCommand, `${path}.targetTestCommand`);
    requiredString(bug.regressionCommand, `${path}.regressionCommand`);
    if (!/^[a-f0-9]{64}$/i.test(String(bug.targetTestSha256 ?? ""))
      || /^0{64}$/.test(bug.targetTestSha256)) {
      fail(`${path}.targetTestSha256 must be a SHA-256 hex digest`);
    }
    if (typeof bug.expectedHubHelp !== "boolean") fail(`${path}.expectedHubHelp must be boolean`);
    if (!bug.expectedHubHelp) negativeControls += 1;
  });
  if (negativeControls < 2) fail("bugs must include at least 2 negative controls with expectedHubHelp:false");
  return manifest;
};

const hashUnit = (value) => {
  const bytes = createHash("sha256").update(value).digest();
  return bytes.readUInt32BE(0) / 0x100000000;
};

export const buildPilotPlan = (input) => {
  const manifest = validatePilotManifest(input);
  const attempts = [];
  for (const bug of manifest.bugs) {
    for (let repetition = 1; repetition <= manifest.repetitions; repetition += 1) {
      const hubFirst = hashUnit(`${manifest.seed}:${bug.id}:${repetition}`) < 0.5;
      for (const arm of hubFirst ? ["hub", "control"] : ["control", "hub"]) {
        attempts.push({
          attemptId: `${bug.id}:r${repetition}:${arm}`,
          bugId: bug.id,
          repetition,
          arm,
          orderWithinPair: attempts.length % 2 === 0 ? 1 : 2,
        });
      }
    }
  }
  return {
    format: `${PILOT_FORMAT}-plan`,
    version: PILOT_VERSION,
    manifestSha256: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
    seed: manifest.seed,
    attempts,
  };
};

const choose = (n, k) => {
  let result = 1;
  for (let i = 1; i <= k; i += 1) result = result * (n - k + i) / i;
  return result;
};

export const exactMcNemar = (hubOnly, controlOnly) => {
  const discordant = hubOnly + controlOnly;
  if (!discordant) return 1;
  const tail = Math.min(hubOnly, controlOnly);
  let probability = 0;
  for (let i = 0; i <= tail; i += 1) probability += choose(discordant, i) * (0.5 ** discordant);
  return Math.min(1, 2 * probability);
};

const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const pairedBootstrapDifference = (bugs, seed, samples = 10000) => {
  const differences = bugs.map((bug) => Number(bug.hub.resolved) - Number(bug.control.resolved));
  const observed = differences.reduce((sum, value) => sum + value, 0) / differences.length;
  const draws = [];
  for (let sample = 0; sample < samples; sample += 1) {
    let sum = 0;
    for (let index = 0; index < differences.length; index += 1) {
      const picked = Math.floor(hashUnit(`${seed}:bootstrap:${sample}:${index}`) * differences.length);
      sum += differences[picked];
    }
    draws.push(sum / differences.length);
  }
  draws.sort((a, b) => a - b);
  return {
    estimate: observed,
    confidenceLevel: 0.95,
    method: "paired cluster bootstrap over bugs, 10000 deterministic resamples",
    lower: draws[Math.floor(samples * 0.025)],
    upper: draws[Math.ceil(samples * 0.975) - 1],
  };
};

export const analyzePilot = (inputManifest, rows) => {
  const manifest = validatePilotManifest(inputManifest);
  const plan = buildPilotPlan(manifest);
  if (!Array.isArray(rows)) fail("attempt results must be an array");
  const byId = new Map();
  for (const row of rows) {
    requiredString(row?.attemptId, "attempt.attemptId");
    if (byId.has(row.attemptId)) fail(`duplicate attempt result ${row.attemptId}`);
    if (typeof row.resolved !== "boolean") fail(`${row.attemptId}.resolved must be boolean`);
    requiredInteger(row.durationMs, `${row.attemptId}.durationMs`);
    requiredInteger(row.toolCalls, `${row.attemptId}.toolCalls`);
    requiredInteger(row.tokens, `${row.attemptId}.tokens`);
    requiredInteger(row.regressions, `${row.attemptId}.regressions`);
    if (typeof row.targetTestPassed !== "boolean" || typeof row.regressionPassed !== "boolean") {
      fail(`${row.attemptId} must record targetTestPassed and regressionPassed booleans`);
    }
    if (typeof row.declaredSuccess !== "boolean") fail(`${row.attemptId}.declaredSuccess must be boolean`);
    if (!["final", "tool-call-cap", "wall-clock-cap"].includes(row.termination)) {
      fail(`${row.attemptId}.termination must be final, tool-call-cap or wall-clock-cap`);
    }
    const derivedResolved = row.targetTestPassed && row.regressionPassed && row.termination === "final";
    if (row.resolved !== derivedResolved) fail(`${row.attemptId}.resolved disagrees with tests or termination`);
    if (row.regressionPassed !== (row.regressions === 0)) {
      fail(`${row.attemptId}.regressionPassed disagrees with regressions`);
    }
    if (row.falseClaim !== (row.declaredSuccess && !row.resolved)) {
      fail(`${row.attemptId}.falseClaim disagrees with declaredSuccess and resolved`);
    }
    if (row.toolCalls > manifest.budget.toolCalls || row.durationMs > manifest.budget.wallClockMs) {
      fail(`${row.attemptId} exceeds the preregistered budget`);
    }
    if (typeof row.falseDiagnosis !== "boolean" || typeof row.falseClaim !== "boolean") {
      fail(`${row.attemptId} must record falseDiagnosis and falseClaim booleans`);
    }
    byId.set(row.attemptId, row);
  }
  const expected = new Set(plan.attempts.map((attempt) => attempt.attemptId));
  const missing = [...expected].filter((id) => !byId.has(id));
  const unexpected = [...byId.keys()].filter((id) => !expected.has(id));
  if (missing.length || unexpected.length) {
    fail(`attempt set mismatch; missing=${missing.join(",") || "none"}; unexpected=${unexpected.join(",") || "none"}`);
  }

  const bugs = manifest.bugs.map((bug) => {
    const arm = (name) => {
      const attempts = Array.from({ length: manifest.repetitions }, (_, index) =>
        byId.get(`${bug.id}:r${index + 1}:${name}`));
      return { resolved: attempts.filter((row) => row.resolved).length >= 2, attempts };
    };
    return { id: bug.id, category: bug.category, hub: arm("hub"), control: arm("control") };
  });
  const hubOnly = bugs.filter((bug) => bug.hub.resolved && !bug.control.resolved).length;
  const controlOnly = bugs.filter((bug) => !bug.hub.resolved && bug.control.resolved).length;
  const summarizeArm = (name) => {
    const attempts = bugs.flatMap((bug) => bug[name].attempts);
    const resolved = attempts.filter((row) => row.resolved);
    return {
      resolvedAttempts: resolved.length,
      totalAttempts: attempts.length,
      resolutionRate: resolved.length / attempts.length,
      medianDurationMsResolved: median(resolved.map((row) => row.durationMs)),
      medianToolCallsResolved: median(resolved.map((row) => row.toolCalls)),
      medianTokensResolved: median(resolved.map((row) => row.tokens)),
      falseDiagnoses: attempts.filter((row) => row.falseDiagnosis).length,
      falseClaims: attempts.filter((row) => row.falseClaim).length,
      regressions: attempts.reduce((sum, row) => sum + row.regressions, 0),
    };
  };
  return {
    format: `${PILOT_FORMAT}-analysis`,
    version: PILOT_VERSION,
    manifestSha256: plan.manifestSha256,
    bugResolution: {
      hub: bugs.filter((bug) => bug.hub.resolved).length,
      control: bugs.filter((bug) => bug.control.resolved).length,
      hubOnly,
      controlOnly,
      concordantResolved: bugs.filter((bug) => bug.hub.resolved && bug.control.resolved).length,
      concordantUnresolved: bugs.filter((bug) => !bug.hub.resolved && !bug.control.resolved).length,
      exactMcNemarP: exactMcNemar(hubOnly, controlOnly),
      resolutionRateDifference: pairedBootstrapDifference(bugs, manifest.seed),
    },
    attempts: { hub: summarizeArm("hub"), control: summarizeArm("control") },
    bugs: bugs.map((bug) => ({
      id: bug.id,
      category: bug.category,
      hubResolved: bug.hub.resolved,
      controlResolved: bug.control.resolved,
    })),
  };
};
