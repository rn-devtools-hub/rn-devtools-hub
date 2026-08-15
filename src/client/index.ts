/**
 * Devtools SDK: public entry point.
 *
 * Designed to be extracted as an npm package ("plug into any app"):
 * - zero external dependencies
 * - completely inert until init() has been called
 * - init() must be guarded by __DEV__ on the app side: nothing runs in production
 *
 * API:
 *   devtools.init({ serverUrl, appName, deviceName })
 *   devtools.emit(type, payload)              // custom event
 *   devtools.onCommand(name, handler)         // command from the dashboard
 *   devtools.attachAxios(instance, label)     // instruments an axios instance
 *   devtools.wrapFetch(fetchImpl, label)      // returns an instrumented fetch
 *   devtools.attachConsole()                  // forwards console.log/warn/error
 *   devtools.startPerformanceSampler()        // JS lag + uptime
 *   devtools.attachUiAutomation()             // ui.tree/ui.query/ui.act for agents
 *   devtools.attachOriginTracking()           // call-site frames on network events
 *   devtools.registerPreview(name, factory)   // component an agent can mount in situ
 *   devtools.registerStore(name, adapter)     // state an agent can read and write
 *   devtools.attachDeterminism()              // controlled clock and network (JS level)
 *   devtools.markScreenReady("Login")         // "screen ready" signal for agents
 */

import { installUiAutomation, type AutomationApi } from "./automation";
import { installOverlayControl } from "./overlay";
import { installRuntimeContext } from "./context";
import { installDeterminism } from "./determinism";
import { installPreviews, type PreviewFactory, type PreviewRegistry } from "./preview";
import { captureOrigin } from "./source";
import { installStateAccess, type StoreAdapter } from "./state";
import { DevtoolsTransport } from "./transport";
import {
  ActionDefinition,
  CommandHandler,
  DevtoolsInitOptions,
  redactBody,
  redactHeaders,
  truncateForWire,
} from "./types";

/** One wrap attempt on a network client, live or not */
export interface NetworkWrap {
  kind: "fetch" | "axios";
  label: string;
  /** False when the wrap ran before init(): it returned the client unchanged */
  active: boolean;
}

/**
 * What this app has actually attached.
 *
 * Read by the hub when a tool comes back empty, so it can answer
 * "nothing is watching" instead of "nothing happened". The two look
 * identical from outside the runtime and only one of them is a bug.
 */
export interface InstrumentationReport {
  network: { instrumented: boolean; wraps: NetworkWrap[] };
  uiAutomation: boolean;
  determinism: boolean;
  originTracking: boolean;
  console: boolean;
  stores: Array<{ name: string; kind: string | null; writable: boolean }>;
  actions: string[];
  previews: string[];
}

type AxiosLikeInstance = {
  interceptors: {
    request: { use: (onOk: (config: any) => any) => unknown };
    response: {
      use: (
        onOk: (response: any) => any,
        onError: (error: any) => Promise<never>
      ) => unknown;
    };
  };
};

class Devtools {
  private transport: DevtoolsTransport | null = null;
  private requestCounter = 0;
  private perfTimer: ReturnType<typeof setInterval> | null = null;
  private consoleAttached = false;
  private startedAt = Date.now();
  private trackOrigin = false;
  private determinism: ReturnType<typeof installDeterminism> | null = null;

  /**
   * Every wrap ever attempted on a network client, live or not.
   *
   * wrapFetch returns the client UNCHANGED when the SDK is not
   * initialized yet, which is exactly what a module-scope
   * `const api = devtools.wrapFetch(fetch, "api")` hits when its file is
   * imported before init() runs. The app then works perfectly and the bus
   * stays empty forever. Recording the attempt is what lets the hub say
   * so instead of returning an empty list that reads like "no request".
   */
  private wraps: NetworkWrap[] = [];

  /**
   * Enables the controlled clock and controlled network.
   *
   * Deterministic at the JS level only: Date and the requests going
   * through wrapFetch. Native animations and Reanimated read native
   * clocks and are unaffected, which is stated rather than implied.
   */
  attachDeterminism(): void {
    if (!this.enabled || this.determinism) return;
    this.determinism = installDeterminism({
      onCommand: (command, handler) => this.transport?.onCommand(command, handler),
    });
  }

  /**
   * Puts a call site on the event bus, not only on the UI tree: each
   * request carries the frames of the code that fired it. Capturing a
   * stack has a cost on every request, so it stays opt-in.
   */
  attachOriginTracking(): void {
    if (!this.enabled) return;
    this.trackOrigin = true;
  }

