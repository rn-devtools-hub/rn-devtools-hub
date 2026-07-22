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
 *   devtools.markScreenReady("Login")         // "screen ready" signal for agents
 */

import { installUiAutomation } from "./automation";
import { DevtoolsTransport } from "./transport";
import {
  ActionDefinition,
  CommandHandler,
  DevtoolsInitOptions,
  redactHeaders,
  truncateForWire,
} from "./types";

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

  get enabled(): boolean {
    return this.transport !== null;
  }

  init(options: DevtoolsInitOptions): void {
    // Built-in safeguard: never active in production, even if the host app
    // forgets its own __DEV__ guard (lesson learned from Rozenite)
    if (typeof __DEV__ !== "undefined" && !__DEV__) return;
    if (this.transport) return; // already initialized
    this.transport = new DevtoolsTransport(options);
    this.transport.start();
    this.startedAt = Date.now();
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

  emit(type: string, payload: unknown): void {
    this.transport?.enqueue(type, truncateForWire(payload));
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
      const name = String((payload as { name?: string })?.name ?? "");
      const action = this.actions.get(name);
      if (!action) throw new Error(`Unknown action: ${name}`);
      return action.handler(payload);
    });
    this.emit("actions.register", {
      actions: Array.from(this.actions.values()).map((a) => a.definition),
    });
  }

  // ------------------------------------------------------------------
  // UI automation for agents (MCP): ui.tree / ui.query / ui.act
  // ------------------------------------------------------------------
  private automationAttached = false;

  /** Enables runtime UI perception and actions for AI agents.
   * Call it at startup (with the other attach* calls) so the React
   * roots are observed from the first render. */
  attachUiAutomation(): void {
    if (!this.enabled || this.automationAttached) return;
    this.automationAttached = true;
    installUiAutomation({
      onCommand: (command, handler) => this.transport?.onCommand(command, handler),
      emit: (type, payload) => this.emit(type, payload),
    });
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
        headers: redactHeaders(this.flattenAxiosHeaders(config.headers)),
        body: config.data,
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
          headers: redactHeaders(response.headers),
          body: response.data,
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
          body: error?.response?.data,
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
        headers: redactHeaders(init?.headers),
        // Do not serialize binary bodies (File/Blob from uploads)
        body:
          typeof init?.body === "string"
            ? init.body
            : init?.body
              ? "[binary]"
              : undefined,
      });

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

  // Exposed for tests
  get __transport(): DevtoolsTransport | null {
    return this.transport;
  }
}

export const devtools = new Devtools();
export { DevtoolsTransport } from "./transport";
export { truncateForWire, redactHeaders } from "./types";
export type { UiNode, UiSelector, FiberLike } from "./automation";
export type {
  ActionDefinition,
  CommandHandler,
  DevtoolsEvent,
  DevtoolsInitOptions,
} from "./types";
