import { discoverHubPort, hubServesProject } from "./stdio.mjs";

const DEFAULT_PORT = 8973;

export const parseRunFlowArgs = (argv) => {
  const options = { path: null, deviceId: undefined, target: undefined, port: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--device") options.deviceId = argv[++index];
    else if (value === "--target") options.target = argv[++index];
    else if (value === "--port") options.port = Number(argv[++index]);
    else if (!options.path) options.path = value;
    else throw new Error(`Unexpected argument: ${value}`);
  }
  if (!options.path) throw new Error("Pass a .hubflow file to run");
  if (!String(options.path).endsWith(".hubflow")) throw new Error("The scenario path must end in .hubflow");
  if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)) {
    throw new Error("Port must be a number between 1 and 65535");
  }
  return options;
};

const readToolResult = (message) => {
  const result = message?.result;
  const text = result?.content?.find((entry) => entry.type === "text")?.text;
  if (typeof text !== "string") throw new Error(message?.error?.message ?? "The hub returned no flow result");
  let value;
  try { value = JSON.parse(text); } catch { throw new Error(text); }
  return { value, isError: result?.isError === true };
};

const failureEvidence = (value) => value?.setupFailure?.nativeEvidence
  ?? value?.teardownFailure?.nativeEvidence
  ?? value?.steps?.find((step) => step?.failure?.nativeEvidence)?.failure?.nativeEvidence
  ?? null;

export const runFlowCommand = async (argv, io = {}) => {
  const options = parseRunFlowArgs(argv);
  const cwd = io.cwd ?? process.cwd();
  const fetchImpl = io.fetchImpl ?? fetch;
  const port = options.port ?? discoverHubPort(cwd) ?? DEFAULT_PORT;
  if (!(await hubServesProject(port, cwd, fetchImpl))) {
    throw new Error(`No rn-devtools-hub for this project is reachable on port ${port}`);
  }
  const response = await fetchImpl(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "hubflow-cli",
      method: "tools/call",
      params: {
        name: "run_flow",
        arguments: {
          path: options.path,
          ...(options.deviceId ? { deviceId: options.deviceId } : {}),
          ...(options.target ? { target: options.target } : {}),
        },
      },
    }),
  });
  if (!response.ok) throw new Error(`Hub request failed with status ${response.status}`);
  const { value, isError } = readToolResult(await response.json());
  const write = io.write ?? ((line) => process.stdout.write(`${line}\n`));
  write(`${value.name ?? options.path}: ${value.status ?? (value.ok ? "passed" : "failed")}`);
  write(`Run: ${value.runId ?? "not available"}`);
  if (value.failedStep !== undefined && value.failedStep !== null) write(`Failed step: ${value.failedStep + 1}`);
  if (value.reason) write(`Reason: ${value.reason}`);
  const nativeEvidence = failureEvidence(value);
  if (nativeEvidence) {
    write(`Native evidence: ${nativeEvidence.count ?? nativeEvidence.lines?.length ?? 0} line(s) from ${nativeEvidence.target ?? "device"}`);
    for (const line of nativeEvidence.lines ?? []) write(`  ${line}`);
  }
  return isError || value.ok === false ? 1 : 0;
};
