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

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 8973;
const START_TIMEOUT_MS = 20000;

const endpoint = (port) => `http://127.0.0.1:${port}/mcp`;

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

const startHub = (port) =>
  new Promise((resolve, reject) => {
    const child = spawn("bun", [join(HERE, "..", "..", "server", "server.mjs"), "--port", String(port)], {
      cwd: process.cwd(),
      // The hub's banner would corrupt the JSON-RPC stream if it reached
      // stdout, so it goes to stderr where clients show it as a log
      stdio: ["ignore", "pipe", "inherit"],
      env: process.env,
    });
    child.stdout.on("data", (data) => process.stderr.write(data));
    child.on("error", (error) =>
      reject(
        new Error(
          error.code === "ENOENT"
            ? "The hub needs Bun (https://bun.sh). Install it, or start the hub yourself with `npx rn-devtools-hub` and point this bridge at it."
            : String(error.message)
        )
      )
    );
    resolve(child);
  });

export const runStdioBridge = async (argv = []) => {
  const portIndex = argv.indexOf("--port");
  const port = portIndex > -1 ? Number(argv[portIndex + 1]) : DEFAULT_PORT;

  let child = null;
  if (!(await isHubReachable(port))) {
    child = await startHub(port);
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await isHubReachable(port)) break;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    if (!(await isHubReachable(port))) {
      throw new Error(`The hub did not answer on port ${port} within ${START_TIMEOUT_MS} ms`);
    }
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
