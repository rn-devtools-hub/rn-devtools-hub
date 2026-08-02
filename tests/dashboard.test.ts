/**
 * Dashboard contract checks.
 *
 * Nothing here judges the design; only a human can. What it catches is the
 * failure that actually happened: a rule block was inserted by matching
 * `.tile .sub{` while the file contains `.tile .sub {`, the replacement
 * silently did nothing, and the project context panel rendered with no
 * styles at all for as long as it existed. No test could see it because
 * the dashboard had none.
 *
 * So: every class the script assigns must exist in the stylesheet, and
 * every id it reaches for must exist in the markup.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "server/dashboard.html"), "utf-8");

const styleBlock = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? "";
const scriptBlock = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";

/** Selectors the stylesheet defines, e.g. `.ctx-facts` */
const definedClasses = new Set(
  [...styleBlock.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((match) => match[1])
);

/**
 * Classes the markup uses, e.g. class="tile good".
 *
 * Attributes containing a template expression are skipped whole: splitting
 * `class="${ok ? 'good' : 'bad'}"` on whitespace yields `===` and `?` as
 * if they were class names.
 */
const markupClasses = new Set(
  [...html.matchAll(/class="([^"]*)"/g)]
    .map((match) => match[1])
    .filter((value) => !value.includes("${"))
    .flatMap((value) => value.split(/\s+/))
    .filter((name) => /^[a-zA-Z][\w-]*$/.test(name))
);

const declaredIds = new Set([...html.matchAll(/\sid="([\w-]+)"/g)].map((match) => match[1]));

describe("dashboard is a single self-contained file", () => {
  it("has exactly one style block and one script block", () => {
    expect(styleBlock.length).toBeGreaterThan(500);
    expect(scriptBlock.length).toBeGreaterThan(500);
    expect(html.match(/<script>/g)?.length).toBe(1);
  });

  it("pulls nothing from a CDN", () => {
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link[^>]+stylesheet/);
  });
});

/**
 * A class earns its place by being styled OR by being a query hook. An SVG
 * element carrying presentation attributes is legitimately unstyled and
 * still needs its class to be found. What must not exist is a class that
 * is neither: written into the markup expecting a rule that is not there,
 * which is exactly how the context panel shipped unstyled.
 */
const queriedClasses = new Set(
  [...scriptBlock.matchAll(/["'`]\.([a-zA-Z][\w-]*)["'`]/g)].map((match) => match[1])
);

describe("every class used is styled or queried", () => {
  it("markup carries no class that is neither", () => {
    const orphans = [...markupClasses].filter(
      (name) => !definedClasses.has(name) && !queriedClasses.has(name)
    );
    expect(orphans, `classes neither styled nor queried: ${orphans.join(", ")}`).toEqual([]);
  });

  it("the project context panel is actually styled", () => {
    // The exact regression: these were referenced by the script and absent
    // from the stylesheet, so the panel rendered raw
    for (const name of ["ctx", "ctx-facts", "ctx-item", "ctx-warn", "ctx-crit"]) {
      expect(definedClasses.has(name), `.${name} has no CSS rule`).toBe(true);
    }
  });
});

describe("every element the script reaches for exists", () => {
  it("$(\"id\") only names ids present in the markup", () => {
    const used = [...scriptBlock.matchAll(/\$\("([\w-]+)"\)/g)].map((match) => match[1]);
    const missing = [...new Set(used)].filter((id) => !declaredIds.has(id));
    expect(missing, `ids read by the script but absent from the HTML: ${missing.join(", ")}`).toEqual(
      []
    );
  });
});

describe("theme colours come from variables", () => {
  it("the context panel uses theme variables rather than hardcoded hex", () => {
    const contextRules = /\.ctx \{[\s\S]*?\.tile \.sub \{/.exec(styleBlock)?.[0] ?? "";
    expect(contextRules).toContain("var(--");
    expect(contextRules).not.toMatch(/#[0-9a-f]{6}/i);
  });
});
