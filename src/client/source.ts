/**
 * Source location of a rendered element.
 *
 * An agent that knows a button exists but not which file produced it has
 * to grep the repo and hope. This module closes that gap, and it is the
 * one thing only a fiber walker can do: the location lives in React's dev
 * bookkeeping, not in anything the OS or a WebDriver can see.
 *
 * React moved this data three times, so resolution is a CASCADE, best
 * first, each step probed and skipped when absent:
 *
 *   1. fiber._debugSource            React <= 18, exact
 *   2. props.__source                classic JSX runtime, exact
 *   3. renderer inspector data       React Native, exact
 *   4. the _debugOwner chain         the owning component's location
 *   5. _debugStack frames            React 19 owner stacks, BUNDLE
 *                                    coordinates, need symbolication
 *   6. component name alone          no location, still worth having
 *
 * Beware of one trap: with the automatic JSX runtime (the default since
 * RN 0.71 and on every Expo template), the source goes to jsxDEV as an
 * ARGUMENT and never lands in memoizedProps. Step 2 is therefore a
 * fallback for classic-runtime projects, not the main road, and React 19
 * removed _debugSource outright. Steps 3 and 4 carry most real projects.
 *
 * `via` is returned on every result so an agent knows how much to trust
 * what it just read.
 */

import type { FiberLike } from "./automation";

export type SourceVia =
  | "debugSource"
  | "sourceProp"
  | "inspector"
  | "owner"
  | "stack"
  | "componentOnly";

export interface SourceLocation {
  file: string | null;
  line: number | null;
  column: number | null;
  componentName: string | null;
  via: SourceVia;
  /** Raw stack frames when only step 5 answered: these are BUNDLE
   * positions, to be symbolicated against Metro before being shown */
  stack?: string[];
}

interface DebugFiber extends FiberLike {
  _debugSource?: unknown;
  _debugOwner?: DebugFiber | null;
  _debugStack?: unknown;
}

const globalAny = (): Record<string, any> => globalThis as Record<string, any>;

const MAX_OWNER_CLIMB = 12;
const MAX_STACK_FRAMES = 8;
// Enough owners to walk out of a wrapper library and reach app code,
// without turning one tree into a megabyte of frames
const MAX_TOTAL_STACK_FRAMES = 40;

/** forwardRef exposes `render`, memo exposes `type`: unwrap both */
export const componentNameOf = (type: unknown, depth = 0): string | null => {
  if (depth > 4) return null;
  if (typeof type === "string") return type;
  if (typeof type === "function") {
    const fn = type as { displayName?: unknown; name?: unknown };
    if (typeof fn.displayName === "string" && fn.displayName) return fn.displayName;
    if (typeof fn.name === "string" && fn.name) return fn.name;
    return null;
  }
  if (type && typeof type === "object") {
    const object = type as Record<string, unknown>;
    if (typeof object.displayName === "string" && object.displayName) return object.displayName;
    return (
      componentNameOf(object.render, depth + 1) ??
      componentNameOf(object.type, depth + 1) ??
      null
    );
  }
  return null;
};

const numberOr = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** React has used both {fileName,lineNumber,columnNumber} and, more
 * recently in inspector payloads, plain {fileName,lineNumber} */
export const normalizeSource = (
  raw: unknown
): { file: string; line: number | null; column: number | null } | null => {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  const file = typeof source.fileName === "string" && source.fileName ? source.fileName : null;
  if (!file) return null;
  return {
    file,
    line: numberOr(source.lineNumber),
    column: numberOr(source.columnNumber),
  };
};

const propsOf = (fiber: FiberLike): Record<string, unknown> | null => {
  const props = fiber.memoizedProps;
  return props && typeof props === "object" ? (props as Record<string, unknown>) : null;
};

/**
 * The COMPONENT name, never the host tag. "RCTView" is already the node's
 * type: repeating it as a component name would inflate every node in the
 * tree while telling an agent nothing it can search for. What is worth
 * knowing about a host element is which component rendered it.
 */
const nameForFiber = (fiber: DebugFiber): string | null => {
  const isHost = typeof fiber.type === "string" || typeof fiber.elementType === "string";
  const own = isHost ? null : componentNameOf(fiber.elementType ?? fiber.type);
  return own ?? componentNameOf(fiber._debugOwner?.elementType ?? fiber._debugOwner?.type);
};

/**
 * React Native publishes getInspectorDataForInstance on the renderer
 * config it injects into the DevTools hook. Reaching it through the hook
 * rather than through an import is what keeps src/client free of any
 * external module, react-native included.
 */
