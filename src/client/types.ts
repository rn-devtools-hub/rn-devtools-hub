/**
 * Shared types for the devtools SDK (app side).
 * This folder is designed to be extracted as a standalone npm package:
 * no external dependency, no reference to the host app's code.
 */

export interface DevtoolsEvent {
  /** Unique incrementing identifier per session */
  id: number;
  /** Event type, e.g. "network.request", "console", "perf.sample" */
  type: string;
  /** Epoch timestamp in ms */
  ts: number;
  /** JSON-serializable payload */
  payload: unknown;
}

export interface DevtoolsInitOptions {
  /** Hub URL, e.g. ws://192.168.1.20:8973 */
  serverUrl: string;
  /** App name shown in the dashboard */
  appName: string;
  /** Device name (model, platform...) */
  deviceName?: string;
  /** STABLE device identifier: app reloads reconnect under the same
   * entry in the hub instead of creating ghost sessions */
  stableId?: string;
  /** Max size of the offline buffer (default 1000) */
  maxBufferSize?: number;
  /** Batch flush interval in ms (default 300) */
  flushIntervalMs?: number;
}

export type CommandHandler = (
  payload: unknown
) => Promise<unknown> | unknown;

export interface IncomingCommand {
  type: "command";
  command: string;
  requestId?: string;
  payload?: unknown;
}

export interface ActionDefinition {
  name: string;
  label: string;
  /** Asks for a confirmation in the dashboard before running */
  danger?: boolean;
  /** Requires a development build (disabled in Expo Go) */
  requiresNative?: boolean;
}

/** Recursively truncates a value for serialization (network payloads, cache...).
 * Generous limits: we prefer showing complete data in the dashboard. */
export const truncateForWire = (
  value: unknown,
  maxStringLength = 20000,
  maxDepth = 8
): unknown => {
  const seen = new WeakSet<object>();

  const walk = (input: unknown, depth: number): unknown => {
    if (input === null || input === undefined) return input;
    if (typeof input === "string") {
      return input.length > maxStringLength
        ? `${input.slice(0, maxStringLength)}… [truncated ${input.length} chars]`
        : input;
    }
    if (typeof input === "number" || typeof input === "boolean") return input;
    if (typeof input === "function") return "[function]";
    if (depth >= maxDepth) return "[max depth]";
    if (typeof input === "object") {
      if (seen.has(input as object)) return "[circular]";
      seen.add(input as object);

      if (Array.isArray(input)) {
        const capped = input.slice(0, 300).map((item) => walk(item, depth + 1));
        if (input.length > 300) capped.push(`[+${input.length - 300} items]` as never);
        return capped;
      }

      const out: Record<string, unknown> = {};
      let count = 0;
      for (const key of Object.keys(input as object)) {
        if (count++ >= 300) {
          out["…"] = "[truncated object]";
          break;
        }
        out[key] = walk((input as Record<string, unknown>)[key], depth + 1);
      }
      return out;
    }
    return String(input);
  };

  return walk(value, 0);
};

/** Redacts sensitive values in HTTP headers */
export const redactHeaders = (
  headers: Record<string, unknown> | undefined
): Record<string, unknown> => {
  if (!headers) return {};
  const SENSITIVE = ["authorization", "x-api-key", "cookie", "set-cookie"];
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(headers)) {
    out[key] = SENSITIVE.includes(key.toLowerCase())
      ? "•••redacted•••"
      : headers[key];
  }
  return out;
};
