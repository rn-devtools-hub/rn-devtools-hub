import { describe, expect, it } from "vitest";
// @ts-expect-error untyped hub module
import * as symbolicateModule from "../server/symbolicate.mjs";

interface Frame {
  methodName: string;
  file: string;
  lineNumber: number;
  column: number;
  collapse?: boolean;
}

const { parseFrames, firstAppFrame, metroUrlFromFrames, symbolicate, upgradeSource, upgradeTreeSources } =
  symbolicateModule as {
    parseFrames: (frames: string[]) => Frame[];
    firstAppFrame: (frames: unknown[]) => Frame | null;
    metroUrlFromFrames: (frames: unknown[], fallback?: string) => string;
    symbolicate: (frames: string[], options?: Record<string, unknown>) => Promise<Record<string, any>>;
    upgradeSource: (source: unknown, options?: Record<string, unknown>) => Promise<Record<string, any>>;
    upgradeTreeSources: (nodes: unknown[], options?: Record<string, unknown>) => Promise<any[]>;
  };

const BUNDLE = "http://localhost:8081/index.bundle?platform=ios&dev=true";

describe("parseFrames", () => {
  it("parses the V8 shape React 19 owner stacks produce", () => {
    expect(parseFrames([`    at ServiceCard (${BUNDLE}:48213:19)`])).toEqual([
      { methodName: "ServiceCard", file: BUNDLE, lineNumber: 48213, column: 19 },
    ]);
  });

  it("parses the Hermes shape", () => {
    expect(parseFrames([`ServiceCard@${BUNDLE}:48213:19`])[0]).toMatchObject({
      methodName: "ServiceCard",
      lineNumber: 48213,
    });
  });

  it("parses an anonymous frame without losing its position", () => {
    const frame = parseFrames([`    at ${BUNDLE}:100:5`])[0];
    expect(frame.methodName).toBe("<unknown>");
    expect(frame.lineNumber).toBe(100);
  });

  it("drops what it cannot parse instead of inventing positions", () => {
    expect(parseFrames(["Error: react-stack-top-frame", "   at [native code]"])).toEqual([]);
  });
});

describe("firstAppFrame", () => {
  it("skips React's own plumbing to reach the component", () => {
    const found = firstAppFrame([
      { file: "/app/node_modules/react/cjs/react-jsx-dev-runtime.development.js", lineNumber: 333 },
      { file: "/app/src/components/ServiceCard.tsx", lineNumber: 42, methodName: "ServiceCard" },
    ]);
    expect(found?.file).toContain("ServiceCard.tsx");
  });

  it("honours Metro's own collapse flag", () => {
    const found = firstAppFrame([
      { file: "/app/src/generated.js", lineNumber: 1, collapse: true },
      { file: "/app/src/Real.tsx", lineNumber: 7 },
    ]);
    expect(found?.file).toContain("Real.tsx");
  });

  // Found against a real Metro: it answers 200 for positions it cannot map
  // and hands back the bundle URL with a null line. A naive filter accepts
  // that frame and reports a URL as the source file.
  it("rejects a frame Metro could not map, rather than reporting a URL", () => {
    expect(
      firstAppFrame([
        { file: "http://localhost:8081/index.bundle?platform=ios", lineNumber: null, methodName: "X" },
        { file: "/app/src/Real.tsx", lineNumber: 7 },
      ])?.file
    ).toBe("/app/src/Real.tsx");

    expect(
      firstAppFrame([{ file: "http://localhost:8081/index.bundle", lineNumber: null }])
    ).toBeNull();
  });

  it("rejects a frame with no usable line number", () => {
    expect(firstAppFrame([{ file: "/app/src/Real.tsx", lineNumber: null }])).toBeNull();
  });

  it("returns null when every frame is library code", () => {
    expect(firstAppFrame([{ file: "/app/node_modules/react/index.js", lineNumber: 1 }])).toBeNull();
    expect(firstAppFrame([])).toBeNull();
  });
});

describe("metroUrlFromFrames", () => {
  it("reads Metro's address off the bundle URL rather than assuming 8081", () => {
    expect(metroUrlFromFrames([{ file: "http://192.168.1.10:8088/index.bundle" }])).toBe(
      "http://192.168.1.10:8088"
    );
  });

  it("falls back when no frame carries a URL", () => {
    expect(metroUrlFromFrames([{ file: "src/App.tsx" }])).toBe("http://localhost:8081");
  });
});

