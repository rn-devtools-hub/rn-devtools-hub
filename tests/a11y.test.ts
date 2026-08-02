import { describe, expect, it } from "vitest";
// @ts-expect-error untyped hub module
import * as a11yModule from "../server/a11y.mjs";
// @ts-expect-error untyped hub module
import * as buildModule from "../server/build.mjs";

interface A11yNode {
  source: string;
  type: string | null;
  text: string | null;
  label: string | null;
  testID: string | null;
  clickable: boolean;
  rect: { x: number; y: number; width: number; height: number } | null;
}

interface Finding {
  kind: string;
  detail: string;
  node: Record<string, unknown>;
}

const { parseAndroidA11y, parseIosA11y, flattenReactTree, crossCheck } = a11yModule as {
  parseAndroidA11y: (xml: string) => A11yNode[];
  parseIosA11y: (json: unknown) => A11yNode[];
  flattenReactTree: (nodes: unknown[]) => Array<Record<string, unknown>>;
  crossCheck: (
    reactNodes: unknown[],
    a11yNodes: unknown[]
  ) => { reactNodes: number; accessibilityNodes: number; findings: Finding[]; conclusive: boolean };
};

const { buildCommand, classifyBuildLine, summarizeBuildOutput, runBuild } = buildModule as {
  buildCommand: (args: Record<string, unknown>) => string[];
  classifyBuildLine: (line: string) => string;
  summarizeBuildOutput: (lines: string[], limit?: number) => { errors: string[]; tail: string[] };
  runBuild: (args: Record<string, unknown>, deps: Record<string, any>) => Promise<Record<string, any>>;
};

describe("parseAndroidA11y", () => {
  const xml = `<?xml version='1.0'?><hierarchy>
    <node class="android.widget.FrameLayout" bounds="[0,0][1080,2400]" clickable="false" />
    <node class="android.widget.TextView" text="Commander" bounds="[40,100][400,180]" clickable="true" resource-id="com.app:id/order" enabled="true" />
    <node class="android.widget.ImageView" content-desc="Panier &amp; total" bounds="[900,100][1000,180]" clickable="true" />
  </hierarchy>`;

  it("keeps only the nodes an agent could act on", () => {
    const nodes = parseAndroidA11y(xml);
    expect(nodes).toHaveLength(2);
    expect(nodes[0].text).toBe("Commander");
  });

  it("decodes XML entities in a label", () => {
    expect(parseAndroidA11y(xml)[1].label).toBe("Panier & total");
  });

  it("parses bounds into a rect", () => {
    expect(parseAndroidA11y(xml)[0].rect).toEqual({ x: 40, y: 100, width: 360, height: 80 });
  });

  it("shortens the resource id to its name", () => {
    expect(parseAndroidA11y(xml)[0].testID).toBe("order");
  });

  it("marks every node as coming from accessibility, never from React", () => {
    expect(parseAndroidA11y(xml).every((node) => node.source === "accessibility")).toBe(true);
  });

  it("returns an empty list on junk rather than throwing", () => {
    expect(parseAndroidA11y("not xml at all")).toEqual([]);
    expect(parseAndroidA11y("")).toEqual([]);
  });
});

describe("parseIosA11y", () => {
  it("walks the AXe tree and keeps named elements", () => {
    const nodes = parseIosA11y(
      JSON.stringify({
        AXLabel: "root",
        children: [
          { AXLabel: "Commander", type: "Button", frame: { x: 10, y: 20, width: 100, height: 40 } },
          { children: [{ AXLabel: "Total", AXValue: "12 EUR" }] },
        ],
      })
    );
    expect(nodes.map((node) => node.label)).toEqual(["root", "Commander", "Total"]);
    expect(nodes[1].rect).toEqual({ x: 10, y: 20, width: 100, height: 40 });
    expect(nodes[2].text).toBe("12 EUR");
  });

  it("returns an empty list on unparseable output", () => {
    expect(parseIosA11y("{not json")).toEqual([]);
  });
});

describe("flattenReactTree", () => {
  it("descends into children", () => {
    const flat = flattenReactTree([
      { type: "View", children: [{ type: "Text", text: "Hello" }] },
    ]);
    expect(flat).toHaveLength(2);
    expect(flat[1].text).toBe("Hello");
  });
});

