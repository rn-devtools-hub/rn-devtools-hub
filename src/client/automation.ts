/**
 * Runtime UI automation for AI agents (MCP).
 *
 * Reads the mounted React tree through the React DevTools global hook
 * (fiber walking) and acts on elements through their JS props
 * (onPress, onChangeText...): no native accessibility bridge, no pixel
 * coordinates, no idb/adb dependency.
 *
 * Works wherever the React renderer runs in dev mode: Expo Go,
 * development builds, bare React Native, react-native-web. Degrades
 * cleanly when the hook is unavailable: every command returns a typed
 * error instead of throwing into the app.
 *
 * Caveat, stated on purpose: acting through props exercises the app's
 * JS logic (like React Native Testing Library), not the native touch
 * and keyboard pipeline. Typing places the exact string given (no
 * autocapitalize interference), which is the point for agents.
 */

// Minimal structural view of a React fiber. Only the fields we read.
export interface FiberLike {
  tag?: number;
  type?: unknown;
  elementType?: unknown;
  memoizedProps?: unknown;
  stateNode?: unknown;
  child?: FiberLike | null;
  sibling?: FiberLike | null;
  return?: FiberLike | null;
}

export interface UiNode {
  type: string;
  testID?: string;
  label?: string;
  role?: string;
  text?: string;
  value?: string;
  placeholder?: string;
  editable?: boolean;
  pressable?: boolean;
  /** Number of purely structural views merged into this node */
  collapsed?: number;
  children?: UiNode[];
}

export interface UiSelector {
  by: "testID" | "text" | "label" | "type";
  value: string;
  /** For by:"text": exact match instead of substring */
  exact?: boolean;
}

export interface SerializeOptions {
  maxDepth?: number;
  maxNodes?: number;
}

const HOST_TYPE_ALIASES: Record<string, string> = {
  RCTView: "View",
  RCTText: "Text",
  RCTRawText: "Text",
  RCTVirtualText: "Text",
  RCTImageView: "Image",
  RCTScrollView: "ScrollView",
  RCTScrollContentView: "View",
  RCTSafeAreaView: "SafeAreaView",
  RCTSinglelineTextInputView: "TextInput",
  RCTMultilineTextInputView: "TextInput",
  AndroidTextInput: "TextInput",
  RCTSwitch: "Switch",
  AndroidSwitch: "Switch",
  RCTModalHostView: "Modal",
  RCTActivityIndicatorView: "ActivityIndicator",
};

export const prettyHostType = (type: string): string =>
  HOST_TYPE_ALIASES[type] ?? type.replace(/^RCT/, "");

const isHostFiber = (fiber: FiberLike): boolean =>
  typeof fiber.type === "string";

// HostText fibers carry their string directly in memoizedProps
const isTextFiber = (fiber: FiberLike): boolean =>
  typeof fiber.memoizedProps === "string" ||
  typeof fiber.memoizedProps === "number";

const propsOf = (fiber: FiberLike): Record<string, unknown> | null => {
  const props = fiber.memoizedProps;
  return props && typeof props === "object"
    ? (props as Record<string, unknown>)
    : null;
};