describe("symbolicate", () => {
  const metroAnswer = (stack: unknown) => ({
    ok: true,
    status: 200,
    json: async () => ({ stack }),
  });

  it("posts the parsed frames to Metro and returns what it maps", async () => {
    let body: any = null;
    const result = await symbolicate([`    at ServiceCard (${BUNDLE}:48213:19)`], {
      fetchImpl: async (_url: string, init: any) => {
        body = JSON.parse(init.body);
        return metroAnswer([
          { file: "/app/src/ServiceCard.tsx", lineNumber: 42, column: 10, methodName: "ServiceCard" },
        ]);
      },
    });
    expect(body.stack[0].lineNumber).toBe(48213);
    expect(result.ok).toBe(true);
    expect(result.frames[0].file).toContain("ServiceCard.tsx");
  });

  it("refuses to send a stack to a host that is not local", async () => {
    let called = false;
    const result = await symbolicate([`    at X (https://evil.example.com/b.js:1:1)`], {
      fetchImpl: async () => {
        called = true;
        return metroAnswer([]);
      },
    });
    expect(called).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("non-local");
  });

  it("degrades when Metro is not running", async () => {
    const result = await symbolicate([`    at X (${BUNDLE}:1:1)`], {
      fetchImpl: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("ECONNREFUSED");
  });

  it("degrades on an unexpected Metro status", async () => {
    const result = await symbolicate([`    at X (${BUNDLE}:1:1)`], {
      fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("404");
  });

  it("says so when nothing could be parsed", async () => {
    const result = await symbolicate(["Error: nope"], { fetchImpl: async () => metroAnswer([]) });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("no parsable frames");
  });
});

describe("upgradeSource", () => {
  const stackSource = {
    file: null,
    line: null,
    column: null,
    componentName: "ServiceCard",
    via: "stack",
    stack: [`    at ServiceCard (${BUNDLE}:48213:19)`],
  };

  const metro = {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        stack: [
          { file: "/app/node_modules/react/cjs/react-jsx-dev-runtime.development.js", lineNumber: 333 },
          { file: "/app/src/components/ServiceCard.tsx", lineNumber: 42, column: 10, methodName: "ServiceCard" },
        ],
      }),
    }),
  };

  it("turns bundle coordinates into a real file and line", async () => {
    const upgraded = await upgradeSource(stackSource, metro);
    expect(upgraded).toMatchObject({
      file: "/app/src/components/ServiceCard.tsx",
      line: 42,
      column: 10,
      via: "symbolicated",
    });
    expect(upgraded.stack).toBeUndefined();
  });

  it("leaves an already exact location alone, without a round trip", async () => {
    let called = false;
    const exact = { file: "src/App.tsx", line: 3, column: 1, componentName: "App", via: "debugSource" };
    const result = await upgradeSource(exact, {
      fetchImpl: async () => {
        called = true;
        return { ok: true, status: 200, json: async () => ({ stack: [] }) };
      },
    });
    expect(result).toBe(exact);
    expect(called).toBe(false);
  });

  it("keeps the raw frames and explains itself when Metro is unreachable", async () => {
    const result = await upgradeSource(stackSource, {
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(result.via).toBe("stack");
    expect(result.stack).toEqual(stackSource.stack);
    expect(result.symbolication.ok).toBe(false);
  });

  it("explains itself when every symbolicated frame is library code", async () => {
    const result = await upgradeSource(stackSource, {
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ stack: [{ file: "/app/node_modules/react/index.js", lineNumber: 1 }] }),
      }),
    });
    expect(result.via).toBe("stack");
    expect(result.symbolication.reason).toContain("no application frame");
  });
});

describe("upgradeTreeSources", () => {
  it("upgrades nested nodes and asks Metro once per distinct stack", async () => {
    let calls = 0;
    const stack = [`    at ServiceCard (${BUNDLE}:48213:19)`];
    const tree = [
      { type: "View", source: { via: "stack", stack }, children: [{ type: "Text", source: { via: "stack", stack } }] },
    ];
    await upgradeTreeSources(tree, {
      fetchImpl: async () => {
        calls += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({ stack: [{ file: "/app/src/ServiceCard.tsx", lineNumber: 42 }] }),
        };
      },
    });
    expect(calls).toBe(1);
    expect(tree[0].source).toMatchObject({ file: "/app/src/ServiceCard.tsx", via: "symbolicated" });
    expect((tree[0].children[0] as any).source).toMatchObject({ via: "symbolicated" });
  });

  it("leaves a tree without sources untouched", async () => {
    const tree = [{ type: "View", children: [{ type: "Text" }] }];
    await expect(upgradeTreeSources(tree, {})).resolves.toBe(tree);
  });
});
