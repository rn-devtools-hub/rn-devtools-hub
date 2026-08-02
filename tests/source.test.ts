import { afterEach, describe, expect, it } from "vitest";
import {
  componentNameOf,
  normalizeSource,
  resolveSource,
  stackFramesOf,
  captureOrigin,
} from "../src/client/source";
import type { FiberLike } from "../src/client/automation";

const setHook = (value: unknown): void => {
  (globalThis as Record<string, unknown>).__REACT_DEVTOOLS_GLOBAL_HOOK__ = value;
};

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__REACT_DEVTOOLS_GLOBAL_HOOK__;
});

const fiber = (overrides: Record<string, unknown> = {}): FiberLike =>
  ({ type: "RCTView", memoizedProps: {}, ...overrides }) as FiberLike;

describe("componentNameOf", () => {
  it("prefers displayName over the function name", () => {
    const Component = (): null => null;
    (Component as unknown as Record<string, unknown>).displayName = "ServiceCard";
    expect(componentNameOf(Component)).toBe("ServiceCard");
  });

  it("falls back to the function name", () => {
    function OrderButton(): null {
      return null;
    }
    expect(componentNameOf(OrderButton)).toBe("OrderButton");
  });

  it("unwraps forwardRef and memo", () => {
    function Inner(): null {
      return null;
    }
    expect(componentNameOf({ render: Inner })).toBe("Inner");
    expect(componentNameOf({ type: { render: Inner } })).toBe("Inner");
  });

  it("returns host tag names as-is and null for anything unnamed", () => {
    expect(componentNameOf("RCTView")).toBe("RCTView");
    expect(componentNameOf(null)).toBeNull();
    expect(componentNameOf({})).toBeNull();
  });

  it("stops recursing on a self-referencing type", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.type = cyclic;
    expect(() => componentNameOf(cyclic)).not.toThrow();
    expect(componentNameOf(cyclic)).toBeNull();
  });
});

describe("normalizeSource", () => {
  it("accepts the three-field shape", () => {
    expect(
      normalizeSource({ fileName: "src/App.tsx", lineNumber: 12, columnNumber: 4 })
    ).toEqual({ file: "src/App.tsx", line: 12, column: 4 });
  });

  it("accepts the inspector shape with no column", () => {
    expect(normalizeSource({ fileName: "src/App.tsx", lineNumber: 12 })).toEqual({
      file: "src/App.tsx",
      line: 12,
      column: null,
    });
  });

  it("rejects anything without a file name", () => {
    expect(normalizeSource({ lineNumber: 3 })).toBeNull();
    expect(normalizeSource(null)).toBeNull();
    expect(normalizeSource("src/App.tsx")).toBeNull();
  });
});

