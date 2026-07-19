#!/usr/bin/env node
/**
 * rn-devtools-hub CLI.
 *
 *   npx rn-devtools-hub          start the hub (dashboard + WebSocket + MCP)
 *   npx rn-devtools-hub init     wire the SDK into this project (codemod)
 *   npx rn-devtools-hub --help
 *
 * The hub itself runs on Bun (native WebSocket server, zero dependencies).
 * `init` runs on plain Node, so it works before Bun is installed.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInit } from "../src/cli/init.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const [command, ...rest] = process.argv.slice(2);

if (command === "--help" || command === "-h" || command === "help") {
  console.log(`
  rn-devtools-hub

    npx rn-devtools-hub            Start the hub, prints the dashboard URL
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

// Default: start the hub
const bunCheck = spawnSync("bun", ["--version"], { stdio: "ignore" });
if (bunCheck.error) {
  console.error("");
  console.error("  rn-devtools-hub: Bun is required to run the hub.");
  console.error("  Install: curl -fsSL https://bun.sh/install | bash");
  console.error("  (or: npm install -g bun)");
  console.error("");
  console.error("  Note: `npx rn-devtools-hub init` works without Bun.");
  console.error("");
  process.exit(1);
}

const result = spawnSync("bun", [join(here, "..", "server", "server.mjs"), ...process.argv.slice(2)], {
  stdio: "inherit",
  cwd: process.cwd(),
});
process.exit(result.status ?? 0);