  /** Exposed on the instance so wrapFetch's inner function can reach it */
  private origin(): string[] | undefined {
    return this.trackOrigin ? (captureOrigin() ?? undefined) : undefined;
  }

  /** Extra field names this project considers secret, from init() */
  private redactKeys: string[] = [];

  /**
   * A body ready to leave the device: credentials removed, and the paths
   * that were removed named. Silence would leave a reader hunting for a
   * value the tool itself took out.
   */
  private safeBody(body: unknown): Record<string, unknown> {
    if (body === undefined) return {};
    const { value, redacted } = redactBody(body, this.redactKeys);
    return redacted.length ? { body: value, redacted } : { body: value };
  }

  get enabled(): boolean {
    return this.transport !== null;
  }

  init(options: DevtoolsInitOptions): void {
    /**
     * Built-in safeguard: never active in production, even if the host app
     * forgets its own __DEV__ guard.
     *
     * The condition used to be "stop when __DEV__ exists and is false",
     * so a bundle where the global had been stripped ran the SDK anyway.
     * A tool that reads your state and your network traffic has to fail
     * closed: it starts when development is affirmed, not when production
     * fails to announce itself. The NODE_ENV fallback keeps the paths
     * where __DEV__ genuinely does not exist working, tests and plain
     * Node among them.
     */
    const nodeEnv = (globalThis as Record<string, any>).process?.env?.NODE_ENV;
    const development =
      typeof __DEV__ !== "undefined" ? __DEV__ === true : nodeEnv !== "production";
    if (!development) return;
    if (this.transport) return; // already initialized
    this.redactKeys = Array.isArray(options.redactKeys) ? options.redactKeys : [];
    this.transport = new DevtoolsTransport(options);
    this.transport.start();
    this.startedAt = Date.now();
    // Always on: reading globals costs nothing and the answer is what
    // every other tool needs first (is this binary even current?)
    installRuntimeContext({
      onCommand: (command, handler) => this.transport?.onCommand(command, handler),
    });
    // Also always on, and for the same reason: an agent reading an empty
    // answer needs to know whether anything was even attached to observe
    this.transport.onCommand("context.instrumentation", () => this.instrumentation());
    // Always on as well: the dev-menu bubble covers native controls the
    // agent cannot even see, and asking an app to opt in to being able to
    // move something it never asked for would be backwards
    installOverlayControl({
      onCommand: (command, handler) => this.transport?.onCommand(command, handler),
    });
    this.emit("app.info", {
      appName: options.appName,
      deviceName: options.deviceName,
      startedAt: this.startedAt,
    });
  }

  stop(): void {
    this.transport?.stop();
    this.transport = null;
    if (this.perfTimer) {
      clearInterval(this.perfTimer);
      this.perfTimer = null;
    }
  }

  /**
   * Event types the protocol defines as carrying binary payloads.
   *
   * Truncating one produces an undecodable image and a blank panel, with
   * no error anywhere. Asking every caller to remember `emitRaw` for these
   * is a rule that will be forgotten, by a person or by an agent, so the
   * SDK keeps them whole instead of relying on the reminder.
   */
  private static readonly BINARY_TYPES = new Set(["screen.frame"]);

  private warnedTruncation = new Set<string>();

  emit(type: string, payload: unknown): void {
    if (Devtools.BINARY_TYPES.has(type)) {
      this.transport?.enqueue(type, payload);
      return;
    }
    const wire = truncateForWire(payload);
    // Truncation is normally desirable, but a caller who did not expect it
    // gets silent corruption. Say it once per type, with the fix.
    if (!this.warnedTruncation.has(type) && JSON.stringify(wire ?? null)?.includes("[truncated")) {
      this.warnedTruncation.add(type);
      console.warn(
        `[rn-devtools-hub] "${type}" was truncated at 20 KB. If this payload is binary or must ` +
          "arrive whole, send it with devtools.emitRaw(type, payload) instead of devtools.emit."
      );
    }
    this.transport?.enqueue(type, wire);
  }

  /** Emission WITHOUT truncation: reserved for legitimate binary payloads
   * (base64 screen frames...) that truncation would corrupt */
  emitRaw(type: string, payload: unknown): void {
    this.transport?.enqueue(type, payload);
  }

  onCommand(command: string, handler: CommandHandler): void {
    this.transport?.onCommand(command, handler);
  }