describe("resolveSource cascade", () => {
  it("reads _debugSource first (React <= 18)", () => {
    const found = resolveSource(
      fiber({ _debugSource: { fileName: "src/Card.tsx", lineNumber: 42, columnNumber: 8 } })
    );
    expect(found).toMatchObject({ file: "src/Card.tsx", line: 42, column: 8, via: "debugSource" });
  });

  it("falls back to the __source prop of the classic JSX runtime", () => {
    const found = resolveSource(
      fiber({ memoizedProps: { __source: { fileName: "src/Card.tsx", lineNumber: 7 } } })
    );
    expect(found).toMatchObject({ file: "src/Card.tsx", line: 7, via: "sourceProp" });
  });

  it("uses the React Native inspector data exposed on the renderer config", () => {
    setHook({
      renderers: new Map([
        [
          1,
          {
            rendererConfig: {
              getInspectorDataForInstance: () => ({
                source: { fileName: "src/screens/Orders.tsx", lineNumber: 88 },
              }),
            },
          },
        ],
      ]),
    });
    const found = resolveSource(fiber());
    expect(found).toMatchObject({ file: "src/screens/Orders.tsx", line: 88, via: "inspector" });
  });

  it("survives a renderer whose inspector throws", () => {
    setHook({
      renderers: new Map([
        [
          1,
          {
            rendererConfig: {
              getInspectorDataForInstance: () => {
                throw new Error("not a host instance");
              },
            },
          },
        ],
      ]),
    });
    expect(() => resolveSource(fiber())).not.toThrow();
  });

  it("climbs the owner chain when the host element carries nothing", () => {
    function ServiceCard(): null {
      return null;
    }
    const owner = {
      type: ServiceCard,
      elementType: ServiceCard,
      memoizedProps: {},
      _debugSource: { fileName: "src/components/ServiceCard.tsx", lineNumber: 42 },
    };
    const found = resolveSource(fiber({ _debugOwner: owner }));
    expect(found).toMatchObject({
      file: "src/components/ServiceCard.tsx",
      line: 42,
      componentName: "ServiceCard",
      via: "owner",
    });
  });

  it("keeps climbing past owners that carry no location", () => {
    const grandParent = {
      type: "Screen",
      memoizedProps: {},
      _debugSource: { fileName: "src/screens/Home.tsx", lineNumber: 10 },
    };
    const parent = { type: "Wrapper", memoizedProps: {}, _debugOwner: grandParent };
    const found = resolveSource(fiber({ _debugOwner: parent }));
    expect(found).toMatchObject({ file: "src/screens/Home.tsx", via: "owner" });
  });

  it("stops climbing instead of looping on a cyclic owner chain", () => {
    const node: Record<string, unknown> = { type: "Wrapper", memoizedProps: {} };
    node._debugOwner = node;
    expect(() => resolveSource(node as FiberLike)).not.toThrow();
  });

  it("returns React 19 owner stack frames, flagged as bundle coordinates", () => {
    const error = new Error("owner");
    error.stack = "Error: owner\n    at ServiceCard (http://localhost:8081/index.bundle:1234:56)";
    const found = resolveSource(fiber({ _debugStack: error }));
    expect(found?.via).toBe("stack");
    expect(found?.file).toBeNull();
    expect(found?.stack?.[0]).toContain("ServiceCard");
  });

  it("falls back to the component name alone rather than to null", () => {
    function OrderButton(): null {
      return null;
    }
    const found = resolveSource(fiber({ type: OrderButton, elementType: OrderButton }));
    expect(found).toMatchObject({ componentName: "OrderButton", via: "componentOnly", file: null });
  });

  it("returns null when nothing at all is knowable", () => {
    expect(resolveSource(fiber({ type: null }))).toBeNull();
    expect(resolveSource(null)).toBeNull();
    expect(resolveSource(undefined)).toBeNull();
  });

  it("adds nothing to a bare host node: the tag is already the node type", () => {
    expect(resolveSource(fiber({ type: "RCTView" }))).toBeNull();
  });

  it("names the component that rendered a host element, not the host tag", () => {
    function ServiceCard(): null {
      return null;
    }
    const found = resolveSource(
      fiber({ type: "RCTView", _debugOwner: { type: ServiceCard, memoizedProps: {} } })
    );
    expect(found).toMatchObject({ componentName: "ServiceCard", via: "componentOnly" });
  });

  it("prefers the exact location over the owner's when both exist", () => {
    const owner = {
      type: "Parent",
      memoizedProps: {},
      _debugSource: { fileName: "src/Parent.tsx", lineNumber: 1 },
    };
    const found = resolveSource(
      fiber({
        _debugSource: { fileName: "src/Child.tsx", lineNumber: 99 },
        _debugOwner: owner,
      })
    );
    expect(found).toMatchObject({ file: "src/Child.tsx", via: "debugSource" });
  });
});

describe("stackFramesOf", () => {
  it("drops the message line and keeps the frames", () => {
    const error = new Error("boom");
    error.stack = "Error: boom\n    at a (x.js:1:1)\n    at b (y.js:2:2)";
    expect(stackFramesOf(error)).toEqual(["at a (x.js:1:1)", "at b (y.js:2:2)"]);
  });

  it("caps the number of frames", () => {
    const error = new Error("boom");
    error.stack = ["Error: boom", ...Array.from({ length: 30 }, (_, i) => `    at f${i} ()`)].join("\n");
    expect(stackFramesOf(error)).toHaveLength(8);
  });

  it("returns null without a usable stack", () => {
    expect(stackFramesOf(null)).toBeNull();
    expect(stackFramesOf({ stack: "" })).toBeNull();
    expect(stackFramesOf({ stack: "Error: only a message" })).toBeNull();
  });
});

describe("captureOrigin", () => {
  it("returns bounded call-site frames", () => {
    const frames = captureOrigin();
    expect(frames === null || Array.isArray(frames)).toBe(true);
    if (frames) expect(frames.length).toBeLessThanOrEqual(8);
  });
});