const inspectorSource = (fiber: FiberLike): ReturnType<typeof normalizeSource> => {
  const hook = globalAny().__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook?.renderers || typeof hook.renderers.values !== "function") return null;
  try {
    for (const renderer of hook.renderers.values()) {
      const inspect = renderer?.rendererConfig?.getInspectorDataForInstance;
      if (typeof inspect !== "function") continue;
      const source = normalizeSource(inspect(fiber)?.source);
      if (source) return source;
    }
  } catch {
    // renderer without inspector support, or a fiber it refuses
  }
  return null;
};

export const stackFramesOf = (error: unknown): string[] | null => {
  const stack = (error as { stack?: unknown } | null)?.stack;
  if (typeof stack !== "string" || !stack) return null;
  const frames = stack
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^(Error|Warning)\b/.test(line))
    .slice(0, MAX_STACK_FRAMES);
  return frames.length ? frames : null;
};

/**
 * Owner stacks, from the fiber outwards.
 *
 * One stack is not enough, and this is only visible on a real app. A <View>
 * rendered inside react-native-safe-area-context carries a _debugStack that
 * points, correctly, into that library: the library really did create the
 * element. The APPLICATION frame lives further out, on the owner that
 * rendered the library's component.
 *
 * Verified against an Expo 56 app: taking the nearest stack alone yields
 * node_modules for every node on screen. Concatenating outwards lets the
 * host side pick the first frame that belongs to the app.
 */
const ownerStacks = (node: DebugFiber): string[] => {
  const frames: string[] = [];
  let current: DebugFiber | null = node;
  for (let steps = 0; current && steps <= MAX_OWNER_CLIMB; steps += 1) {
    if (frames.length >= MAX_TOTAL_STACK_FRAMES) break;
    const own = stackFramesOf(current._debugStack);
    if (own) {
      for (const frame of own) {
        // The renderer's own frames repeat on every owner and would fill
        // the budget before the application frame is reached
        if (!frames.includes(frame)) frames.push(frame);
      }
    }
    current = current._debugOwner ?? null;
  }
  return frames.slice(0, MAX_TOTAL_STACK_FRAMES);
};

/** Direct location on a fiber: its own dev record, then its props */
const directSource = (
  fiber: DebugFiber
): { source: NonNullable<ReturnType<typeof normalizeSource>>; via: SourceVia } | null => {
  const debugSource = normalizeSource(fiber._debugSource);
  if (debugSource) return { source: debugSource, via: "debugSource" };
  const propSource = normalizeSource(propsOf(fiber)?.__source);
  if (propSource) return { source: propSource, via: "sourceProp" };
  return null;
};

/**
 * Resolves where a fiber was written. Always returns something: a bare
 * component name is still worth more to an agent than null, because it
 * turns a repo-wide grep into a one-symbol search.
 */
export const resolveSource = (fiber: FiberLike | null | undefined): SourceLocation | null => {
  if (!fiber || typeof fiber !== "object") return null;
  const node = fiber as DebugFiber;
  const componentName = nameForFiber(node);

  const direct = directSource(node);
  if (direct) return { ...direct.source, componentName, via: direct.via };

  const inspector = inspectorSource(node);
  if (inspector) return { ...inspector, componentName, via: "inspector" };

  // Host elements rarely carry their own record; the component that
  // rendered them almost always does
  let owner = node._debugOwner ?? null;
  for (let steps = 0; owner && steps < MAX_OWNER_CLIMB; steps += 1) {
    const found = directSource(owner);
    if (found) {
      return {
        ...found.source,
        componentName: componentNameOf(owner.elementType ?? owner.type) ?? componentName,
        via: "owner",
      };
    }
    owner = owner._debugOwner ?? null;
  }

  // React 19 owner stacks: real frames, but pointing into the bundle
  const frames = ownerStacks(node);
  if (frames.length) {
    return { file: null, line: null, column: null, componentName, via: "stack", stack: frames };
  }

  if (componentName) {
    return { file: null, line: null, column: null, componentName, via: "componentOnly" };
  }
  return null;
};

/**
 * Bounded call-site frames, captured where a side effect STARTS rather
 * than where it is observed. This is what puts a source on the event bus
 * instead of only on the tree: a request that carries the frames of the
 * hook that fired it. The frames are bundle positions, to be symbolicated
 * host-side.
 */
export const captureOrigin = (): string[] | null => {
  try {
    const frames = stackFramesOf(new Error("devtools-origin"));
    if (!frames) return null;
    // Drop the frames belonging to the SDK itself: the caller is what matters
    const external = frames.filter((frame) => !/rn-devtools-hub|devtools[\\/](client|dist)/.test(frame));
    return (external.length ? external : frames).slice(0, MAX_STACK_FRAMES);
  } catch {
    return null;
  }
};
