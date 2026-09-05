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
  by: "testID" | "text" | "label" | "type" | "role" | "placeholder";
  value: string;
  /** For by:"text", by:"placeholder" and name matching: exact match
   * instead of substring */
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

/** A string child inlined into the props, which is how react-dom carries
 * a single text child (React Native also mounts a HostText fiber for it) */
const inlineText = (fiber: FiberLike): string => {
  const children = propsOf(fiber)?.children;
  return typeof children === "string" || typeof children === "number"
    ? String(children)
    : "";
};

/**
 * What an element renders as text, counted once.
 *
 * React Native puts a single string child in BOTH places: the host props
 * and a HostText fiber. Adding the two, which is what this used to do,
 * returned "Log InLog In": every diagnostic listing present values read
 * double, and `by:"text"` with `exact` could never match a Text at all.
 */
const renderedText = (fiber: FiberLike): string =>
  collectSubtreeText(fiber, 30) || inlineText(fiber);

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
    renderedText(fiber)
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
    /**
     * The selector the common form actually needs. A TextInput without
     * testID and without accessibilityLabel is the norm, and the only
     * thing left to select it by was the index, which is precisely the
     * fragile path. The placeholder is already read (it feeds the tree
     * and the accessible name); it simply was not selectable.
     */
    case "placeholder": {
      const placeholder = stringProp(props, "placeholder");
      if (placeholder === undefined) return false;
      return selector.exact ? placeholder === value : placeholder.includes(value);
    }
    case "text": {
      // Only text-bearing elements match: containers aggregate the text
      // of their whole subtree and would shadow the actual target
      const pretty = prettyHostType(String(fiber.type));
      if (!isTextType(pretty) && !inlineText(fiber)) return false;
      const text = renderedText(fiber);
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
  placeholder: "placeholder",
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
    case "placeholder":
      return stringProp(props, "placeholder");
    case "text": {
      if (!isTextType(prettyHostType(String(fiber.type))) && !inlineText(fiber)) return undefined;
      return renderedText(fiber) || undefined;
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
export const findHandlerOwner = (
  fiber: FiberLike,
  propNames: string[],
  searchDepth = 10,
  climbDepth = 15,
): { fiber: FiberLike; handler: (event: unknown) => unknown; prop: string; from: Proximity } | null => {
  const handlerOf = (
    node: FiberLike,
  ): { handler: (event: unknown) => unknown; prop: string } | null => {
    const props = propsOf(node);
    for (const name of propNames) {
      const candidate = props?.[name];
      if (typeof candidate === "function") {
        return { handler: candidate as (event: unknown) => unknown, prop: name };
      }
    }
    return null;
  };

  const found = searchNearby(
    fiber,
    (node) => {
      const hit = handlerOf(node);
      return hit ? { node, ...hit } : null;
    },
    searchDepth,
    climbDepth,
  );
  return found
    ? { fiber: found.found.node, handler: found.found.handler, prop: found.found.prop, from: found.from }
    : null;
};

export const findHandler = (
  fiber: FiberLike,
  propNames: string[],
  searchDepth = 10,
  climbDepth = 15,
): ((event: unknown) => unknown) | null =>
  findHandlerOwner(fiber, propNames, searchDepth, climbDepth)?.handler ?? null;

const isHostInput = (node: FiberLike): boolean =>
  isHostFiber(node) && isInputType(prettyHostType(String(node.type)));

const isInputFiber = (node: FiberLike): boolean =>
  typeof propsOf(node)?.onChangeText === "function" || isHostInput(node);

/** The host input a wrapper component renders, when it renders one */
const hostInputInside = (fiber: FiberLike): FiberLike | null => {
  const queue: Array<{ node: FiberLike; depth: number }> = [{ node: fiber, depth: 0 }];
  while (queue.length) {
    const { node, depth } = queue.shift()!;
    if (node !== fiber && isHostInput(node)) return node;
    if (depth < 6) {
      for (let child = node.child ?? null; child; child = child.sibling ?? null) {
        queue.push({ node: child, depth: depth + 1 });
      }
    }
  }
  return null;
};

/**
 * Every text input reachable from a fiber, and how far away they are.
 *
 * Returning only the first one is what let a selector matching a
 * CONTAINER, which is the normal case for a form row or a card, write
 * into whichever input happened to come first in the traversal, with
 * nothing in the answer saying a choice had been made. The caller can now
 * refuse an ambiguous target instead of guessing.
 *
 * A wrapper component and the host TextInput it renders are ONE field,
 * not two: the traversal does not descend into a match, and a wrapper
 * resolves to the host input it contains, whose onChangeText is the one
 * the keyboard would fire.
 */
export const findTextInputFibers = (
  fiber: FiberLike,
  limit = 5,
): { inputs: FiberLike[]; from: Proximity | null } => {
  const resolve = (node: FiberLike): FiberLike =>
    isHostInput(node) ? node : hostInputInside(node) ?? node;

  if (isInputFiber(fiber)) return { inputs: [resolve(fiber)], from: "self" };

  const inputs: FiberLike[] = [];
  const queue: Array<{ node: FiberLike; depth: number }> = [];
  for (let child = fiber.child ?? null; child; child = child.sibling ?? null) {
    queue.push({ node: child, depth: 1 });
  }
  while (queue.length && inputs.length < limit) {
    const { node, depth } = queue.shift()!;
    if (isInputFiber(node)) {
      inputs.push(resolve(node));
      continue; // a wrapper and its host input are the same field
    }
    if (depth < 10) {
      for (let child = node.child ?? null; child; child = child.sibling ?? null) {
        queue.push({ node: child, depth: depth + 1 });
      }
    }
  }
  if (inputs.length) return { inputs, from: "descendant" };

  let ancestor = fiber.return ?? null;
  for (let steps = 0; ancestor && steps < 10; steps += 1) {
    if (isInputFiber(ancestor)) return { inputs: [resolve(ancestor)], from: "ancestor" };
    ancestor = ancestor.return ?? null;
  }
  return { inputs: [], from: null };
};

/** Finds the closest text input fiber (self, descendants, then ancestors) */
export const findTextInputFiber = (fiber: FiberLike): FiberLike | null =>
  findTextInputFibers(fiber, 1).inputs[0] ?? null;

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

/**
 * The public instance React exposes for a host fiber, on BOTH
 * architectures.
 *
 * On the old architecture the stateNode IS the instance and carries the
 * methods. On Fabric it is `{ node, canonical }`, an object with no
 * method at all, and the instance lives at `canonical.publicInstance`,
 * created lazily. Handing `{ node, canonical }` to a caller that then
 * looks for `setNativeProps` or `scrollToEnd` is how an action that never
 * happened gets reported as a success, so that shape is refused here
 * rather than passed on.
 */
export const publicInstanceOf = (fiber: FiberLike): Record<string, unknown> | null => {
  const state = fiber.stateNode as Record<string, any> | null | undefined;
  if (!state || typeof state !== "object") return null;
  if (state.canonical || state.node) {
    const instance = state.canonical?.publicInstance;
    return instance && typeof instance === "object"
      ? (instance as Record<string, unknown>)
      : null;
  }
  return state as Record<string, unknown>;
};

/**
 * Calls a method on a native instance and SAYS whether it happened.
 *
 * The previous version returned void and swallowed both the missing
 * method and the exception. On an observation path that is fine; on an
 * action path it is the silent failure this tool exists to remove, and
 * it is what made `type` and `scrollToEnd` no-ops on the New
 * Architecture while still answering ok.
 */
const callNative = (
  instance: Record<string, unknown> | null,
  method: string,
  ...args: unknown[]
): boolean => {
  const fn = instance?.[method];
  if (typeof fn !== "function") return false;
  try {
    fn.apply(instance, args);
    return true;
  } catch {
    return false;
  }
};

/** Where a value was found relative to the fiber it was asked for */
export type Proximity = "self" | "descendant" | "ancestor";

/**
 * Looks for something on the fiber itself, then in its subtree, then up
 * its ancestors, and SAYS which of the three answered.
 *
 * The distinction is the whole point: a value found on the fiber itself
 * is the answer, one found on an ancestor is an approximation, and
 * presenting the second as the first is what made every row of a list
 * report the rect of the ScrollView that contains them.
 */
const searchNearby = <T>(
  fiber: FiberLike,
  pick: (node: FiberLike) => T | null,
  descendDepth = 10,
  climbDepth = 12,
): { found: T; from: Proximity } | null => {
  const own = pick(fiber);
  if (own) return { found: own, from: "self" };

  const queue: Array<{ node: FiberLike; depth: number }> = [];
  for (let child = fiber.child ?? null; child; child = child.sibling ?? null) {
    queue.push({ node: child, depth: 1 });
  }
  while (queue.length) {
    const { node, depth } = queue.shift()!;
    const hit = pick(node);
    if (hit) return { found: hit, from: "descendant" };
    if (depth < descendDepth) {
      for (let child = node.child ?? null; child; child = child.sibling ?? null) {
        queue.push({ node: child, depth: depth + 1 });
      }
    }
  }

  let ancestor = fiber.return ?? null;
  for (let steps = 0; ancestor && steps < climbDepth; steps += 1) {
    const hit = pick(ancestor);
    if (hit) return { found: hit, from: "ancestor" };
    ancestor = ancestor.return ?? null;
  }
  return null;
};

/**
 * On the old architecture the host fiber's stateNode IS the component
 * instance and carries measureInWindow. On Fabric it is not: it holds
 * `{ node, canonical }`, and the instance with measureInWindow lives at
 * canonical.publicInstance, created LAZILY. Looking only at stateNode
 * therefore returns null for every element on any New Architecture app,
 * which is most of them now.
 */
const measurableInstance = (fiber: FiberLike): Record<string, unknown> | null => {
  const candidate = fiber.stateNode;
  if (!candidate || typeof candidate !== "object") return null;
  const node = candidate as Record<string, any>;
  if (typeof node.measureInWindow === "function") return node;
  const publicInstance = node.canonical?.publicInstance;
  if (publicInstance && typeof publicInstance.measureInWindow === "function") {
    return publicInstance as Record<string, unknown>;
  }
  return null;
};

const ownShadowNode = (fiber: FiberLike): unknown => {
  const state = fiber.stateNode as Record<string, any> | null | undefined;
  return isHostFiber(fiber) && state?.node ? state.node : null;
};

/**
 * First native instance able to measure itself: the fiber's own host
 * subtree first, then its ancestors. Text and virtual nodes often have
 * no measurable instance of their own (rect used to come back null):
 * the closest measurable ancestor is the honest approximation.
 */
export const findMeasurableInstance = (
  fiber: FiberLike,
): Record<string, unknown> | null =>
  searchNearby(fiber, measurableInstance)?.found ?? null;

/**
 * The shadow node a Fabric fiber wraps, measurable through the Fabric
 * UIManager without waiting for a public instance to be created. This is
 * the path that works when the element has never been measured or
 * ref'd before, which is the common case for an agent inspecting a
 * screen it did not build.
 */
export const findShadowNode = (fiber: FiberLike): unknown =>
  searchNearby(fiber, ownShadowNode)?.found ?? null;

export interface Rect { x: number; y: number; width: number; height: number }

/** A rect plus how far from the element it was actually taken */
export interface Measurement {
  rect: Rect | null;
  /** "self" is the element's own box; anything else is an approximation */
  from: Proximity | null;
}

const measureInstance = (instance: Record<string, unknown> | null): Promise<Rect | null> =>
  new Promise((resolve) => {
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

const measureShadow = (shadowNode: unknown): Promise<Rect | null> =>
  new Promise((resolve) => {
    const fabric = (globalThis as Record<string, any>).nativeFabricUIManager;
    if (!shadowNode || typeof fabric?.measureInWindow !== "function") { resolve(null); return; }
    const timer = setTimeout(() => resolve(null), 400);
    try {
      fabric.measureInWindow(shadowNode, (x: number, y: number, width: number, height: number) => {
        clearTimeout(timer);
        resolve({ x, y, width, height });
      });
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });

/**
 * Measures an element, own box first.
 *
 * The order used to be: any measurable instance found by walking down
 * THEN UP, and only then the Fabric shadow node. On the New Architecture
 * the public instance is created lazily, so an ordinary View or a list
 * row does not have one, the walk climbed to the nearest component that
 * did (typically the enclosing ScrollView) and returned ITS box for every
 * row. That is why rects stopped moving after a scroll: they were never
 * the row's rects. The element's own shadow node answers correctly and is
 * now tried before any neighbour.
 *
 * What remains, and cannot be fixed here: on Fabric the position comes
 * from the shadow tree, and a ScrollView's content offset only reaches it
 * through an asynchronous state update. A measurement taken while a
 * scroll is still settling can lag by a frame.
 */
export const measureFiberDetailed = async (fiber: FiberLike): Promise<Measurement> => {
  /**
   * One walk, ordered by DISTANCE, trying both mechanisms at each step.
   * Ordering by mechanism instead would let a ScrollView two steps up that
   * owns a public instance beat the row one step up that only owns a
   * shadow node, which is the same borrowed box under another name.
   */
  const candidates: Array<{ fiber: FiberLike; from: Proximity }> = [];
  const consider = (node: FiberLike, from: Proximity): void => {
    if (candidates.length < 8 && (measurableInstance(node) || ownShadowNode(node))) {
      candidates.push({ fiber: node, from });
    }
  };

  consider(fiber, "self");
  const queue: Array<{ node: FiberLike; depth: number }> = [];
  for (let child = fiber.child ?? null; child; child = child.sibling ?? null) {
    queue.push({ node: child, depth: 1 });
  }
  while (queue.length && candidates.length < 8) {
    const { node, depth } = queue.shift()!;
    consider(node, "descendant");
    if (depth < 10) {
      for (let child = node.child ?? null; child; child = child.sibling ?? null) {
        queue.push({ node: child, depth: depth + 1 });
      }
    }
  }
  let ancestor = fiber.return ?? null;
  for (let steps = 0; ancestor && steps < 12 && candidates.length < 8; steps += 1) {
    consider(ancestor, "ancestor");
    ancestor = ancestor.return ?? null;
  }

  for (const candidate of candidates) {
    const rect =
      (await measureInstance(measurableInstance(candidate.fiber))) ??
      (await measureShadow(ownShadowNode(candidate.fiber)));
    if (rect) return { rect, from: candidate.from };
  }
  return { rect: null, from: null };
};

const measureFiber = async (fiber: FiberLike): Promise<Rect | null> =>
  (await measureFiberDetailed(fiber)).rect;

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
  // The input's OWN instance, never a neighbour's: focusing the field
  // above the one that was asked for is the same lie as typing into it
  const instance = publicInstanceOf(input);
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
    | "scrollBy"
    | "focus"
    | "blur";
  text?: string;
  clear?: boolean;
  x?: number;
  y?: number;
  /** For scrollBy: how far to move, in points */
  dx?: number;
  dy?: number;
}

/**
 * What an action actually did, and to WHOM.
 *
 * `acted` is the fiber that received the action, which is not always the
 * fiber that matched the selector: a container matches, the text goes
 * into the input it holds, the press fires the handler of a Pressable
 * ancestor. Returning it is what lets the answer name the element it
 * really touched instead of the one that was asked for.
 */
export interface ActOutcome {
  detail: string;
  acted: FiberLike;
  from: Proximity;
  extra?: Record<string, unknown>;
}

const inputSummary = (fiber: FiberLike): string => {
  const props = propsOf(fiber);
  const label = stringProp(props, "placeholder", "testID", "accessibilityLabel", "aria-label");
  return label ? `"${clip(label)}"` : prettyHostType(String(fiber.type ?? "?"));
};

/** Resolves the single input an action applies to, or refuses to guess */
const requireTextInput = (fiber: FiberLike, action: string): { input: FiberLike; from: Proximity } => {
  const { inputs, from } = findTextInputFibers(fiber);
  if (!inputs.length || from === null) {
    throw new Error("No text input found on the element or nearby");
  }
  if (inputs.length > 1) {
    throw new Error(
      `Ambiguous ${action} target: the matched element contains ${inputs.length} text inputs ` +
      `(${inputs.map(inputSummary).join(", ")}). Select the input itself, for instance ` +
      'by:"placeholder", instead of the container that holds it.'
    );
  }
  return { input: inputs[0], from };
};

/** ScrollView, FlatList and friends expose these on the PUBLIC instance */
const scrollableInstance = (fiber: FiberLike): Record<string, unknown> | null => {
  const instance = publicInstanceOf(fiber);
  if (!instance) return null;
  const scrollable =
    typeof instance.scrollTo === "function" ||
    typeof instance.scrollToEnd === "function" ||
    typeof instance.getScrollResponder === "function";
  return scrollable ? instance : null;
};

/** The scrollable nearest to a matched element, and how far it is */
const findScrollable = (
  fiber: FiberLike,
): { instance: Record<string, unknown>; fiber: FiberLike; from: Proximity } | null => {
  const found = searchNearby(fiber, (node) => {
    const instance = scrollableInstance(node);
    return instance ? { instance, node } : null;
  });
  return found ? { instance: found.found.instance, fiber: found.found.node, from: found.from } : null;
};

/** The fiber itself when it is a host, otherwise its first host descendant */
const firstHostFiber = (fiber: FiberLike): FiberLike | null => {
  if (isHostFiber(fiber)) return fiber;
  for (let child = fiber.child ?? null; child; child = child.sibling ?? null) {
    const found = firstHostFiber(child);
    if (found) return found;
  }
  return null;
};

/**
 * The content view of a scrollable: its box moves when the list scrolls,
 * the scroller's box does not, and the difference is the offset.
 *
 * It has to be resolved from the SCROLL HOST, not from whichever fiber
 * happened to carry the scroll methods. React Native puts them on the
 * host public instance, but a wrapper component can carry them too, and
 * taking the first host below such a wrapper returns the scroll view
 * itself: the same box measured twice, an offset of exactly 0 forever,
 * and a scrollToEnd that reports movedBy 0 and atEnd true on a list that
 * did move. An offset that cannot be established honestly is null.
 */
const scrollContentFiber = (scrollHost: FiberLike): FiberLike | null => {
  for (let child = scrollHost.child ?? null; child; child = child.sibling ?? null) {
    const found = firstHostFiber(child);
    if (found && found !== scrollHost) return found;
  }
  return null;
};

/** The content view instance, through the accessor ScrollView exposes for
 * exactly this, when the running version has it */
const innerViewInstance = (
  instance: Record<string, unknown>,
): Record<string, unknown> | null => {
  const accessor = instance.getInnerViewRef;
  if (typeof accessor !== "function") return null;
  try {
    const inner = (accessor as () => unknown)();
    return inner && typeof inner === "object" &&
      typeof (inner as Record<string, unknown>).measureInWindow === "function"
      ? (inner as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

/** Two frames: long enough for a native scroll to reach the shadow tree */
const FRAME_MS = 16;
const nextFrames = (count = 2): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, FRAME_MS * count));

/**
 * How far a scrollable has scrolled, or null when that cannot be
 * established from its own boxes. A borrowed measurement would make the
 * subtraction meaningless, so only boxes measured on the elements
 * themselves count.
 */
const scrollOffsetOf = async (
  scrollHost: FiberLike | null,
  content: FiberLike | null,
  inner: Record<string, unknown> | null,
): Promise<{ x: number; y: number } | null> => {
  if (!scrollHost) return null;
  const outer = await measureFiberDetailed(scrollHost);
  if (!outer.rect || outer.from !== "self") return null;

  const innerRect = inner ? await measureInstance(inner) : null;
  let contentRect = innerRect;
  if (!contentRect && content) {
    const measured = await measureFiberDetailed(content);
    contentRect = measured.from === "self" ? measured.rect : null;
  }
  if (!contentRect) return null;
  return { x: outer.rect.x - contentRect.x, y: outer.rect.y - contentRect.y };
};

const callScroll = (
  instance: Record<string, unknown>,
  method: "scrollTo" | "scrollToEnd",
  args: Record<string, unknown>,
): boolean => {
  // On the old architecture the methods live behind the responder
  const responder = typeof instance.getScrollResponder === "function"
    ? (() => {
        try { return (instance.getScrollResponder as () => unknown)() as Record<string, unknown>; }
        catch { return instance; }
      })()
    : instance;
  return callNative(instance, method, args) || callNative(responder, method, args);
};

/** Passes of scrollToEnd: a virtualized list only knows the end of what
 * it has already rendered, so one call stops short of the real bottom */
const SCROLL_END_PASSES = 5;

/** Performs an action on a matched fiber through its JS props */
export const performAct = async (fiber: FiberLike, request: ActRequest): Promise<ActOutcome> => {
  if (request.action === "tap" || request.action === "longPress") {
    const names = request.action === "tap" ? ["onPress", "onClick"] : ["onLongPress"];
    const owner = findHandlerOwner(fiber, names);
    if (!owner) {
      throw new Error(`No ${names[0]} handler found on the element or its ancestors`);
    }
    owner.handler({ nativeEvent: {}, persist: () => {} });
    return {
      detail: `${owner.prop} invoked`,
      acted: owner.fiber,
      from: owner.from,
      extra: { handler: owner.prop },
    };
  }

  /**
   * Opening the keyboard was impossible from the hub, which made anything
   * that depends on it, KeyboardAvoidingView above all, impossible to
   * verify without touching the device by hand. The call already existed
   * inside `type`; it simply was not reachable on its own.
   */
  if (request.action === "focus" || request.action === "blur") {
    const { input, from } = requireTextInput(fiber, request.action);
    const detail = dispatchFocus(input, request.action);
    if (!detail) {
      throw new Error(
        `Could not ${request.action} the input: no public instance and no Fabric UIManager to dispatch through`
      );
    }
    return { detail, acted: input, from };
  }

  if (request.action === "type" || request.action === "clear") {
    const { input, from } = requireTextInput(fiber, request.action);
    const props = propsOf(input);
    if (props?.editable === false) {
      throw new Error(`The input ${inputSummary(input)} is not editable (editable={false})`);
    }
    /**
     * The instance must be the input's OWN public instance. `findStateNode`
     * returned `{node, canonical}` on Fabric, an object with no method, so
     * setNativeProps and focus silently did nothing on every New
     * Architecture app while the answer still said the text was typed.
     */
    const instance = publicInstanceOf(input);
    let native = false;
    let js = false;
    const apply = (text: string): void => {
      native = callNative(instance, "setNativeProps", { text }) || native;
      const onChangeText = props?.onChangeText;
      if (typeof onChangeText === "function") { onChangeText(text); js = true; }
      const onChange = props?.onChange;
      if (typeof onChange === "function") {
        onChange({ nativeEvent: { text, eventCount: 0, target: null } });
        js = true;
      }
    };
    dispatchFocus(input, "focus");
    const text = request.action === "clear" ? "" : String(request.text ?? "");
    if (request.action === "type" && request.clear) apply("");
    apply(text);
    if (!native && !js) {
      throw new Error(
        `Nothing to type into ${inputSummary(input)}: it has no onChangeText, no onChange, and no ` +
        "public instance to set the text on. Typing through the JS props cannot reach it."
      );
    }
    return {
      detail: request.action === "clear" ? "cleared" : `typed ${text.length} chars`,
      acted: input,
      from,
      extra: { via: native && js ? "props+native" : js ? "props" : "native" },
    };
  }

  if (request.action === "submit") {
    const { input, from } = requireTextInput(fiber, "submit");
    const props = propsOf(input);
    const onSubmit = props?.onSubmitEditing;
    if (typeof onSubmit !== "function") {
      throw new Error("No onSubmitEditing handler found");
    }
    const current = typeof props?.value === "string" ? props.value : String(request.text ?? "");
    (onSubmit as (event: unknown) => unknown)({ nativeEvent: { text: current, target: null } });
    return { detail: "submitted", acted: input, from };
  }

  if (
    request.action === "scrollTo" ||
    request.action === "scrollToEnd" ||
    request.action === "scrollBy"
  ) {
    const scrollable = findScrollable(fiber);
    if (!scrollable) {
      throw new Error(
        "No scrollable element found on the match or nearby. The scroll methods live on the " +
        "public instance React Native creates for a ScrollView/FlatList, so select the list " +
        'itself (by:"type" value:"ScrollView", or its testID) rather than an element inside it.'
      );
    }
    const { instance } = scrollable;
    const scrollHost = firstHostFiber(scrollable.fiber);
    const content = scrollHost ? scrollContentFiber(scrollHost) : null;
    const inner = innerViewInstance(instance);
    const offsetNow = (): Promise<{ x: number; y: number } | null> =>
      scrollOffsetOf(scrollHost, content, inner);
    const before = await offsetNow();

    if (request.action === "scrollToEnd") {
      /**
       * A virtualized list only knows the end of what it has already
       * rendered: one scrollToEnd lands short of the real bottom, and the
       * next one used to report the same success while going nowhere.
       * Repeat until the offset stops moving, and say how far it went.
       */
      let passes = 0;
      let last = before;
      for (let pass = 0; pass < SCROLL_END_PASSES; pass += 1) {
        if (!callScroll(instance, "scrollToEnd", { animated: false })) {
          throw new Error(
            "The matched element exposes no scrollToEnd. On the New Architecture this means its " +
            "public instance does not exist yet: interact with the list once, or scroll the " +
            "ScrollView itself."
          );
        }
        passes += 1;
        if (!last) break; // nothing measurable to compare against
        await nextFrames();
        const now = await offsetNow();
        if (!now || Math.abs(now.y - last.y) < 1) { last = now ?? last; break; }
        last = now;
      }
      const moved = before && last ? Math.round(last.y - before.y) : null;
      return {
        detail: `scrollToEnd in ${passes} pass(es)`,
        acted: scrollable.fiber,
        from: scrollable.from,
        extra: {
          passes,
          movedBy: moved,
          offset: last ? Math.round(last.y) : null,
          atEnd: moved === null ? null : passes < SCROLL_END_PASSES,
          ...(moved === null
            ? {
                note:
                  "The scroll offset is not measurable on this element, so nothing here says how " +
                  "far it went or whether the end was reached. Verify with query_ui, or use " +
                  "swipe_native.",
              }
            : {}),
        },
      };
    }

    if (request.action === "scrollBy") {
      if (!before) {
        throw new Error(
          "scrollBy needs the current offset, which could not be measured on this element. " +
          "Use scrollTo with an absolute position, or scrollToEnd."
        );
      }
      const target = {
        x: before.x + Number(request.dx ?? 0),
        y: before.y + Number(request.dy ?? 0),
        animated: false,
      };
      if (!callScroll(instance, "scrollTo", target)) {
        throw new Error("The matched element exposes no scrollTo");
      }
      await nextFrames();
      const now = await offsetNow();
      return {
        detail: `scrollBy ${Math.round(Number(request.dy ?? 0))}pt`,
        acted: scrollable.fiber,
        from: scrollable.from,
        extra: {
          requested: { x: Math.round(target.x), y: Math.round(target.y) },
          offset: now ? Math.round(now.y) : null,
          movedBy: now ? Math.round(now.y - before.y) : null,
        },
      };
    }

    const target = {
      x: Number(request.x ?? 0),
      y: Number(request.y ?? 0),
      animated: false,
    };
    if (!callScroll(instance, "scrollTo", target)) {
      throw new Error(
        "The matched element exposes no scrollTo. On the New Architecture the scroll methods " +
        "live on the public instance: select the ScrollView/FlatList itself."
      );
    }
    await nextFrames();
    const now = await offsetNow();
    return {
      detail: `scrollTo y=${target.y}`,
      acted: scrollable.fiber,
      from: scrollable.from,
      extra: { requested: { x: target.x, y: target.y }, offset: now ? Math.round(now.y) : null },
    };
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
  const type = isHostFiber(fiber)
    ? prettyHostType(String(fiber.type))
    : resolveSource(fiber)?.componentName ?? "Component";
  const input = isInputType(type) || typeof props?.onChangeText === "function";
  const value = props?.value ?? props?.text ?? props?.defaultValue;
  const measurement = await measureFiberDetailed(fiber);
  return {
    type,
    testID: stringProp(props, "testID", "data-testid") ?? null,
    label: stringProp(props, "accessibilityLabel", "aria-label") ?? null,
    text: renderedText(fiber) || null,
    ...(input
      ? {
          value: typeof value === "string" ? value : null,
          placeholder: stringProp(props, "placeholder") ?? null,
          editable: props?.editable !== false,
        }
      : {}),
    rect: measurement.rect,
    /**
     * A rect measured on a neighbour is an approximation, and saying so
     * costs one field. Every row of a list used to report the box of the
     * ScrollView above it, which reads as a rect that does not move when
     * the list scrolls.
     */
    ...(measurement.rect && measurement.from !== "self"
      ? {
          rectFrom: measurement.from,
          rectNote: `approximate: measured on the closest measurable ${measurement.from}`,
        }
      : {}),
    // A match without a source turns editing into a repo-wide grep
    source: resolveSource(fiber),
  };
};

/**
 * What an element IS, stable across the commit that swaps a fiber for its
 * alternate. Deliberately excludes the value: the point is to recognise
 * the same field after it changed.
 */
const identityOf = (fiber: FiberLike | null): string => {
  if (!fiber) return "";
  const props = propsOf(fiber);
  const source = resolveSource(fiber);
  return [
    isHostFiber(fiber) ? String(fiber.type) : "composite",
    stringProp(props, "testID", "data-testid") ?? "",
    stringProp(props, "placeholder") ?? "",
    stringProp(props, "accessibilityLabel", "aria-label") ?? "",
    source ? `${source.file ?? ""}:${source.line ?? ""}:${source.componentName ?? ""}` : "",
  ].join("|");
};

/** A match labelled with the position `index` addresses in ui.act */
const withIndex = async (
  fiber: FiberLike,
  index: number,
): Promise<Record<string, unknown>> => ({ index, ...(await describeMatch(fiber)) });

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
  if (!["testID", "text", "label", "type", "role", "placeholder"].includes(by)) {
    throw new Error(
      `Unknown selector: ${by} (use testID, text, label, placeholder, type or role)`
    );
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
    // One past the limit, so "there are more" is a fact rather than a
    // guess drawn from a count that happens to equal the limit
    const probe = limit + 1;
    const found: FiberLike[] = [];
    for (const fiber of scopes) {
      found.push(...queryFibers(fiber, selector, probe - found.length, includeHidden));
      if (found.length >= probe) break;
    }
    const capped = found.length > limit;
    const matches = capped ? found.slice(0, limit) : found;
    return {
      generation: tracker.generation,
      count: matches.length,
      /**
       * `count` is capped by `limit`, and a capped count read as a total
       * is how an agent computes an index that does not exist. Say when
       * the search stopped at the limit rather than at the last match.
       */
      truncated: capped,
      /**
       * Each match carries the index ui.act expects for the same
       * selector: both walk the same tree in the same order, so a
       * position read here is usable there without counting by hand.
       */
      matches: await Promise.all(matches.map(withIndex)),
      // An empty array says "nothing matched" and lets the reader hear
      // "nothing is there". Say which of the two it is.
      ...(matches.length ? {} : { absence: describeAbsence(scopes, selector, includeHidden) }),
    };
  });

  /**
   * How many candidates ui.act collects. It used to be 5, in hard code,
   * while `index` was unbounded and then clamped: index 6 acted on the
   * fifth element and the answer, rebuilt with a DIFFERENT limit,
   * described the seventh. Right placeholder, right source, wrong field,
   * and nothing in the answer said so.
   */
  const ACT_MATCH_LIMIT = 50;
  /** Candidates described on a refusal. Each carries its index, so ten is
   * enough to choose from without paying for fifty rects and sources. */
  const CANDIDATE_LIMIT = 10;

  const parseIndex = (raw: unknown): number | undefined => {
    if (raw === undefined || raw === null) return undefined;
    const index = Number(raw);
    if (!Number.isInteger(index) || index < 0) {
      throw new Error(`index must be a non-negative integer, got ${JSON.stringify(raw)}`);
    }
    return index;
  };

  host.onCommand("ui.act", async (rawPayload) => {
    const payload = (rawPayload ?? {}) as Record<string, unknown>;
    const selector = parseSelector(payload);
    const action = String(payload.action ?? "") as ActRequest["action"];
    const includeHidden = payload.includeHidden === true;
    const index = parseIndex(payload.index);
    if (
      (action === "type" || action === "submit") &&
      payload.text !== undefined &&
      typeof payload.text !== "string"
    ) {
      // Dropping it typed an empty string while the answer still compared
      // against the number, so the tool wiped the field and called it a
      // transformation the app had made
      throw new Error(`text must be a string, got ${JSON.stringify(payload.text)}`);
    }
    // Collect one more than asked for, so "there are others" can be told
    // apart from "that was the last one"
    const wanted = Math.min(Math.max(5, (index ?? 0) + 2), ACT_MATCH_LIMIT);

    /** The one way this command resolves a target, used before AND after
     * the action so the element described is the element acted on */
    const collect = (): { scopes: FiberLike[]; matches: FiberLike[]; truncated: boolean } => {
      const scopes = resolveScopes(requireRoots(tracker), payload, includeHidden);
      // One more than needed: "there are others" and "that was the last
      // one" answer differently, and a capped count read as a total is
      // what makes an agent compute an index that does not exist
      const probe = wanted + 1;
      const found: FiberLike[] = [];
      for (const fiber of scopes) {
        found.push(...queryFibers(fiber, selector, probe - found.length, includeHidden));
        if (found.length >= probe) break;
      }
      const truncated = found.length > wanted;
      return { scopes, matches: truncated ? found.slice(0, wanted) : found, truncated };
    };

    const { scopes, matches, truncated } = collect();
    if (!matches.length) {
      const absence = describeAbsence(scopes, selector, includeHidden);
      throw new Error(
        `No element matches ${selector.by}="${selector.value}". ${absence.note}`
      );
    }
    if (matches.length > 1 && index === undefined) {
      // Give the agent what it needs to choose: the candidates with
      // their rects, instead of a bare "pass an index" error
      return {
        ok: false,
        reason: "ambiguous",
        count: matches.length,
        truncated,
        candidates: await Promise.all(matches.slice(0, CANDIDATE_LIMIT).map(withIndex)),
        hint: "Pass index, narrow the selector, or scope it with within",
      };
    }
    const position = index ?? 0;
    /**
     * Out of range is a refusal, not a rounding. `Math.min(index, last)`
     * quietly acted on some other element and answered ok, which is the
     * one thing an automation tool must never do.
     */
    if (position >= matches.length) {
      return {
        ok: false,
        reason: "index-out-of-range",
        index: position,
        count: matches.length,
        truncated,
        candidates: await Promise.all(matches.slice(0, CANDIDATE_LIMIT).map(withIndex)),
        hint: truncated
          ? `index ${position} was asked for. The search stopped at ${matches.length} matches ` +
            `for ${selector.by}="${selector.value}" without reaching it: narrow the selector or ` +
            "scope it with within."
          : `index ${position} was asked for, ${matches.length} element(s) match ` +
            `${selector.by}="${selector.value}". Valid indexes are 0 to ${matches.length - 1}.`,
      };
    }

    const target = matches[position];
    const beforeGeneration = tracker.generation;
    const typing = action === "type" || action === "clear";
    const expected = typing
      ? action === "clear" ? "" : String(payload.text ?? "")
      : null;
    const valueOf = (fiber: FiberLike | null): string | null => {
      const value = fiber ? propsOf(fiber)?.value : undefined;
      return typeof value === "string" ? value : null;
    };
    // Read BEFORE acting: after the commit this fiber holds the old props
    // by luck rather than by design, and luck is not a contract
    const inputBefore = typing ? findTextInputFibers(target, 5).inputs[0] ?? null : null;
    const valueBefore = valueOf(inputBefore);
    const identityBefore = identityOf(inputBefore);

    const outcome = await performAct(target, {
      action,
      text: typeof payload.text === "string" ? payload.text : undefined,
      clear: payload.clear === true,
      x: Number(payload.x) || undefined,
      y: Number(payload.y) || undefined,
      dx: Number(payload.dx) || undefined,
      dy: Number(payload.dy) || undefined,
    });

    /**
     * Typing goes through onChangeText, so the new value only exists after
     * React commits. Waiting is not enough: on commit React swaps to the
     * fiber's alternate, so the reference held here keeps the OLD props and
     * reports the value from before the edit. The selector has to be run
     * again, WITH THE SAME SCOPE AND THE SAME LIMIT, to reach the fresh
     * fiber at the same position.
     */
    let freshMatch: FiberLike | null = target;
    let actedOn: FiberLike | null = outcome.acted;
    let drifted = false;
    if (typing) {
      await new Promise((resolve) => setTimeout(resolve, COMMIT_SETTLE_MS));
      try {
        freshMatch = collect().matches[position] ?? null;
      } catch {
        freshMatch = null; // the screen may have gone: reported below, not thrown
      }
      const resolved = freshMatch ? findTextInputFibers(freshMatch, 5).inputs : [];
      /**
       * A count that is still one proves nothing: a row can unmount, a
       * list can reorder, a field can appear above, and this position then
       * holds ANOTHER input whose value would be read back as if it were
       * the one that was typed into. Compare what the element is, not how
       * many there are.
       */
      const same = resolved.length === 1 && identityOf(resolved[0]) === identityBefore;
      drifted = Boolean(freshMatch) && !same;
      actedOn = same ? resolved[0] : null;
    }

    const valueAfter = typing ? valueOf(actedOn) : null;
    const described = actedOn ?? freshMatch;
    /**
     * `committed` only ever said "React rendered something", which any
     * root committing anywhere makes true. What an agent needs to know is
     * whether the text reached the field, so read it back and say.
     */
    let verified: string | null = null;
    let note: string | null = null;
    if (typing) {
      if (!described) {
        verified = "unverifiable";
        note = "The element is gone after the action (navigation, unmount): nothing left to read back.";
      } else if (drifted) {
        verified = "unverifiable";
        note = "The element at this position no longer resolves to a single input: the screen changed under the action.";
      } else if (valueAfter === expected) {
        verified = "exact";
      } else if (valueAfter === null) {
        verified = "unverifiable";
        note =
          "This input is uncontrolled (no value prop), so its content cannot be read back from React. " +
          "The keystrokes were delivered; confirm with a screenshot or bind value to state.";
      } else if (valueAfter !== valueBefore) {
        verified = "transformed";
        note =
          `The input now holds ${JSON.stringify(valueAfter)} instead of ${JSON.stringify(expected)}: ` +
          "the app transformed it (mask, maxLength, trim, uppercase).";
      } else {
        return {
          ok: false,
          reason: "value-unchanged",
          action,
          generation: tracker.generation,
          committed: tracker.generation > beforeGeneration,
          expected,
          value: valueAfter,
          detail: outcome.detail,
          target: await describeMatch(described ?? target),
          hint:
            "The text was delivered to the input's props but its value did not change. Its onChangeText " +
            "probably does not write back to the value it renders (unwired state, controlled value from " +
            "elsewhere, or a debounce that has not fired yet).",
        };
      }
    }

    return {
      ok: true,
      generation: tracker.generation,
      committed: tracker.generation > beforeGeneration,
      action,
      detail: outcome.detail,
      execution: {
        mode: action === "tap" || action === "longPress" ? "js-handler" : "runtime-command",
        nativeGesture: false,
      },
      /** The element the SELECTOR matched */
      target: await describeMatch(freshMatch ?? target),
      /**
       * Where the action really landed when it was not the match itself:
       * the input inside the container, the Pressable above the view.
       * Silence here is what let a typo in a selector look like a bug in
       * the app.
       */
      ...(outcome.from === "self" || !actedOn
        ? {}
        : { actedOn: { ...(await describeMatch(actedOn)), relation: outcome.from } }),
      ...(outcome.extra ? { result: outcome.extra } : {}),
      ...(verified ? { verified } : {}),
      ...(note ? { note } : {}),
      ...(truncated ? { truncated: true } : {}),
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
