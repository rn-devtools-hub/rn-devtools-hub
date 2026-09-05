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
  describeAbsence,
  fiberMatches,
  findHandler,
  findMeasurableInstance,
  findShadowNode,
  findTextInputFiber,
  findTextInputFibers,
  installUiAutomation,
  isHiddenSubtree,
  measureFiberDetailed,
  performAct,
  prettyHostType,
  publicInstanceOf,
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

type MeasureCallback = (x: number, y: number, width: number, height: number) => void;

/** Installs a fake Fabric UIManager for the duration of the run. Awaits
 * the result before restoring it: the measurement paths are async, and a
 * global restored one tick too early leaves them measuring nothing. */
const withFabric = async <T,>(
  uiManager: unknown,
  run: () => T | Promise<T>,
): Promise<T> => {
  const key = "nativeFabricUIManager";
  const previous = (globalThis as Record<string, unknown>)[key];
  (globalThis as Record<string, unknown>)[key] = uiManager;
  try {
    return await run();
  } finally {
    (globalThis as Record<string, unknown>)[key] = previous;
  }
};

/** A Fabric UIManager that only knows the shadow nodes it was given */
const fabricMeasuring = (
  rects: Array<[unknown, [number, number, number, number]]>,
): Record<string, unknown> => ({
  measureInWindow: (node: unknown, callback: MeasureCallback) => {
    const found = rects.find(([shadow]) => shadow === node);
    if (found) callback(...found[1]);
  },
});

/**
 * A form of `count` TextInputs, each distinguishable by its placeholder
 * and each recording what it was asked to hold. `transform` returns what
 * the app writes back into the value it renders, or null for an app that
 * writes nothing back.
 */
const formOf = (
  count: number,
  writes: Array<[number, string]>,
  transform: (text: string) => string | null = (text) => text,
): Spec => ({
  type: "RCTView",
  props: { testID: "form" },
  children: Array.from({ length: count }, (_unused, index) => {
    const props: Record<string, unknown> = { placeholder: `F${index}`, value: "" };
    props.onChangeText = (text: string) => {
      writes.push([index, text]);
      const next = transform(text);
      if (next !== null) props.value = next;
    };
    return { type: "AndroidTextInput", props };
  }),
});

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

/**
 * The selector a bare form actually needs: a TextInput with neither
 * testID nor accessibilityLabel left the index as the only handle, which
 * is the fragile path this whole file exists to remove.
 */
