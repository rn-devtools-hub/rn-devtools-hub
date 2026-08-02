import { describe, expect, it, vi } from "vitest";
import {
  readPath,
  applyPatch,
  createStoreRegistry,
  zustandStore,
  reduxStore,
  reactQueryStore,
} from "../src/client/state";
import { createPreviewRegistry, PREVIEW_OUTLET_TEST_ID } from "../src/client/preview";

describe("readPath", () => {
  const state = { user: { profile: { name: "Ada" } }, items: [1, 2] };

  it("returns the whole state without a path", () => {
    expect(readPath(state)).toBe(state);
  });

  it("walks a dotted path", () => {
    expect(readPath(state, "user.profile.name")).toBe("Ada");
  });

  it("returns undefined for a missing branch instead of throwing", () => {
    expect(readPath(state, "user.settings.theme")).toBeUndefined();
    expect(readPath(null, "user.name")).toBeUndefined();
    expect(readPath(state, "items.0.length")).toBeUndefined();
  });
});

describe("applyPatch", () => {
  it("shallow merges at the root", () => {
    expect(applyPatch({ a: 1, b: 2 }, { b: 3 })).toEqual({ a: 1, b: 3 });
  });

  it("replaces rather than deep merging, so removed keys really go", () => {
    const next = applyPatch({ user: { name: "Ada", role: "admin" } }, { name: "Grace" }, "user");
    expect(next).toEqual({ user: { name: "Grace" } });
  });

  it("creates the missing branches of a path", () => {
    expect(applyPatch({}, "dark", "settings.theme")).toEqual({ settings: { theme: "dark" } });
  });

  it("does not mutate the original state", () => {
    const original = { user: { name: "Ada" } };
    applyPatch(original, { name: "Grace" }, "user");
    expect(original.user.name).toBe("Ada");
  });

  it("replaces the root when the patch is not a mergeable object", () => {
    expect(applyPatch({ a: 1 }, [1, 2])).toEqual([1, 2]);
    expect(applyPatch({ a: 1 }, null)).toBeNull();
  });
});

describe("store registry", () => {
  it("lists stores with their kind and whether they are writable", () => {
    const registry = createStoreRegistry();
    registry.register("session", { get: () => ({}), kind: "custom" });
    registry.register("cart", { get: () => ({}), set: (patch) => patch, kind: "zustand" });
    expect(registry.names()).toEqual([
      { name: "session", kind: "custom", writable: false },
      { name: "cart", kind: "zustand", writable: true },
    ]);
  });

  it("names the known stores when asked for an unknown one", () => {
    const registry = createStoreRegistry();
    registry.register("cart", { get: () => ({}) });
    expect(() => registry.get("basket")).toThrow(/cart/);
  });

  it("refuses to write a read-only store instead of failing silently", () => {
    const registry = createStoreRegistry();
    registry.register("session", { get: () => ({}) });
    expect(() => registry.set("session", { a: 1 })).toThrow(/read-only/);
  });

  it("ignores a registration with no get()", () => {
    const registry = createStoreRegistry();
    registry.register("broken", {} as never);
    expect(registry.names()).toEqual([]);
  });
});

describe("adapters", () => {
  it("reads and writes a Zustand store through its own API", () => {
    let state: Record<string, unknown> = { user: { name: "Ada" }, count: 1 };
    const adapter = zustandStore({
      getState: () => state,
      setState: (next) => {
        state = next as Record<string, unknown>;
      },
    });
    expect(adapter.get("user.name")).toBe("Ada");
    adapter.set!({ count: 5 });
    expect(state.count).toBe(5);
    expect(state.user).toEqual({ name: "Ada" });
  });

  it("writes Redux by dispatching, and refuses to fake a mutation", () => {
    const dispatch = vi.fn();
    const adapter = reduxStore({ getState: () => ({ auth: { user: null } }), dispatch });
    expect(adapter.get("auth.user")).toBeNull();
    expect(() => adapter.set!({ user: "Ada" })).toThrow(/action object with a type/);
    adapter.set!({ type: "auth/signedIn", payload: { id: 1 } });
    expect(dispatch).toHaveBeenCalledWith({ type: "auth/signedIn", payload: { id: 1 } });
  });

  it("summarizes the React Query cache and writes by key", () => {
    const setQueryData = vi.fn();
    const adapter = reactQueryStore({
      getQueryCache: () => ({
        getAll: () => [
          { queryKey: ["orders", 1], state: { status: "success", dataUpdatedAt: 10, data: { id: 1 } } },
        ],
      }),
      setQueryData,
    });
    expect(adapter.get()).toEqual([
      { key: ["orders", 1], status: "success", updatedAt: 10, hasData: true },
    ]);
    expect(adapter.get('["orders",1]')).toEqual({ id: 1 });
    adapter.set!({ id: 2 }, '["orders",1]');
    expect(setQueryData).toHaveBeenCalledWith(["orders", 1], { id: 2 });
  });

  it("explains that React Query needs a key rather than writing blindly", () => {
    const adapter = reactQueryStore({
      getQueryCache: () => ({ getAll: () => [] }),
      setQueryData: () => undefined,
    });
    expect(() => adapter.set!({ id: 2 })).toThrow(/JSON query key/);
  });
});

describe("preview registry", () => {
  it("reports no outlet until one subscribes", () => {
    const registry = createPreviewRegistry();
    expect(registry.hasOutlet()).toBe(false);
    const unsubscribe = registry.onChange(() => {});
    expect(registry.hasOutlet()).toBe(true);
    unsubscribe();
    expect(registry.hasOutlet()).toBe(false);
  });

  it("passes the factory result to every outlet", () => {
    const registry = createPreviewRegistry();
    const seen: unknown[] = [];
    registry.onChange((element) => seen.push(element));
    registry.register("Card", (props) => ({ element: "Card", props }));
    registry.render("Card", { title: "Hello" });
    expect(seen).toEqual([{ element: "Card", props: { title: "Hello" } }]);
  });

  it("replays the current preview to a late outlet", () => {
    const registry = createPreviewRegistry();
    registry.register("Card", () => ({ element: "Card" }));
    registry.render("Card", {});
    const seen: unknown[] = [];
    registry.onChange((element) => seen.push(element));
    expect(seen).toEqual([{ element: "Card" }]);
  });

  it("keeps notifying the other outlets when one throws", () => {
    const registry = createPreviewRegistry();
    const seen: unknown[] = [];
    registry.onChange(() => {
      throw new Error("outlet exploded");
    });
    registry.onChange((element) => seen.push(element));
    registry.register("Card", () => "card");
    expect(() => registry.render("Card", {})).not.toThrow();
    expect(seen).toEqual(["card"]);
  });

  it("lists the known previews when asked for an unknown one", () => {
    const registry = createPreviewRegistry();
    registry.register("Card", () => null);
    expect(() => registry.render("Missing", {})).toThrow(/Known: Card/);
  });

  it("clears the outlet on unmount", () => {
    const registry = createPreviewRegistry();
    const seen: unknown[] = [];
    registry.onChange((element) => seen.push(element));
    registry.register("Card", () => "card");
    registry.render("Card", {});
    registry.clear();
    expect(seen).toEqual(["card", null]);
  });

  it("publishes a stable outlet testID for the SDK to find", () => {
    expect(PREVIEW_OUTLET_TEST_ID).toBe("devtools-preview");
  });
});
