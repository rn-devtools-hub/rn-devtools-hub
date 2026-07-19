#!/usr/bin/env node
/**
 * Hub launcher: `npx rn-devtools-hub` from the project root.
 * The hub runs on Bun (native WebSocket server, zero dependencies).
 * This launcher checks for Bun then delegates, keeping the host project's
 * cwd (the hub reads app.json and the assets there for the Design panel).
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const serverPath = join(dirname(fileURLToPath(import.meta.url)), "..", "server", "server.mjs");

const bunCheck = spawnSync("bun", ["--version"], { stdio: "ignore" });
if (bunCheck.error) {
  console.error("");
  console.error("  rn-devtools-hub: Bun is required to run the hub.");
  console.error("  Install: curl -fsSL https://bun.sh/install | bash");
  console.error("  (or: npm install -g bun)");
  console.error("");
  process.exit(1);
}

const result = spawnSync("bun", [serverPath, ...process.argv.slice(2)], {
  stdio: "inherit",
  cwd: process.cwd(),
});
process.exit(result.status ?? 0);