  // ------------------------------------------------------------------
  // Actions: buttons shown in the dashboard (reload, clear cache...)
  // ------------------------------------------------------------------
  private actions = new Map<string, { definition: ActionDefinition; handler: CommandHandler }>();

  registerAction(definition: ActionDefinition, handler: CommandHandler): void {
    if (!this.enabled) return;
    this.actions.set(definition.name, { definition, handler });

    // (Re)install the dispatcher and publish the up-to-date list
    this.transport?.onCommand("action.run", async (payload) => {
      const incoming = payload as { name?: string; args?: unknown };
      const name = String(incoming?.name ?? "");
      const action = this.actions.get(name);
      if (!action) throw new Error(`Unknown action: ${name}`);
      // Typed args (nav:packageDetail {id}...) when provided, otherwise
      // the whole payload for backward compatibility
      return action.handler(incoming?.args ?? payload);
    });
    this.emit("actions.register", {
      actions: Array.from(this.actions.values()).map((a) => a.definition),
    });
  }

  // ------------------------------------------------------------------
  // UI automation for agents (MCP): ui.tree / ui.query / ui.act
  // ------------------------------------------------------------------
  private automationAttached = false;
  private automation: AutomationApi | null = null;
  private previews: PreviewRegistry | null = null;
  private stores: ReturnType<typeof installStateAccess> | null = null;

  /** Enables runtime UI perception and actions for AI agents.
   * Call it at startup (with the other attach* calls) so the React
   * roots are observed from the first render. */
  attachUiAutomation(): void {
    if (!this.enabled || this.automationAttached) return;
    this.automationAttached = true;
    this.automation = installUiAutomation({
      onCommand: (command, handler) => this.transport?.onCommand(command, handler),
      emit: (type, payload) => this.emit(type, payload),
    });
  }

  // ------------------------------------------------------------------
  // Previews: mounted in the live app, under its real providers
  // ------------------------------------------------------------------

  /** Registers a component an agent can mount on demand. Metro resolves
   * statically, so previews are named rather than addressed by path. */
  registerPreview(name: string, factory: PreviewFactory): void {
    if (!this.enabled) return;
    this.ensurePreviews().register(name, factory);
  }

  /** Subscribed by the app's outlet. Returns an unsubscribe function, so
   * it drops straight into a useEffect. */
  onPreviewChange(listener: (element: unknown) => void): () => void {
    return this.ensurePreviews().onChange(listener);
  }

  private ensurePreviews(): PreviewRegistry {
    if (!this.previews) {
      this.previews = installPreviews({
        onCommand: (command, handler) => this.transport?.onCommand(command, handler),
        automation: () => this.automation,
      });
    }
    return this.previews;
  }

  // ------------------------------------------------------------------
  // Stores: reading is convenient, writing is the point
  // ------------------------------------------------------------------

  /** Exposes a store to get_state and set_state. The SDK never imports
   * the library: pass the instance, or one of the provided adapters. */
  registerStore(name: string, adapter: StoreAdapter): void {
    if (!this.enabled) return;
    if (!this.stores) {
      this.stores = installStateAccess({
        onCommand: (command, handler) => this.transport?.onCommand(command, handler),
      });
    }
    this.stores.register(name, adapter);
  }

  /** Signals that the current screen finished loading its data
   * (no skeletons left). Agents wait for this event instead of sleeping. */
  markScreenReady(screen?: string): void {
    this.emit("screen.ready", { screen: screen ?? null });
  }

  // ------------------------------------------------------------------
  // Network: axios
  // ------------------------------------------------------------------
  attachAxios(instance: AxiosLikeInstance, label: string): void {
    // Recorded before the guard: a wrap that no-opped is the answer to
    // "why is the network panel empty", and it is invisible otherwise
    this.wraps.push({ kind: "axios", label, active: this.enabled });
    if (!this.enabled) return;

    instance.interceptors.request.use((config: any) => {
      const requestId = ++this.requestCounter;
      config.__devtoolsRequestId = requestId;
      config.__devtoolsStart = Date.now();

      this.emit("network.request", {
        requestId,
        source: label,
        method: (config.method ?? "get").toUpperCase(),
        url: `${config.baseURL ?? ""}${config.url ?? ""}`,
        headers: redactHeaders(this.flattenAxiosHeaders(config.headers), this.redactKeys),
        ...this.safeBody(config.data),
        origin: this.origin(),
      });
      return config;
    });

    instance.interceptors.response.use(
      (response: any) => {
        this.emit("network.response", {
          requestId: response.config?.__devtoolsRequestId,
          source: label,
          status: response.status,
          durationMs: response.config?.__devtoolsStart
            ? Date.now() - response.config.__devtoolsStart
            : undefined,
          headers: redactHeaders(response.headers, this.redactKeys),
          ...this.safeBody(response.data),
        });
        return response;
      },
      (error: any) => {
        this.emit("network.error", {
          requestId: error?.config?.__devtoolsRequestId,
          source: label,
          status: error?.response?.status ?? null,
          durationMs: error?.config?.__devtoolsStart
            ? Date.now() - error.config.__devtoolsStart
            : undefined,
          message: error?.message,
          ...this.safeBody(error?.response?.data),
        });
        return Promise.reject(error);
      }
    );
  }

