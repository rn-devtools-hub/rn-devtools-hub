/**
 * Application state: reading it is convenient, WRITING it is the point.
 *
 * Putting the app into an exact state without walking through ten screens
 * is only possible from inside the runtime. It is also what makes a
 * recorded flow hermetic: a test can start from an injected session
 * instead of replaying a login every time.
 *
 * The SDK never imports Zustand, Redux or React Query. The app hands over
 * the instance it already has, and the adapters below only describe how
 * to read and write it. Zero dependency, and no version coupling either.
 */

export interface StoreAdapter {
  get: (path?: string) => unknown;
  set?: (patch: unknown, path?: string) => unknown;
  /** Free-form description shown to the agent, e.g. "zustand" */
  kind?: string;
}

interface StateHost {
  onCommand: (command: string, handler: (payload: unknown) => Promise<unknown> | unknown) => void;
}

/** "user.profile.name" on a plain object; undefined for a missing branch */
export const readPath = (value: unknown, path?: string): unknown => {
  if (!path) return value;
  let current = value;
  for (const key of String(path).split(".")) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
};

/** Shallow merge at the root, targeted replacement below it. Deep merging
 * would silently keep stale keys an agent thought it had removed. */
export const applyPatch = (current: unknown, patch: unknown, path?: string): unknown => {
  if (!path) {
    if (current && typeof current === "object" && patch && typeof patch === "object" && !Array.isArray(patch)) {
      return { ...(current as Record<string, unknown>), ...(patch as Record<string, unknown>) };
    }
    return patch;
  }
  const keys = String(path).split(".");
  const clone = (node: unknown): Record<string, unknown> =>
    node && typeof node === "object" ? { ...(node as Record<string, unknown>) } : {};
  const root = clone(current);
  let cursor = root;
  for (let index = 0; index < keys.length - 1; index += 1) {
    cursor[keys[index]] = clone(cursor[keys[index]]);
    cursor = cursor[keys[index]] as Record<string, unknown>;
  }
  cursor[keys[keys.length - 1]] = patch;
  return root;
};

export const createStoreRegistry = () => {
  const stores = new Map<string, StoreAdapter>();
  return {
    register: (name: string, adapter: StoreAdapter): void => {
      if (!name || typeof adapter?.get !== "function") return;
      stores.set(name, adapter);
    },
    names: (): Array<{ name: string; kind: string | null; writable: boolean }> =>
      [...stores.entries()].map(([name, adapter]) => ({
        name,
        kind: adapter.kind ?? null,
        writable: typeof adapter.set === "function",
      })),
    get: (name: string, path?: string): unknown => {
      const adapter = stores.get(name);
      if (!adapter) {
        throw new Error(
          `Unknown store "${name}". Known: ${[...stores.keys()].join(", ") || "none"}. Register one with devtools.registerStore(name, adapter).`
        );
      }
      return adapter.get(path);
    },
    set: (name: string, patch: unknown, path?: string): unknown => {
      const adapter = stores.get(name);
      if (!adapter) throw new Error(`Unknown store "${name}"`);
      if (typeof adapter.set !== "function") {
        throw new Error(`Store "${name}" is read-only: its adapter declares no set()`);
      }
      return adapter.set(patch, path);
    },
  };
};

// ====================================================================
// Adapters: the app passes its instance, the SDK imports nothing
// ====================================================================

interface ZustandLike {
  getState: () => unknown;
  setState: (patch: unknown) => void;
}

export const zustandStore = (store: ZustandLike): StoreAdapter => ({
  kind: "zustand",
  get: (path) => readPath(store.getState(), path),
  set: (patch, path) => {
    store.setState(applyPatch(store.getState(), patch, path));
    return store.getState();
  },
});

interface ReduxLike {
  getState: () => unknown;
  dispatch: (action: unknown) => unknown;
}

/**
 * Redux state is owned by its reducers, so writing means dispatching. The
 * adapter refuses to fake a mutation it cannot legitimately perform, and
 * says how to do it instead.
 */
export const reduxStore = (store: ReduxLike): StoreAdapter => ({
  kind: "redux",
  get: (path) => readPath(store.getState(), path),
  set: (patch) => {
    if (!patch || typeof patch !== "object" || typeof (patch as { type?: unknown }).type !== "string") {
      throw new Error(
        "A Redux store is written through its reducers: pass an action object with a type, e.g. { type: \"auth/signedIn\", payload: {...} }"
      );
    }
    store.dispatch(patch);
    return store.getState();
  },
});

interface QueryClientLike {
  getQueryCache: () => { getAll: () => Array<Record<string, any>> };
  setQueryData: (key: unknown, data: unknown) => unknown;
  invalidateQueries?: (filters?: unknown) => unknown;
}

/**
 * React Query is keyed, not a single tree: reading returns the cache
 * entries, writing targets one key. `path` is the JSON-encoded query key.
 */
export const reactQueryStore = (client: QueryClientLike): StoreAdapter => ({
  kind: "react-query",
  get: (path) => {
    const queries = client.getQueryCache().getAll();
    if (path) {
      const found = queries.find((query) => JSON.stringify(query.queryKey) === path);
      return found ? found.state?.data : undefined;
    }
    return queries.map((query) => ({
      key: query.queryKey,
      status: query.state?.status ?? null,
      updatedAt: query.state?.dataUpdatedAt ?? null,
      hasData: query.state?.data !== undefined,
    }));
  },
  set: (patch, path) => {
    if (!path) {
      throw new Error(
        'React Query is keyed: pass path as the JSON query key, e.g. path: "[\\"orders\\",1]"'
      );
    }
    const key = JSON.parse(path);
    client.setQueryData(key, patch);
    return { key, written: true };
  },
});

export const installStateAccess = (
  host: StateHost,
  registry = createStoreRegistry()
): ReturnType<typeof createStoreRegistry> => {
  host.onCommand("state.list", () => ({ stores: registry.names() }));
  host.onCommand("state.get", (rawPayload) => {
    const payload = (rawPayload ?? {}) as Record<string, unknown>;
    if (!payload.store) return { stores: registry.names() };
    return {
      store: payload.store,
      path: payload.path ?? null,
      value: registry.get(String(payload.store), payload.path ? String(payload.path) : undefined),
    };
  });
  host.onCommand("state.set", (rawPayload) => {
    const payload = (rawPayload ?? {}) as Record<string, unknown>;
    if (!payload.store) throw new Error("state.set needs a store name");
    return {
      store: payload.store,
      path: payload.path ?? null,
      result: registry.set(
        String(payload.store),
        payload.value,
        payload.path ? String(payload.path) : undefined
      ),
    };
  });
  return registry;
};
