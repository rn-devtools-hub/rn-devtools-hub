/**
 * UI automation tests: fiber walking, selectors and actions on
 * hand-built fiber trees (no React needed), plus the command wiring
 * through a fake React DevTools hook.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  FiberLike,
  UiNode,
  accessibleName,
  collectSubtreeText,
  fiberMatches,
  findHandler,
  findMeasurableInstance,
  findTextInputFiber,
  installUiAutomation,
  isHiddenSubtree,
  performAct,
  prettyHostType,
  queryFibers,
  serializeTree,
} from "../src/client/automation";

// ------------------------------------------------------------------
// Fake fiber builder: nested specs to child/sibling/return links
// ------------------------------------------------------------------

interface Spec {
  /** Host type string, or a function for a composite component */
  type?: unknown;
  props?: Record<string, unknown>;
  /** Shorthand: adds a HostText child holding this string */
  text?: string;
  stateNode?: unknown;
  children?: Spec[];
}

const Composite = function Composite(): null { return null; };

const fiberFrom = (spec: Spec, parent: FiberLike | null = null): FiberLike => {
  const fiber: FiberLike = {
    type: spec.type ?? Composite,
    memoizedProps: spec.props ?? {},
    stateNode: spec.stateNode ?? null,
    child: null,
    sibling: null,
    return: parent,
  };
  const children: FiberLike[] = [];
  if (spec.text !== undefined) {
    children.push({ tag: 6, memoizedProps: spec.text, child: null, sibling: null, return: fiber });
  }
  for (const childSpec of spec.children ?? []) {
    children.push(fiberFrom(childSpec, fiber));
  }
  for (let index = 0; index < children.length; index += 1) {
    if (index === 0) fiber.child = children[index];
    else children[index - 1].sibling = children[index];
  }
  return fiber;
};

const rootOf = (spec: Spec): FiberLike => {
  const root: FiberLike = { child: null, sibling: null, return: null };
  root.child = fiberFrom(spec, root);
  return root;
};

// ------------------------------------------------------------------
// Serialization
// ------------------------------------------------------------------

describe("serializeTree", () => {
  it("keeps host components, resolves aliases and aggregates text", () => {
    const root = rootOf({
      type: "RCTView",
      props: { testID: "loginScreen" },
      children: [
        { type: Composite, children: [{ type: "RCTText", text: "Welcome back" }] },
        {
          type: "AndroidTextInput",
          props: { testID: "loginEmail", placeholder: "Email", value: "a@b.c", editable: true },
        },
      ],
    });
    const { nodes, truncated } = serializeTree(root);
    expect(truncated).toBe(false);
    expect(nodes).toHaveLength(1);
    const screen = nodes[0];
    expect(screen.type).toBe("View");
    expect(screen.testID).toBe("loginScreen");
    const [text, input] = screen.children ?? [];
    expect(text).toMatchObject({ type: "Text", text: "Welcome back" });
    expect(input).toMatchObject({
      type: "TextInput",
      testID: "loginEmail",
      placeholder: "Email",
      value: "a@b.c",
      editable: true,
    });
  });

  it("collapses pyramids of purely structural views", () => {
    const root = rootOf({
      type: "RCTView",
      children: [{
        type: "RCTView",
        children: [{ type: "RCTView", props: { testID: "content" } }],
      }],
    });
    const { nodes } = serializeTree(root);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].testID).toBe("content");
    expect(nodes[0].collapsed).toBe(2);
  });

  it("marks truncation when the node budget is exceeded", () => {
    const root = rootOf({
      type: "RCTView",
      children: Array.from({ length: 30 }, () => ({ type: "RCTView", props: { testID: "x" } })),
    });
    const { nodes, truncated } = serializeTree(root, { maxNodes: 10 });
    expect(truncated).toBe(true);
    expect(nodes.length).toBeLessThanOrEqual(10);
  });

  it("exposes native views without accessibility, like a MapView", () => {
    const root = rootOf({
      type: "RCTView",
      children: [{ type: "AIRMap", props: { testID: "homeMap" } }],
    });
    const { nodes } = serializeTree(root);
    const map = nodes[0].children?.[0] ?? nodes[0];
    expect(map).toMatchObject({ type: "AIRMap", testID: "homeMap" });
  });
});

describe("collectSubtreeText", () => {
  it("aggregates nested host text", () => {
    const fiber = fiberFrom({
      type: "RCTText",
      children: [
        { type: "RCTText", text: "1000 " },
        { type: "RCTText", text: "HTG" },
      ],
    });
    expect(collectSubtreeText(fiber)).toBe("1000 HTG");
  });

  it("reads react-dom style string children", () => {
    const fiber = fiberFrom({ type: "span", children: [{ type: "b", props: { children: "web text" } }] });
    expect(collectSubtreeText(fiber)).toBe("web text");
  });
});

