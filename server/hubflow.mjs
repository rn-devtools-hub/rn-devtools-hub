import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { expectationForEvent } from "./flow.mjs";

export const HUBFLOW_FORMAT = "rn-devtools-hub/flow";
export const HUBFLOW_VERSION = 1;
export const DEFAULT_FLOW_DIR = "tests/hub";

const ALLOWED_TOOLS = new Set([
  "advance_time", "assert", "compare_snapshot", "freeze_time", "get_state",
  "launch_app", "mock_network", "open_url", "restore_time", "run_action",
  "set_animations", "set_appearance", "set_location", "set_orientation",
  "set_permission", "set_state", "terminate_app", "ui_act", "wait_for_event",
]);
const SCREENSHOT_POLICIES = new Set(["off", "failure-only", "important-and-failure", "every-step"]);
const MAX_FLOW_BYTES = 1024 * 1024;
const MAX_STEPS = 500;
const MAX_CALLS_PER_PHASE = 1000;

export const HUBFLOW_TOOLS = [
  {
    name: "list_flows",
    description: "Lists versioned .hubflow scenarios in tests/hub with their latest local run.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_flow",
    description: "Reads and validates one project-relative .hubflow scenario.",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: { path: { type: "string" } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "save_flow",
    description: "Saves the current action and consequence recording as a versioned .hubflow file under tests/hub by default.",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: {
        deviceId: { type: "string" },
        path: { type: "string" },
        description: { type: "string" },
        screenshotPolicy: { type: "string", enum: [...SCREENSHOT_POLICIES] },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: "run_flow",
    description: "Runs a validated .hubflow with explicit expectations and writes screenshots and a human-readable report under .rn-devtools. Recorded event association is temporal, not proven causality.",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: {
        deviceId: { type: "string" },
        path: { type: "string" },
        target: { type: "string" },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: "propose_flow_repair",
    description: "Writes a sibling .candidate.hubflow for a failed target only when recorded identity evidence strongly matches a reported candidate. It never changes assertions or the original file.",
    inputSchema: {
      type: "object",
      required: ["path", "stepIndex", "candidateIndex"],
      properties: {
        path: { type: "string" },
        stepIndex: { type: "integer", minimum: 0 },
        candidateIndex: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
];

const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const assertString = (value, label) => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
};

export const resolveHubflowPath = (projectRoot, file, { defaultDir = DEFAULT_FLOW_DIR } = {}) => {
  assertString(projectRoot, "projectRoot");
  assertString(file, "file");
  if (isAbsolute(file) || file.includes("\0")) throw new Error("Hubflow path must be project-relative");
  const candidate = file.includes("/") || file.includes("\\") ? file : `${defaultDir}/${file}`;
  if (!candidate.endsWith(".hubflow")) throw new Error("Hubflow path must end in .hubflow");
  const root = resolve(projectRoot);
  const target = resolve(root, candidate);
  const rel = relative(root, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("Hubflow path escapes the project root");
  }
  return target;
};

const validateCall = (call, label) => {
  if (!object(call)) throw new Error(`${label} must be an object`);
  assertString(call.tool, `${label}.tool`);
  if (!ALLOWED_TOOLS.has(call.tool)) throw new Error(`${label} uses disallowed tool: ${call.tool}`);
  if (call.arguments !== undefined && !object(call.arguments)) throw new Error(`${label}.arguments must be an object`);
};

export const validateHubflow = (flow) => {
  if (!object(flow)) throw new Error("Hubflow must be a JSON object");
  if (flow.format !== HUBFLOW_FORMAT) throw new Error(`Unsupported hubflow format: ${String(flow.format)}`);
  if (flow.version !== HUBFLOW_VERSION) throw new Error(`Unsupported hubflow version: ${String(flow.version)}`);
  assertString(flow.name, "name");
  if (!Array.isArray(flow.steps) || flow.steps.length === 0) throw new Error("steps must contain at least one step");
  if (flow.steps.length > MAX_STEPS) throw new Error(`steps cannot contain more than ${MAX_STEPS} entries`);
  const policy = flow.visualEvidence?.screenshots ?? "important-and-failure";
  if (!SCREENSHOT_POLICIES.has(policy)) throw new Error(`Unknown screenshot policy: ${String(policy)}`);
  for (const [phase, calls] of [["setup", flow.setup ?? []], ["teardown", flow.teardown ?? []]]) {
    if (!Array.isArray(calls)) throw new Error(`${phase} must be an array`);
    if (calls.length > MAX_CALLS_PER_PHASE) throw new Error(`${phase} contains too many calls`);
    calls.forEach((call, index) => validateCall(call, `${phase}[${index}]`));
  }
  flow.steps.forEach((step, index) => {
    if (!object(step)) throw new Error(`steps[${index}] must be an object`);
    assertString(step.name ?? `Step ${index + 1}`, `steps[${index}].name`);
    validateCall(step.act, `steps[${index}].act`);
    if (!Array.isArray(step.expect ?? [])) throw new Error(`steps[${index}].expect must be an array`);
    if ((step.expect ?? []).length > MAX_CALLS_PER_PHASE) throw new Error(`steps[${index}].expect contains too many calls`);
    (step.expect ?? []).forEach((call, callIndex) => validateCall(call, `steps[${index}].expect[${callIndex}]`));
  });
  return flow;
};

const ensureContainedDirectory = async (projectRoot, target) => {
  const root = await realpath(projectRoot);
  await mkdir(dirname(target), { recursive: true });
  const parent = await realpath(dirname(target));
  const rel = relative(root, parent);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Hubflow path crosses a symlink outside the project");
};

export const writeHubflow = async (projectRoot, file, flow) => {
  validateHubflow(flow);
  const target = resolveHubflowPath(projectRoot, file);
  await ensureContainedDirectory(projectRoot, target);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(flow, null, 2)}\n`, "utf8");
  await rename(temporary, target);
  return { path: relative(resolve(projectRoot), target), flow };
};

export const readHubflow = async (projectRoot, file) => {
  const target = resolveHubflowPath(projectRoot, file);
  const root = await realpath(projectRoot);
  const actual = await realpath(target);
  const rel = relative(root, actual);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Hubflow path crosses a symlink outside the project");
  if ((await stat(actual)).size > MAX_FLOW_BYTES) throw new Error("Hubflow file exceeds the 1 MB limit");
  return validateHubflow(JSON.parse(await readFile(actual, "utf8")));
};

export const listHubflows = async (projectRoot, directory = DEFAULT_FLOW_DIR) => {
  if (isAbsolute(directory)) throw new Error("Hubflow directory must be project-relative");
  const root = resolve(projectRoot);
  const base = resolve(root, directory);
  const rel = relative(root, base);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Hubflow directory escapes the project root");
  const found = [];
  try {
    const [actualRoot, actualBase] = await Promise.all([realpath(root), realpath(base)]);
    const actualRel = relative(actualRoot, actualBase);
    if (actualRel === ".." || actualRel.startsWith(`..${sep}`) || isAbsolute(actualRel)) {
      throw new Error("Hubflow directory crosses a symlink outside the project");
    }
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const walk = async (dir) => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith(".hubflow")) found.push(relative(root, path));
    }
  };
  await walk(base);
  return found.sort();
};

const safeSegment = (value, label) => {
  assertString(value, label);
  if (!/^[a-z0-9._-]+$/i.test(value)) throw new Error(`${label} is invalid`);
  return value;
};

const flowStorageKey = (flowName, flowPath = "") => {
  const safeName = flowName.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-|-$/g, "") || "flow";
  const suffix = createHash("sha256").update(String(flowPath)).digest("hex").slice(0, 10);
  return `${safeName}-${suffix}`;
};

const latestRunFor = async (projectRoot, flowName, flowPath) => {
  const root = resolve(projectRoot, ".rn-devtools/flows/runs", flowStorageKey(flowName, flowPath));
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return null; }
  const runs = [];
  for (const entry of entries) if (entry.isDirectory()) {
    const path = resolve(root, entry.name, "report.json");
    try { runs.push({ path, mtime: (await stat(path)).mtimeMs }); } catch { /* incomplete run */ }
  }
  runs.sort((a, b) => b.mtime - a.mtime);
  if (!runs.length) return null;
  try { return JSON.parse(await readFile(runs[0].path, "utf8")); } catch { return null; }
};

export const listHubflowCatalog = async (projectRoot) => {
  const paths = await listHubflows(projectRoot);
  const flows = [];
  for (const path of paths) {
    try {
      const flow = await readHubflow(projectRoot, path);
      flows.push({ path, ...flow, lastRun: await latestRunFor(projectRoot, flow.name, path) });
    } catch (error) {
      flows.push({ path, name: path.split("/").pop()?.replace(/\.hubflow$/, "") ?? path, invalid: true, error: String(error?.message ?? error), steps: [] });
    }
  }
  return flows;
};

export const resolveHubflowArtifact = async (projectRoot, flowName, runId, file) => {
  const safeName = safeSegment(flowName, "flowName");
  const safeRun = safeSegment(runId, "runId");
  const safeFile = safeSegment(file, "file");
  if (!safeFile.endsWith(".png")) throw new Error("Only PNG flow artifacts can be served");
  const root = resolve(projectRoot, ".rn-devtools/flows/runs");
  const target = resolve(root, safeName, safeRun, safeFile);
  const [actualRoot, actualTarget] = await Promise.all([realpath(root), realpath(target)]);
  const rel = relative(actualRoot, actualTarget);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Flow artifact escapes the runs directory");
  return actualTarget;
};

export const durableFlowFromRecorded = (recorded, options = {}) => {
  if (!object(recorded) || !Array.isArray(recorded.steps)) throw new Error("Recorded flow is invalid");
  const steps = recorded.steps.map((step, index) => ({
    name: step.name ?? `${step.action ?? "Action"} ${index + 1}`,
    act: { tool: "ui_act", arguments: {
      action: step.action, ...(step.selector ?? {}),
      ...(step.index === null || step.index === undefined ? {} : { index: step.index }),
      ...(step.text === null || step.text === undefined ? {} : { text: step.text }),
    } },
    expect: (step.consequences ?? []).filter((item) => item.kind === "wait" && !item.failed).map(expectationForEvent),
    ...(step.source ? { targetEvidence: { source: step.source } } : {}),
  }));
  const flow = {
    format: HUBFLOW_FORMAT, version: HUBFLOW_VERSION, name: recorded.name ?? "recorded-flow",
    ...(options.description ? { description: options.description } : {}),
    ...((Number.isFinite(options.finalCursor) || Number.isFinite(recorded.finalCursor)) ? {
      recording: { finalCursor: Number(options.finalCursor ?? recorded.finalCursor), attribution: "temporal" },
    } : {}),
    setup: options.setup ?? [], steps, teardown: options.teardown ?? [],
    visualEvidence: options.visualEvidence ?? { screenshots: "important-and-failure", final: true },
  };
  return validateHubflow(flow);
};

export const classifyFlowFailure = (error, call) => {
  const message = String(error?.message ?? error ?? "Unknown failure");
  if (/ambiguous|not found|no match|selector|index-out-of-range/i.test(message)) return "target-mismatch";
  if (/capability|not attached|not registered|unavailable|unsupported|environment variable .* not set/i.test(message)) return "capability-missing";
  if (/timeout|timed out/i.test(message)) return "timeout";
  if (call?.tool === "assert" || call?.tool === "wait_for_event" || /expected|assert/i.test(message)) return "expectation-failed";
  return "action-failed";
};

const repairCandidates = (error) => (error?.result?.candidates ?? []).slice(0, 5).map((candidate) => ({
  testID: candidate.testID ?? candidate.props?.testID ?? null,
  role: candidate.role ?? candidate.props?.accessibilityRole ?? null,
  name: candidate.name ?? candidate.accessibilityLabel ?? candidate.props?.accessibilityLabel ?? null,
  source: object(candidate.source) ? {
    file: candidate.source.file ?? null,
    line: candidate.source.line ?? null,
    componentName: candidate.source.componentName ?? null,
  } : null,
}));

export const proposeHubflowRepair = async (projectRoot, file, { stepIndex, candidateIndex }) => {
  const flow = await readHubflow(projectRoot, file);
  const run = await latestRunFor(projectRoot, flow.name, file);
  const failed = run?.steps?.[Number(stepIndex)]?.failure;
  if (failed?.classification !== "target-mismatch") throw new Error("The selected step has no target mismatch to repair");
  const candidate = failed.candidates?.[Number(candidateIndex)];
  if (!candidate) throw new Error("Repair candidate index is out of range");
  const step = flow.steps[Number(stepIndex)];
  if (!step) throw new Error("Step index is out of range");
  const current = step.act?.arguments ?? {};
  const evidence = step.targetEvidence ?? {};
  const sameTestId = Boolean(candidate.testID) && (current.by === "testID" ? current.value === candidate.testID : evidence.testID === candidate.testID);
  const sameComponent = Boolean(candidate.source?.componentName) && candidate.source.componentName === evidence.source?.componentName;
  const sameFile = Boolean(candidate.source?.file) && candidate.source.file === evidence.source?.file;
  if (!sameTestId && !(sameComponent && sameFile)) {
    throw new Error("Candidate identity is not strong enough for a repair proposal");
  }
  const repaired = JSON.parse(JSON.stringify(flow));
  const arguments_ = repaired.steps[Number(stepIndex)].act.arguments;
  if (candidate.testID) {
    arguments_.by = "testID";
    arguments_.value = candidate.testID;
    delete arguments_.name;
  } else if (candidate.role && candidate.name) {
    arguments_.by = "role";
    arguments_.value = candidate.role;
    arguments_.name = candidate.name;
  } else {
    throw new Error("Candidate has no portable selector to propose");
  }
  const candidateFile = file.replace(/\.hubflow$/, ".candidate.hubflow");
  await writeHubflow(projectRoot, candidateFile, repaired);
  return {
    ok: true,
    original: file,
    candidate: candidateFile,
    stepIndex: Number(stepIndex),
    before: current,
    after: arguments_,
    note: "Assertions and the original scenario were not changed.",
  };
};

const invokeCall = async (invoke, call, context) => {
  try {
    const result = await invoke(call.tool, call.arguments ?? {}, context);
    if (result?.ok === false) throw Object.assign(new Error(result.error ?? result.message ?? `${call.tool} failed`), { result });
    return result;
  } catch (error) {
    error.flowCall = call;
    throw error;
  }
};

const summarizeResult = (result) => {
  if (!object(result)) return result === undefined ? null : result;
  const summary = {};
  for (const key of ["ok", "verified", "timedOut", "reason", "count", "status", "atEnd", "committed", "execution", "conclusive", "observation"]) {
    if (["string", "number", "boolean"].includes(typeof result[key])) summary[key] = result[key];
  }
  if (object(result.execution)) summary.execution = {
    mode: result.execution.mode ?? null, nativeGesture: result.execution.nativeGesture === true,
  };
  if (result.kind === "network_response" && Array.isArray(result.evidence)) {
    summary.evidence = result.evidence.slice(0, 10).map((event) => ({
      seq: event.seq ?? null, type: event.type ?? null,
      status: event.payload?.status ?? null, method: event.payload?.method ?? null,
      mocked: event.payload?.mocked === true,
    }));
  }
  if (object(result.event)) {
    summary.event = { type: result.event.type ?? null };
    const payload = result.event.payload;
    if (object(payload)) {
      const safePayload = {};
      for (const key of ["screen", "route", "status", "method", "durationMs"]) {
        if (["string", "number", "boolean"].includes(typeof payload[key])) safePayload[key] = payload[key];
      }
      if (Object.keys(safePayload).length) summary.event.payload = safePayload;
    }
  }
  const source = result.actedOn?.source ?? result.target?.source ?? result.source;
  if (object(source)) summary.source = {
    file: source.file ?? null,
    line: source.line ?? null,
    componentName: source.componentName ?? null,
  };
  return summary;
};

const safeCapture = async (capture, runDir, label, context, report) => {
  try {
    return await captureEvidence(capture, runDir, label, context);
  } catch (error) {
    report.evidenceErrors ??= [];
    report.evidenceErrors.push({ label, message: String(error?.message ?? error) });
    return null;
  }
};

const NATIVE_CRASH_PATTERN = /FATAL EXCEPTION|AndroidRuntime|RuntimeException|Caused by:|MapView\.onAttachedToWindow|Stopping surface|SIGABRT|SIGSEGV/i;
const NATIVE_FAILURE_PATTERN = /SurfaceMountingManager|DevLauncher|ReactHost|BridgelessReact|rnmaps|FabricUIManager/i;

/** Prioritize fatal neighborhoods, then add bounded lifecycle context. */
export const selectNativeFailureLogs = (lines, limit = 80) => {
  if (!Array.isArray(lines)) return [];
  const maximum = Math.max(1, Math.min(Number(limit) || 80, 200));
  const critical = new Set();
  const related = new Set();
  lines.forEach((line, index) => {
    const value = String(line);
    const destination = NATIVE_CRASH_PATTERN.test(value) ? critical : NATIVE_FAILURE_PATTERN.test(value) ? related : null;
    if (!destination) return;
    const radius = destination === critical ? 4 : 2;
    for (let nearby = Math.max(0, index - radius); nearby <= Math.min(lines.length - 1, index + radius); nearby += 1) {
      destination.add(nearby);
    }
  });
  const selected = [...critical];
  for (const index of related) {
    if (selected.length >= maximum) break;
    if (!critical.has(index)) selected.push(index);
  }
  return selected.sort((a, b) => a - b).slice(0, maximum).map((index) => String(lines[index]));
};

const safeFailureEvidence = async (collect, context, report) => {
  if (!collect) return null;
  try {
    return await collect(context);
  } catch (error) {
    report.evidenceErrors ??= [];
    report.evidenceErrors.push({ label: "native-failure-logs", message: String(error?.message ?? error) });
    return null;
  }
};

const captureEvidence = async (capture, runDir, label, context) => {
  if (!capture) return null;
  const path = resolve(runDir, `${label}.png`);
  const value = await capture({ ...context, path });
  return { path: relative(runDir, path), ...(object(value) ? value : {}) };
};

const pruneRuns = async (runsRoot, retention) => {
  let entries;
  try { entries = await readdir(runsRoot, { withFileTypes: true }); } catch { return; }
  const dirs = [];
  for (const entry of entries) if (entry.isDirectory()) {
    const path = resolve(runsRoot, entry.name);
    dirs.push({ path, name: entry.name, mtime: (await stat(path)).mtimeMs });
  }
  dirs.sort((a, b) => b.mtime - a.mtime);
  const keep = Number.isInteger(retention?.runs) ? Math.max(0, retention.runs) : 20;
  const maxAge = Number.isFinite(retention?.maxAgeDays) ? retention.maxAgeDays * 86400000 : Infinity;
  await Promise.all(dirs.filter((entry, index) => index >= keep || Date.now() - entry.mtime > maxAge).map((entry) => rm(entry.path, { recursive: true, force: true })));
};

export const runHubflow = async (flow, options) => {
  validateHubflow(flow);
  if (typeof options?.invoke !== "function") throw new Error("runHubflow requires an invoke callback");
  const projectRoot = resolve(options.projectRoot);
  const storageKey = flowStorageKey(flow.name, options.flowPath ?? flow.name);
  const runId = options.runId ?? new Date().toISOString().replace(/[:.]/g, "-");
  const runsRoot = resolve(projectRoot, ".rn-devtools/flows/runs", storageKey);
  const runDir = resolve(runsRoot, runId);
  await mkdir(runDir, { recursive: true });
  const policy = flow.visualEvidence?.screenshots ?? "important-and-failure";
  const report = { format: HUBFLOW_FORMAT, version: HUBFLOW_VERSION, name: flow.name, path: options.flowPath ?? null, storageKey, runId, startedAt: Date.now(), status: "running", steps: [], artifacts: [] };
  const progress = () => options.onProgress?.(JSON.parse(JSON.stringify(report)));
  progress();
  let previousSuccessfulCapture = null;
  let failure = null;
  try {
    for (const call of flow.setup ?? []) await invokeCall(options.invoke, call, { phase: "setup" });
    if (policy === "important-and-failure" || policy === "every-step") {
      const artifact = await safeCapture(options.capture, runDir, "start", { kind: "start" }, report);
      if (artifact) {
        report.artifacts.push(artifact);
        previousSuccessfulCapture = artifact;
      }
    }
    for (let index = 0; index < flow.steps.length; index += 1) {
      const step = flow.steps[index];
      const stepReport = { index, name: step.name ?? `Step ${index + 1}`, status: "running", startedAt: Date.now(), calls: [] };
      report.steps.push(stepReport);
      progress();
      try {
        const cursor = options.getCursor?.();
        for (const [kind, calls] of [["act", [step.act]], ["expect", step.expect ?? []]]) for (const call of calls) {
          const startedAt = Date.now();
          const eventCheck = call.tool === "wait_for_event" || (call.tool === "assert" &&
            ["network_response", "network_ok", "no_console_error", "no_crash"].includes(call.arguments?.kind));
          const scoped = kind === "expect" && eventCheck && Number.isInteger(cursor) && call.arguments?.since == null
            ? { ...call, arguments: { ...call.arguments, since: cursor } } : call;
          const result = await invokeCall(options.invoke, scoped, { phase: "step", kind, step: index });
          stepReport.calls.push({ kind, tool: call.tool, status: "passed", durationMs: Date.now() - startedAt, result: summarizeResult(result) });
        }
        stepReport.status = "passed";
        stepReport.finishedAt = Date.now();
        if (policy === "every-step" || (policy === "important-and-failure" && step.capture === true)) {
          const artifact = await safeCapture(options.capture, runDir, `step-${String(index + 1).padStart(2, "0")}`, { kind: "step", step: index }, report);
          if (artifact) { report.artifacts.push(artifact); previousSuccessfulCapture = artifact; stepReport.screenshot = artifact; }
        }
        progress();
      } catch (error) {
        stepReport.status = "failed";
        stepReport.finishedAt = Date.now();
        stepReport.failure = {
          classification: classifyFlowFailure(error, error.flowCall),
          message: String(error.message),
          tool: error.flowCall?.tool ?? null,
          ...(repairCandidates(error).length ? { candidates: repairCandidates(error) } : {}),
        };
        const nativeEvidence = await safeFailureEvidence(options.collectFailureEvidence, {
          phase: "step", step: index, error: String(error.message), tool: error.flowCall?.tool ?? null,
        }, report);
        if (nativeEvidence) stepReport.failure.nativeEvidence = nativeEvidence;
        if (policy !== "off") {
          const artifact = await safeCapture(options.capture, runDir, `failure-step-${String(index + 1).padStart(2, "0")}`, { kind: "failure", step: index }, report);
          if (artifact) { report.artifacts.push(artifact); stepReport.screenshot = artifact; }
        }
        stepReport.previousSuccessfulCapture = previousSuccessfulCapture;
        failure = error;
        progress();
        break;
      }
    }
  } catch (error) {
    failure = error;
    report.setupFailure = { classification: classifyFlowFailure(error, error.flowCall), message: String(error.message), tool: error.flowCall?.tool ?? null };
    const nativeEvidence = await safeFailureEvidence(options.collectFailureEvidence, {
      phase: "setup", error: String(error.message), tool: error.flowCall?.tool ?? null,
    }, report);
    if (nativeEvidence) report.setupFailure.nativeEvidence = nativeEvidence;
    if (policy !== "off") {
      const artifact = await safeCapture(options.capture, runDir, "failure-setup", { kind: "failure", phase: "setup" }, report);
      if (artifact) report.artifacts.push(artifact);
    }
  } finally {
    const teardownErrors = [];
    for (const call of flow.teardown ?? []) try { await invokeCall(options.invoke, call, { phase: "teardown" }); } catch (error) { teardownErrors.push({ tool: call.tool, message: String(error.message) }); }
    if (teardownErrors.length) {
      report.teardownErrors = teardownErrors;
      report.teardownFailure = { classification: "teardown-failed", message: "One or more teardown calls failed" };
      const nativeEvidence = await safeFailureEvidence(options.collectFailureEvidence, {
        phase: "teardown", error: report.teardownFailure.message, tool: teardownErrors[0]?.tool ?? null,
      }, report);
      if (nativeEvidence) report.teardownFailure.nativeEvidence = nativeEvidence;
      failure ??= new Error("Hubflow teardown failed");
      if (policy !== "off") {
        const artifact = await safeCapture(options.capture, runDir, "failure-teardown", { kind: "failure", phase: "teardown" }, report);
        if (artifact) report.artifacts.push(artifact);
      }
    }
  }
  report.status = failure ? "failed" : "passed";
  report.ok = !failure;
  if (failure) {
    report.reason = report.steps.find((step) => step.status === "failed")?.failure?.classification
      ?? report.setupFailure?.classification
      ?? report.teardownFailure?.classification
      ?? "flow-failed";
    const failed = report.steps.find((step) => step.status === "failed");
    report.failedStep = failed?.index ?? null;
  }
  report.finishedAt = Date.now();
  if (!failure && flow.visualEvidence?.final !== false && (policy === "important-and-failure" || policy === "every-step")) {
    const artifact = await safeCapture(options.capture, runDir, "final", { kind: "final" }, report);
    if (artifact) report.artifacts.push(artifact);
  }
  const reportFile = resolve(runDir, "report.json");
  const temporary = `${reportFile}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await rename(temporary, reportFile);
  await pruneRuns(runsRoot, flow.retention ?? options.retention);
  progress();
  return report;
};
