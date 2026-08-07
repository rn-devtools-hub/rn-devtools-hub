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

import { resolveSource, type SourceLocation } from "./source";

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
  /** Where this element was written, when React still knows */
  source?: SourceLocation;
  children?: UiNode[];
}

export interface UiSelector {
  by: "testID" | "text" | "label" | "type" | "role";
  value: string;
  /** For by:"text" and name matching: exact match instead of substring */
  exact?: boolean;
  /** For by:"role": accessible name filter (label, aria-label or text) */
  name?: string;
}

/**
 * Why a selector matched nothing.
 *
 * "No element carries a role" and "no element carries THIS role" are
 * different facts, and an empty array states neither: it reads as
 * "nothing on screen", which sends an agent looking for a regression
 * that does not exist. An app that never sets accessibilityRole answers
 * zero to every by:"role" query, forever, and no retry changes that.
 */
export interface UiAbsence {
  by: UiSelector["by"];
  value: string;
  reason: "attribute-absent" | "value-absent" | "name-absent";
  /** How many VISIBLE elements expose the attribute the selector reads */
  exposedBy: number;
  /** A sample of the values actually present, to select on instead */
  present: string[];
  /** True when the sample was capped, not exhaustive */
  truncated: boolean;
  note: string;
}

export interface SerializeOptions {
  maxDepth?: number;
  maxNodes?: number;
  /** Also include screens the navigator keeps mounted but hidden */
  includeHidden?: boolean;
  /** Attach the source location to every node (default true) */
  includeSource?: boolean;
}

/** Long enough for React to commit a state update triggered by onChangeText */
const COMMIT_SETTLE_MS = 50;

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