// ------------------------------------------------------------------
// Hidden screens: navigators keep previous screens mounted
// ------------------------------------------------------------------

describe("hidden navigator screens", () => {
  // A stack after Login -> Home: the Login card stays mounted but is
  // marked hidden by react-navigation / react-native-screens
  const stack = rootOf({
    type: "RCTView",
    children: [
      {
        type: "RNSScreen",
        props: { activityState: 0 },
        children: [{ type: "RCTText", text: "Se connecter" }],
      },
      {
        type: "RNSScreen",
        props: { activityState: 2 },
        children: [{ type: "RCTText", text: "Accueil" }],
      },
    ],
  });

  it("detects the signals set on inactive scenes", () => {
    expect(isHiddenSubtree(fiberFrom({ type: "RNSScreen", props: { activityState: 0 } }))).toBe(true);
    expect(isHiddenSubtree(fiberFrom({ type: "RNSScreen", props: { activityState: 2 } }))).toBe(false);
    expect(isHiddenSubtree(fiberFrom({ type: "RCTView", props: { importantForAccessibility: "no-hide-descendants" } }))).toBe(true);
    expect(isHiddenSubtree(fiberFrom({ type: "RCTView", props: { accessibilityElementsHidden: true } }))).toBe(true);
    expect(isHiddenSubtree(fiberFrom({ type: "RCTView", props: { style: [{ flex: 1 }, { display: "none" }] } }))).toBe(true);
    expect(isHiddenSubtree(fiberFrom({ type: "RCTView", props: { style: { display: "flex" } } }))).toBe(false);
  });

  it("serializes only the active screen after a navigation", () => {
    const { nodes, hiddenSubtrees } = serializeTree(stack);
    const text = JSON.stringify(nodes);
    expect(text).toContain("Accueil");
    expect(text).not.toContain("Se connecter");
    expect(hiddenSubtrees).toBe(1);
  });

  it("selectors ignore the previous screen unless includeHidden", () => {
    expect(queryFibers(stack, { by: "text", value: "Se connecter" })).toHaveLength(0);
    expect(queryFibers(stack, { by: "text", value: "Accueil" })).toHaveLength(1);
    expect(queryFibers(stack, { by: "text", value: "Se connecter" }, 10, true)).toHaveLength(1);
  });

  it("keeps hidden screens when includeHidden is set on the tree", () => {
    const { nodes, hiddenSubtrees } = serializeTree(stack, { includeHidden: true });
    expect(JSON.stringify(nodes)).toContain("Se connecter");
    expect(hiddenSubtrees).toBe(0);
  });
});

// ------------------------------------------------------------------
// Selectors
// ------------------------------------------------------------------

describe("queryFibers", () => {
  const tree = rootOf({
    type: "RCTView",
    children: [
      { type: "AndroidTextInput", props: { testID: "loginEmail", accessibilityLabel: "Email address" } },
      { type: "RCTText", text: "Se connecter" },
      { type: "RCTText", text: "Mot de passe oublie" },
    ],
  });

  it("finds by testID", () => {
    const matches = queryFibers(tree, { by: "testID", value: "loginEmail" });
    expect(matches).toHaveLength(1);
    expect(prettyHostType(String(matches[0].type))).toBe("TextInput");
  });

  it("finds by label", () => {
    expect(queryFibers(tree, { by: "label", value: "Email address" })).toHaveLength(1);
  });

  it("finds by text, substring by default and exact on demand", () => {
    expect(queryFibers(tree, { by: "text", value: "connecter" })).toHaveLength(1);
    expect(queryFibers(tree, { by: "text", value: "connecter", exact: true })).toHaveLength(0);
    expect(queryFibers(tree, { by: "text", value: "Se connecter", exact: true })).toHaveLength(1);
  });

  it("finds by type through aliases", () => {
    expect(queryFibers(tree, { by: "type", value: "TextInput" })).toHaveLength(1);
    expect(queryFibers(tree, { by: "type", value: "AndroidTextInput" })).toHaveLength(1);
  });

  it("ignores composite fibers", () => {
    const composite = fiberFrom({ type: Composite, props: { testID: "ghost" } });
    expect(fiberMatches(composite, { by: "testID", value: "ghost" })).toBe(false);
  });
});

