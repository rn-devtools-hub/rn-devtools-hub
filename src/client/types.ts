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
  /** Max bytes per batch sent to the hub (default 262144). A buffer that
   * filled up while offline is drained over several sends rather than in
   * one burst on the JS thread. */
  maxBatchBytes?: number;
  /** Field names this project treats as secret, on top of the built-in
   * list. Matched on the whole key, case-insensitively. */
  redactKeys?: string[];
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
  /** What the action does, shown to agents by list_actions */
  description?: string;
  /** Free-form JSON schema of the args the handler accepts */
  argsSchema?: Record<string, unknown>;
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

export const REDACTED = "•••redacted•••";

/**
 * Words that name a credential. Matched against the PARTS of a key, split
 * on separators and on camelCase, never as a substring: "author" must not
 * read as "auth", and a plain "key" is a field name in half the payloads
 * in existence. Compounds like "api key" are matched on adjacent parts.
 */
const SENSITIVE_WORDS = new Set([
  "password", "passwd", "pwd", "passphrase",
  "secret", "secrets",
  "token", "tokens", "jwt", "bearer",
  "credential", "credentials",
  "authorization", "authorisation", "auth",
  "cookie", "cookies",
  "session", "sessionid",
  "apikey", "apisecret",
  "otp", "totp", "mfa",
  "signature", "sig",
  "cvv", "cvc", "ssn", "pan",
]);

const SENSITIVE_PAIRS = new Set([
  "api key", "api secret", "private key", "secret key", "access key",
  "client secret", "card number", "account number", "security code",
]);

const keyParts = (key: string): string[] =>
  key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9]+/)
    .map((part) => part.toLowerCase())
    .filter(Boolean);

/** True when a field name announces a credential */
export const isSensitiveKey = (key: string, extra: string[] = []): boolean => {
  const parts = keyParts(key);
  if (!parts.length) return false;
  if (parts.some((part) => SENSITIVE_WORDS.has(part))) return true;
  for (let index = 0; index + 1 < parts.length; index += 1) {
    if (SENSITIVE_PAIRS.has(`${parts[index]} ${parts[index + 1]}`)) return true;
  }
  const lower = key.toLowerCase();
  return extra.some((candidate) => candidate.toLowerCase() === lower);
};

/**
 * Values that carry a credential whatever they are called. A token pasted
 * into a field named `data` is still a token.
 */
const SENSITIVE_VALUE = [
  /^bearer\s+\S+/i,
  /^basic\s+[A-Za-z0-9+/=]{8,}$/i,
  /^ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./, // JWT
  /^(sk|pk|rk)_(live|test)_[A-Za-z0-9]{8,}$/, // provider secret keys
  /^gh[pousr]_[A-Za-z0-9]{20,}$/, // GitHub tokens
  /^xox[baprs]-[A-Za-z0-9-]{10,}$/, // Slack tokens
  /^-{5}BEGIN [A-Z ]*PRIVATE KEY-{5}/,
];

const looksSecret = (value: string): boolean =>
  SENSITIVE_VALUE.some((pattern) => pattern.test(value));

/**
 * Removes credentials from anything about to leave the device.
 *
 * Header names were the only thing ever redacted, and only four of them,
 * while the request and response BODIES went out whole. A password field,
 * an access token in a login response or a client secret in a webhook
 * payload therefore reached the hub, the dashboard and, through MCP, the
 * context window of a model. Truncating a payload is not redacting it.
 *
 * What was hidden is reported rather than hidden twice: the caller gets
 * the paths, so a field that mattered can be renamed instead of leaving
 * the reader wondering where the value went.
 */
export const redactSecrets = (
  value: unknown,
  extraKeys: string[] = [],
  maxDepth = 8,
): { value: unknown; redacted: string[] } => {
  const redacted: string[] = [];
  const seen = new WeakSet<object>();

  const walk = (input: unknown, path: string, depth: number, keyIsSensitive: boolean): unknown => {
    if (typeof input === "string") {
      if (keyIsSensitive || looksSecret(input)) {
        if (redacted.length < 50) redacted.push(path || "(root)");
        return REDACTED;
      }
      return input;
    }
    if (keyIsSensitive && (typeof input === "number" || typeof input === "boolean")) {
      if (redacted.length < 50) redacted.push(path || "(root)");
      return REDACTED;
    }
    if (!input || typeof input !== "object" || depth >= maxDepth) return input;
    if (seen.has(input as object)) return input;
    seen.add(input as object);

    if (Array.isArray(input)) {
      return input.map((item, index) => walk(item, `${path}[${index}]`, depth + 1, keyIsSensitive));
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(input as Record<string, unknown>)) {
      const child = (input as Record<string, unknown>)[key];
      const childPath = path ? `${path}.${key}` : key;
      out[key] = walk(child, childPath, depth + 1, isSensitiveKey(key, extraKeys));
    }
    return out;
  };

  return { value: walk(value, "", 0, false), redacted };
};

const FORM_ENCODED = /^[\w.[\]%-]+=[^&]*(&[\w.[\]%-]+=[^&]*)*$/;

/**
 * Redacts a request or response body, whatever shape it arrived in.
 *
 * A body is most often a STRING holding JSON, so redacting objects only
 * would have missed the very payload that carries the password: the one
 * the app just serialized.
 */
export const redactBody = (
  body: unknown,
  extraKeys: string[] = [],
): { value: unknown; redacted: string[] } => {
  if (typeof body !== "string") return redactSecrets(body, extraKeys);
  const trimmed = body.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      const result = redactSecrets(parsed, extraKeys);
      return result.redacted.length
        ? { value: JSON.stringify(result.value), redacted: result.redacted }
        : { value: body, redacted: [] };
    } catch {
      // not JSON after all: fall through to the string rules
    }
  }
  if (FORM_ENCODED.test(trimmed) && trimmed.includes("=")) {
    const redacted: string[] = [];
    const rebuilt = trimmed
      .split("&")
      .map((pair) => {
        const separator = pair.indexOf("=");
        const key = decodeURIComponent(pair.slice(0, separator));
        if (!isSensitiveKey(key, extraKeys)) return pair;
        redacted.push(key);
        return `${pair.slice(0, separator)}=${REDACTED}`;
      })
      .join("&");
    return redacted.length ? { value: rebuilt, redacted } : { value: body, redacted: [] };
  }
  return looksSecret(trimmed)
    ? { value: REDACTED, redacted: ["(body)"] }
    : { value: body, redacted: [] };
};

/** Redacts sensitive values in HTTP headers */
export const redactHeaders = (
  headers: Record<string, unknown> | undefined,
  extraKeys: string[] = []
): Record<string, unknown> => {
  if (!headers) return {};
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(headers)) {
    out[key] = isSensitiveKey(key, extraKeys) ? REDACTED : headers[key];
  }
  return out;
};
