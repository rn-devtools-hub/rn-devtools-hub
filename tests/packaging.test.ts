/**
 * Packaging contract tests.
 *
 * Consumers resolve this package under very different TypeScript settings.
 * Modern setups (bundler, node16) read the "exports" map; many React Native
 * projects still run moduleResolution "node" (node10), which ignores exports
 * entirely and needs "typesVersions" to find the subpath types. Both paths
 * must keep working, so they are asserted here rather than discovered by a
 * user whose typecheck breaks.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));

describe("package exports", () => {
  it("exposes the client subpath through the exports map", () => {
    expect(pkg.exports["./client"]).toBeDefined();
    expect(pkg.exports["./client"].types).toBe("./dist/client/index.d.ts");
  });

  it("exposes the same subpath through typesVersions for node10 resolution", () => {
    // Without this, `import ... from "rn-devtools-hub/client"` fails to
    // typecheck in any project using moduleResolution "node"
    expect(pkg.typesVersions).toBeDefined();
    expect(pkg.typesVersions["*"].client).toEqual(["./dist/client/index.d.ts"]);
  });

  it("ships the files the CLI and the hub need at runtime", () => {
    for (const entry of ["dist", "server", "bin", "src/cli"]) {
      expect(pkg.files).toContain(entry);
    }
  });

  it("keeps the hub binary declared", () => {
    expect(pkg.bin["rn-devtools-hub"]).toBe("./bin/rn-devtools-hub.mjs");
  });
});

describe("SDK dependencies", () => {
  it("has no runtime dependencies", () => {
    // The zero-dependency promise is what makes this safe to add to any app
    expect(pkg.dependencies ?? {}).toEqual({});
  });
});

/**
 * Registry and plugin contract.
 *
 * The MCP registry verifies that the npm package claims the server name it
 * is published under, and it rejects a server.json whose version does not
 * match the package it points at. Both are silent-at-authoring, loud-at-
 * publishing failures, so they are asserted here instead.
 */
describe("MCP registry manifest", () => {
  const server = JSON.parse(readFileSync(join(root, "server.json"), "utf-8"));

  it("claims the registry name from package.json, which proves ownership", () => {
    expect(pkg.mcpName).toBe(server.name);
    // GitHub-based authentication only accepts this namespace
    expect(server.name.startsWith("io.github.rn-devtools-hub/")).toBe(true);
  });

  it("points at the npm package it is published alongside", () => {
    const npmPackage = server.packages.find(
      (entry: { registryType: string }) => entry.registryType === "npm"
    );
    expect(npmPackage.identifier).toBe(pkg.name);
    expect(npmPackage.registryBaseUrl).toBe("https://registry.npmjs.org");
  });

  it("keeps the manifest version aligned with the package version", () => {
    const npmPackage = server.packages.find(
      (entry: { registryType: string }) => entry.registryType === "npm"
    );
    expect(server.version).toBe(npmPackage.version);
    // release-it bumps package.json; this catches the manifest left behind
    expect(server.version).toBe(pkg.version);
  });

  // The registry enforces these and rejects with a 422 AFTER the tag and
  // the npm publish already happened, so the limits are asserted here
  // rather than discovered by a failed release
  it("respects the registry's field limits", () => {
    expect(server.description.length).toBeGreaterThan(0);
    expect(server.description.length).toBeLessThanOrEqual(100);
    expect(server.title.length).toBeLessThanOrEqual(100);
    expect(server.name.length).toBeLessThanOrEqual(200);
    expect(server.name).toMatch(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
  });

  it("ships the plugin and the manifest to npm consumers", () => {
    expect(pkg.files).toContain("plugins");
    expect(pkg.files).toContain("server.json");
  });
});

describe("Claude Code plugin", () => {
  const marketplace = JSON.parse(
    readFileSync(join(root, ".claude-plugin", "marketplace.json"), "utf-8")
  );

  it("lists a plugin whose source directory really exists", () => {
    const entry = marketplace.plugins[0];
    expect(entry.source).toBe("./plugins/rn-devtools-hub");
    const plugin = JSON.parse(
      readFileSync(join(root, "plugins/rn-devtools-hub/.claude-plugin/plugin.json"), "utf-8")
    );
    expect(plugin.name).toBe(entry.name);
  });

  it("registers the MCP server on the port the hub actually listens on", () => {
    const mcp = JSON.parse(readFileSync(join(root, "plugins/rn-devtools-hub/.mcp.json"), "utf-8"));
    expect(mcp.mcpServers["rn-devtools"].url).toContain("8973");
  });

  it("carries a skill with the frontmatter Claude Code needs to route it", () => {
    const skill = readFileSync(
      join(root, "plugins/rn-devtools-hub/skills/rn-devtools-hub/SKILL.md"),
      "utf-8"
    );
    expect(skill.startsWith("---\n")).toBe(true);
    expect(skill).toMatch(/^name: rn-devtools-hub$/m);
    expect(skill).toMatch(/^description: .{40,}/m);
  });
});