describe("role selector and within scoping", () => {
  const screen = rootOf({
    type: "RCTView",
    children: [
      {
        type: "RCTView",
        props: { testID: "tabBar" },
        children: [{
          type: "RCTView",
          props: { accessibilityRole: "button", accessibilityLabel: "Colis" },
          children: [{ type: "RCTText", text: "Colis" }],
        }],
      },
      {
        type: "RCTView",
        props: { testID: "packageList" },
        children: [
          { type: "RCTText", text: "Colis SPX-1" },
          { type: "RCTView", props: { role: "button" }, children: [{ type: "RCTText", text: "Suivre" }] },
        ],
      },
    ],
  });

  it("finds by role and accessible name", () => {
    const matches = queryFibers(screen, { by: "role", value: "button", name: "Colis" });
    expect(matches).toHaveLength(1);
    expect(accessibleName(matches[0])).toBe("Colis");
  });

  it("uses rendered text as the accessible name when there is no label", () => {
    const matches = queryFibers(screen, { by: "role", value: "button", name: "Suivre" });
    expect(matches).toHaveLength(1);
  });

  it("matches the ARIA-style role prop too", () => {
    expect(queryFibers(screen, { by: "role", value: "button" })).toHaveLength(2);
  });

  it("bridges ARIA and legacy role names through aliases", () => {
    const tree = rootOf({
      type: "RCTView",
      children: [
        { type: "RCTImageView", props: { accessibilityRole: "image" } },
        { type: "RCTText", props: { role: "heading" }, text: "Mes colis" },
      ],
    });
    expect(queryFibers(tree, { by: "role", value: "img" })).toHaveLength(1);
    expect(queryFibers(tree, { by: "role", value: "image" })).toHaveLength(1);
    expect(queryFibers(tree, { by: "role", value: "header" })).toHaveLength(1);
  });

  it("gives Text hosts an implicit text role, like Testing Library", () => {
    const tree = rootOf({ type: "RCTText", text: "Statut" });
    expect(queryFibers(tree, { by: "role", value: "text", name: "Statut" })).toHaveLength(1);
  });

  it("within restricts the scope to a container", async () => {
    const globalAny = globalThis as Record<string, any>;
    globalAny.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {};
    const handlers = new Map<string, (payload: unknown) => Promise<unknown> | unknown>();
    installUiAutomation({
      onCommand: (command, handler) => handlers.set(command, handler),
      emit: () => {},
    });
    globalAny.__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot(1, { current: screen });

    const everywhere = await handlers.get("ui.query")!({ by: "text", value: "Colis" }) as { count: number };
    const scoped = await handlers.get("ui.query")!({
      by: "text", value: "Colis", within: { by: "testID", value: "packageList" },
    }) as { count: number; matches: Array<{ text: string | null }> };
    expect(everywhere.count).toBeGreaterThan(scoped.count);
    expect(scoped.count).toBe(1);
    expect(scoped.matches[0].text).toBe("Colis SPX-1");
    delete globalAny.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  });
});

describe("findMeasurableInstance", () => {
  const measurer = { measureInWindow: (cb: (x: number, y: number, w: number, h: number) => void) => cb(1, 2, 3, 4) };

  it("falls back to a measurable ancestor for virtual text nodes", () => {
    const tree = rootOf({
      type: "RCTView",
      stateNode: measurer,
      children: [{ type: "RCTText", text: "LIVRE" }],
    });
    const [text] = queryFibers(tree, { by: "text", value: "LIVRE" });
    expect(findMeasurableInstance(text)).toBe(measurer);
  });

  it("prefers the element's own subtree instance", () => {
    const own = { measureInWindow: () => {} };
    const tree = rootOf({
      type: "RCTView",
      stateNode: measurer,
      children: [{ type: "RCTText", text: "LIVRE", stateNode: own }],
    });
    const [text] = queryFibers(tree, { by: "text", value: "LIVRE" });
    expect(findMeasurableInstance(text)).toBe(own);
  });
});

// ------------------------------------------------------------------
// Actions
// ------------------------------------------------------------------

