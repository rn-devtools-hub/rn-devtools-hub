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
import { readFileSync, readdirSync } from "node:fs";
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
    for (const entry of server.packages) {
      expect(entry.identifier).toBe(pkg.name);
      expect(entry.registryBaseUrl).toBe("https://registry.npmjs.org");
    }
  });

  /**
   * A client that discovers the server through the registry can install a
   * stdio package by itself. It cannot know that an http:// URL on
   * localhost requires the user to have started the hub first, so a
   * registry entry offering only that silently fails to connect.
   */
  it("offers stdio first, so discovery can install it unattended", () => {
    expect(server.packages[0].transport.type).toBe("stdio");
    expect(server.packages[0].packageArguments[0].value).toBe("mcp");
    expect(server.packages.some((entry: any) => entry.transport.type === "streamable-http")).toBe(true);
  });

  it("keeps the manifest version aligned with the package version", () => {
    for (const entry of server.packages) expect(entry.version).toBe(server.version);
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

/**
 * Two agents, one skill.
 *
 * Claude Code reads plugins/<name>/skills/<name>/SKILL.md, Codex reads
 * .agents/skills/<name>/SKILL.md. The format is the same, so the file is
 * duplicated rather than abstracted; this test is what makes the
 * duplication safe, because a skill that drifts between the two silently
 * teaches two different things.
 */
/**
 * Cursor has no marketplace: the rule and the MCP entry only reach a user
 * if `init` writes them into their project, so the template has to be in
 * the published package and has to be a rule Cursor will actually load.
 */
describe("Cursor rule template", () => {
  const rule = readFileSync(join(root, "templates/cursor-rule.mdc"), "utf-8");

  it("carries the frontmatter Cursor needs to route it", () => {
    expect(rule.startsWith("---\n")).toBe(true);
    expect(rule).toMatch(/^description: .{60,}/m);
    // Always-on rules cost tokens on every request, including the ones
    // that have nothing to do with the app
    expect(rule).toMatch(/^alwaysApply: false$/m);
  });

  it("ships to npm consumers, since init reads it from the package", () => {
    expect(pkg.files).toContain("templates");
  });

  it("teaches the same three habits as the skill", () => {
    expect(rule).toContain("get_project_context");
    expect(rule).toContain("assert");
    expect(rule).toContain("wait_for_event");
  });
});

/**
 * Cursor's setup is documented, not automated, so the template has to be
 * in the published package: the instructions tell the user to copy it out
 * of node_modules, and a rule Cursor will not load helps nobody.
 */
describe("Cursor rule template", () => {
  const rule = readFileSync(join(root, "templates/cursor-rule.mdc"), "utf-8");

  it("carries the frontmatter Cursor needs to route it", () => {
    expect(rule.startsWith("---\n")).toBe(true);
    expect(rule).toMatch(/^description: .{60,}/m);
    // Always-on rules cost tokens on every request, including the ones
    // that have nothing to do with the app
    expect(rule).toMatch(/^alwaysApply: false$/m);
  });

  it("ships to npm consumers, since the docs tell them to copy it", () => {
    expect(pkg.files).toContain("templates");
  });

  it("teaches the same three habits as the skill", () => {
    expect(rule).toContain("get_project_context");
    expect(rule).toContain("assert");
    expect(rule).toContain("wait_for_event");
  });
});

describe("Codex plugin", () => {
  const claudeSkills = join(root, "plugins/rn-devtools-hub/skills");
  const skills = readdirSync(claudeSkills).sort();

  it("ships the skills that teach both halves of the job", () => {
    // The release skill is why installing the hub is enough: the agent
    // that drives App Store Connect and Play is the one that already
    // knows the app from the inside, with no second thing to install
    expect(skills).toContain("rn-devtools-hub");
    expect(skills).toContain("rn-devtools-release");
  });

  it("carries every skill of the Claude Code plugin, byte for byte", () => {
    for (const skill of skills) {
      const claude = readFileSync(join(claudeSkills, skill, "SKILL.md"), "utf-8");
      const codex = readFileSync(join(root, ".agents/skills", skill, "SKILL.md"), "utf-8");
      expect(codex).toBe(claude);
    }
  });

  it("licenses each skill the way the package is licensed", () => {
    for (const skill of skills) {
      const source = readFileSync(join(claudeSkills, skill, "SKILL.md"), "utf-8");
      expect(source).toMatch(/^license: MIT$/m);
      expect(source).toMatch(/^name: /m);
      expect(source).toMatch(/^description: .{80,}/m);
    }
  });

  it("declares a plugin Codex can read", () => {
    const plugin = JSON.parse(readFileSync(join(root, ".codex-plugin/plugin.json"), "utf-8"));
    expect(plugin.name).toBe("rn-devtools-hub");
    expect(plugin.interface.displayName).toBeTruthy();
    expect(plugin.interface.defaultPrompt.length).toBeGreaterThan(0);
  });

  it("lists itself in the marketplace manifest Codex looks for", () => {
    const marketplace = JSON.parse(
      readFileSync(join(root, ".agents/plugins/marketplace.json"), "utf-8")
    );
    expect(marketplace.plugins[0].name).toBe("rn-devtools-hub");
  });

  it("ships both plugin layouts to npm consumers", () => {
    expect(pkg.files).toContain(".agents");
    expect(pkg.files).toContain(".codex-plugin");
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