describe("crossCheck", () => {
  const reactTree = [
    {
      type: "View",
      children: [
        { type: "Text", text: "Commander" },
        { type: "Text", text: "Total caché" },
        { type: "View", pressable: true, source: { file: "src/Cart.tsx", line: 12 } },
      ],
    },
  ];
  const a11yNodes = [{ text: "Commander", label: null, testID: null }];

  it("finds text React renders but accessibility does not expose", () => {
    const report = crossCheck(reactTree, a11yNodes);
    const missing = report.findings.find((finding) => finding.kind === "text-not-exposed");
    expect(missing?.node.text).toBe("Total caché");
  });

  it("finds a pressable with no accessible name at all", () => {
    const report = crossCheck(reactTree, a11yNodes);
    const unnamed = report.findings.find((finding) => finding.kind === "unnamed-control");
    expect(unnamed).toBeTruthy();
    expect(unnamed?.node.sourceLocation).toMatchObject({ file: "src/Cart.tsx", line: 12 });
  });

  it("does not flag what accessibility does expose", () => {
    const report = crossCheck(reactTree, a11yNodes);
    expect(report.findings.some((finding) => finding.node.text === "Commander")).toBe(false);
  });

  it("matches case-insensitively and ignores surrounding space", () => {
    const report = crossCheck([{ type: "Text", text: "  COMMANDER " }], a11yNodes);
    expect(report.findings).toEqual([]);
  });

  it("reports conclusive:false rather than a clean audit on an empty tree", () => {
    expect(crossCheck(reactTree, []).conclusive).toBe(false);
    expect(crossCheck([], a11yNodes).conclusive).toBe(false);
    expect(crossCheck(reactTree, a11yNodes).conclusive).toBe(true);
  });
});

describe("buildCommand", () => {
  it("delegates to the local runner by default", () => {
    expect(buildCommand({ platform: "ios" })).toEqual(["npx", "expo", "run:ios"]);
  });

  it("goes through EAS as soon as a profile is named", () => {
    expect(buildCommand({ platform: "android", profile: "preview" })).toContain("eas-cli");
  });

  it("rejects an unknown platform and an unsafe profile", () => {
    expect(() => buildCommand({ platform: "web" })).toThrow(/ios/);
    expect(() => buildCommand({ platform: "ios", profile: "a; rm -rf /" })).toThrow(/Invalid eas profile/);
  });
});

describe("classifyBuildLine", () => {
  it("recognises real failures", () => {
    expect(classifyBuildLine("** BUILD FAILED **")).toBe("error");
    expect(classifyBuildLine("fatal error: 'React/RCTBridge.h' file not found")).toBe("error");
    expect(classifyBuildLine("FAILURE: Build failed with an exception.")).toBe("error");
  });

  it("does not turn a green build red on its own summary line", () => {
    expect(classifyBuildLine("Compile finished with 0 errors")).toBe("log");
  });

  it("treats warnings and notes as noise", () => {
    expect(classifyBuildLine("warning: unused variable 'x'")).toBe("log");
    expect(classifyBuildLine("note: expanded from macro")).toBe("log");
  });
});

describe("summarizeBuildOutput", () => {
  it("keeps the failures and a bounded tail", () => {
    const lines = [...Array.from({ length: 100 }, (_, i) => `line ${i}`), "fatal error: boom"];
    const summary = summarizeBuildOutput(lines, 10);
    expect(summary.errors).toEqual(["fatal error: boom"]);
    expect(summary.tail).toHaveLength(10);
  });
});

describe("runBuild", () => {
  const streamOf = (text: string): AsyncIterable<Uint8Array> => ({
    async *[Symbol.asyncIterator]() {
      yield new TextEncoder().encode(text);
    },
  });

  it("puts each failing line on the bus while the build runs", async () => {
    const emitted: Array<{ type: string; payload: any }> = [];
    const result = await runBuild(
      { platform: "ios" },
      {
        emit: (type: string, payload: unknown) => emitted.push({ type, payload }),
        spawn: () => ({
          stdout: streamOf("Compiling\nfatal error: missing header\n"),
          stderr: streamOf(""),
          exited: Promise.resolve(65),
        }),
      }
    );
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(65);
    expect(emitted.map((entry) => entry.type)).toEqual(["build.start", "build.error", "build.done"]);
    expect(emitted[1].payload.line).toContain("missing header");
  });

  it("reports a successful build without inventing errors", async () => {
    const emitted: string[] = [];
    const result = await runBuild(
      { platform: "android" },
      {
        emit: (type: string) => emitted.push(type),
        spawn: () => ({
          stdout: streamOf("BUILD SUCCESSFUL in 42s\n"),
          stderr: streamOf(""),
          exited: Promise.resolve(0),
        }),
      }
    );
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(emitted).toEqual(["build.start", "build.done"]);
  });
});