  private flattenAxiosHeaders(headers: unknown): Record<string, unknown> {
    if (!headers || typeof headers !== "object") return {};
    // AxiosHeaders exposes toJSON, otherwise a plain object
    const anyHeaders = headers as { toJSON?: () => Record<string, unknown> };
    if (typeof anyHeaders.toJSON === "function") {
      try {
        return anyHeaders.toJSON();
      } catch {
        return {};
      }
    }
    return headers as Record<string, unknown>;
  }

  // ------------------------------------------------------------------
  // Network: fetch (expo/fetch, S3 uploads...)
  // ------------------------------------------------------------------
  wrapFetch<T extends (...args: any[]) => Promise<any>>(
    fetchImpl: T,
    label: string
  ): T {
    this.wraps.push({ kind: "fetch", label, active: this.enabled });
    if (!this.enabled) return fetchImpl;

    const self = this;
    const wrapped = async function (this: unknown, ...args: any[]) {
      const [input, init] = args;
      const requestId = ++self.requestCounter;
      const start = Date.now();
      const url = typeof input === "string" ? input : String(input?.url ?? input);
      const method = (init?.method ?? "GET").toUpperCase();

      self.emit("network.request", {
        requestId,
        source: label,
        method,
        url,
        headers: redactHeaders(init?.headers, self.redactKeys),
        // Do not serialize binary bodies (File/Blob from uploads)
        ...self.safeBody(
          typeof init?.body === "string"
            ? init.body
            : init?.body
              ? "[binary]"
              : undefined
        ),
        origin: self.origin(),
      });

      const plan = self.determinism?.network.plan(url, method) ?? null;
      if (plan?.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, plan.delayMs));
      }
      if (plan?.fail) {
        self.emit("network.error", {
          requestId,
          source: label,
          status: null,
          durationMs: Date.now() - start,
          message: plan.fail,
          mocked: true,
        });
        throw new Error(plan.fail);
      }
      if (plan?.mock) {
        // A mocked response still goes on the bus, flagged: an agent must
        // never mistake a fixture for the real backend
        self.emit("network.response", {
          requestId,
          source: label,
          status: plan.mock.status,
          durationMs: Date.now() - start,
          mocked: true,
        });
        return new Response(
          typeof plan.mock.body === "string" ? plan.mock.body : JSON.stringify(plan.mock.body ?? null),
          { status: plan.mock.status, headers: { "Content-Type": "application/json" } }
        ) as never;
      }

