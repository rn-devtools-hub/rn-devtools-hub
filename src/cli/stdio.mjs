/**
 * stdio bridge to the local hub.
 *
 * The hub speaks streamable HTTP on 127.0.0.1, which Claude Code and Cursor
 * handle natively. Plenty of MCP clients only speak stdio, and registries
 * that list local servers assume it too. Rather than teach the hub a second
 * transport, this bridges one to the other: JSON-RPC in on stdin, the same
 * JSON-RPC out on stdout, HTTP in between.
 *
 * It runs on plain Node. The hub itself needs Bun, and the bridge starts it
 * on demand in the current working directory, because the hub reads the host
 * project from its cwd: started from the wrong place it would report another
 * project's assets and versions.
 */

import { spawn, spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 8973;
const START_TIMEOUT_MS = 20000;

const endpoint = (port) => `http://127.0.0.1:${port}/mcp`;

/**
 * The port this project's hub actually bound, as the hub itself recorded it.
 *
 * The bridge only ever knew the default port, so a hub that had to fall
 * back to another one was invisible to it: the bridge started a SECOND hub
 * for the same project, and the agent then talked to a hub with no device
 * attached while the real one sat next to it.
 */
export const discoverHubPort = (cwd = process.cwd()) => {
  try {
    const written = JSON.parse(readFileSync(join(cwd, ".rn-devtools", "hub.json"), "utf-8"));
    const port = Number(written.port);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
  } catch {
    return null; // no hub has run here, or the file is unreadable
  }
};

/** Symlinks and trailing separators make two spellings of one directory,
 * and /tmp against /private/tmp is the everyday example on macOS */
const canonicalPath = (path) => {
  if (!path) return null;
  const absolute = resolve(String(path));
  try {
    return realpathSync(absolute);
  } catch {
    return absolute; // the directory may be gone; the spelling still compares
  }
};

/**
 * Whether the hub on a port serves THIS project, asked of the hub itself.
 *
 * "Something answered" is not the same fact as "my project's hub answered",
 * and the difference is an agent driving the wrong app while every answer
 * looks normal. It happens without anyone doing anything strange: project A
 * is killed with -9 and leaves its hub.json behind, project B's hub falls
 * back onto that very port, and the bridge started in A now types into B.
 * The plain version needs no stale file at all: A's hub is simply off, so
 * the bridge falls back to 8973, where B has been listening all along.
 *
 * The hub already names its project on list_devices, which is the only
 * source that cannot be stale: it comes from the running process.
 */
export const hubServesProject = async (port, cwd = process.cwd(), fetchImpl = fetch) => {
  try {
    const response = await fetchImpl(endpoint(port), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "whoami",
        method: "tools/call",
        params: { name: "list_devices", arguments: {} },
      }),
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) return false;
    const message = await response.json();
    const text = message?.result?.content?.[0]?.text;
    const directory = JSON.parse(String(text)).project?.directory;
    const here = canonicalPath(cwd);
    return Boolean(here && canonicalPath(directory) === here);
  } catch {
    return false; // unreachable, not a hub, or an answer we cannot read
  }
};

export const isHubReachable = async (port, fetchImpl = fetch) => {
  try {
    const response = await fetchImpl(endpoint(port), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "probe", method: "ping" }),
      signal: AbortSignal.timeout(1500),
    });
    return response.ok;
  } catch {
    return false;
  }
};

/**
 * JSON-RPC over stdio is newline-delimited, but a chunk boundary can land
 * mid-message and several messages can arrive in one chunk. Framing is
 * therefore its own function, and its own tests.
 */
export const createFramer = () => {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    const messages = [];
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        try {
          messages.push(JSON.parse(line));
        } catch {
          // A malformed line is the client's problem; dropping it beats
          // desynchronising the stream for every message after it
        }
      }
      newline = buffer.indexOf("\n");
    }
    return messages;
  };
};

const errorFor = (id, message) => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: { code: -32603, message },
});

/**
 * The bridge itself. IO is injected so the routing can be tested without a
 * hub and without a real stdin.
 */
export const createBridge = ({ post, write }) => {
  const framer = createFramer();
  return async (chunk) => {
    for (const message of framer(String(chunk))) {
      // A notification has no id and expects no answer: forwarding a reply
      // for one would violate the protocol
      const isNotification = message.id === undefined || message.id === null;
      try {
        const response = await post(message);
        if (!isNotification && response !== undefined) write(response);
      } catch (error) {
        if (!isNotification) write(errorFor(message.id, String(error?.message ?? error)));
      }
    }
  };
};

