/**
 * Component previews, mounted IN the running app.
 *
 * Storybook and IDE previews mount a component in an empty shell, and
 * the real cost of using them is re-mocking the providers, the session
 * and the cache until the component agrees to render. Being inside the
 * app removes that cost entirely: the component mounts under the app's
 * own providers, with its real session and its real cache. Nothing to
 * mock, because nothing is missing.
 *
 * Two constraints shape the API:
 *
 * - Metro resolves statically, so no arbitrary file path can be required
 *   at runtime. Previews are therefore REGISTERED by the app, by name.
 * - src/client imports nothing, React included, so the SDK cannot mount
 *   an element itself. The app hosts a four-line outlet and the SDK
 *   drives it:
 *
 *     function DevtoolsPreviewOutlet() {
 *       const [element, setElement] = useState(null);
 *       useEffect(() => devtools.onPreviewChange(setElement), []);
 *       return <View testID="devtools-preview">{element}</View>;
 *     }
 *
 *   Placed inside the provider tree, that outlet is what makes the
 *   preview "in situ" rather than isolated.
 */

import type { AutomationApi, UiNode } from "./automation";

export type PreviewFactory = (props: Record<string, unknown>) => unknown;

/** testID the outlet must carry, so the SDK can find and measure it */
export const PREVIEW_OUTLET_TEST_ID = "devtools-preview";

const COMMIT_SETTLE_MS = 50;

export interface PreviewRegistry {
  register: (name: string, factory: PreviewFactory) => void;
  names: () => string[];
  onChange: (listener: (element: unknown) => void) => () => void;
}

interface PreviewHost {
  onCommand: (command: string, handler: (payload: unknown) => Promise<unknown> | unknown) => void;
  automation: () => AutomationApi | null;
}

export const createPreviewRegistry = (): PreviewRegistry & {
  render: (name: string, props: Record<string, unknown>) => void;
  clear: () => void;
  hasOutlet: () => boolean;
} => {
  const factories = new Map<string, PreviewFactory>();
  const listeners = new Set<(element: unknown) => void>();
  let current: unknown = null;

  const publish = (element: unknown): void => {
    current = element;
    for (const listener of listeners) {
      // One broken outlet must not stop the others, nor the command
      try {
        listener(element);
      } catch {
        // the app's outlet threw; nothing the SDK can do about it
      }
    }
  };

  return {
    register: (name, factory) => {
      if (typeof factory !== "function" || !name) return;
      factories.set(name, factory);
    },
    names: () => [...factories.keys()],
    onChange: (listener) => {
      listeners.add(listener);
      // A late outlet still gets the current preview
      if (current !== null) {
        try {
          listener(current);
        } catch {
          // ignored, see publish
        }
      }
      return () => listeners.delete(listener);
    },
    hasOutlet: () => listeners.size > 0,
    render: (name, props) => {
      const factory = factories.get(name);
      if (!factory) {
        throw new Error(
          `Unknown preview "${name}". Register it with devtools.registerPreview(name, props => <Component {...props} />). Known: ${[...factories.keys()].join(", ") || "none"}`
        );
      }
      publish(factory(props ?? {}));
    },
    clear: () => publish(null),
  };
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const outletSelector = { by: "testID", value: PREVIEW_OUTLET_TEST_ID } as const;

/** Reads back what the outlet actually rendered: an agent gets the tree
 * and the measured box, not just a promise that something was mounted */
const inspectOutlet = async (
  automation: AutomationApi
): Promise<{ tree: UiNode[] | null; rect: unknown }> => {
  await sleep(COMMIT_SETTLE_MS);
  const matches = await automation.query(outletSelector, 1);
  return {
    tree: automation.subtree(outletSelector, { maxDepth: 30, maxNodes: 400 }),
    rect: matches[0]?.rect ?? null,
  };
};

export const installPreviews = (host: PreviewHost, registry = createPreviewRegistry()): PreviewRegistry => {
  host.onCommand("preview.list", () => ({
    previews: registry.names(),
    outletMounted: registry.hasOutlet(),
    hint: registry.hasOutlet()
      ? null
      : `No outlet mounted. Render a component subscribing to devtools.onPreviewChange inside your providers, wrapped in a view with testID="${PREVIEW_OUTLET_TEST_ID}".`,
  }));

  host.onCommand("preview.render", async (rawPayload) => {
    const payload = (rawPayload ?? {}) as Record<string, unknown>;
    const automation = host.automation();
    if (!automation) {
      throw new Error("UI automation is not attached: call devtools.attachUiAutomation() first");
    }
    if (!registry.hasOutlet()) {
      throw new Error(
        `No preview outlet is mounted, so nothing can be rendered. Mount one inside your provider tree with testID="${PREVIEW_OUTLET_TEST_ID}".`
      );
    }
    registry.render(String(payload.name ?? ""), (payload.props ?? {}) as Record<string, unknown>);
    const inspected = await inspectOutlet(automation);
    return {
      ok: true,
      name: payload.name,
      generation: automation.generation(),
      rect: inspected.rect,
      tree: inspected.tree,
      note: inspected.tree
        ? null
        : "Mounted, but the outlet could not be located: check its testID.",
    };
  });

  host.onCommand("preview.unmount", () => {
    registry.clear();
    return { ok: true };
  });

  return registry;
};