      try {
        const response = await fetchImpl.apply(this, args as never);
        self.emit("network.response", {
          requestId,
          source: label,
          status: response?.status,
          durationMs: Date.now() - start,
        });
        return response;
      } catch (error: unknown) {
        self.emit("network.error", {
          requestId,
          source: label,
          status: null,
          durationMs: Date.now() - start,
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    };

    return wrapped as unknown as T;
  }

  // ------------------------------------------------------------------
  // Console
  // ------------------------------------------------------------------
  attachConsole(): void {
    if (!this.enabled || this.consoleAttached) return;
    this.consoleAttached = true;

    const levels = ["log", "info", "warn", "error"] as const;
    for (const level of levels) {
      const original = console[level].bind(console);
      console[level] = (...args: unknown[]) => {
        original(...args);
        // Defensive serialization: the console must NEVER crash the app
        try {
          this.emit("console", {
            level,
            args: args.map((arg) =>
              arg instanceof Error
                ? { message: arg.message, stack: arg.stack }
                : truncateForWire(arg, 1000, 4)
            ),
          });
        } catch {
          // ignored
        }
      };
    }
  }

  // ------------------------------------------------------------------
  // Crash reporting: fatal JS errors + unhandled promise rejections
  // ------------------------------------------------------------------
  attachCrashReporting(): void {
    if (!this.enabled) return;

    // 1. Global JS errors (ErrorUtils is provided by React Native)
    const globalAny = globalThis as any;
    const errorUtils = globalAny.ErrorUtils;
    if (errorUtils?.setGlobalHandler) {
      const previousHandler = errorUtils.getGlobalHandler?.();
      errorUtils.setGlobalHandler((error: unknown, isFatal?: boolean) => {
        try {
          this.emit("crash", {
            kind: isFatal ? "fatal" : "error",
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            isFatal: !!isFatal,
          });
          // Push immediately: the app may be about to die
          this.transport?.flush();
        } catch {
          // reporting must never make a crash worse
        }
        previousHandler?.(error, isFatal);
      });
    }

    // 2. Unhandled promise rejections (Hermes API, defensive)
    const hermes = globalAny.HermesInternal;
    if (hermes?.enablePromiseRejectionTracker) {
      try {
        hermes.enablePromiseRejectionTracker({
          allRejections: true,
          onUnhandled: (_id: number, rejection: unknown) => {
            this.emit("crash", {
              kind: "unhandledRejection",
              message:
                rejection instanceof Error
                  ? rejection.message
                  : String(rejection),
              stack: rejection instanceof Error ? rejection.stack : undefined,
              isFatal: false,
            });
            this.transport?.flush();
          },
        });
      } catch {
        // API not available on this runtime: never mind
      }
    }
  }

  // ------------------------------------------------------------------
  // Performance: JS event-loop lag (proxy for JS thread smoothness)
  // ------------------------------------------------------------------
  startPerformanceSampler(sampleEveryMs = 500, reportEveryMs = 2000): void {
    if (!this.enabled || this.perfTimer) return;

    let lastTick = Date.now();
    let samples: number[] = [];
    let lastReport = Date.now();

    this.perfTimer = setInterval(() => {
      const now = Date.now();
      const lag = Math.max(0, now - lastTick - sampleEveryMs);
      lastTick = now;
      samples.push(lag);

      if (now - lastReport >= reportEveryMs && samples.length > 0) {
        const sorted = [...samples].sort((a, b) => a - b);
        const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
        const max = sorted[sorted.length - 1] ?? 0;
        const avg = samples.reduce((sum, v) => sum + v, 0) / samples.length;

        this.emit("perf.sample", {
          jsLagAvgMs: Math.round(avg),
          jsLagP95Ms: p95,
          jsLagMaxMs: max,
          uptimeMs: now - this.startedAt,
        });

        samples = [];
        lastReport = now;
      }
    }, sampleEveryMs);
  }

  /**
   * What is attached right now, so an empty answer can be explained.
   *
   * Nothing here is derived from the event history: an app that made no
   * request and an app whose fetch was never wrapped produce the same
   * empty history, and only the runtime knows which one it is.
   */
  instrumentation(): InstrumentationReport {
    return {
      network: {
        instrumented: this.wraps.some((wrap) => wrap.active),
        wraps: this.wraps.map((wrap) => ({ ...wrap })),
      },
      uiAutomation: this.automationAttached,
      determinism: this.determinism !== null,
      originTracking: this.trackOrigin,
      console: this.consoleAttached,
      stores: this.stores ? this.stores.names() : [],
      actions: [...this.actions.keys()],
      previews: this.previews ? this.previews.names() : [],
    };
  }

  // Exposed for tests
  get __transport(): DevtoolsTransport | null {
    return this.transport;
  }
}

export const devtools = new Devtools();
export { DevtoolsTransport } from "./transport";
export { truncateForWire, redactHeaders, redactBody, redactSecrets, isSensitiveKey } from "./types";
export { collectRuntimeContext } from "./context";
export { resolveSource, componentNameOf } from "./source";
export { PREVIEW_OUTLET_TEST_ID } from "./preview";
export type { PreviewFactory } from "./preview";
export { zustandStore, reduxStore, reactQueryStore, readPath, applyPatch } from "./state";
export { conditionProfile, matchRule, createClock, createNetworkControl } from "./determinism";
export type { NetworkRule, NetworkCondition } from "./determinism";
export type { StoreAdapter, ZustandLike, ReduxLike, QueryClientLike } from "./state";
export type { SourceLocation, SourceVia } from "./source";
export type { RuntimeContext, RendererInfo } from "./context";
export type { UiNode, UiSelector, UiAbsence, FiberLike } from "./automation";
export type {
  ActionDefinition,
  CommandHandler,
  DevtoolsEvent,
  DevtoolsInitOptions,
} from "./types";
