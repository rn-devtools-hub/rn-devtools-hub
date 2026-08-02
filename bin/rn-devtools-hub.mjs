#!/usr/bin/env node
/**
 * rn-devtools-hub CLI.
 *
 *   npx rn-devtools-hub          start the hub (dashboard + WebSocket + MCP)
 *   npx rn-devtools-hub init     wire the SDK into this project (codemod)
 *   npx rn-devtools-hub --help
 *
 * The hub runs on Bun or on Node: Bun when present, Node otherwise. No
 * dependency either way. `init` and `mcp` are plain Node.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInit } from "../src/cli/init.mjs";
import { runStdioBridge } from "../src/cli/stdio.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const [command, ...rest] = process.argv.slice(2);

if (command === "--help" || command === "-h" || command === "help") {
  console.log(`
  rn-devtools-hub

    npx rn-devtools-hub            Start the hub, prints the dashboard URL
    npx rn-devtools-hub mcp        Speak MCP over stdio (bridges to the hub)
    npx rn-devtools-hub init       Wire the SDK into this project
      --dry-run                    Show what would change, write nothing
      --force                      Regenerate the glue file if it exists

  Options for the hub:
    --port <number>                Listen on another port (default 8973)

  Environment:
    RN_DEVTOOLS_TOKEN              Pin the dashboard token (default: random)

  Docs: https://rn-devtools-hub.github.io/rn-devtools-hub/
`);
  process.exit(0);
}

if (command === "init") {
  process.exit(runInit(rest));
}

if (command === "mcp") {
  // stdio transport for clients that do not speak HTTP. Nothing may be
  // written to stdout except JSON-RPC, so failures go to stderr.
  try {
    await runStdioBridge(rest);
    process.exit(0);
  } catch (error) {
    console.error(`rn-devtools-hub mcp: ${error?.message ?? error}`);
    process.exit(1);
  }
}

// Default: start the hub.
//
// Bun when it is there, because it starts faster, and Node otherwise. The
// hub itself runs on both: server/runtime.mjs papers over the difference,
// including the WebSocket server Node does not ship. Requiring a second
// runtime to try a tool whose whole argument is the absence of friction
// was a barrier, not a design.
const hub = join(here, "..", "server", "server.mjs");
const args = process.argv.slice(2);
const useBun = !spawnSync("bun", ["--version"], { stdio: "ignore" }).error;

if (!useBun && Number(process.versions.node.split(".")[0]) < 20) {
  console.error("");
  console.error(`  rn-devtools-hub: Node 20 or newer is required (found ${process.versions.node}).`);
  console.error("  Alternatively, install Bun: curl -fsSL https://bun.sh/install | bash");
  console.error("");
  process.exit(1);
}

const result = useBun
  ? spawnSync("bun", [hub, ...args], { stdio: "inherit", cwd: process.cwd() })
  : spawnSync(process.execPath, [hub, ...args], { stdio: "inherit", cwd: process.cwd() });
process.exit(result.status ?? 0);
