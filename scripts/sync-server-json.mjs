/**
 * Keeps server.json's version in step with package.json.
 *
 * release-it bumps package.json and leaves every other manifest behind. The
 * MCP registry rejects a server.json whose version does not match the npm
 * package it points at, and that rejection lands at publish time, after the
 * tag and the changelog. Running this from the after:bump hook makes the
 * drift impossible instead of catching it late.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2] ?? JSON.parse(readFileSync(join(root, "package.json"), "utf-8")).version;

const path = join(root, "server.json");
const manifest = JSON.parse(readFileSync(path, "utf-8"));
manifest.version = version;
for (const entry of manifest.packages ?? []) entry.version = version;
writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`server.json synced to ${version}`);