const stringProp = (
  props: Record<string, unknown> | null,
  ...keys: string[]
): string | undefined => {
  for (const key of keys) {
    const value = props?.[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
};

/** Aggregated text of a fiber subtree (bounded) */
export const collectSubtreeText = (fiber: FiberLike, maxDepth = 30): string => {
  const parts: string[] = [];
  const visit = (node: FiberLike | null | undefined, depth: number): void => {
    for (let current = node; current; current = current.sibling ?? null) {
      if (parts.length > 200) return;
      if (isTextFiber(current)) {
        parts.push(String(current.memoizedProps));
      } else {
        // react-dom inlines a single text child into the host props
        const children = propsOf(current)?.children;
        if (typeof children === "string" || typeof children === "number") {
          parts.push(String(children));
        }
        if (depth > 0) visit(current.child ?? null, depth - 1);
      }
    }
  };
  visit(fiber.child ?? null, maxDepth);
  return parts.join("");
};

const isInputType = (type: string): boolean => /TextInput|TextField|input/i.test(type);
const isTextType = (type: string): boolean => /^Text$/.test(type);

const buildNode = (
  fiber: FiberLike,
  children: UiNode[],
): UiNode => {
  const props = propsOf(fiber);
  const type = prettyHostType(String(fiber.type));
  const node: UiNode = { type };

  const testID = stringProp(props, "testID", "data-testid");
  if (testID) node.testID = testID;
  const label = stringProp(props, "accessibilityLabel", "aria-label");
  if (label) node.label = label;
  const role = stringProp(props, "accessibilityRole", "role");
  if (role) node.role = role;
  const placeholder = stringProp(props, "placeholder");
  if (placeholder) node.placeholder = placeholder;

  if (isInputType(type)) {
    const value = props?.value ?? props?.text ?? props?.defaultValue;
    if (typeof value === "string") node.value = value;
    node.editable = props?.editable !== false;
  }
  if (typeof props?.onPress === "function" || typeof props?.onClick === "function") {
    node.pressable = true;
  }

  // Text content: full subtree for Text nodes, direct text children otherwise
  const text = collectSubtreeText(fiber, isTextType(type) ? 30 : 0);
  if (text) node.text = text;

  if (children.length) node.children = children;
  return node;
};

const isCollapsible = (node: UiNode): boolean =>
  node.type === "View" &&
  !node.testID && !node.label && !node.text && !node.pressable &&
  node.editable === undefined && !node.role &&
  (node.children?.length ?? 0) === 1;

interface NodeBudget { nodes: number; truncated: boolean; }

const serializeChildren = (
  fiber: FiberLike,
  depthLeft: number,
  budget: NodeBudget,
): UiNode[] => {
  const out: UiNode[] = [];
  for (let child = fiber.child ?? null; child; child = child.sibling ?? null) {
    if (budget.nodes <= 0) { budget.truncated = true; break; }
    if (isTextFiber(child)) continue; // aggregated by the parent host node
    if (isHostFiber(child)) {
      if (depthLeft <= 0) { budget.truncated = true; continue; }
      budget.nodes -= 1;
      const grandChildren = serializeChildren(child, depthLeft - 1, budget);
      let node = buildNode(child, grandChildren);
      // Collapse pyramids of purely structural Views
      if (isCollapsible(node)) {
        const only = node.children![0];
        node = { ...only, collapsed: (only.collapsed ?? 0) + 1 };
      }
      out.push(node);
    } else {
      // Composite components are transparent: recurse without consuming depth
      out.push(...serializeChildren(child, depthLeft, budget));
    }
  }
  return out;
};

/** Serializes the host component tree under a fiber root */
export const serializeTree = (
  rootFiber: FiberLike,
  options: SerializeOptions = {},
): { nodes: UiNode[]; truncated: boolean } => {
  const budget: NodeBudget = {
    nodes: Math.max(1, Math.min(options.maxNodes ?? 2500, 10000)),
    truncated: false,
  };
  const maxDepth = Math.max(1, Math.min(options.maxDepth ?? 60, 200));
  const nodes = serializeChildren(rootFiber, maxDepth, budget);
  return { nodes, truncated: budget.truncated };
};

/** True when the fiber matches the selector. Host fibers only. */
export const fiberMatches = (fiber: FiberLike, selector: UiSelector): boolean => {
  if (!isHostFiber(fiber)) return false;
  const props = propsOf(fiber);
  const value = String(selector.value ?? "");
  switch (selector.by) {
    case "testID":
      return stringProp(props, "testID", "data-testid") === value;
    case "label":
      return stringProp(props, "accessibilityLabel", "aria-label") === value;
    case "type": {
      const raw = String(fiber.type);
      return raw === value || prettyHostType(raw) === value;
    }
    case "text": {
      // Only text-bearing elements match: containers aggregate the text
      // of their whole subtree and would shadow the actual target
      const pretty = prettyHostType(String(fiber.type));
      const own = props?.children;
      const ownText = typeof own === "string" || typeof own === "number" ? String(own) : "";
      if (!isTextType(pretty) && !ownText) return false;
      const text = ownText + collectSubtreeText(fiber, 30);
      if (!text) return false;
      return selector.exact ? text === value : text.includes(value);
    }
    default:
      return false;
  }
};

/** Finds matching host fibers (depth-first, no descent into a match) */
export const queryFibers = (
  rootFiber: FiberLike,
  selector: UiSelector,
  limit = 10,
): FiberLike[] => {
  const found: FiberLike[] = [];
  const visit = (node: FiberLike | null | undefined): void => {
    for (let current = node; current && found.length < limit; current = current.sibling ?? null) {
      if (fiberMatches(current, selector)) {
        found.push(current);
        continue; // nested duplicates (composite + host) are not useful
      }
      visit(current.child ?? null);
    }
  };
  visit(rootFiber.child ?? rootFiber);
  return found;
};

/**
 * Finds a function prop on the fiber itself, its descendants (breadth
 * first) or its ancestors. Handlers usually live on a composite parent
 * (Pressable) of the matched host view.
 */
export const findHandler = (
  fiber: FiberLike,
  propNames: string[],
  searchDepth = 10,
  climbDepth = 15,
): ((event: unknown) => unknown) | null => {
  const handlerOf = (node: FiberLike): ((event: unknown) => unknown) | null => {
    const props = propsOf(node);
    for (const name of propNames) {
      const candidate = props?.[name];
      if (typeof candidate === "function") {
        return candidate as (event: unknown) => unknown;
      }
    }
    return null;
  };

  const queue: Array<{ node: FiberLike; depth: number }> = [{ node: fiber, depth: 0 }];
  while (queue.length) {
    const { node, depth } = queue.shift()!;
    const handler = handlerOf(node);
    if (handler) return handler;
    if (depth < searchDepth) {
      for (let child = node.child ?? null; child; child = child.sibling ?? null) {
        queue.push({ node: child, depth: depth + 1 });
      }
    }
  }

  let ancestor = fiber.return ?? null;
  for (let steps = 0; ancestor && steps < climbDepth; steps += 1) {
    const handler = handlerOf(ancestor);
    if (handler) return handler;
    ancestor = ancestor.return ?? null;
  }
  return null;
};

/** Finds the closest text input fiber (self, descendants, then ancestors) */
export const findTextInputFiber = (fiber: FiberLike): FiberLike | null => {
  const isInput = (node: FiberLike): boolean => {
    if (typeof propsOf(node)?.onChangeText === "function") return true;
    return isHostFiber(node) && isInputType(prettyHostType(String(node.type)));
  };

  const queue: Array<{ node: FiberLike; depth: number }> = [{ node: fiber, depth: 0 }];
  while (queue.length) {
    const { node, depth } = queue.shift()!;
    if (isInput(node)) return node;
    if (depth < 10) {
      for (let child = node.child ?? null; child; child = child.sibling ?? null) {
        queue.push({ node: child, depth: depth + 1 });
      }
    }
  }
  let ancestor = fiber.return ?? null;
  for (let steps = 0; ancestor && steps < 10; steps += 1) {
    if (isInput(ancestor)) return ancestor;
    ancestor = ancestor.return ?? null;
  }
  return null;
};

/** First host state node (native instance) in a fiber subtree */
const findStateNode = (fiber: FiberLike): Record<string, unknown> | null => {
  const queue: Array<{ node: FiberLike; depth: number }> = [{ node: fiber, depth: 0 }];
  while (queue.length) {
    const { node, depth } = queue.shift()!;
    if (isHostFiber(node) && node.stateNode && typeof node.stateNode === "object") {
      return node.stateNode as Record<string, unknown>;
    }
    if (depth < 10) {
      for (let child = node.child ?? null; child; child = child.sibling ?? null) {
        queue.push({ node: child, depth: depth + 1 });
      }
    }
  }
  return null;
};

const callNative = (
  instance: Record<string, unknown> | null,
  method: string,
  ...args: unknown[]
): void => {
  const fn = instance?.[method];
  if (typeof fn === "function") {
    try { fn.apply(instance, args); } catch { /* native call is best effort */ }
  }
};

const measureFiber = (fiber: FiberLike): Promise<
  { x: number; y: number; width: number; height: number } | null
> =>
  new Promise((resolve) => {
    const instance = findStateNode(fiber);
    const measure = instance?.measureInWindow;
    if (typeof measure !== "function") { resolve(null); return; }
    const timer = setTimeout(() => resolve(null), 400);
    try {
      measure.call(instance, (x: number, y: number, width: number, height: number) => {
        clearTimeout(timer);
        resolve({ x, y, width, height });
      });
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });

export interface ActRequest {
  action: "tap" | "longPress" | "type" | "clear" | "submit" | "scrollTo" | "scrollToEnd";
  text?: string;
  clear?: boolean;
  x?: number;
  y?: number;
}

/** Performs an action on a matched fiber through its JS props */
export const performAct = (fiber: FiberLike, request: ActRequest): { detail: string } => {
  if (request.action === "tap" || request.action === "longPress") {
    const names = request.action === "tap" ? ["onPress", "onClick"] : ["onLongPress"];
    const handler = findHandler(fiber, names);
    if (!handler) {
      throw new Error(`No ${names[0]} handler found on the element or its ancestors`);
    }
    handler({ nativeEvent: {}, persist: () => {} });
    return { detail: `${names[0]} invoked` };
  }

  if (request.action === "type" || request.action === "clear") {
    const input = findTextInputFiber(fiber);
    if (!input) throw new Error("No text input found on the element or nearby");
    const props = propsOf(input);
    const instance = findStateNode(input);
    const apply = (text: string): void => {
      callNative(instance, "setNativeProps", { text });
      const onChangeText = props?.onChangeText;
      if (typeof onChangeText === "function") onChangeText(text);
      const onChange = props?.onChange;
      if (typeof onChange === "function") {
        onChange({ nativeEvent: { text, eventCount: 0, target: null } });
      }
    };
    callNative(instance, "focus");
    const text = request.action === "clear" ? "" : String(request.text ?? "");
    if (request.action === "type" && request.clear) apply("");
    apply(text);
    return { detail: request.action === "clear" ? "cleared" : `typed ${text.length} chars` };
  }

  if (request.action === "submit") {
    const input = findTextInputFiber(fiber);
    const props = input ? propsOf(input) : null;
    const onSubmit = props?.onSubmitEditing;
    if (typeof onSubmit !== "function") {
      throw new Error("No onSubmitEditing handler found");
    }
    const current = typeof props?.value === "string" ? props.value : String(request.text ?? "");
    onSubmit({ nativeEvent: { text: current, target: null } });
    return { detail: "submitted" };
  }

  if (request.action === "scrollTo" || request.action === "scrollToEnd") {
    const instance = findStateNode(fiber);
    if (!instance) throw new Error("No native instance found to scroll");
    // ScrollView instances expose scrollTo/scrollToEnd via the responder
    const responder = typeof instance.getScrollResponder === "function"
      ? (() => { try { return (instance.getScrollResponder as () => unknown)() as Record<string, unknown>; } catch { return instance; } })()
      : instance;
    if (request.action === "scrollToEnd") {
      callNative(responder, "scrollToEnd", { animated: false });
    } else {
      callNative(responder, "scrollTo", {
        x: Number(request.x ?? 0),
        y: Number(request.y ?? 0),
        animated: false,
      });
    }
    return { detail: request.action };
  }

  throw new Error(`Unknown action: ${String(request.action)}`);
};

// ====================================================================
// Wiring: React DevTools hook observation + command handlers
// ====================================================================

interface AutomationHost {
  onCommand: (command: string, handler: (payload: unknown) => Promise<unknown> | unknown) => void;
  emit: (type: string, payload: unknown) => void;
}

interface RootTracker {
  roots: FiberLike[];
  generation: number;
  hookFound: boolean;
}

const describeMatch = async (fiber: FiberLike): Promise<Record<string, unknown>> => {
  const props = propsOf(fiber);
  return {
    type: prettyHostType(String(fiber.type ?? "?")),
    testID: stringProp(props, "testID", "data-testid") ?? null,
    label: stringProp(props, "accessibilityLabel", "aria-label") ?? null,
    text: collectSubtreeText(fiber, 30) || null,
    rect: await measureFiber(fiber),
  };
};

const trackRoots = (emit: AutomationHost["emit"]): RootTracker => {
  const tracker: RootTracker = { roots: [], generation: 0, hookFound: false };
  const globalAny = globalThis as Record<string, any>;
  const hook = globalAny.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook || typeof hook !== "object") return tracker;
  tracker.hookFound = true;

  const rememberRoot = (root: unknown): void => {
    if (!root || typeof root !== "object") return;
    const fiberRoot = root as FiberLike & { current?: FiberLike };
    const index = tracker.roots.indexOf(fiberRoot);
    if (index > -1) tracker.roots.splice(index, 1);
    tracker.roots.unshift(fiberRoot); // most recently committed first
    if (tracker.roots.length > 8) tracker.roots.pop();
  };

  // Seed with already-mounted roots (attach may run after first render)
  try {
    if (typeof hook.getFiberRoots === "function" && hook.renderers?.keys) {
      for (const rendererId of hook.renderers.keys()) {
        for (const root of hook.getFiberRoots(rendererId) ?? []) rememberRoot(root);
      }
    }
  } catch { /* hook variant without getFiberRoots */ }

  // Observe every commit: fresh roots + a UI generation counter
  const previous = hook.onCommitFiberRoot;
  let lastEmit = 0;
  let pendingEmit = false;
  hook.onCommitFiberRoot = function (this: unknown, rendererId: unknown, root: unknown, ...rest: unknown[]) {
    try {
      rememberRoot(root);
      tracker.generation += 1;
      const now = Date.now();
      if (now - lastEmit >= 1000) {
        lastEmit = now;
        emit("ui.change", { generation: tracker.generation });
      } else if (!pendingEmit) {
        pendingEmit = true;
        setTimeout(() => {
          pendingEmit = false;
          lastEmit = Date.now();
          emit("ui.change", { generation: tracker.generation });
        }, 1000);
      }
    } catch { /* observation must never break rendering */ }
    return typeof previous === "function"
      ? previous.call(this, rendererId, root, ...rest)
      : undefined;
  };
  return tracker;
};

const liveRootFibers = (tracker: RootTracker): FiberLike[] => {
  const fibers: FiberLike[] = [];
  for (const root of tracker.roots) {
    const current = (root as { current?: FiberLike }).current;
    if (current) fibers.push(current);
  }
  return fibers;
};

const requireRoots = (tracker: RootTracker): FiberLike[] => {
  if (!tracker.hookFound) {
    throw new Error(
      "React DevTools hook unavailable: UI automation needs a dev-mode React runtime"
    );
  }
  const fibers = liveRootFibers(tracker);
  if (!fibers.length) {
    throw new Error(
      "No React root observed yet: call attachUiAutomation() at startup, then reload the app"
    );
  }
  return fibers;
};

const parseSelector = (payload: Record<string, unknown>): UiSelector => {
  const by = String(payload.by ?? "testID") as UiSelector["by"];
  if (!["testID", "text", "label", "type"].includes(by)) {
    throw new Error(`Unknown selector: ${by} (use testID, text, label or type)`);
  }
  const value = payload.value;
  if (typeof value !== "string" || !value.length) {
    throw new Error("Selector needs a non-empty string value");
  }
  return { by, value, exact: payload.exact === true };
};

/** Registers the ui.tree / ui.query / ui.act command handlers */
export const installUiAutomation = (host: AutomationHost): void => {
  const tracker = trackRoots(host.emit);

  host.onCommand("ui.tree", (rawPayload) => {
    const payload = (rawPayload ?? {}) as Record<string, unknown>;
    const fibers = requireRoots(tracker);
    const roots = fibers.map((fiber) => serializeTree(fiber, {
      maxDepth: Number(payload.maxDepth) || undefined,
      maxNodes: Number(payload.maxNodes) || undefined,
    }));
    return {
      generation: tracker.generation,
      truncated: roots.some((root) => root.truncated),
      roots: roots.map((root) => root.nodes),
    };
  });

  host.onCommand("ui.query", async (rawPayload) => {
    const payload = (rawPayload ?? {}) as Record<string, unknown>;
    const selector = parseSelector(payload);
    const limit = Math.max(1, Math.min(Number(payload.limit) || 10, 50));
    const fibers = requireRoots(tracker);
    const matches: FiberLike[] = [];
    for (const fiber of fibers) {
      matches.push(...queryFibers(fiber, selector, limit - matches.length));
      if (matches.length >= limit) break;
    }
    return {
      generation: tracker.generation,
      count: matches.length,
      matches: await Promise.all(matches.map(describeMatch)),
    };
  });

  host.onCommand("ui.act", async (rawPayload) => {
    const payload = (rawPayload ?? {}) as Record<string, unknown>;
    const selector = parseSelector(payload);
    const action = String(payload.action ?? "") as ActRequest["action"];
    const fibers = requireRoots(tracker);
    const matches: FiberLike[] = [];
    for (const fiber of fibers) {
      matches.push(...queryFibers(fiber, selector, 5 - matches.length));
      if (matches.length >= 5) break;
    }
    if (!matches.length) {
      throw new Error(`No element matches ${selector.by}="${selector.value}"`);
    }
    const index = Math.max(0, Number(payload.index) || 0);
    if (matches.length > 1 && payload.index === undefined) {
      throw new Error(
        `${matches.length} elements match ${selector.by}="${selector.value}": pass an index or use a more specific selector`
      );
    }
    const target = matches[Math.min(index, matches.length - 1)];
    const result = performAct(target, {
      action,
      text: typeof payload.text === "string" ? payload.text : undefined,
      clear: payload.clear === true,
      x: Number(payload.x) || undefined,
      y: Number(payload.y) || undefined,
    });
    return {
      ok: true,
      generation: tracker.generation,
      action,
      detail: result.detail,
      target: await describeMatch(target),
    };
  });
};