const startHub = (port, pinned) =>
  new Promise((resolve, reject) => {
    // The hub runs on either runtime, so the bridge must too. Hardcoding
    // Bun here meant the bridge failed on a Node-only machine while the
    // hub itself was perfectly happy.
    const hub = join(HERE, "..", "..", "server", "server.mjs");
    const useBun = !spawnSync("bun", ["--version"], { stdio: "ignore" }).error;
    const command = useBun ? "bun" : process.execPath;

    // --port only when the user asked for one: passing it always would
    // forbid the hub the fallback it has for a busy default port, and the
    // bridge reads back where it landed anyway
    const args = pinned ? [hub, "--port", String(port)] : [hub];
    const child = spawn(command, args, {
      cwd: process.cwd(),
      // The hub's banner would corrupt the JSON-RPC stream if it reached
      // stdout, so it goes to stderr where clients show it as a log
      stdio: ["ignore", "pipe", "inherit"],
      env: process.env,
    });
    child.stdout.on("data", (data) => process.stderr.write(data));

    // Resolving immediately swallowed the spawn failure: the caller then
    // waited out the whole start timeout and reported "no answer" instead
    // of the reason. Settle on the first event either way.
    let settled = false;
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(new Error(`Could not start the hub with ${command}: ${error.message}`));
    });
    setImmediate(() => {
      if (settled) return;
      settled = true;
      resolve(child);
    });
  });

export const runStdioBridge = async (argv = []) => {
  const portIndex = argv.indexOf("--port");
  const explicitPort = portIndex > -1 ? Number(argv[portIndex + 1]) : null;
  const pinned = explicitPort !== null;
  const cwd = process.cwd();

  /**
   * A port is only adopted once the hub there confirms it serves this
   * project. A pinned port is an instruction and is used either way, but
   * never silently: driving another project's app is the failure this
   * check exists for, and it costs nothing to say it out loud.
   */
  const isOurs = async (candidate) => {
    if (!candidate) return false;
    if (await hubServesProject(candidate, cwd)) return true;
    if (pinned && (await isHubReachable(candidate))) {
      process.stderr.write(
        `rn-devtools-hub: the hub on port ${candidate} serves another project, using it because --port was given\n`
      );
      return true;
    }
    return false;
  };

  // Re-read on every attempt: the hub writes the file as it starts, and a
  // hub that fell back to another port says so nowhere else
  const candidates = () => (pinned
    ? [explicitPort]
    : [...new Set([discoverHubPort(cwd), DEFAULT_PORT].filter(Boolean))]);

  const findHub = async () => {
    for (const candidate of candidates()) {
      if (await isOurs(candidate)) return candidate;
    }
    return null;
  };

  let port = pinned ? explicitPort : DEFAULT_PORT;
  let child = null;
  const running = await findHub();
  if (running !== null) {
    port = running;
  } else {
    child = await startHub(port, pinned);
    const deadline = Date.now() + START_TIMEOUT_MS;
    let started = null;
    while (started === null && Date.now() < deadline) {
      started = await findHub();
      if (started === null) await new Promise((resolve) => setTimeout(resolve, 300));
    }
    if (started === null) {
      throw new Error(
        `No hub answered for ${cwd} within ${START_TIMEOUT_MS} ms (last port tried: ${port})`
      );
    }
    port = started;
  }

  const post = async (message) => {
    const response = await fetch(endpoint(port), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });
    // The hub answers 202 with no body for notifications
    if (response.status === 202) return undefined;
    return response.json();
  };

  const handle = createBridge({
    post,
    write: (value) => process.stdout.write(`${JSON.stringify(value)}\n`),
  });

  process.stdin.setEncoding("utf-8");
  // Chained rather than fired and forgotten: stdin closes as soon as the
  // last chunk is written, and without this the process would exit, and
  // kill the hub, while the answers were still in flight. A piped client
  // then sees nothing at all.
  let inFlight = Promise.resolve();
  process.stdin.on("data", (chunk) => {
    inFlight = inFlight.then(() => handle(chunk));
  });
  await new Promise((resolve) => {
    process.stdin.on("end", resolve);
    process.stdin.on("close", resolve);
  });
  await inFlight;
  // Only stop what we started: a hub the user launched keeps running
  if (child) child.kill();
};