describe("performAct", () => {
  it("taps through a handler carried by a composite ancestor", () => {
    const events: unknown[] = [];
    const tree = rootOf({
      type: Composite,
      props: { onPress: (event: unknown) => events.push(event) },
      children: [{ type: "RCTView", children: [{ type: "RCTText", text: "Se connecter" }] }],
    });
    const [target] = queryFibers(tree, { by: "text", value: "Se connecter" });
    const outcome = performAct(target, { action: "tap" });
    expect(outcome.detail).toBe("onPress invoked");
    expect(events).toHaveLength(1);
  });

  it("types the exact text, clearing first when asked", () => {
    const typed: string[] = [];
    const tree = rootOf({
      type: "RCTView",
      children: [{
        type: "AndroidTextInput",
        props: { testID: "loginEmail", onChangeText: (text: string) => typed.push(text) },
      }],
    });
    const [target] = queryFibers(tree, { by: "testID", value: "loginEmail" });
    performAct(target, { action: "type", text: "Customer@test.com", clear: true });
    expect(typed).toEqual(["", "Customer@test.com"]);
  });

  it("finds the input inside a matched wrapper", () => {
    const typed: string[] = [];
    const tree = rootOf({
      type: "RCTView",
      props: { testID: "searchBox" },
      children: [{
        type: "RCTSinglelineTextInputView",
        props: { onChangeText: (text: string) => typed.push(text) },
      }],
    });
    const [target] = queryFibers(tree, { by: "testID", value: "searchBox" });
    performAct(target, { action: "type", text: "SPX-4821" });
    expect(typed).toEqual(["SPX-4821"]);
  });

  it("submits through onSubmitEditing", () => {
    const submitted: unknown[] = [];
    const tree = rootOf({
      type: "AndroidTextInput",
      props: { value: "SPX-4821", onSubmitEditing: (event: unknown) => submitted.push(event) },
    });
    const [target] = queryFibers(tree, { by: "type", value: "TextInput" });
    performAct(target, { action: "submit" });
    expect(submitted).toHaveLength(1);
  });

  it("fails with a clear error when no handler exists", () => {
    const tree = rootOf({ type: "RCTView", props: { testID: "static" } });
    const [target] = queryFibers(tree, { by: "testID", value: "static" });
    expect(() => performAct(target, { action: "tap" })).toThrow(/No onPress handler/);
  });
});

describe("findHandler and findTextInputFiber", () => {
  it("prefers the closest descendant handler", () => {
    const calls: string[] = [];
    const tree = fiberFrom({
      type: "RCTView",
      children: [{ type: Composite, props: { onPress: () => calls.push("inner") } }],
    });
    findHandler(tree, ["onPress"])?.({});
    expect(calls).toEqual(["inner"]);
  });

  it("climbs to an ancestor input when matching a nested label", () => {
    const tree = rootOf({
      type: "AndroidTextInput",
      props: { onChangeText: () => {} },
      children: [{ type: "RCTText", text: "inside" }],
    });
    const [label] = queryFibers(tree, { by: "text", value: "inside" });
    expect(findTextInputFiber(label)).not.toBeNull();
  });
});

// ------------------------------------------------------------------
// Command wiring through a fake React DevTools hook
// ------------------------------------------------------------------

describe("installUiAutomation", () => {
  const globalAny = globalThis as Record<string, any>;

  afterEach(() => {
    delete globalAny.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  });

  const install = () => {
    const handlers = new Map<string, (payload: unknown) => Promise<unknown> | unknown>();
    const emitted: Array<{ type: string; payload: unknown }> = [];
    installUiAutomation({
      onCommand: (command, handler) => handlers.set(command, handler),
      emit: (type, payload) => emitted.push({ type, payload }),
    });
    return { handlers, emitted };
  };

  it("serves ui.tree from roots observed on commit", async () => {
    globalAny.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {};
    const { handlers } = install();
    const hook = globalAny.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    const fiberRoot = { current: rootOf({ type: "RCTView", props: { testID: "home" } }) };
    hook.onCommitFiberRoot(1, fiberRoot);

    const result = await handlers.get("ui.tree")!({}) as { roots: UiNode[][]; generation: number };
    expect(result.generation).toBe(1);
    expect(result.roots[0][0].testID).toBe("home");
  });

  it("returns the candidates with details on ambiguous ui.act targets", async () => {
    globalAny.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {};
    const { handlers } = install();
    const hook = globalAny.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    hook.onCommitFiberRoot(1, {
      current: rootOf({
        type: "RCTView",
        children: [
          { type: "RCTText", text: "Suivre" },
          { type: "RCTText", text: "Suivre" },
        ],
      }),
    });

    const result = await handlers.get("ui.act")!({
      action: "tap", by: "text", value: "Suivre",
    }) as { ok: boolean; reason: string; count: number; candidates: unknown[] };
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("ambiguous");
    expect(result.count).toBe(2);
    expect(result.candidates).toHaveLength(2);
  });

  it("fails with a typed error when the hook is missing", () => {
    const { handlers } = install();
    expect(() => handlers.get("ui.tree")!({})).toThrow(/hook unavailable/);
  });
});
