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
