/**
 * What every hub plugin talking to a vendor API needs, and nothing else.
 *
 * Signing and HTTP only. No credential ever appears in a thrown message
 * or a returned payload: what leaves this file is a decoded body or a
 * one-line explanation of why the call failed, because everything a
 * plugin returns lands in a model's context window.
 *
 * The JOSE signatures are built by hand for the same reason the hub
 * implements its own WebSocket framing: a package to sign a JWT would
 * contradict the argument printed on the box. node:crypto has the
 * primitives; only the encoding is missing.
 *
 * Files here whose name starts with "_" are helpers, not plugins: the
 * loader skips them.
 */

import { createSign } from "node:crypto";

export const base64url = (value) =>
  Buffer.from(value).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

/** One DER INTEGER, minus the sign padding a fixed-width field must not keep */
const readInteger = (der, offset) => {
  if (der[offset] !== 0x02) throw new Error("Malformed ECDSA signature: expected an INTEGER");
  const end = offset + 2 + der[offset + 1];
  let start = offset + 2;
  while (der[start] === 0x00 && end - start > 1) start += 1;
  return { bytes: der.subarray(start, end), next: end };
};

/**
 * DER (what node:crypto signs with) to P1363 (what JOSE reads).
 *
 * Node can emit the second form directly through dsaEncoding, but that
 * option is a Node extension and this hub must also run on Bun, so the
 * twenty lines of conversion are cheaper than the compatibility bet.
 */
export const derToJose = (der, size = 32) => {
  if (der[0] !== 0x30) throw new Error("Malformed ECDSA signature: expected a SEQUENCE");
  // A long-form length prefixes its own byte count; short form is one byte
  const offset = der[1] & 0x80 ? 2 + (der[1] & 0x7f) : 2;
  const r = readInteger(der, offset);
  const s = readInteger(der, r.next);
  if (r.bytes.length > size || s.bytes.length > size) throw new Error("ECDSA signature wider than the curve");
  const out = Buffer.alloc(size * 2);
  Buffer.from(r.bytes).copy(out, size - r.bytes.length);
  Buffer.from(s.bytes).copy(out, size * 2 - s.bytes.length);
  return out;
};

const ALGORITHMS = {
  ES256: { digest: "SHA256", jose: 32 },
  RS256: { digest: "RSA-SHA256", jose: null },
};

/** A signed compact JWT. The private key never leaves this frame. */
export const signJwt = ({ algorithm, header = {}, claims, privateKey }) => {
  const spec = ALGORITHMS[algorithm];
  if (!spec) throw new Error(`Unsupported JWT algorithm: ${algorithm}`);
  const signingInput = [
    base64url(JSON.stringify({ ...header, alg: algorithm, typ: "JWT" })),
    base64url(JSON.stringify(claims)),
  ].join(".");

  let signature;
  try {
    const signer = createSign(spec.digest);
    signer.update(signingInput);
    signature = signer.sign(privateKey);
  } catch (error) {
    // The usual cause is a key that is not the one the API expects (a .pem
    // where a .p8 belongs, a truncated paste). Say that, not the raw error.
    throw new Error(`The private key could not sign a ${algorithm} token: ${error?.message ?? error}`);
  }
  return `${signingInput}.${base64url(spec.jose ? derToJose(signature, spec.jose) : signature)}`;
};

/** The first line of an error, folded to something a log can hold */
export const oneLine = (value, limit = 400) =>
  String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);

/**
 * A JSON call to a vendor API, with its failures translated.
 *
 * An agent reading "401" learns nothing it can act on. Every provider
 * states what went wrong in its own error shape, so each plugin passes
 * an `explain` that pulls that sentence out, and this adds what the
 * status alone means for the credentials in play.
 */
export const apiJson = async (url, { label, explain, timeoutMs = 20000, ...init } = {}) => {
  let response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const reason = error?.name === "TimeoutError"
      ? `no answer after ${timeoutMs}ms`
      : oneLine(error?.message ?? error, 160);
    throw new Error(`${label} is unreachable: ${reason}`);
  }

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (response.ok) return data;

  const detail = (explain?.(data) ?? "") || oneLine(text, 200) || "no detail";
  const context =
    response.status === 401 ? " (the credentials were rejected: wrong key, or a token this API will not accept)"
    : response.status === 403 ? " (authenticated, but this key has no access to that resource)"
    : response.status === 404 ? " (no such resource for this account)"
    : response.status === 429 ? " (rate limited by the API, retry later)"
    : "";
  throw new Error(`${label} answered ${response.status}${context}: ${detail}`);
};

/** Query string with the empty values dropped, so callers can pass undefined */
export const query = (params) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const rendered = search.toString();
  return rendered ? `?${rendered}` : "";
};

/** Keep only the fields we know how to name, and only when present */
export const project = (source, keys) => {
  const out = {};
  for (const key of keys) {
    if (source?.[key] !== undefined) out[key] = source[key];
  }
  return out;
};
