/**
 * Build errors on the event bus.
 *
 * Delegating a build to `expo run:ios` adds nothing on its own: the CLI
 * already exists and reimplementing xcodebuild or gradle is a maintenance
 * pit. What is worth adding is putting the build's failures on the SAME
 * timestamped bus as the crashes and the requests.
 *
 * Compile error at t0, relaunch at t1, first JS crash at t2, one clock.
 * The agent reads a continuous stream from broken code to running app,
 * instead of switching between a terminal and a devtool and correlating
 * by hand.
 */

const BUILD_COMMANDS = {
  ios: ["npx", "expo", "run:ios"],
  android: ["npx", "expo", "run:android"],
};

/** Chooses the command without guessing: eas when a profile is asked
 * for, the local runner otherwise */
export const buildCommand = ({ platform, profile, device }) => {
  if (!["ios", "android"].includes(String(platform))) {
    throw new Error('platform must be "ios" or "android"');
  }
  if (profile) {
    if (!/^[A-Za-z0-9._-]+$/.test(String(profile))) throw new Error(`Invalid eas profile: ${profile}`);
    return ["npx", "eas-cli", "build", "--platform", String(platform), "--profile", String(profile), "--non-interactive"];
  }
  const argv = [...BUILD_COMMANDS[platform]];
  if (device) {
    if (!/^[A-Za-z0-9 ._:-]+$/.test(String(device))) throw new Error(`Invalid device: ${device}`);
    argv.push("--device", String(device));
  }
  return argv;
};

const ERROR_PATTERNS = [
  /\berror\b/i,
  /\bfailed\b/i,
  /^\s*\*\* BUILD FAILED \*\*/,
  /FAILURE: Build failed/,
  /Could not (find|resolve)/i,
  /ld: /,
  /fatal error:/i,
];

const NOISE_PATTERNS = [
  /warning:/i,
  /^\s*$/,
  /^note:/i,
  // Xcode prints "0 errors" on success; treating it as an error would
  // turn every green build red
  /\b0 errors?\b/i,
];

export const classifyBuildLine = (line) => {
  const text = String(line ?? "");
  if (NOISE_PATTERNS.some((pattern) => pattern.test(text))) return "log";
  return ERROR_PATTERNS.some((pattern) => pattern.test(text)) ? "error" : "log";
};

/**
 * Keeps the lines worth reading. A build prints thousands of lines and
 * pushing all of them onto the bus would drown the very events it is
 * supposed to sit next to.
 */
export const summarizeBuildOutput = (lines, limit = 40) => {
  const errors = [];
  const tail = [];
  for (const line of lines) {
    if (classifyBuildLine(line) === "error") errors.push(line);
    tail.push(line);
    if (tail.length > limit) tail.shift();
  }
  return { errors: errors.slice(0, limit), tail };
};

/**
 * Runs the build, streaming each line to `emit` as it arrives so the bus
 * carries the failure while it is happening, not once the process ends.
 */
export const runBuild = async (args, { emit, spawn }) => {
  const argv = buildCommand(args);
  const startedAt = Date.now();
  emit("build.start", { command: argv.join(" "), platform: args.platform, startedAt });

  const proc = spawn(argv);
  const lines = [];
  const consume = async (stream, channel) => {
    if (!stream) return;
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      for (const line of parts) {
        if (!line.trim()) continue;
        lines.push(line);
        const kind = classifyBuildLine(line);
        // Only the failures go on the bus one by one; the rest is kept
        // for the summary so the timeline stays readable
        if (kind === "error") emit("build.error", { line, channel });
      }
    }
  };

  await Promise.all([consume(proc.stdout, "stdout"), consume(proc.stderr, "stderr")]);
  const exitCode = await proc.exited;
  const summary = summarizeBuildOutput(lines);
  emit("build.done", {
    exitCode,
    ok: exitCode === 0,
    durationMs: Date.now() - startedAt,
    errorCount: summary.errors.length,
  });

  return {
    ok: exitCode === 0,
    exitCode,
    command: argv.join(" "),
    durationMs: Date.now() - startedAt,
    errors: summary.errors,
    tail: summary.tail,
    hint:
      exitCode === 0
        ? "Build finished. The build events are on the same bus as the crashes: poll get_events_since to follow the relaunch."
        : "Build failed. The failing lines are in errors, and build.error events sit on the bus next to whatever happened before.",
  };
};

export const BUILD_TOOL = {
  name: "build_app",
  description:
    "Builds the app by delegating to expo run:ios, expo run:android or eas build, and streams the build's failures onto the SAME timestamped bus as the crashes and the requests. Compile error at t0, relaunch at t1, first JS crash at t2, one clock: the agent reads a continuous stream from broken code to running app. xcodebuild and gradle are delegated to, never reimplemented.",
  inputSchema: {
    type: "object",
    required: ["platform"],
    properties: {
      platform: { type: "string", enum: ["ios", "android"] },
      profile: { type: "string", description: "eas.json profile; given, the build goes through EAS instead of the local runner" },
      device: { type: "string", description: "Target device or simulator name for the local runner" },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: true },
};