describe("placeholder selector", () => {
  const form = rootOf({
    type: "RCTView",
    children: [
      { type: "AndroidTextInput", props: { placeholder: "Numero de suivi" } },
      { type: "AndroidTextInput", props: { placeholder: "Numero de telephone" } },
    ],
  });

  it("matches a substring by default and an equality with exact", () => {
    expect(queryFibers(form, { by: "placeholder", value: "Numero" })).toHaveLength(2);
    expect(queryFibers(form, { by: "placeholder", value: "suivi" })).toHaveLength(1);
    expect(queryFibers(form, { by: "placeholder", value: "Numero", exact: true })).toHaveLength(0);
    expect(
      queryFibers(form, { by: "placeholder", value: "Numero de suivi", exact: true })
    ).toHaveLength(1);
  });

  it("ignores an element that carries no placeholder at all", () => {
    const text = fiberFrom({ type: "RCTText", text: "Numero de suivi" });
    expect(fiberMatches(text, { by: "placeholder", value: "Numero" })).toBe(false);
  });

  it("explains a screen without placeholders instead of printing undefined", () => {
    const bare = rootOf({
      type: "RCTView",
      children: [{ type: "RCTText", text: "Accueil" }],
    });
    const absence = describeAbsence([bare], { by: "placeholder", value: "Email" });
    expect(absence.reason).toBe("attribute-absent");
    expect(absence.note).toContain("placeholder");
    expect(absence.note).not.toContain("undefined");
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

// ------------------------------------------------------------------
// Empty answers: nothing observed vs nothing observable
// ------------------------------------------------------------------

describe("describeAbsence", () => {
  const screen = () => rootOf({
    type: "RCTView",
    props: { testID: "signIn" },
    children: [
      { type: "RCTText", text: "Se connecter" },
      { type: "RCTView", props: { testID: "submit", onPress: () => {} } },
    ],
  });

  it("says an app exposing no role will answer zero to every role query", () => {
    const absence = describeAbsence([screen()], { by: "role", value: "button" });
    expect(absence.reason).toBe("attribute-absent");
    expect(absence.note).toMatch(/this app exposes no roles/);
    // The implicit "text" role of a Text host must not count as a
    // declared role, or the diagnostic never fires on a real screen
    expect(absence.note).toMatch(/implicit "text" role/);
  });

  it("lists the values present when the attribute exists but the value does not", () => {
    const absence = describeAbsence([screen()], { by: "testID", value: "logout" });
    expect(absence.reason).toBe("value-absent");
    expect(absence.present).toContain("submit");
    expect(absence.present).toContain("signIn");
  });

  it("separates a missing accessible name from a missing role", () => {
    const root = rootOf({
      type: "RCTView",
      children: [
        { type: "RCTView", props: { accessibilityRole: "button", accessibilityLabel: "Valider" } },
      ],
    });
    const absence = describeAbsence([root], { by: "role", value: "button", name: "Annuler" });
    expect(absence.reason).toBe("name-absent");
    expect(absence.present).toEqual(["Valider"]);
  });

  it("counts the implicit text role like the selector does once a role is declared", () => {
    const root = rootOf({
      type: "RCTView",
      children: [
        { type: "RCTView", props: { accessibilityRole: "button" } },
        { type: "RCTText", text: "Se connecter" },
      ],
    });
    const absence = describeAbsence([root], { by: "role", value: "header" });
    expect(absence.reason).toBe("value-absent");
    expect(absence.present).toEqual(expect.arrayContaining(["button", "text"]));
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
  it("taps through a handler carried by a composite ancestor", async () => {
    const events: unknown[] = [];
    const tree = rootOf({
      type: Composite,
      props: { onPress: (event: unknown) => events.push(event) },
      children: [{ type: "RCTView", children: [{ type: "RCTText", text: "Se connecter" }] }],
    });
    const [target] = queryFibers(tree, { by: "text", value: "Se connecter" });
    const outcome = await performAct(target, { action: "tap" });
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

  it("fails with a clear error when no handler exists", async () => {
    const tree = rootOf({ type: "RCTView", props: { testID: "static" } });
    const [target] = queryFibers(tree, { by: "testID", value: "static" });
    await expect(performAct(target, { action: "tap" })).rejects.toThrow(/No onPress handler/);
  });

  // A form row or a card matches as a container, and picking the first
  // input inside it wrote into whichever one the traversal reached first
  it("refuses to choose between the inputs held by a matched container", async () => {
    const tree = rootOf({
      type: "RCTView",
      props: { testID: "credentials" },
      children: [
        { type: "AndroidTextInput", props: { placeholder: "Email", onChangeText: () => {} } },
        { type: "AndroidTextInput", props: { placeholder: "Mot de passe", onChangeText: () => {} } },
      ],
    });
    const [row] = queryFibers(tree, { by: "testID", value: "credentials" });
    await expect(performAct(row, { action: "type", text: "x" })).rejects.toThrow(
      /Ambiguous type target[\s\S]*"Email", "Mot de passe"/
    );
  });

  it("writes into the host input a wrapper renders, not into the wrapper handler", async () => {
    const wrapper: string[] = [];
    const host: string[] = [];
    const tree = rootOf({
      type: "RCTView",
      props: { testID: "field" },
      children: [{
        type: Composite,
        props: { onChangeText: (text: string) => wrapper.push(text) },
        children: [{
          type: "AndroidTextInput",
          props: { placeholder: "Suivi", onChangeText: (text: string) => host.push(text) },
        }],
      }],
    });
    const [field] = queryFibers(tree, { by: "testID", value: "field" });
    const outcome = await performAct(field, { action: "type", text: "SPX-4821" });
    expect(host).toEqual(["SPX-4821"]);
    expect(wrapper).toEqual([]);
    expect(outcome.from).toBe("descendant");
  });

  it("refuses a read-only input instead of reporting a keystroke it never delivered", async () => {
    const tree = rootOf({
      type: "AndroidTextInput",
      props: { placeholder: "Total", editable: false, onChangeText: () => {} },
    });
    const [input] = queryFibers(tree, { by: "type", value: "TextInput" });
    await expect(performAct(input, { action: "type", text: "9" })).rejects.toThrow(
      /is not editable/
    );
  });

  it("types through the Fabric public instance, not the raw state node", async () => {
    const applied: unknown[] = [];
    const publicInstance = { setNativeProps: (props: unknown) => applied.push(props) };
    const input = {
      type: "AndroidTextInput",
      memoizedProps: { placeholder: "Suivi" },
      stateNode: { node: {}, canonical: { publicInstance } },
    } as FiberLike;
    const outcome = await performAct(input, { action: "type", text: "SPX-4821" });
    expect(applied).toEqual([{ text: "SPX-4821" }]);
    expect(outcome.extra).toMatchObject({ via: "native" });
  });

  // {node, canonical} carries no method at all: calling setNativeProps on
  // it did nothing and the answer still said the text had been typed
  it("says nothing could be typed rather than reporting a Fabric no-op as success", async () => {
    const input = {
      type: "AndroidTextInput",
      memoizedProps: { placeholder: "Suivi" },
      stateNode: { node: {}, canonical: { publicInstance: null } },
    } as FiberLike;
    await expect(performAct(input, { action: "type", text: "SPX-4821" })).rejects.toThrow(
      /Nothing to type into "Suivi"/
    );
  });
});

describe("findTextInputFibers", () => {
  const placeholderOf = (fiber: FiberLike): unknown =>
    (fiber.memoizedProps as Record<string, unknown>).placeholder;

  it("counts a wrapper component and the host input it renders as one field", () => {
    const tree = rootOf({
      type: "RCTView",
      props: { testID: "field" },
      children: [{
        type: Composite,
        props: { onChangeText: () => {} },
        children: [{ type: "AndroidTextInput", props: { placeholder: "Suivi", onChangeText: () => {} } }],
      }],
    });
    const [field] = queryFibers(tree, { by: "testID", value: "field" });
    const { inputs, from } = findTextInputFibers(field);
    expect(inputs).toHaveLength(1);
    expect(from).toBe("descendant");
    // The host input is the one whose onChangeText the keyboard would fire
    expect(String(inputs[0].type)).toBe("AndroidTextInput");
    expect(placeholderOf(inputs[0])).toBe("Suivi");
  });

  it("returns every reachable input so an ambiguous target can be refused", () => {
    const tree = rootOf({
      type: "RCTView",
      props: { testID: "credentials" },
      children: [
        { type: "AndroidTextInput", props: { placeholder: "Email" } },
        { type: "AndroidTextInput", props: { placeholder: "Mot de passe" } },
      ],
    });
    const [row] = queryFibers(tree, { by: "testID", value: "credentials" });
    const { inputs } = findTextInputFibers(row);
    expect(inputs.map(placeholderOf)).toEqual(["Email", "Mot de passe"]);
  });
});

describe("publicInstanceOf", () => {
  // The wrapper has no setNativeProps, no focus and no scrollTo: handing
  // it back is how an action that never happened was reported as done
  it("never hands back the Fabric {node, canonical} wrapper as an instance", () => {
    const publicInstance = { setNativeProps: () => {}, scrollTo: () => {} };
    const withInstance = { type: "RCTScrollView", stateNode: { node: {}, canonical: { publicInstance } } } as FiberLike;
    expect(publicInstanceOf(withInstance)).toBe(publicInstance);

    const notCreatedYet = { type: "RCTScrollView", stateNode: { node: {}, canonical: {} } } as FiberLike;
    expect(publicInstanceOf(notCreatedYet)).toBeNull();
  });

  it("returns the state node itself on the old architecture", () => {
    const instance = { setNativeProps: () => {} };
    expect(publicInstanceOf({ type: "RCTView", stateNode: instance } as FiberLike)).toBe(instance);
    expect(publicInstanceOf({ type: "RCTView", stateNode: null } as FiberLike)).toBeNull();
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

  /** Mounts a tree and returns the command handlers bound to it */
  const mount = (spec: Spec) => {
    globalAny.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {};
    const { handlers } = install();
    globalAny.__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot(1, { current: rootOf(spec) });
    return handlers;
  };

  type Handlers = ReturnType<typeof mount>;
  const act = (handlers: Handlers, payload: Record<string, unknown>): Promise<any> =>
    Promise.resolve(handlers.get("ui.act")!(payload)) as Promise<any>;
  const query = (handlers: Handlers, payload: Record<string, unknown>): Promise<any> =>
    Promise.resolve(handlers.get("ui.query")!(payload)) as Promise<any>;

  it("labels handler invocation without claiming a native gesture", async () => {
    let pressed = 0;
    const handlers = mount({ type: "RCTView", props: { testID: "submit", onPress: () => { pressed++; } } });
    const result = await act(handlers, { action: "tap", by: "testID", value: "submit" });
    expect(pressed).toBe(1);
    expect(result.execution).toEqual({ mode: "js-handler", nativeGesture: false });
  });

  /**
   * The defect: candidates were collected with a hard-coded limit of 5
   * while `index` was unbounded, then clamped with Math.min, and the
   * answer was rebuilt with a DIFFERENT limit. On a screen of 8 inputs,
   * index 6 typed into the fifth field and described the seventh.
   */
  it("types into the input at the requested index and describes that same one", async () => {
    const writes: Array<[number, string]> = [];
    const handlers = mount(formOf(8, writes));

    const result = await act(handlers, {
      action: "type", by: "type", value: "TextInput", index: 6, text: "x",
    });
    expect(result.ok).toBe(true);
    expect(writes).toEqual([[6, "x"]]);
    expect(result.target.placeholder).toBe("F6");
    expect(result.target.value).toBe("x");
    expect(result.verified).toBe("exact");
  });

  it("refuses an out-of-range index instead of clamping it onto another element", async () => {
    const writes: Array<[number, string]> = [];
    const handlers = mount(formOf(8, writes));

    const result = await act(handlers, {
      action: "type", by: "type", value: "TextInput", index: 12, text: "x",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("index-out-of-range");
    expect(result.index).toBe(12);
    expect(result.count).toBe(8);
    expect(result.candidates).toHaveLength(8);
    expect(result.hint).toContain("Valid indexes are 0 to 7");
    // Refusing means doing nothing at all, not doing it somewhere else
    expect(writes).toEqual([]);
  });

  it("rejects an index that is not a non-negative integer", async () => {
    const writes: Array<[number, string]> = [];
    const handlers = mount(formOf(8, writes));
    const payload = { action: "type", by: "type", value: "TextInput", text: "x" };

    await expect(act(handlers, { ...payload, index: 1.5 })).rejects.toThrow(
      /index must be a non-negative integer/
    );
    await expect(act(handlers, { ...payload, index: -1 })).rejects.toThrow(
      /index must be a non-negative integer/
    );
    expect(writes).toEqual([]);
  });

  /**
   * The re-read that follows a keystroke used to restart from every root
   * and ignore `within`, so it described the first field of the screen
   * instead of the one inside the scoped container.
   */
  it("keeps the within scope when reading the value back after typing", async () => {
    const writes: Array<[string, string]> = [];
    const field = (testID: string, initial: string, controlled: boolean): Spec => {
      const props: Record<string, unknown> = { testID, placeholder: "Shared", value: initial };
      props.onChangeText = (text: string) => {
        writes.push([testID, text]);
        if (controlled) props.value = text;
      };
      return { type: "AndroidTextInput", props };
    };
    const handlers = mount({
      type: "RCTView",
      children: [
        { type: "RCTView", props: { testID: "cardA" }, children: [field("inputA", "A-value", false)] },
        { type: "RCTView", props: { testID: "cardB" }, children: [field("inputB", "", true)] },
      ],
    });

    const result = await act(handlers, {
      action: "type",
      by: "placeholder",
      value: "Shared",
      within: { by: "testID", value: "cardB" },
      text: "typed",
    });
    expect(writes).toEqual([["inputB", "typed"]]);
    expect(result.target.testID).toBe("inputB");
    expect(result.verified).toBe("exact");
  });

  it("reports a value the app rewrote as transformed, not as typed", async () => {
    const writes: Array<[number, string]> = [];
    const handlers = mount(formOf(2, writes, (text) => text.slice(0, 4)));

    const result = await act(handlers, {
      action: "type", by: "placeholder", value: "F1", text: "123456789",
    });
    expect(result.ok).toBe(true);
    expect(result.verified).toBe("transformed");
    expect(result.target.value).toBe("1234");
    expect(result.note).toContain("1234");
  });

  it("says the value is unverifiable on an input that is not controlled", async () => {
    const typed: string[] = [];
    const handlers = mount({
      type: "AndroidTextInput",
      props: { placeholder: "Suivi", onChangeText: (text: string) => typed.push(text) },
    });

    const result = await act(handlers, {
      action: "type", by: "placeholder", value: "Suivi", text: "SPX-4821",
    });
    expect(typed).toEqual(["SPX-4821"]);
    expect(result.ok).toBe(true);
    expect(result.verified).toBe("unverifiable");
    expect(result.note).toContain("uncontrolled");
  });

  // "committed" only ever meant "React rendered something somewhere"
  it("refuses to call it typed when the value never moved", async () => {
    const writes: Array<[number, string]> = [];
    const handlers = mount(formOf(2, writes, () => null));

    const result = await act(handlers, {
      action: "type", by: "placeholder", value: "F0", text: "SPX-4821",
    });
    expect(writes).toEqual([[0, "SPX-4821"]]);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("value-unchanged");
    expect(result.expected).toBe("SPX-4821");
    expect(result.value).toBe("");
  });

  it("verifies a clear by reading the emptied value back", async () => {
    const writes: Array<[number, string]> = [];
    const handlers = mount(formOf(2, writes, (text) => text));
    await act(handlers, { action: "type", by: "placeholder", value: "F0", text: "SPX" });

    const result = await act(handlers, { action: "clear", by: "placeholder", value: "F0" });
    expect(result.ok).toBe(true);
    expect(result.verified).toBe("exact");
    expect(result.target.value).toBe("");
  });

  /**
   * A count capped by the limit and read as a total is exactly how an
   * agent computes an index that does not exist.
   */
  it("says a ui.query count was capped by the limit", async () => {
    const writes: Array<[number, string]> = [];
    const handlers = mount(formOf(8, writes));

    const capped = await query(handlers, { by: "type", value: "TextInput", limit: 3 });
    expect(capped.count).toBe(3);
    expect(capped.truncated).toBe(true);

    const whole = await query(handlers, { by: "type", value: "TextInput", limit: 20 });
    expect(whole.count).toBe(8);
    expect(whole.truncated).toBe(false);
  });

  it("selects by placeholder through the command payload", async () => {
    const writes: Array<[number, string]> = [];
    const handlers = mount(formOf(8, writes));

    const substring = await query(handlers, { by: "placeholder", value: "F" });
    expect(substring.count).toBe(8);
    const one = await query(handlers, { by: "placeholder", value: "F3", exact: true });
    expect(one.count).toBe(1);
    expect(one.matches[0].placeholder).toBe("F3");
  });

  it("names the input it typed into when the selector matched the container", async () => {
    const typed: string[] = [];
    const handlers = mount({
      type: "RCTView",
      props: { testID: "searchBox" },
      children: [{
        type: "AndroidTextInput",
        props: { placeholder: "Suivi", onChangeText: (text: string) => typed.push(text) },
      }],
    });

    const result = await act(handlers, {
      action: "type", by: "testID", value: "searchBox", text: "SPX-4821",
    });
    expect(typed).toEqual(["SPX-4821"]);
    expect(result.target.testID).toBe("searchBox");
    expect(result.actedOn.placeholder).toBe("Suivi");
    expect(result.actedOn.relation).toBe("descendant");
  });

  it("names the ancestor whose handler a tap actually fired", async () => {
    const presses: unknown[] = [];
    const handlers = mount({
      type: "RCTView",
      props: { testID: "card", onPress: (event: unknown) => presses.push(event) },
      children: [{ type: "RCTText", text: "Suivre" }],
    });

    const result = await act(handlers, { action: "tap", by: "text", value: "Suivre" });
    expect(presses).toHaveLength(1);
    expect(result.target.text).toBe("Suivre");
    expect(result.actedOn.testID).toBe("card");
    expect(result.actedOn.relation).toBe("ancestor");
  });

  it("stays silent about actedOn when the match is what received the action", async () => {
    const presses: unknown[] = [];
    const handlers = mount({
      type: "RCTView",
      props: { testID: "cta", onPress: (event: unknown) => presses.push(event) },
    });

    const result = await act(handlers, { action: "tap", by: "testID", value: "cta" });
    expect(presses).toHaveLength(1);
    expect(result).not.toHaveProperty("actedOn");
  });

  it("marks a rect measured on a neighbour and leaves the element's own unmarked", async () => {
    const scrollShadow = { scroll: true };
    const rowShadow = { row: true };
    const handlers = mount({
      type: "RCTScrollView",
      stateNode: { node: scrollShadow },
      children: [{
        type: "RCTView",
        props: { testID: "row0" },
        stateNode: { node: rowShadow },
        children: [{ type: "RCTText", text: "Ligne 0" }],
      }],
    });
    const fabric = fabricMeasuring([
      [scrollShadow, [0, 0, 400, 800]],
      [rowShadow, [0, 300, 400, 60]],
    ]);

    const row = await withFabric(fabric, () => query(handlers, { by: "testID", value: "row0" }));
    expect(row.matches[0].rect).toEqual({ x: 0, y: 300, width: 400, height: 60 });
    expect(row.matches[0]).not.toHaveProperty("rectFrom");

    const label = await withFabric(fabric, () => query(handlers, { by: "text", value: "Ligne 0" }));
    expect(label.matches[0].rect).toEqual({ x: 0, y: 300, width: 400, height: 60 });
    expect(label.matches[0].rectFrom).toBe("ancestor");
  });
});

/**
 * Measurement across architectures.
 *
 * On the old architecture the host fiber's stateNode IS the instance. On
 * Fabric it is not, and looking only there returns null for every element
 * on screen, which silently breaks the hit test and, with it, the
 * explanation attached to a visual diff. Found on a real Expo 56 app.
 */
/**
 * Raising the keyboard needs the native command, not a method call. On
 * Fabric the stateNode is `{ node, canonical }` with no methods, so
 * calling `.focus()` on it found nothing, did nothing, and still reported
 * success. Reported from a real Android device.
 */
describe("focus dispatch", () => {
  const withInput = (stateNode: unknown): FiberLike =>
    ({
      type: "AndroidTextInput",
      memoizedProps: { onChangeText: () => {} },
      stateNode,
    }) as FiberLike;

  it("calls the public instance when there is one", async () => {
    let called = "";
    const publicInstance = { focus: () => { called = "focus"; }, measureInWindow: () => {} };
    const result = await performAct(withInput({ node: {}, canonical: { publicInstance } }), {
      action: "focus",
    });
    expect(called).toBe("focus");
    expect(result.detail).toContain("public instance");
  });

  it("dispatches the command when Fabric has no public instance yet", async () => {
    const dispatched: unknown[] = [];
    const result = await withFabric(
      { dispatchCommand: (node: unknown, name: string) => dispatched.push([node, name]) },
      () => performAct(withInput({ node: { shadow: true }, canonical: { publicInstance: null } }), {
        action: "focus",
      })
    );
    expect(dispatched).toEqual([[{ shadow: true }, "focus"]]);
    expect(result.detail).toContain("dispatched");
  });

  it("blurs through the same path", async () => {
    const dispatched: string[] = [];
    await withFabric({ dispatchCommand: (_n: unknown, name: string) => dispatched.push(name) }, () =>
      performAct(withInput({ node: {}, canonical: { publicInstance: null } }), { action: "blur" })
    );
    expect(dispatched).toEqual(["blur"]);
  });

  // The defect being fixed: no path at all used to report success
  it("fails loudly when no path exists rather than claiming success", async () => {
    await expect(
      withFabric(undefined, () =>
        performAct(withInput({ node: {}, canonical: { publicInstance: null } }), { action: "focus" })
      )
    ).rejects.toThrow(/Could not focus/);
  });
});

describe("measurable instance", () => {
  const fiber = (stateNode: unknown): FiberLike =>
    ({ type: "RCTView", memoizedProps: {}, stateNode }) as FiberLike;

  it("finds the instance directly on the old architecture", () => {
    const instance = { measureInWindow: () => {} };
    expect(findMeasurableInstance(fiber(instance))).toBe(instance);
  });

  it("reaches through canonical.publicInstance on Fabric", () => {
    const publicInstance = { measureInWindow: () => {} };
    const found = findMeasurableInstance(
      fiber({ node: {}, canonical: { nativeTag: 1, publicInstance } })
    );
    expect(found).toBe(publicInstance);
  });

  it("returns null on a Fabric node whose public instance is not created yet", () => {
    expect(
      findMeasurableInstance(fiber({ node: {}, canonical: { nativeTag: 1, publicInstance: null } }))
    ).toBeNull();
  });

  it("exposes the shadow node so Fabric can measure without a public instance", () => {
    const shadow = { __shadow: true };
    expect(findShadowNode(fiber({ node: shadow, canonical: { publicInstance: null } }))).toBe(shadow);
  });

  it("climbs to an ancestor's shadow node when the fiber has none", () => {
    const shadow = { __shadow: true };
    const parent = { type: "RCTView", memoizedProps: {}, stateNode: { node: shadow } } as FiberLike;
    const child = { type: "RCTText", memoizedProps: {}, stateNode: null, return: parent } as FiberLike;
    expect(findShadowNode(child)).toBe(shadow);
  });

  it("returns null rather than a wrong node when nothing is measurable", () => {
    expect(findShadowNode(fiber(null))).toBeNull();
    expect(findMeasurableInstance(fiber(null))).toBeNull();
  });
});

/**
 * On the New Architecture the public instance is created lazily, so an
 * ordinary row has none: the measurement climbed to the enclosing
 * ScrollView and returned ITS box for every row, which reads as rects
 * that do not move after a scroll.
 */
describe("measureFiberDetailed", () => {
  const rowShadow = { row: true };
  const scrollBox = { measureInWindow: (callback: MeasureCallback) => callback(0, 0, 400, 800) };

  const list = (): FiberLike => rootOf({
    type: "RCTScrollView",
    stateNode: scrollBox,
    children: [{
      type: "RCTView",
      props: { testID: "row0" },
      stateNode: { node: rowShadow, canonical: { publicInstance: null } },
      children: [{ type: "RCTText", text: "Ligne 0" }],
    }],
  });

  it("keeps the element's own shadow rect instead of the enclosing ScrollView box", async () => {
    const [row] = queryFibers(list(), { by: "testID", value: "row0" });
    const measurement = await withFabric(
      fabricMeasuring([[rowShadow, [0, 300, 400, 60]]]),
      () => measureFiberDetailed(row),
    );
    expect(measurement).toEqual({
      rect: { x: 0, y: 300, width: 400, height: 60 },
      from: "self",
    });
  });

  it("says the rect is a neighbour's when the element has nothing of its own", async () => {
    const tree = rootOf({
      type: "RCTView",
      stateNode: scrollBox,
      children: [{ type: "RCTText", text: "LIVRE" }],
    });
    const [text] = queryFibers(tree, { by: "text", value: "LIVRE" });
    expect(await measureFiberDetailed(text)).toEqual({
      rect: { x: 0, y: 0, width: 400, height: 800 },
      from: "ancestor",
    });
  });

  /**
   * When the element has neither its own instance nor its own shadow
   * node, the walk must be ordered by DISTANCE and try both mechanisms at
   * each step. Ordering by mechanism instead let a ScrollView two steps up
   * win over the row one step up that knows exactly where it is, which is
   * the same "rect that does not move after a scroll" under another name.
   */
  it("prefers the closest ancestor over the closest measurable instance", async () => {
    const rowShadow = { row: true };
    const tree = rootOf({
      type: "RCTScrollView",
      stateNode: scrollBox,
      children: [{
        type: "RCTView",
        props: { testID: "row0" },
        stateNode: { node: rowShadow },
        children: [{ type: "RCTView", props: { testID: "badge" } }],
      }],
    });
    const [badge] = queryFibers(tree, { by: "testID", value: "badge" });
    const measurement = await withFabric(
      fabricMeasuring([[rowShadow, [0, 300, 400, 60]]]),
      () => measureFiberDetailed(badge),
    );
    expect(measurement.rect).toEqual({ x: 0, y: 300, width: 400, height: 60 });
  });

  it("returns a null rect rather than a borrowed one when nothing can measure", async () => {
    const tree = rootOf({ type: "RCTView", children: [{ type: "RCTText", text: "LIVRE" }] });
    const [text] = queryFibers(tree, { by: "text", value: "LIVRE" });
    expect(await measureFiberDetailed(text)).toEqual({ rect: null, from: null });
  });
});

/**
 * Scrolling used to go through the raw state node, which on Fabric holds
 * no method: the call found nothing, did nothing, and answered ok.
 */
describe("scroll actions", () => {
  const buildList = (maxOffset: number) => {
    const state = { offset: 0 };
    const publicInstance = {
      measureInWindow: (callback: MeasureCallback) => callback(0, 0, 400, 800),
      scrollTo: (args: { y?: number }) => {
        state.offset = Math.max(0, Math.min(Number(args?.y ?? 0), maxOffset));
      },
      // A virtualized list only knows the end of what it has rendered
      scrollToEnd: () => { state.offset = Math.min(state.offset + 500, maxOffset); },
    };
    const tree = rootOf({
      type: "RCTScrollView",
      props: { testID: "list" },
      stateNode: { node: {}, canonical: { publicInstance } },
      children: [{
        type: "RCTView",
        stateNode: {
          measureInWindow: (callback: MeasureCallback) => callback(0, -state.offset, 400, 2000),
        },
        children: [{ type: "RCTText", text: "Ligne 0" }],
      }],
    });
    const [scroller] = queryFibers(tree, { by: "testID", value: "list" });
    return { scroller, state };
  };

  /**
   * The scroll methods normally live on the host public instance
   * (ScrollView assigns them onto it), but a wrapper component can carry
   * them too. Taking the first host below such a wrapper returns the
   * scroll view itself, and subtracting a box from itself is an offset of
   * exactly 0 forever: movedBy 0 and atEnd true on a list that did move.
   */
  it("says the offset is unknown rather than zero when it cannot measure two boxes", async () => {
    const state = { offset: 0 };
    const scrollMethods = {
      scrollToEnd: () => { state.offset = Math.min(state.offset + 500, 1200); },
      scrollTo: (args: { y?: number }) => { state.offset = Number(args?.y ?? 0); },
    };
    // The wrapper carries the methods, the host below it is the scroll view
    const tree = rootOf({
      type: Composite,
      stateNode: scrollMethods,
      children: [{
        type: "RCTScrollView",
        props: { testID: "list" },
        stateNode: { measureInWindow: (callback: MeasureCallback) => callback(0, 0, 400, 800) },
      }],
    });
    const [scroller] = queryFibers(tree, { by: "testID", value: "list" });
    const outcome = await performAct(scroller, { action: "scrollToEnd" });
    expect(state.offset).toBe(500);
    expect(outcome.extra).toMatchObject({ movedBy: null, offset: null, atEnd: null });
    expect(String(outcome.extra?.note)).toMatch(/not measurable/);
    await expect(performAct(scroller, { action: "scrollBy", dy: 100 })).rejects.toThrow(
      /scrollBy needs the current offset/
    );
  });

  it("scrolls through the public instance and reports the offset it reached", async () => {
    const { scroller, state } = buildList(1200);
    const outcome = await performAct(scroller, { action: "scrollTo", y: 250 });
    expect(state.offset).toBe(250);
    expect(outcome.extra).toMatchObject({ requested: { x: 0, y: 250 }, offset: 250 });
  });

  it("repeats scrollToEnd until the measured offset stops moving", async () => {
    const { scroller, state } = buildList(1200);
    const outcome = await performAct(scroller, { action: "scrollToEnd" });
    expect(state.offset).toBe(1200);
    expect(outcome.extra).toMatchObject({ passes: 4, movedBy: 1200, offset: 1200, atEnd: true });
  });

  it("computes scrollBy from the current offset instead of scrolling to a raw delta", async () => {
    const { scroller, state } = buildList(1200);
    await performAct(scroller, { action: "scrollTo", y: 100 });
    const outcome = await performAct(scroller, { action: "scrollBy", dy: 150 });
    expect(state.offset).toBe(250);
    expect(outcome.extra).toMatchObject({
      requested: { x: 0, y: 250 },
      offset: 250,
      movedBy: 150,
    });
  });

  it("refuses scrollBy when the current offset cannot be measured", async () => {
    const tree = rootOf({
      type: "RCTScrollView",
      props: { testID: "list" },
      stateNode: { node: {}, canonical: { publicInstance: { scrollTo: () => {} } } },
      children: [{ type: "RCTView" }],
    });
    const [scroller] = queryFibers(tree, { by: "testID", value: "list" });
    await expect(performAct(scroller, { action: "scrollBy", dy: 100 })).rejects.toThrow(
      /scrollBy needs the current offset/
    );
  });

  it("reaches the methods through the scroll responder on the old architecture", async () => {
    const calls: unknown[] = [];
    const responder = { scrollTo: (args: unknown) => calls.push(args) };
    const tree = rootOf({
      type: "RCTScrollView",
      props: { testID: "list" },
      stateNode: { getScrollResponder: () => responder },
      children: [{ type: "RCTView" }],
    });
    const [scroller] = queryFibers(tree, { by: "testID", value: "list" });
    await performAct(scroller, { action: "scrollTo", y: 120 });
    expect(calls).toEqual([{ x: 0, y: 120, animated: false }]);
  });

  it("says nothing is scrollable instead of answering ok to a silent no-op", async () => {
    const tree = rootOf({
      type: "RCTView",
      props: { testID: "page" },
      children: [{ type: "RCTText", text: "Accueil" }],
    });
    const [page] = queryFibers(tree, { by: "testID", value: "page" });
    await expect(performAct(page, { action: "scrollToEnd" })).rejects.toThrow(
      /No scrollable element found/
    );
  });

  it("refuses a Fabric list whose public instance does not exist yet", async () => {
    const tree = rootOf({
      type: "RCTScrollView",
      props: { testID: "list" },
      stateNode: { node: {}, canonical: { publicInstance: null } },
      children: [{ type: "RCTView" }],
    });
    const [scroller] = queryFibers(tree, { by: "testID", value: "list" });
    await expect(performAct(scroller, { action: "scrollToEnd" })).rejects.toThrow(
      /No scrollable element found/
    );
  });
});

/**
 * React Native puts a single string child in two places at once: the host
 * props AND a HostText fiber. Reading both and adding them returned every
 * label twice, which read as duplicated diagnostics and made `exact`
 * matching on a Text impossible.
 */
describe("text read once", () => {
  // The real shape: props.children carries the string and a HostText
  // child carries it too
  const realText = (value: string) =>
    rootOf({
      type: "RCTView",
      children: [{ type: "RCTText", props: { children: value }, text: value }],
    });

  it("matches a Text exactly instead of against its doubled content", () => {
    const tree = realText("Log In");
    expect(fiberMatches(queryFibers(tree, { by: "type", value: "Text" })[0], {
      by: "text",
      value: "Log In",
      exact: true,
    })).toBe(true);
  });

  it("lists a present value once in an absence diagnostic", () => {
    const absence = describeAbsence([realText("Welcome back!")], {
      by: "text",
      value: "Absent",
    });
    expect(absence.present).toEqual(["Welcome back!"]);
  });

  it("still reads a string child inlined in the props, as react-dom does", () => {
    const tree = rootOf({ type: "div", children: [{ type: "b", props: { children: "web text" } }] });
    const [bold] = queryFibers(tree, { by: "type", value: "b" });
    expect(fiberMatches(bold, { by: "text", value: "web text", exact: true })).toBe(true);
  });
});

/**
 * query_ui was the only way to discover elements, and its positions did
 * not survive into ui_act. Labelling each match with the index ui.act
 * expects makes the two commands speak about the same element.
 */
describe("index parity between ui.query and ui.act", () => {
  const globalAny = globalThis as Record<string, any>;
  afterEach(() => { delete globalAny.__REACT_DEVTOOLS_GLOBAL_HOOK__; });

  it("labels every match with the index ui.act addresses", async () => {
    const writes: Array<[number, string]> = [];
    const form = () => rootOf(formOf(6, writes));
    globalAny.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {};
    const handlers = new Map<string, (payload: unknown) => Promise<unknown> | unknown>();
    installUiAutomation({
      onCommand: (command, handler) => handlers.set(command, handler),
      emit: () => {},
    });
    globalAny.__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot(1, { current: form() });

    const queried = await handlers.get("ui.query")!({
      by: "type", value: "TextInput", limit: 20,
    }) as { matches: Array<{ index: number; placeholder: string }> };
    expect(queried.matches.map((match) => match.index)).toEqual([0, 1, 2, 3, 4, 5]);

    const fourth = queried.matches.find((match) => match.placeholder === "F4")!;
    const acted = await handlers.get("ui.act")!({
      action: "type", by: "type", value: "TextInput", index: fourth.index, text: "here",
    }) as { ok: boolean; target: { placeholder: string } };
    expect(acted.ok).toBe(true);
    expect(acted.target.placeholder).toBe("F4");
    expect(writes).toEqual([[4, "here"]]);
  });
});