const styleDisplay = (style: unknown): string | undefined => {
  if (Array.isArray(style)) {
    // Last entry wins, like StyleSheet.flatten
    for (let index = style.length - 1; index >= 0; index -= 1) {
      const found = styleDisplay(style[index]);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (style && typeof style === "object") {
    const display = (style as Record<string, unknown>).display;
    return typeof display === "string" ? display : undefined;
  }
  return undefined;
};

/**
 * True for subtrees the user cannot see or touch. Navigators keep the
 * previous screens MOUNTED (stack cards for the back animation, tab
 * scenes for their state): without this filter the tree and the
 * selectors keep matching the screen the user just left. The detection
 * relies on the signals the navigators themselves set on inactive
 * scenes.
 */
export const isHiddenSubtree = (fiber: FiberLike): boolean => {
  const props = propsOf(fiber);
  if (!props) return false;
  if (props.accessibilityElementsHidden === true) return true;
  if (props.importantForAccessibility === "no-hide-descendants") return true;
  if (props["aria-hidden"] === true) return true;
  // react-native-screens: 0 = detached scene, 2 = active
  if (/RNSScreen/.test(String(fiber.type ?? ""))) {
    if (props.activityState === 0 || props.active === 0) return true;
  }
  return styleDisplay(props.style) === "none";
};

const buildNode = (
  fiber: FiberLike,
  children: UiNode[],
  includeSource = true,
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

  if (includeSource) {
    const source = resolveSource(fiber);
    if (source) node.source = source;
  }

  if (children.length) node.children = children;
  return node;
};

const isCollapsible = (node: UiNode): boolean =>
  node.type === "View" &&
  !node.testID && !node.label && !node.text && !node.pressable &&
  node.editable === undefined && !node.role &&
  (node.children?.length ?? 0) === 1;

interface NodeBudget {
  nodes: number;
  truncated: boolean;
  includeHidden: boolean;
  includeSource: boolean;
  hiddenSubtrees: number;
}

const serializeChildren = (
  fiber: FiberLike,
  depthLeft: number,
  budget: NodeBudget,
): UiNode[] => {
  const out: UiNode[] = [];
  for (let child = fiber.child ?? null; child; child = child.sibling ?? null) {
    if (budget.nodes <= 0) { budget.truncated = true; break; }
    if (isTextFiber(child)) continue; // aggregated by the parent host node
    if (!budget.includeHidden && isHiddenSubtree(child)) {
      budget.hiddenSubtrees += 1;
      continue;
    }
    if (isHostFiber(child)) {
      if (depthLeft <= 0) { budget.truncated = true; continue; }
      budget.nodes -= 1;
      const grandChildren = serializeChildren(child, depthLeft - 1, budget);
      let node = buildNode(child, grandChildren, budget.includeSource);
      // Collapse pyramids of purely structural Views. The collapsed
      // wrapper's own source is dropped with it: the surviving node keeps
      // its own, which is the one the agent wants to edit
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
): { nodes: UiNode[]; truncated: boolean; hiddenSubtrees: number } => {
  const budget: NodeBudget = {
    nodes: Math.max(1, Math.min(options.maxNodes ?? 2500, 10000)),
    truncated: false,
    includeHidden: options.includeHidden === true,
    includeSource: options.includeSource !== false,
    hiddenSubtrees: 0,
  };
  const maxDepth = Math.max(1, Math.min(options.maxDepth ?? 60, 200));
  const nodes = serializeChildren(rootFiber, maxDepth, budget);
  return { nodes, truncated: budget.truncated, hiddenSubtrees: budget.hiddenSubtrees };
};

/** Accessible name, mirroring Testing Library order: aria-label /
 * accessibilityLabel, then alt, then placeholder, then rendered text */
export const accessibleName = (fiber: FiberLike): string => {
  const props = propsOf(fiber);
  return (
    stringProp(props, "aria-label", "accessibilityLabel", "alt", "placeholder") ??
    collectSubtreeText(fiber, 30)
  );
};

// RN 0.71+ ARIA role names vs legacy accessibilityRole names
// (mapping table from RN's AccessibilityMapping)
const ROLE_ALIASES: Record<string, string> = {
  heading: "header",
  img: "image",
  searchbox: "search",
  slider: "adjustable",
  presentation: "none",
};
const normalizeRole = (role: string): string => ROLE_ALIASES[role] ?? role;

/** RN 0.71+ ARIA-style role wins over accessibilityRole; Text hosts carry
 * an implicit "text" role, like in Testing Library */
const roleOf = (fiber: FiberLike): string | undefined => {
  const explicit = stringProp(propsOf(fiber), "role", "accessibilityRole");
  return explicit ?? (isTextType(prettyHostType(String(fiber.type))) ? "text" : undefined);
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
    case "role": {
      // Both naming families match through the alias table
      const role = roleOf(fiber);
      if (role === undefined || normalizeRole(role) !== normalizeRole(value)) return false;
      if (selector.name === undefined) return true;
      const name = accessibleName(fiber);
      return selector.exact
        ? name === selector.name
        : name.includes(selector.name);
    }
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

/** Finds matching host fibers (depth-first, no descent into a match).
 * Hidden subtrees (inactive navigator screens) are skipped by default:
 * selectors must target what the user actually sees. */
export const queryFibers = (
  rootFiber: FiberLike,
  selector: UiSelector,
  limit = 10,
  includeHidden = false,
): FiberLike[] => {
  const found: FiberLike[] = [];
  const visit = (node: FiberLike | null | undefined): void => {
    for (let current = node; current && found.length < limit; current = current.sibling ?? null) {
      if (!includeHidden && isHiddenSubtree(current)) continue;
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

/** The props each selector family reads, named as the app writes them */
const SELECTOR_SOURCE: Record<UiSelector["by"], string> = {
  testID: "testID (or data-testid)",
  label: "accessibilityLabel (or aria-label)",
  role: "role or accessibilityRole",
  text: "rendered text",
  type: "a host type",
};

/** The value a fiber exposes for a given selector family, if any */
const exposedValue = (fiber: FiberLike, by: UiSelector["by"]): string | undefined => {
  const props = propsOf(fiber);
  switch (by) {
    case "testID":
      return stringProp(props, "testID", "data-testid");
    case "label":
      return stringProp(props, "accessibilityLabel", "aria-label");
    case "role":
      return roleOf(fiber);
    case "type":
      return prettyHostType(String(fiber.type));
    case "text": {
      const own = props?.children;
      const ownText = typeof own === "string" || typeof own === "number" ? String(own) : "";
      if (!isTextType(prettyHostType(String(fiber.type))) && !ownText) return undefined;
      return (ownText + collectSubtreeText(fiber, 30)) || undefined;
    }
    default:
      return undefined;
  }
};

/** Bounded: this runs on the empty path, where the caller is already
 * waiting, and a sample is enough to pick another selector */
const ABSENCE_SCAN_LIMIT = 4000;
const ABSENCE_SAMPLE = 20;
const clip = (value: string): string => (value.length > 60 ? `${value.slice(0, 60)}...` : value);

/**
 * Explains an empty match set: nothing observed, or nothing observable.
 *
 * Only called when a query returned zero, so the extra walk costs
 * nothing on the path that found something.
 */
export const describeAbsence = (
  scopes: FiberLike[],
  selector: UiSelector,
  includeHidden = false,
): UiAbsence => {
  const present = new Set<string>();
  const namesForRole = new Set<string>();
  let exposedBy = 0;
  let sameRole = 0;
  /** Roles the app actually WRITES. Every Text host carries an implicit
   * "text" role, so counting those would report an app that declares no
   * role at all as role-exposing, which is the mistake this exists to
   * prevent. */
  let declaredRoles = 0;
  let scanned = 0;

  const visit = (node: FiberLike | null | undefined): void => {
    for (let current = node; current && scanned < ABSENCE_SCAN_LIMIT; current = current.sibling ?? null) {
      if (!includeHidden && isHiddenSubtree(current)) continue;
      scanned += 1;
      if (isHostFiber(current)) {
        const value = exposedValue(current, selector.by);
        if (selector.by === "role" && stringProp(propsOf(current), "role", "accessibilityRole")) {
          declaredRoles += 1;
        }
        if (value) {
          exposedBy += 1;
          if (present.size < ABSENCE_SAMPLE) present.add(clip(value));
          if (selector.by === "role" && normalizeRole(value) === normalizeRole(selector.value)) {
            sameRole += 1;
            const name = accessibleName(current);
            if (name && namesForRole.size < ABSENCE_SAMPLE) namesForRole.add(clip(name));
          }
        }
      }
      visit(current.child ?? null);
    }
  };
  for (const scope of scopes) visit(scope.child ?? scope);

  const truncated = scanned >= ABSENCE_SCAN_LIMIT;
  const quote = (values: Set<string>): string =>
    [...values].map((value) => `"${value}"`).join(", ");

  // The role exists, the accessible name is what missed: an agent that
  // reads "no match" here goes looking for the button on another screen
  if (selector.by === "role" && selector.name !== undefined && sameRole > 0) {
    return {
      by: selector.by,
      value: selector.value,
      reason: "name-absent",
      exposedBy,
      present: [...namesForRole],
      truncated,
      note:
        `${sameRole} visible element(s) have role "${selector.value}", none named ` +
        `${selector.exact ? "exactly " : ""}"${selector.name}". Names present: ` +
        `${quote(namesForRole) || "none, these elements have no accessible name"}.`,
    };
  }

  // The case the report of a real run named: role queries answering zero
  // on an app that simply never sets a role. Retrying will never help.
  if (selector.by === "role" && declaredRoles === 0 && normalizeRole(selector.value) !== "text") {
    return {
      by: selector.by,
      value: selector.value,
      reason: "attribute-absent",
      exposedBy: 0,
      present: [...present],
      truncated,
      note:
        "No visible element declares role or accessibilityRole: this app exposes no roles, so " +
        'every by:"role" query answers zero whatever the value, and retrying cannot change that. ' +
        (present.size ? 'Only Text nodes carry the implicit "text" role. ' : "") +
        "Select by testID or text, or add accessibilityRole in the source.",
    };
  }

  if (exposedBy === 0) {
    return {
      by: selector.by,
      value: selector.value,
      reason: "attribute-absent",
      exposedBy: 0,
      present: [],
      truncated,
      note:
        `No visible element exposes ${SELECTOR_SOURCE[selector.by]}: this app sets it nowhere on ` +
        `this screen, so every by:"${selector.by}" query answers zero whatever the value. ` +
        "Nothing is missing from the screen, nothing is observable this way. " +
        (selector.by === "role" || selector.by === "label"
          ? "Select by testID or text, or add the accessibility props in the source."
          : "Select by role plus name, or by text."),
    };
  }

  return {
    by: selector.by,
    value: selector.value,
    reason: "value-absent",
    exposedBy,
    present: [...present],
    truncated,
    note:
      `${exposedBy} visible element(s) expose ${SELECTOR_SOURCE[selector.by]}, none matching ` +
      `"${selector.value}". Present: ${quote(present)}${truncated ? ", and more" : ""}.`,
  };
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

/**
 * First native instance able to measure itself: the fiber's own host
 * subtree first, then its ancestors. Text and virtual nodes often have
 * no measurable instance of their own (rect used to come back null):
 * the closest measurable ancestor is the honest approximation.
 */
export const findMeasurableInstance = (
  fiber: FiberLike,
): Record<string, unknown> | null => {
  /**
   * On the old architecture the host fiber's stateNode IS the component
   * instance and carries measureInWindow. On Fabric it is not: it holds
   * `{ node, canonical }`, and the instance with measureInWindow lives at
   * canonical.publicInstance, created LAZILY. Looking only at stateNode
   * therefore returns null for every element on any New Architecture app,
   * which is most of them now.
   */
  const measurable = (candidate: unknown): Record<string, unknown> | null => {
    if (!candidate || typeof candidate !== "object") return null;
    const node = candidate as Record<string, any>;
    if (typeof node.measureInWindow === "function") return node;
    const publicInstance = node.canonical?.publicInstance;
    if (publicInstance && typeof publicInstance.measureInWindow === "function") {
      return publicInstance as Record<string, unknown>;
    }
    return null;
  };

  const queue: Array<{ node: FiberLike; depth: number }> = [{ node: fiber, depth: 0 }];
  while (queue.length) {
    const { node, depth } = queue.shift()!;
    const found = isHostFiber(node) ? measurable(node.stateNode) : null;
    if (found) return found;
    if (depth < 10) {
      for (let child = node.child ?? null; child; child = child.sibling ?? null) {
        queue.push({ node: child, depth: depth + 1 });
      }
    }
  }
  let ancestor = fiber.return ?? null;
  for (let steps = 0; ancestor && steps < 12; steps += 1) {
    const found = measurable(ancestor.stateNode);
    if (found) return found;
    ancestor = ancestor.return ?? null;
  }
  return null;
};

/**
 * The shadow node a Fabric fiber wraps, measurable through the Fabric
 * UIManager without waiting for a public instance to be created. This is
 * the path that works when the element has never been measured or
 * ref'd before, which is the common case for an agent inspecting a
 * screen it did not build.
 */
export const findShadowNode = (fiber: FiberLike): unknown => {
  const queue: Array<{ node: FiberLike; depth: number }> = [{ node: fiber, depth: 0 }];
  while (queue.length) {
    const { node, depth } = queue.shift()!;
    const state = node.stateNode as Record<string, any> | null | undefined;
    if (isHostFiber(node) && state?.node) return state.node;
    if (depth < 10) {
      for (let child = node.child ?? null; child; child = child.sibling ?? null) {
        queue.push({ node: child, depth: depth + 1 });
      }
    }
  }
  let ancestor = fiber.return ?? null;
  for (let steps = 0; ancestor && steps < 12; steps += 1) {
    const state = ancestor.stateNode as Record<string, any> | null | undefined;
    if (state?.node) return state.node;
    ancestor = ancestor.return ?? null;
  }
  return null;
};

const measureFiber = (fiber: FiberLike): Promise<
  { x: number; y: number; width: number; height: number } | null
> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 400);
    const done = (rect: { x: number; y: number; width: number; height: number } | null): void => {
      clearTimeout(timer);
      resolve(rect);
    };

    const instance = findMeasurableInstance(fiber);
    const measure = instance?.measureInWindow;
    if (typeof measure === "function") {
      try {
        measure.call(instance, (x: number, y: number, width: number, height: number) =>
          done({ x, y, width, height })
        );
        return;
      } catch {
        // fall through to the Fabric path
      }
    }

    // Fabric with no public instance yet: measure the shadow node directly
    const fabric = (globalThis as Record<string, any>).nativeFabricUIManager;
    const shadowNode = fabric ? findShadowNode(fiber) : null;
    if (shadowNode && typeof fabric.measureInWindow === "function") {
      try {
        fabric.measureInWindow(shadowNode, (x: number, y: number, width: number, height: number) =>
          done({ x, y, width, height })
        );
        return;
      } catch {
        // measurement is best effort; a null rect is honest
      }
    }
    done(null);
  });

/**
 * Raising the keyboard needs the native COMMAND, not a method call.
 *
 * On Android the soft keyboard only appears through ReactEditText's
 * requestFocusFromJS, which the "focus" command maps to. And on Fabric the
 * fiber's stateNode is `{ node, canonical }`, an object with no methods at
 * all, so calling `.focus()` on it found nothing and did nothing while
 * still reporting success. Both paths are tried, and the absence of any is
 * an error rather than a silent no-op.
 */
const dispatchFocus = (input: FiberLike, action: "focus" | "blur"): string | null => {
  const instance = findMeasurableInstance(input);
  if (instance && typeof instance[action] === "function") {
    try {
      (instance[action] as () => void).call(instance);
      return `${action} called on the public instance`;
    } catch {
      // fall through to the command
    }
  }

  const fabric = (globalThis as Record<string, any>).nativeFabricUIManager;
  const shadowNode = fabric ? findShadowNode(input) : null;
  if (shadowNode && typeof fabric.dispatchCommand === "function") {
    try {
      fabric.dispatchCommand(shadowNode, action, []);
      return `${action} command dispatched`;
    } catch {
      // fall through
    }
  }

  // Old architecture: the view manager takes the same command name
  const legacy = (globalThis as Record<string, any>).nativeModuleProxy?.UIManager;
  const tag = (findStateNode(input) as Record<string, any> | null)?._nativeTag;
  if (legacy && tag && typeof legacy.dispatchViewManagerCommand === "function") {
    try {
      legacy.dispatchViewManagerCommand(tag, action, []);
      return `${action} command dispatched (legacy)`;
    } catch {
      // nothing left to try
    }
  }
  return null;
};

export interface ActRequest {
  action:
    | "tap"
    | "longPress"
    | "type"
    | "clear"
    | "submit"
    | "scrollTo"
    | "scrollToEnd"
    | "focus"
    | "blur";
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

  /**
   * Opening the keyboard was impossible from the hub, which made anything
   * that depends on it, KeyboardAvoidingView above all, impossible to
   * verify without touching the device by hand. The call already existed
   * inside `type`; it simply was not reachable on its own.
   */
  if (request.action === "focus" || request.action === "blur") {
    const input = findTextInputFiber(fiber);
    if (!input) throw new Error("No text input found on the element or nearby");
    const detail = dispatchFocus(input, request.action);
    if (!detail) {
      throw new Error(
        `Could not ${request.action} the input: no public instance and no Fabric UIManager to dispatch through`
      );
    }
    return { detail };
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

/**
 * What an agent sees for one element.
 *
 * `value` was missing here while being present in get_ui_tree, so the two
 * calls that make up the actual loop, query_ui and the target returned by
 * ui_act, could never show what a field contains. An agent typing into an
 * input then had no way to prove the result from the tree and fell back to
 * a screenshot, which is the exact cost this tool exists to remove.
 *
 * A TextInput's content is `value`, never `text`: `text` is rendered
 * children, and an input has none. Both are returned so it does not matter
 * which one is read.
 */
const describeMatch = async (fiber: FiberLike): Promise<Record<string, unknown>> => {
  const props = propsOf(fiber);
  const type = prettyHostType(String(fiber.type ?? "?"));
  const input = isInputType(type);
  const value = props?.value ?? props?.text ?? props?.defaultValue;
  return {
    type,
    testID: stringProp(props, "testID", "data-testid") ?? null,
    label: stringProp(props, "accessibilityLabel", "aria-label") ?? null,
    text: collectSubtreeText(fiber, 30) || null,
    ...(input
      ? {
          value: typeof value === "string" ? value : null,
          placeholder: stringProp(props, "placeholder") ?? null,
          editable: props?.editable !== false,
        }
      : {}),
    rect: await measureFiber(fiber),
    // A match without a source turns editing into a repo-wide grep
    source: resolveSource(fiber),
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
  if (!["testID", "text", "label", "type", "role"].includes(by)) {
    throw new Error(`Unknown selector: ${by} (use testID, text, label, type or role)`);
  }
  const value = payload.value;
  if (typeof value !== "string" || !value.length) {
    throw new Error("Selector needs a non-empty string value");
  }
  return {
    by,
    value,
    exact: payload.exact === true,
    name: typeof payload.name === "string" ? payload.name : undefined,
  };
};

/** Resolves the search scope: the whole roots, or a `within` container */
const resolveScopes = (
  fibers: FiberLike[],
  payload: Record<string, unknown>,
  includeHidden: boolean,
): FiberLike[] => {
  const within = payload.within;
  if (!within || typeof within !== "object") return fibers;
  const container = parseSelector(within as Record<string, unknown>);
  const scopes: FiberLike[] = [];
  for (const fiber of fibers) {
    scopes.push(...queryFibers(fiber, container, 5, includeHidden));
  }
  if (!scopes.length) {
    throw new Error(
      `within: no container matches ${container.by}="${container.value}"`
    );
  }
  return scopes;
};

/** What installUiAutomation hands back so other modules (previews) can
 * reuse the fiber walking without re-implementing root tracking */
export interface AutomationApi {
  generation: () => number;
  query: (selector: UiSelector, limit?: number) => Promise<Array<Record<string, unknown>>>;
  subtree: (selector: UiSelector, options?: SerializeOptions) => UiNode[] | null;
}

/** Registers the ui.tree / ui.query / ui.act command handlers */
export const installUiAutomation = (host: AutomationHost): AutomationApi => {
  const tracker = trackRoots(host.emit);

  host.onCommand("ui.tree", (rawPayload) => {
    const payload = (rawPayload ?? {}) as Record<string, unknown>;
    const fibers = requireRoots(tracker);
    const roots = fibers.map((fiber) => serializeTree(fiber, {
      maxDepth: Number(payload.maxDepth) || undefined,
      maxNodes: Number(payload.maxNodes) || undefined,
      includeHidden: payload.includeHidden === true,
      includeSource: payload.includeSource !== false,
    }));
    return {
      generation: tracker.generation,
      truncated: roots.some((root) => root.truncated),
      hiddenSubtrees: roots.reduce((sum, root) => sum + root.hiddenSubtrees, 0),
      roots: roots.map((root) => root.nodes),
    };
  });

  host.onCommand("ui.query", async (rawPayload) => {
    const payload = (rawPayload ?? {}) as Record<string, unknown>;
    const selector = parseSelector(payload);
    const limit = Math.max(1, Math.min(Number(payload.limit) || 10, 50));
    const includeHidden = payload.includeHidden === true;
    const scopes = resolveScopes(requireRoots(tracker), payload, includeHidden);
    const matches: FiberLike[] = [];
    for (const fiber of scopes) {
      matches.push(...queryFibers(fiber, selector, limit - matches.length, includeHidden));
      if (matches.length >= limit) break;
    }
    return {
      generation: tracker.generation,
      count: matches.length,
      matches: await Promise.all(matches.map(describeMatch)),
      // An empty array says "nothing matched" and lets the reader hear
      // "nothing is there". Say which of the two it is.
      ...(matches.length ? {} : { absence: describeAbsence(scopes, selector, includeHidden) }),
    };
  });

  host.onCommand("ui.act", async (rawPayload) => {
    const payload = (rawPayload ?? {}) as Record<string, unknown>;
    const selector = parseSelector(payload);
    const action = String(payload.action ?? "") as ActRequest["action"];
    const includeHidden = payload.includeHidden === true;
    const scopes = resolveScopes(requireRoots(tracker), payload, includeHidden);
    const matches: FiberLike[] = [];
    for (const fiber of scopes) {
      matches.push(...queryFibers(fiber, selector, 5 - matches.length, includeHidden));
      if (matches.length >= 5) break;
    }
    if (!matches.length) {
      const absence = describeAbsence(scopes, selector, includeHidden);
      throw new Error(
        `No element matches ${selector.by}="${selector.value}". ${absence.note}`
      );
    }
    const index = Math.max(0, Number(payload.index) || 0);
    if (matches.length > 1 && payload.index === undefined) {
      // Give the agent what it needs to choose: the candidates with
      // their rects, instead of a bare "pass an index" error
      return {
        ok: false,
        reason: "ambiguous",
        count: matches.length,
        candidates: await Promise.all(matches.map(describeMatch)),
        hint: "Pass index, narrow the selector, or scope it with within",
      };
    }
    const target = matches[Math.min(index, matches.length - 1)];
    const before = tracker.generation;
    const result = performAct(target, {
      action,
      text: typeof payload.text === "string" ? payload.text : undefined,
      clear: payload.clear === true,
      x: Number(payload.x) || undefined,
      y: Number(payload.y) || undefined,
    });
    /**
     * Typing goes through onChangeText, so the new value only exists after
     * React commits. Waiting is not enough: on commit React swaps to the
     * fiber's alternate, so the reference held here keeps the OLD props and
     * reports the value from before the edit. The selector has to be run
     * again to reach the fresh fiber.
     */
    let described = target;
    if (action === "type" || action === "clear") {
      await new Promise((resolve) => setTimeout(resolve, COMMIT_SETTLE_MS));
      for (const fiber of liveRootFibers(tracker)) {
        const fresh = queryFibers(fiber, selector, index + 1, includeHidden);
        if (fresh.length > index) {
          described = fresh[index];
          break;
        }
      }
    }

    return {
      ok: true,
      generation: tracker.generation,
      committed: tracker.generation > before,
      action,
      detail: result.detail,
      target: await describeMatch(described),
    };
  });

  /**
   * Which elements own a point on screen, outermost first.
   *
   * Descends measuring as it goes and prunes any subtree whose box does
   * not contain the point, so a hit test costs a handful of measurements
   * instead of one per node. The approximation is stated on purpose:
   * a child rendered outside its parent's bounds is missed, which is
   * rare in a layout engine built on flexbox.
   */
  // React Native mounts its own full-screen dev overlays above the app.
  // They are not part of the UI under test and, being full-screen, they
  // swallow every hit test: without this the answer is always the overlay.
  const DEV_OVERLAYS = /DebuggingOverlay|LogBox|YellowBox|Inspector|DevLoadingView/;

  const hitTest = async (
    x: number,
    y: number,
    limit = 200,
  ): Promise<Array<Record<string, unknown>>> => {
    const path: Array<Record<string, unknown>> = [];
    let measurements = 0;

    const visit = async (fiber: FiberLike): Promise<void> => {
      for (let child = fiber.child ?? null; child; child = child.sibling ?? null) {
        if (isHiddenSubtree(child) || isTextFiber(child)) continue;
        if (DEV_OVERLAYS.test(String(resolveSource(child)?.componentName ?? ""))) continue;
        if (!isHostFiber(child)) {
          await visit(child);
          continue;
        }
        if (measurements >= limit) return;
        measurements += 1;
        const rect = await measureFiber(child);
        if (!rect || rect.width <= 0 || rect.height <= 0) continue;
        const inside =
          x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
        if (!inside) continue;
        path.push({ ...(await describeMatch(child)), rect });
        await visit(child);
      }
    };

    for (const root of requireRoots(tracker)) await visit(root);
    return path;
  };

  /**
   * The root's box in POINTS. A screenshot is in device pixels and every
   * measurement here is in points; without the ratio between them a hit
   * test computed from an image lands nowhere near the element. Deriving
   * it from the root rather than from an app-emitted screen width means
   * the app has to declare nothing.
   */
  host.onCommand("ui.viewport", async () => {
    for (const root of requireRoots(tracker)) {
      for (let child = root.child ?? null; child; child = child.sibling ?? null) {
        const rect = await measureFiber(child);
        if (rect && rect.width > 0 && rect.height > 0) {
          return { width: rect.width, height: rect.height };
        }
      }
    }
    return { width: null, height: null };
  });

  host.onCommand("ui.at", async (rawPayload) => {
    const payload = (rawPayload ?? {}) as Record<string, unknown>;
    const x = Number(payload.x);
    const y = Number(payload.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error("ui.at needs numeric x and y in points");
    }
    const path = await hitTest(x, y, Math.max(20, Math.min(Number(payload.limit) || 200, 1000)));
    return {
      generation: tracker.generation,
      point: { x, y },
      // The deepest element is the one that actually drew there
      deepest: path[path.length - 1] ?? null,
      path,
    };
  });

  const firstMatch = (selector: UiSelector): FiberLike | null => {
    for (const fiber of requireRoots(tracker)) {
      const found = queryFibers(fiber, selector, 1, false);
      if (found.length) return found[0];
    }
    return null;
  };

  return {
    generation: () => tracker.generation,
    query: async (selector, limit = 10) => {
      const matches: FiberLike[] = [];
      for (const fiber of requireRoots(tracker)) {
        matches.push(...queryFibers(fiber, selector, limit - matches.length, false));
        if (matches.length >= limit) break;
      }
      return Promise.all(matches.map(describeMatch));
    },
    subtree: (selector, options) => {
      const fiber = firstMatch(selector);
      return fiber ? serializeTree(fiber, options).nodes : null;
    },
  };
};
