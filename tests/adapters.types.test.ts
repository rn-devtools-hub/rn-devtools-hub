/**
 * Type-level regression: the adapters must accept a REALISTICALLY TYPED
 * store, not just a hand-rolled stub.
 *
 * The first version declared `setState: (patch: unknown) => void`, which
 * looks harmless and makes every real store unassignable. Under
 * strictFunctionTypes parameters are contravariant, so a store whose
 * setState takes `Partial<T>` only fits a parameter typed `unknown` if
 * `unknown` is assignable to `Partial<T>`, which it is not. It compiled
 * here because the tests passed stubs typed exactly as declared, and it
 * failed for every actual user, who then reached for a cast.
 *
 * These declarations mirror the real libraries' signatures. If the
 * adapters regress, `npm run typecheck` fails, which is the point: no
 * assertion here can catch a variance bug, only the compiler can.
 */
import { describe, expect, it } from "vitest";
import { zustandStore, reduxStore, reactQueryStore } from "../src/client/state";

interface CartState {
  items: string[];
  total: number;
}

// The shape zustand's create() actually returns
interface ZustandApi<T> {
  getState: () => T;
  setState: (
    partial: T | Partial<T> | ((state: T) => T | Partial<T>),
    replace?: false
  ) => void;
  subscribe: (listener: (state: T, previous: T) => void) => () => void;
}

interface ReduxAction {
  type: string;
  payload?: unknown;
}

interface ReduxApi<T> {
  getState: () => T;
  dispatch: <A extends ReduxAction>(action: A) => A;
  subscribe: (listener: () => void) => () => void;
}

interface QueryApi {
  getQueryCache: () => { getAll: () => Array<{ queryKey: unknown; state: { data: unknown } }> };
  setQueryData: <T>(key: readonly unknown[], updater: T) => T | undefined;
  invalidateQueries: (filters?: { queryKey?: readonly unknown[] }) => Promise<void>;
}

describe("adapters accept realistically typed stores", () => {
  it("takes a zustand store without a cast", () => {
    let state: CartState = { items: [], total: 0 };
    const store: ZustandApi<CartState> = {
      getState: () => state,
      setState: (partial) => {
        const next = typeof partial === "function" ? partial(state) : partial;
        state = { ...state, ...next };
      },
      subscribe: () => () => {},
    };

    // The line that used to require `as never`
    const adapter = zustandStore(store);
    expect(adapter.get("total")).toBe(0);
    adapter.set!({ total: 12 });
    expect(state.total).toBe(12);
    expect(state.items).toEqual([]);
  });

  it("takes a redux store without a cast", () => {
    const seen: ReduxAction[] = [];
    const store: ReduxApi<{ auth: { user: string | null } }> = {
      getState: () => ({ auth: { user: null } }),
      dispatch: (action) => {
        seen.push(action);
        return action;
      },
      subscribe: () => () => {},
    };

    const adapter = reduxStore(store);
    expect(adapter.get("auth.user")).toBeNull();
    adapter.set!({ type: "auth/signedIn" });
    expect(seen).toEqual([{ type: "auth/signedIn" }]);
  });

  it("takes a query client without a cast", () => {
    const written: unknown[] = [];
    const client: QueryApi = {
      getQueryCache: () => ({
        getAll: () => [{ queryKey: ["orders"], state: { data: { id: 1 } } }],
      }),
      setQueryData: (key, updater) => {
        written.push([key, updater]);
        return updater;
      },
      invalidateQueries: async () => {},
    };

    const adapter = reactQueryStore(client);
    expect(adapter.get()).toHaveLength(1);
    adapter.set!({ id: 2 }, '["orders"]');
    expect(written).toEqual([[["orders"], { id: 2 }]]);
  });
});
