/**
 * The plugin contract.
 *
 * A plugin is the one place where this hub stops being local-only, so
 * what is asserted here is mostly what must NOT happen: a secret coming
 * back out, a tool an agent cannot call sitting in its tool list, a
 * plugin tool shadowing a hub tool, a Play edit left open on a listing.
 *
 * Nothing here touches the network: the vendor APIs are stubbed, which is
 * also the only way to assert what was sent to them.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPrivateKey, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { Buffer } from "node:buffer";
// @ts-expect-error plain JS module, no types
import { createPluginHost, resolveConfig, validatePlugin } from "../server/plugins.mjs";
// @ts-expect-error plain JS module, no types
import { base64url, derToJose, signJwt } from "../server/plugins/_api.mjs";
// @ts-expect-error plain JS module, no types
import asc, { CONTRACT as ASC_CONTRACT } from "../server/plugins/asc.mjs";
// @ts-expect-error plain JS module, no types
import gplay, { CONTRACT as GPLAY_CONTRACT } from "../server/plugins/gplay.mjs";

const tool = (name: string) => ({
  name,
  description: "does something",
  inputSchema: { type: "object", properties: {} },
});

const fakePlugin = (overrides: Record<string, unknown> = {}) => ({
  id: "demo",
  title: "Demo",
  hosts: ["example.test"],
  tools: [tool("demo_ping")],
  handle: async (name: string, args: Record<string, unknown>) => ({ name, args }),
  ...overrides,
});

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rn-devtools-plugins-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const writeProject = (config: Record<string, unknown>) =>
  writeFileSync(join(root, "app.json"), JSON.stringify({ expo: config }));

const writePluginConfig = (config: Record<string, unknown>) => {
  mkdirSync(join(root, ".rn-devtools"), { recursive: true });
  writeFileSync(join(root, ".rn-devtools", "plugins.json"), JSON.stringify(config));
};

describe("plugin validation", () => {
  it("accepts a well-formed plugin", () => {
    expect(validatePlugin(fakePlugin())).toBeNull();
  });

  it("refuses a tool that does not carry its plugin's prefix", () => {
    // The prefix is what makes the owner readable from the call itself,
    // in a tool log where every plugin's calls are mixed together
    const invalid = validatePlugin(fakePlugin({ tools: [tool("ping")] }));
    expect(invalid).toMatch(/must start with "demo_"/);
  });

  it("refuses a tool that collides with a hub tool", () => {
    const invalid = validatePlugin(fakePlugin({ id: "assert2", tools: [tool("assert2_run")] }), {
      reserved: new Set(["assert2_run"]),
    });
    expect(invalid).toMatch(/collides with a hub tool/);
  });

  it("refuses a tool a second plugin already provides", () => {
    const invalid = validatePlugin(fakePlugin(), { taken: new Set(["demo_ping"]) });
    expect(invalid).toMatch(/already provided by another plugin/);
  });

  it("refuses an id that is not a namespace, a plugin with no tool and a tool with no schema", () => {
    expect(validatePlugin(fakePlugin({ id: "Demo Plugin" }))).toMatch(/invalid id/);
    expect(validatePlugin(fakePlugin({ tools: [] }))).toMatch(/declares no tool/);
    expect(validatePlugin(fakePlugin({ tools: [{ name: "demo_ping", description: "x" }] }))).toMatch(/no inputSchema/);
    expect(validatePlugin(fakePlugin({ handle: undefined }))).toMatch(/no handle/);
  });
});

describe("configuration resolution", () => {
  const plugin = {
    id: "demo",
    config: [
      { key: "token", env: ["DEMO_TOKEN"], pathEnv: ["DEMO_TOKEN_PATH"], secret: true, description: "a secret" },
      { key: "appId", env: ["DEMO_APP"], required: false, derive: ({ appConfig }: any) => appConfig?.slug ?? null },
    ],
  };

  it("prefers an env var, and records where the value came from", () => {
    const resolved = resolveConfig(plugin, { env: { DEMO_TOKEN: "s3cret" }, projectRoot: root });
    expect(resolved.values.token).toBe("s3cret");
    expect(resolved.entries.find((entry: any) => entry.key === "token").source).toBe("env:DEMO_TOKEN");
  });

  it("reads the file a path env var points at", () => {
    writeFileSync(join(root, "key.pem"), "PRIVATE");
    const resolved = resolveConfig(plugin, { env: { DEMO_TOKEN_PATH: join(root, "key.pem") }, projectRoot: root });
    expect(resolved.values.token).toBe("PRIVATE");
    expect(resolved.entries.find((entry: any) => entry.key === "token").source).toMatch(/^file:/);
  });

  it("names a path that cannot be read instead of reporting it as unset", () => {
    // Silently falling through would read as "not configured" and send the
    // user back to set a variable they had already set
    const resolved = resolveConfig(plugin, { env: { DEMO_TOKEN_PATH: join(root, "absent.pem") }, projectRoot: root });
    expect(resolved.missing[0].description).toMatch(/cannot be read/);
  });

  it("reads plugins.json and its <key>Path sibling", () => {
    writeFileSync(join(root, "key.pem"), "FROM FILE");
    const direct = resolveConfig(plugin, { env: {}, projectRoot: root, file: { demo: { token: "inline" } } });
    expect(direct.values.token).toBe("inline");
    const viaPath = resolveConfig(plugin, { env: {}, projectRoot: root, file: { demo: { tokenPath: "key.pem" } } });
    expect(viaPath.values.token).toBe("FROM FILE");
  });

  it("derives from the project rather than asking for what app.json already says", () => {
    writeProject({ slug: "my-app" });
    const resolved = resolveConfig(plugin, { env: {}, projectRoot: root });
    expect(resolved.values.appId).toBe("my-app");
    expect(resolved.entries.find((entry: any) => entry.key === "appId").source).toBe("project:app.json");
  });

  it("never carries a secret's value in what it describes", () => {
    const resolved = resolveConfig(plugin, { env: { DEMO_TOKEN: "s3cret" }, projectRoot: root });
    expect(JSON.stringify(resolved.entries)).not.toContain("s3cret");
  });

  it("reports an optional key as present without it blocking readiness", () => {
    const resolved = resolveConfig(plugin, { env: { DEMO_TOKEN: "s3cret" }, projectRoot: root });
    expect(resolved.missing).toEqual([]);
  });
});

describe("registry", () => {
  const source = (body: string) => {
    const file = join(root, "demo.mjs");
    writeFileSync(file, body);
    return file;
  };

  const demoModule = `
    export default {
      id: "demo",
      title: "Demo",
      hosts: ["example.test"],
      setupHint: "Set DEMO_TOKEN.",
      config: [{ key: "token", env: ["DEMO_TOKEN"], secret: true, description: "a secret" }],
      tools: [{ name: "demo_ping", description: "pings", inputSchema: { type: "object", properties: {} } }],
      handle: async (name, args, ctx) => ({ name, args, token: ctx.config.token }),
    };
  `;

  it("lists an unconfigured plugin but exposes none of its tools", async () => {
    const host = await createPluginHost({ projectRoot: root, env: {}, sources: [source(demoModule)] });
    expect(host.tools()).toEqual([]);
    const described = host.describe().plugins[0];
    expect(described.ready).toBe(false);
    // The tools are named even though they are not offered: an agent
    // needs to know what configuring the plugin would unlock
    expect(described.tools).toEqual(["demo_ping"]);
    expect(described.missing[0].key).toBe("token");
  });

  it("refuses a call to an unconfigured tool with what is missing and how to set it", async () => {
    const host = await createPluginHost({ projectRoot: root, env: {}, sources: [source(demoModule)] });
    await expect(host.handle("demo_ping", {})).rejects.toThrow(/not configured.*token.*Set DEMO_TOKEN/s);
  });

  it("exposes and dispatches once configured", async () => {
    const host = await createPluginHost({
      projectRoot: root,
      env: { DEMO_TOKEN: "s3cret" },
      sources: [source(demoModule)],
    });
    expect(host.tools().map((entry: any) => entry.name)).toEqual(["demo_ping"]);
    expect(host.owns("demo_ping")).toBe(true);
    await expect(host.handle("demo_ping", { a: 1 })).resolves.toEqual({
      name: "demo_ping",
      args: { a: 1 },
      token: "s3cret",
    });
  });

  it("disables a plugin that fails to load instead of taking the hub down", async () => {
    const host = await createPluginHost({
      projectRoot: root,
      env: {},
      sources: [source("export default { id: 'Nope' };")],
    });
    expect(host.records).toEqual([]);
    expect(host.failures.join(" ")).toMatch(/refused/);
    expect(host.describe().failures.length).toBe(1);
  });

  it("declares the hosts a configured plugin will contact, in the banner", async () => {
    const host = await createPluginHost({
      projectRoot: root,
      env: { DEMO_TOKEN: "s3cret" },
      sources: [source(demoModule)],
    });
    expect(host.banner().join("\n")).toContain("example.test");
  });

  it("ships App Store Connect and Google Play as built-ins", async () => {
    const host = await createPluginHost({ projectRoot: root, env: {} });
    expect(host.describe().plugins.map((entry: any) => entry.id).sort()).toEqual(["asc", "gplay"]);
  });
});

describe("JWT signing", () => {
  const ec = generateKeyPairSync("ec", {
    namedCurve: "P-256",
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const rsa = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });

  const parts = (jwt: string) => {
    const [header, claims, signature] = jwt.split(".");
    return {
      header: JSON.parse(Buffer.from(header, "base64url").toString()),
      claims: JSON.parse(Buffer.from(claims, "base64url").toString()),
      signature: Buffer.from(signature, "base64url"),
      signingInput: `${header}.${claims}`,
    };
  };

  it("signs ES256 in the fixed-width form JOSE reads, not the DER one node emits", () => {
    const jwt = signJwt({
      algorithm: "ES256",
      header: { kid: "KEY" },
      claims: { iss: "issuer", aud: "appstoreconnect-v1" },
      privateKey: ec.privateKey,
    });
    const { header, signature, signingInput } = parts(jwt);
    expect(header).toEqual({ kid: "KEY", alg: "ES256", typ: "JWT" });
    // A DER signature is 70 to 72 bytes and Apple rejects it outright
    expect(signature.length).toBe(64);
    const valid = verify(
      "sha256",
      Buffer.from(signingInput),
      { key: createPublicKey(ec.publicKey), dsaEncoding: "ieee-p1363" },
      signature,
    );
    expect(valid).toBe(true);
  });

  it("signs RS256 with the service account key", () => {
    const jwt = signJwt({
      algorithm: "RS256",
      header: { kid: "abc" },
      claims: { iss: "sa@example.iam.gserviceaccount.com", scope: "s" },
      privateKey: rsa.privateKey,
    });
    const { signature, signingInput } = parts(jwt);
    expect(verify("RSA-SHA256", Buffer.from(signingInput), createPublicKey(rsa.publicKey), signature)).toBe(true);
  });

  it("explains a key that cannot sign instead of leaking the crypto error", () => {
    expect(() =>
      signJwt({ algorithm: "ES256", claims: {}, privateKey: "not a key" }),
    ).toThrow(/private key could not sign/);
  });

  it("refuses an algorithm it does not implement", () => {
    expect(() => signJwt({ algorithm: "HS256", claims: {}, privateKey: "x" })).toThrow(/Unsupported/);
  });

  it("left-pads each half of an ECDSA signature to the curve width", () => {
    // 0x02 0x01 0x05 is a one-byte r: it belongs at the END of its half,
    // and a naive concatenation would produce a signature off by 31 bytes
    const der = Buffer.from([0x30, 0x06, 0x02, 0x01, 0x05, 0x02, 0x01, 0x07]);
    const jose = derToJose(der, 32);
    expect(jose.length).toBe(64);
    expect(jose[31]).toBe(5);
    expect(jose[63]).toBe(7);
  });

  it("strips the sign padding DER adds to a high first byte", () => {
    const der = Buffer.from([0x30, 0x08, 0x02, 0x02, 0x00, 0xff, 0x02, 0x02, 0x00, 0x81]);
    const jose = derToJose(der, 32);
    expect(jose[31]).toBe(0xff);
    expect(jose[63]).toBe(0x81);
  });

  it("produces url-safe base64 with no padding", () => {
    expect(base64url(Buffer.from([251, 255, 190]))).toBe("-_--");
  });
});

/** A stub for the vendor APIs, which also records what was sent */
const stubFetch = (routes: Array<{ match: RegExp; method?: string; status?: number; body: unknown }>) => {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: string | null }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = String(input);
    const method = (init.method ?? "GET").toUpperCase();
    calls.push({ url, method, headers: (init.headers ?? {}) as Record<string, string>, body: init.body ?? null });
    const route = routes.find((entry) => entry.match.test(url) && (!entry.method || entry.method === method));
    if (!route) return new Response(JSON.stringify({ error: { message: `unrouted ${method} ${url}` } }), { status: 500 });
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
};

describe("App Store Connect", () => {
  const ec = generateKeyPairSync("ec", {
    namedCurve: "P-256",
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const ctx = () => ({
    config: { keyId: "KEY", issuerId: "ISSUER", privateKey: ec.privateKey, bundleId: "com.acme.app" },
    projectRoot: root,
    state: {} as Record<string, unknown>,
  });

  it("resolves the app from its bundle id and lists builds newest first", async () => {
    const stub = stubFetch([
      { match: /\/v1\/apps\?/, body: { data: [{ id: "42", attributes: { bundleId: "com.acme.app", name: "Acme" } }] } },
      {
        match: /\/v1\/builds/,
        body: {
          data: [{
            id: "b1",
            attributes: { version: "104", processingState: "VALID", uploadedDate: "2026-08-01T10:00:00Z", expired: false },
            relationships: { preReleaseVersion: { data: { id: "p1", type: "preReleaseVersions" } } },
          }],
          included: [{ id: "p1", type: "preReleaseVersions", attributes: { version: "1.4.0", platform: "IOS" } }],
        },
      },
    ]);
    try {
      const result: any = await asc.handle("asc_list_builds", {}, ctx());
      expect(result.app).toEqual({ id: "42", bundleId: "com.acme.app", name: "Acme" });
      expect(result.builds[0]).toMatchObject({ buildNumber: "104", version: "1.4.0", processingState: "VALID" });
      expect(stub.calls[0].url).toContain("filter%5BbundleId%5D=com.acme.app");
      expect(stub.calls[1].headers.authorization).toMatch(/^Bearer ey/);
    } finally {
      stub.restore();
    }
  });

  it("reuses one signed token across calls", async () => {
    const stub = stubFetch([
      { match: /\/v1\/apps\?/, body: { data: [{ id: "42", attributes: { bundleId: "com.acme.app" } }] } },
      { match: /betaGroups/, body: { data: [] } },
    ]);
    try {
      const shared = ctx();
      await asc.handle("asc_list_beta_groups", {}, shared);
      await asc.handle("asc_list_beta_groups", {}, shared);
      const tokens = new Set(stub.calls.map((call) => call.headers.authorization));
      expect(tokens.size).toBe(1);
      // The app lookup is cached too: two calls, not four
      expect(stub.calls.length).toBe(3);
    } finally {
      stub.restore();
    }
  });

  it("says which bundle identifier it looked for when the account has no such app", async () => {
    const stub = stubFetch([{ match: /\/v1\/apps\?/, body: { data: [] } }]);
    try {
      await expect(asc.handle("asc_list_versions", {}, ctx())).rejects.toThrow(/com.acme.app.*asc_list_apps/s);
    } finally {
      stub.restore();
    }
  });

  it("turns an Apple error document into one actionable line", async () => {
    const stub = stubFetch([
      { match: /\/v1\/apps/, status: 401, body: { errors: [{ title: "NOT_AUTHORIZED", detail: "Authentication credentials are missing or invalid" }] } },
    ]);
    try {
      await expect(asc.handle("asc_list_apps", {}, ctx())).rejects.toThrow(/401.*credentials were rejected.*NOT_AUTHORIZED/s);
    } finally {
      stub.restore();
    }
  });

  it("refuses a path that is not an API path", async () => {
    await expect(asc.handle("asc_request", { path: "https://evil.test/v1/apps" }, ctx())).rejects.toThrow(/Invalid path/);
    await expect(asc.handle("asc_request", { path: "/v1/../secrets" }, ctx())).rejects.toThrow(/Invalid path/);
  });

  it("derives the bundle identifier from app.json when nothing sets it", () => {
    writeProject({ ios: { bundleIdentifier: "com.acme.derived" } });
    const resolved = resolveConfig(asc, { env: {}, projectRoot: root });
    expect(resolved.values.bundleId).toBe("com.acme.derived");
  });
});

describe("Google Play", () => {
  const rsa = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const account = JSON.stringify({
    type: "service_account",
    client_email: "bot@acme.iam.gserviceaccount.com",
    private_key_id: "k1",
    private_key: rsa.privateKey,
  });
  const ctx = () => ({
    config: { serviceAccount: account, packageName: "com.acme.app" },
    projectRoot: root,
    state: {} as Record<string, unknown>,
  });

  const token = { match: /oauth2\.googleapis\.com/, body: { access_token: "ya29.token", expires_in: 3600 } };

  it("opens an edit, reads the tracks through it and deletes it", async () => {
    const stub = stubFetch([
      token,
      { match: /\/edits$/, method: "POST", body: { id: "edit-1" } },
      { match: /\/edits\/edit-1\/tracks$/, body: { tracks: [{ track: "production", releases: [{ name: "1.4.0", versionCodes: ["104"], status: "inProgress", userFraction: 0.1 }] }] } },
      { match: /\/edits\/edit-1$/, method: "DELETE", body: {} },
    ]);
    try {
      const result: any = await gplay.handle("gplay_list_tracks", {}, ctx());
      expect(result.tracks[0]).toMatchObject({ track: "production" });
      expect(result.tracks[0].releases[0]).toMatchObject({ status: "inProgress", userFraction: 0.1 });
      expect(stub.calls.some((call) => call.method === "DELETE" && call.url.endsWith("/edits/edit-1"))).toBe(true);
    } finally {
      stub.restore();
    }
  });

  it("deletes the edit even when the read fails", async () => {
    // An edit left open holds a lock on the listing that someone has to
    // find and clear by hand later
    const stub = stubFetch([
      token,
      { match: /\/edits$/, method: "POST", body: { id: "edit-2" } },
      { match: /\/tracks$/, status: 403, body: { error: { message: "The caller does not have permission" } } },
      { match: /\/edits\/edit-2$/, method: "DELETE", body: {} },
    ]);
    try {
      await expect(gplay.handle("gplay_list_tracks", {}, ctx())).rejects.toThrow(/403.*does not have permission/s);
      expect(stub.calls.some((call) => call.method === "DELETE")).toBe(true);
    } finally {
      stub.restore();
    }
  });

  it("exchanges the service account key for an access token once", async () => {
    const stub = stubFetch([
      token,
      { match: /\/reviews/, body: { reviews: [] } },
    ]);
    try {
      const shared = ctx();
      await gplay.handle("gplay_list_reviews", {}, shared);
      await gplay.handle("gplay_list_reviews", {}, shared);
      expect(stub.calls.filter((call) => call.url.includes("oauth2")).length).toBe(1);
      expect(String(stub.calls[0].body)).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer");
    } finally {
      stub.restore();
    }
  });

  it("flattens a review down to what a reader needs", async () => {
    const stub = stubFetch([
      token,
      {
        match: /\/reviews/,
        body: {
          reviews: [{
            reviewId: "r1",
            authorName: "A",
            comments: [
              { userComment: { text: "crashes on open", starRating: 1, appVersionName: "1.4.0", appVersionCode: 104, androidOsVersion: 34, deviceMetadata: { productName: "Pixel 8" }, lastModified: { seconds: "1756000000" } } },
              { developerComment: { text: "thanks" } },
            ],
          }],
        },
      },
    ]);
    try {
      const result: any = await gplay.handle("gplay_list_reviews", {}, ctx());
      expect(result.reviews[0]).toMatchObject({
        reviewId: "r1",
        starRating: 1,
        text: "crashes on open",
        appVersionName: "1.4.0",
        device: "Pixel 8",
        hasDeveloperReply: true,
      });
      expect(result.reviews[0].lastModified).toBe(1756000000000);
    } finally {
      stub.restore();
    }
  });

  it("refuses an edit path through the generic request tool", async () => {
    await expect(gplay.handle("gplay_request", { path: "/applications/x/edits/1/tracks" }, ctx()))
      .rejects.toThrow(/refused here/);
  });

  it("refuses a package name that is not one", async () => {
    await expect(gplay.handle("gplay_list_tracks", { packageName: "not a package" }, ctx()))
      .rejects.toThrow(/Invalid Android package name/);
  });

  it("says what a credential that is not a service account key is missing", async () => {
    const broken = { config: { serviceAccount: "-----BEGIN PRIVATE KEY-----", packageName: "com.acme.app" }, projectRoot: root, state: {} };
    await expect(gplay.handle("gplay_list_reviews", {}, broken)).rejects.toThrow(/not JSON/);
  });

  it("derives the package name from app.json when nothing sets it", () => {
    writeProject({ android: { package: "com.acme.derived" } });
    const resolved = resolveConfig(gplay, { env: {}, projectRoot: root });
    expect(resolved.values.packageName).toBe("com.acme.derived");
  });
});

describe("plugins.json", () => {
  it("configures a plugin without any environment variable", async () => {
    writeFileSync(join(root, "key.p8"), "-----BEGIN PRIVATE KEY-----\n");
    writePluginConfig({ asc: { keyId: "K", issuerId: "I", privateKeyPath: "key.p8", bundleId: "com.acme.file" } });
    const host = await createPluginHost({ projectRoot: root, env: {} });
    const described = host.describe().plugins.find((entry: any) => entry.id === "asc");
    expect(described.ready).toBe(true);
    expect(host.tools().some((entry: any) => entry.name === "asc_list_builds")).toBe(true);
    // The path is an origin and safe to show; the bytes behind it are not
    expect(JSON.stringify(described)).not.toContain("BEGIN PRIVATE KEY");
  });

  it("reports a plugins.json that cannot be parsed instead of ignoring it", async () => {
    mkdirSync(join(root, ".rn-devtools"), { recursive: true });
    writeFileSync(join(root, ".rn-devtools", "plugins.json"), "{ oops");
    const host = await createPluginHost({ projectRoot: root, env: {} });
    expect(host.describe().configFile.error).toMatch(/not readable/);
  });
});

/**
 * Writes.
 *
 * These tools change something at Apple or Google, so what is asserted is
 * the part that cannot be undone by trying again: that a write tool is
 * labelled as one, that the switch really removes it, that a Play edit is
 * committed exactly when it should be and deleted otherwise, and that the
 * rollout combinations Play rejects are refused here with a sentence
 * instead of there with a status code.
 */
describe("write tools in the registry", () => {
  const source = (body: string) => {
    const file = join(root, "writer.mjs");
    writeFileSync(file, body);
    return file;
  };

  const writerModule = `
    export default {
      id: "writer",
      title: "Writer",
      hosts: ["example.test"],
      license: "MIT",
      config: [{ key: "token", env: ["WRITER_TOKEN"], secret: true, description: "a secret" }],
      tools: [{ name: "writer_read", description: "reads", inputSchema: { type: "object", properties: {} },
                annotations: { readOnlyHint: true } }],
      writeTools: [{ name: "writer_ship", description: "ships", inputSchema: { type: "object", properties: {} },
                     annotations: { readOnlyHint: false, destructiveHint: true } }],
      handle: async (name) => ({ name }),
    };
  `;

  const host = (env: Record<string, string>) =>
    createPluginHost({ projectRoot: root, env, sources: [source(writerModule)] });

  it("exposes the writing half by default, because a release tool that cannot release is half a tool", async () => {
    const registry = await host({ WRITER_TOKEN: "t" });
    expect(registry.tools().map((tool: any) => tool.name)).toEqual(["writer_read", "writer_ship"]);
    const described = registry.describe().plugins[0];
    expect(described.writes.enabled).toBe(true);
    expect(described.writeTools).toEqual(["writer_ship"]);
    expect(described.license).toBe("MIT");
  });

  it("removes the writing half entirely when the switch is off", async () => {
    // Not exposed rather than exposed-and-refusing: an agent never plans a
    // step that does not exist
    const registry = await host({ WRITER_TOKEN: "t", RN_DEVTOOLS_PLUGIN_WRITES: "off" });
    expect(registry.tools().map((tool: any) => tool.name)).toEqual(["writer_read"]);
    await expect(registry.handle("writer_ship", {})).rejects.toThrow(/RN_DEVTOOLS_PLUGIN_WRITES/);
  });

  it("lets one plugin be pinned read-only without touching the others", async () => {
    const registry = await host({ WRITER_TOKEN: "t", RN_DEVTOOLS_WRITER_WRITES: "read-only" });
    const described = registry.describe().plugins[0];
    expect(described.writes).toEqual({ enabled: false, disabledBy: "RN_DEVTOOLS_WRITER_WRITES" });
    await expect(registry.handle("writer_ship", {})).rejects.toThrow(/RN_DEVTOOLS_WRITER_WRITES/);
  });

  it("says the switch, not the credentials, when a configured plugin refuses a write", async () => {
    const registry = await host({ WRITER_TOKEN: "t", RN_DEVTOOLS_PLUGIN_WRITES: "off" });
    await expect(registry.handle("writer_ship", {})).rejects.toThrow(/changes something on Writer/);
  });

  it("refuses a write tool that does not announce itself as one", () => {
    const invalid = validatePlugin({
      id: "writer",
      tools: [tool("writer_read")],
      writeTools: [{ ...tool("writer_ship"), annotations: { readOnlyHint: true } }],
      handle: async () => ({}),
    });
    expect(invalid).toMatch(/must carry annotations/);
  });

  it("ships both store plugins with a license and a writing half", async () => {
    const registry = await createPluginHost({ projectRoot: root, env: {} });
    for (const plugin of registry.describe().plugins) {
      expect(plugin.license).toBe("MIT");
      expect(plugin.writeTools.length).toBeGreaterThan(0);
    }
  });
});

describe("App Store Connect writes", () => {
  const ec = generateKeyPairSync("ec", {
    namedCurve: "P-256",
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const ctx = () => ({
    config: { keyId: "KEY", issuerId: "ISSUER", privateKey: ec.privateKey, bundleId: "com.acme.app" },
    projectRoot: root,
    state: {} as Record<string, unknown>,
  });
  const app = { match: /\/v1\/apps\?/, body: { data: [{ id: "42", attributes: { bundleId: "com.acme.app", name: "Acme" } }] } };

  it("hands a build to a group matched by name", async () => {
    const stub = stubFetch([
      app,
      { match: /\/v1\/builds\?/, body: { data: [{ id: "b1", attributes: { version: "104" } }] } },
      { match: /betaGroups/, body: { data: [{ id: "g1", attributes: { name: "QA", isInternalGroup: true } }] } },
      { match: /betaGroups\/g1\/relationships\/builds/, method: "POST", body: {} },
    ]);
    try {
      const result: any = await asc.handle("asc_distribute_build", { buildNumber: "104", group: "QA" }, ctx());
      expect(result).toMatchObject({ ok: true, action: "add", group: { id: "g1", name: "QA" } });
      const relationship = stub.calls.find((call) => call.url.includes("relationships/builds"));
      expect(JSON.parse(String(relationship?.body))).toEqual({ data: [{ type: "builds", id: "b1" }] });
    } finally {
      stub.restore();
    }
  });

  it("refuses an unknown group with the real ones rather than guessing", async () => {
    const stub = stubFetch([
      app,
      { match: /\/v1\/builds\?/, body: { data: [{ id: "b1", attributes: { version: "104" } }] } },
      { match: /betaGroups/, body: { data: [{ id: "g1", attributes: { name: "QA" } }] } },
    ]);
    try {
      await expect(asc.handle("asc_distribute_build", { buildNumber: "104", group: "Beta" }, ctx()))
        .rejects.toThrow(/No TestFlight group "Beta".*Groups: QA/s);
    } finally {
      stub.restore();
    }
  });

  it("warns that an external group sees nothing until beta review passes", async () => {
    const stub = stubFetch([
      app,
      { match: /\/v1\/builds\?/, body: { data: [{ id: "b1", attributes: { version: "104" } }] } },
      { match: /betaGroups\?/, body: { data: [{ id: "g2", attributes: { name: "Public", isInternalGroup: false } }] } },
      { match: /relationships\/builds/, method: "POST", body: {} },
    ]);
    try {
      const result: any = await asc.handle("asc_distribute_build", { buildNumber: "104", group: "Public" }, ctx());
      expect(result.note).toMatch(/beta review/);
    } finally {
      stub.restore();
    }
  });

  it("creates the What to Test localization when the locale has none, patches it when it does", async () => {
    const missing = stubFetch([
      app,
      { match: /\/v1\/builds\?/, body: { data: [{ id: "b1", attributes: { version: "104" } }] } },
      { match: /betaBuildLocalizations\?/, method: "GET", body: { data: [] } },
      { match: /betaBuildLocalizations$/, method: "POST", body: { data: { id: "loc1" } } },
    ]);
    try {
      const created: any = await asc.handle("asc_set_whats_new", { buildNumber: "104", text: "fixes" }, ctx());
      expect(created.action).toBe("created");
    } finally {
      missing.restore();
    }

    const present = stubFetch([
      app,
      { match: /\/v1\/builds\?/, body: { data: [{ id: "b1", attributes: { version: "104" } }] } },
      { match: /builds\/b1\/betaBuildLocalizations/, body: { data: [{ id: "loc1", attributes: { locale: "en-US" } }] } },
      { match: /betaBuildLocalizations\/loc1/, method: "PATCH", body: {} },
    ]);
    try {
      const updated: any = await asc.handle("asc_set_whats_new", { buildNumber: "104", text: "fixes" }, ctx());
      expect(updated.action).toBe("updated");
    } finally {
      present.restore();
    }
  });

  it("prepares a version in one idempotent call and reports every step it took", async () => {
    const stub = stubFetch([
      app,
      { match: /appStoreVersions\?filter/, body: { data: [] } },
      { match: /\/v1\/appStoreVersions$/, method: "POST", body: { data: { id: "v1", attributes: {} } } },
      { match: /\/v1\/builds\?/, body: { data: [{ id: "b1", attributes: { version: "104" } }] } },
      { match: /appStoreVersions\/v1\/relationships\/build/, method: "PATCH", body: {} },
      { match: /appStoreVersions\/v1\/appStoreVersionLocalizations/, body: { data: [] } },
      { match: /\/v1\/appStoreVersionLocalizations$/, method: "POST", body: { data: { id: "l1" } } },
    ]);
    try {
      const result: any = await asc.handle(
        "asc_prepare_version",
        { version: "1.4.0", buildNumber: "104", releaseNotes: "Faster startup" },
        ctx(),
      );
      expect(result.steps.map((step: any) => `${step.step}:${step.action}`))
        .toEqual(["version:created", "build:attached", "releaseNotes:created"]);
    } finally {
      stub.restore();
    }
  });

  it("reuses an open review submission instead of creating a second Apple will refuse", async () => {
    const stub = stubFetch([
      app,
      { match: /appStoreVersions\?filter/, body: { data: [{ id: "v1", attributes: { versionString: "1.4.0" } }] } },
      { match: /reviewSubmissions\?filter/, body: { data: [{ id: "s1" }] } },
      { match: /reviewSubmissions\/s1\/items/, body: { data: [] } },
      { match: /reviewSubmissionItems$/, method: "POST", body: { data: { id: "i1" } } },
      { match: /reviewSubmissions\/s1$/, method: "PATCH", body: { data: { attributes: { state: "WAITING_FOR_REVIEW" } } } },
    ]);
    try {
      const result: any = await asc.handle("asc_submit_for_review", { version: "1.4.0" }, ctx());
      expect(result).toMatchObject({ ok: true, submissionId: "s1", reusedOpenSubmission: true, state: "WAITING_FOR_REVIEW" });
      expect(stub.calls.some((call) => call.method === "POST" && /reviewSubmissions$/.test(call.url))).toBe(false);
    } finally {
      stub.restore();
    }
  });

  it("refuses to release a version Apple is not waiting on, and names the state", async () => {
    const stub = stubFetch([
      app,
      { match: /appStoreVersions\?filter/, body: { data: [{ id: "v1", attributes: { versionString: "1.4.0", appStoreState: "IN_REVIEW" } }] } },
    ]);
    try {
      const result: any = await asc.handle("asc_release_version", { version: "1.4.0" }, ctx());
      expect(result).toMatchObject({ ok: false, reason: "not-pending-release" });
      expect(result.version.state).toBe("IN_REVIEW");
      expect(stub.calls.some((call) => call.method === "POST")).toBe(false);
    } finally {
      stub.restore();
    }
  });

  it("keeps the reading escape hatch read-only", async () => {
    await expect(asc.handle("asc_write_request", { method: "GET", path: "/v1/apps" }, ctx()))
      .rejects.toThrow(/Unsupported method/);
  });
});

describe("Google Play writes", () => {
  const rsa = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const account = JSON.stringify({
    client_email: "bot@acme.iam.gserviceaccount.com",
    private_key_id: "k1",
    private_key: rsa.privateKey,
  });
  const ctx = () => ({
    config: { serviceAccount: account, packageName: "com.acme.app" },
    projectRoot: root,
    state: {} as Record<string, unknown>,
  });
  const token = { match: /oauth2\.googleapis\.com/, body: { access_token: "ya29.token", expires_in: 3600 } };
  const openEdit = { match: /\/edits$/, method: "POST", body: { id: "e1" } };
  const commit = { match: /:commit/, method: "POST", body: { id: "e1" } };

  it("commits the edit when it writes a track, and never deletes it", async () => {
    const stub = stubFetch([
      token,
      openEdit,
      commit,
      { match: /tracks\/production$/, method: "GET", body: { track: "production", releases: [{ versionCodes: ["104"], status: "completed" }] } },
      { match: /tracks\/production$/, method: "PUT", body: { track: "production", releases: [{ versionCodes: ["104"], status: "inProgress", userFraction: 0.1 }] } },
    ]);
    try {
      const result: any = await gplay.handle(
        "gplay_update_track",
        { track: "production", status: "inProgress", userFraction: 0.1 },
        ctx(),
      );
      expect(result.edit).toEqual({ id: "e1", committed: true });
      expect(result.after.releases[0]).toMatchObject({ status: "inProgress", userFraction: 0.1 });
      // Version codes were not passed: the ones the track already serves
      // are what a pause or a widening is applied to
      const put = stub.calls.find((call) => call.method === "PUT");
      expect(JSON.parse(String(put?.body)).releases[0].versionCodes).toEqual(["104"]);
      expect(stub.calls.some((call) => call.method === "DELETE")).toBe(false);
    } finally {
      stub.restore();
    }
  });

  it("throws the edit away when the write fails, so no lock is left on the listing", async () => {
    const stub = stubFetch([
      token,
      openEdit,
      { match: /tracks\/production$/, method: "GET", body: { track: "production", releases: [{ versionCodes: ["104"] }] } },
      { match: /tracks\/production$/, method: "PUT", status: 403, body: { error: { message: "The caller does not have permission" } } },
      { match: /\/edits\/e1$/, method: "DELETE", body: {} },
    ]);
    try {
      await expect(gplay.handle("gplay_update_track", { track: "production" }, ctx())).rejects.toThrow(/403/);
      expect(stub.calls.some((call) => call.method === "DELETE")).toBe(true);
      expect(stub.calls.some((call) => /:commit/.test(call.url))).toBe(false);
    } finally {
      stub.restore();
    }
  });

  it("refuses the rollout combinations Play rejects, before opening anything", async () => {
    const stub = stubFetch([
      token,
      openEdit,
      { match: /tracks\/production$/, method: "GET", body: { track: "production", releases: [{ versionCodes: ["104"] }] } },
      { match: /\/edits\/e1$/, method: "DELETE", body: {} },
    ]);
    try {
      await expect(gplay.handle("gplay_update_track", { track: "production", status: "inProgress" }, ctx()))
        .rejects.toThrow(/needs userFraction strictly between 0 and 1/);
      await expect(gplay.handle("gplay_update_track", { track: "production", status: "completed", userFraction: 0.5 }, ctx()))
        .rejects.toThrow(/reaches every user, so it cannot carry a userFraction/);
    } finally {
      stub.restore();
    }
  });

  it("promotes what the source track serves into the target track", async () => {
    const stub = stubFetch([
      token,
      openEdit,
      commit,
      { match: /tracks\/internal$/, method: "GET", body: { track: "internal", releases: [{ versionCodes: ["112"], status: "completed", releaseNotes: [{ language: "en-US", text: "beta" }] }] } },
      { match: /tracks\/production$/, method: "GET", body: { track: "production", releases: [{ versionCodes: ["104"], status: "completed" }] } },
      { match: /tracks\/production$/, method: "PUT", body: { track: "production", releases: [{ versionCodes: ["112"], status: "inProgress", userFraction: 0.05 }] } },
    ]);
    try {
      const result: any = await gplay.handle(
        "gplay_promote_release",
        { from: "internal", to: "production", status: "inProgress", userFraction: 0.05 },
        ctx(),
      );
      expect(result.promoted).toEqual({ versionCodes: ["112"], status: "inProgress", userFraction: 0.05 });
      expect(result.before.releases[0].versionCodes).toEqual(["104"]);
      const put = stub.calls.find((call) => call.method === "PUT");
      // Notes follow the release unless new ones are given
      expect(JSON.parse(String(put?.body)).releases[0].releaseNotes).toEqual([{ language: "en-US", text: "beta" }]);
    } finally {
      stub.restore();
    }
  });

  it("refuses to promote a track that serves nothing", async () => {
    const stub = stubFetch([
      token,
      openEdit,
      { match: /tracks\/internal$/, method: "GET", body: { track: "internal", releases: [] } },
      { match: /\/edits\/e1$/, method: "DELETE", body: {} },
    ]);
    try {
      await expect(gplay.handle("gplay_promote_release", { from: "internal", to: "production" }, ctx()))
        .rejects.toThrow(/has no release to promote/);
    } finally {
      stub.restore();
    }
  });

  it("refuses to promote a track onto itself", async () => {
    await expect(gplay.handle("gplay_promote_release", { from: "production", to: "production" }, ctx()))
      .rejects.toThrow(/same track/);
  });

  it("publishes a review reply and holds it to what Play accepts", async () => {
    const stub = stubFetch([
      token,
      { match: /reviews\/r1:reply/, method: "POST", body: { result: { replyText: "thanks", lastEdited: { seconds: "1756000000" } } } },
    ]);
    try {
      const result: any = await gplay.handle("gplay_reply_review", { reviewId: "r1", text: "thanks" }, ctx());
      expect(result).toMatchObject({ ok: true, published: true, lastEdited: 1756000000000 });
      await expect(gplay.handle("gplay_reply_review", { reviewId: "r1", text: "x".repeat(351) }, ctx()))
        .rejects.toThrow(/caps a reply at 350/);
      await expect(gplay.handle("gplay_reply_review", { reviewId: "r1", text: "  " }, ctx()))
        .rejects.toThrow(/empty reply/);
    } finally {
      stub.restore();
    }
  });

  it("keeps edits out of the blunt instrument", async () => {
    await expect(gplay.handle("gplay_write_request", { method: "PUT", path: "/applications/x/edits/1/tracks/production" }, ctx()))
      .rejects.toThrow(/lock nobody closes/);
    await expect(gplay.handle("gplay_write_request", { method: "GET", path: "/applications/x/reviews" }, ctx()))
      .rejects.toThrow(/Unsupported method/);
  });
});

/**
 * The contract with the vendors.
 *
 * Neither plugin reimplements a store: every call is Apple's or Google's
 * own API. The risk of that choice is drift, so each plugin declares what
 * it depends on and scripts/check-store-apis.mjs verifies the declaration
 * against the specification the vendor publishes. That check is only
 * worth anything if the declaration still describes the code, which is
 * what is asserted here: upstream is checked in CI, the coupling between
 * the contract and the source is checked offline.
 */
describe("upstream contracts", () => {
  const source = (file: string) =>
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "server", "plugins", file), "utf-8");

  for (const [name, contract] of [["asc", ASC_CONTRACT], ["gplay", GPLAY_CONTRACT]] as Array<[string, any]>) {
    it(`${name} declares a specification that can be fetched and read`, () => {
      expect(contract.spec.url).toMatch(/^https:\/\//);
      expect(["openapi", "discovery"]).toContain(contract.spec.kind);
      expect(contract.spec.name).toBeTruthy();
    });

    it(`${name} says why it depends on each endpoint`, () => {
      // A contract entry with no reason is one nobody can safely delete
      expect(contract.endpoints.length).toBeGreaterThan(0);
      for (const endpoint of contract.endpoints) {
        expect(endpoint.why, JSON.stringify(endpoint)).toBeTruthy();
      }
    });

    it(`${name} declares the fields it reads`, () => {
      for (const group of contract.fields ?? []) {
        expect(group.schema).toBeTruthy();
        expect(group.read.length).toBeGreaterThan(0);
      }
    });
  }

  it("names every App Store Connect endpoint the way the code calls it", () => {
    // The paths are checked against Apple's spec in CI; here they are
    // checked against the file, so a contract cannot quietly describe an
    // endpoint the plugin stopped using or never called
    const code = source("asc.mjs");
    for (const endpoint of ASC_CONTRACT.endpoints as Array<{ method: string; path: string }>) {
      const statics = endpoint.path.split(/\{[^}]+\}/).filter(Boolean).map((part) =>
        part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      const skeleton = new RegExp(statics.join("[^\"'`]*"));
      expect(skeleton.test(code), `${endpoint.method} ${endpoint.path} is declared but not called`).toBe(true);
    }
  });

  it("names every Play method under the API the code talks to", () => {
    for (const endpoint of GPLAY_CONTRACT.endpoints as Array<{ id: string }>) {
      expect(endpoint.id.startsWith("androidpublisher.")).toBe(true);
    }
  });
});

/**
 * Uploading a captured screenshot set.
 *
 * Both stores make this a multi-step affair, and both fail quietly when a
 * step is skipped: an App Store asset never committed with its checksum
 * sits in the set and never appears on the listing, and a Play edit that
 * is not committed changes nothing at all. So what is asserted here is
 * the shape of the sequence, not just its result.
 */
const captureFixture = (shots: Array<Record<string, unknown>>) => {
  const output = join(root, "shots");
  const written = shots.map((shot, index) => {
    const file = join(output, `${index}.png`);
    mkdirSync(output, { recursive: true });
    writeFileSync(file, `PNG-${index}`);
    return { device: "d", locale: "en-US", screen: `s${index}`, target: "sim:UDID", width: 1290, height: 2796, appleDisplayType: "APP_IPHONE_67", playImageType: "phoneScreenshots", ...shot, file };
  });
  writeFileSync(join(output, "index.json"), JSON.stringify({ takenAt: 1, output, shots: written }));
  return output;
};

describe("App Store Connect screenshot upload", () => {
  const ec = generateKeyPairSync("ec", {
    namedCurve: "P-256",
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const ctx = () => ({
    config: { keyId: "KEY", issuerId: "ISSUER", privateKey: ec.privateKey, bundleId: "com.acme.app" },
    projectRoot: root,
    state: {} as Record<string, unknown>,
  });
  const base = [
    { match: /\/v1\/apps\?/, body: { data: [{ id: "42", attributes: { bundleId: "com.acme.app" } }] } },
    { match: /appStoreVersions\?filter/, body: { data: [{ id: "v1", attributes: { versionString: "1.4.0" } }] } },
  ];
  const localizations = { match: /appStoreVersions\/v1\/appStoreVersionLocalizations/, body: { data: [{ id: "l1", attributes: { locale: "en-US" } }] } };

  it("reserves the asset, follows Apple's upload operations, then commits it with its checksum", async () => {
    const from = captureFixture([{}]);
    const stub = stubFetch([
      ...base,
      localizations,
      { match: /appStoreVersionLocalizations\/l1\/appScreenshotSets/, method: "GET", body: { data: [] } },
      { match: /\/v1\/appScreenshotSets$/, method: "POST", body: { data: { id: "set1" } } },
      {
        match: /\/v1\/appScreenshots$/,
        method: "POST",
        body: { data: { id: "sc1", attributes: { uploadOperations: [{ method: "PUT", url: "https://upload.example/part1", offset: 0, length: 5, requestHeaders: [{ name: "x-apple", value: "token" }] }] } } },
      },
      { match: /upload\.example/, method: "PUT", body: {} },
      { match: /appScreenshots\/sc1$/, method: "PATCH", body: { data: { attributes: { assetDeliveryState: { state: "COMPLETE" } } } } },
    ]);
    try {
      const result: any = await asc.handle("asc_upload_screenshots", { version: "1.4.0", from }, ctx());
      expect(result).toMatchObject({ ok: true, count: 1 });
      expect(result.uploaded[0]).toMatchObject({ locale: "en-US", displayType: "APP_IPHONE_67", setId: "set1" });

      const put = stub.calls.find((call) => call.method === "PUT");
      expect(put?.headers["x-apple"]).toBe("token");
      // The byte range Apple asked for, not the whole file by luck
      expect(String(put?.body).length).toBe(5);

      const patch = stub.calls.find((call) => call.method === "PATCH");
      const attributes = JSON.parse(String(patch?.body)).data.attributes;
      expect(attributes.uploaded).toBe(true);
      expect(attributes.sourceFileChecksum).toMatch(/^[0-9a-f]{32}$/);
    } finally {
      stub.restore();
    }
  });

  it("refuses a size no display type matches instead of uploading it as another device", async () => {
    const from = captureFixture([{ width: 640, height: 480, appleDisplayType: null }]);
    const stub = stubFetch([...base, localizations]);
    try {
      const result: any = await asc.handle("asc_upload_screenshots", { version: "1.4.0", from }, ctx());
      expect(result).toMatchObject({ ok: false, reason: "unknown-display-type" });
      expect(result.files[0].size).toBe("640x480");
      expect(stub.calls.some((call) => call.method === "POST")).toBe(false);
    } finally {
      stub.restore();
    }
  });

  it("names a locale the listing does not have rather than inventing it", async () => {
    const from = captureFixture([{ locale: "de-DE" }]);
    const stub = stubFetch([...base, localizations]);
    try {
      const result: any = await asc.handle("asc_upload_screenshots", { version: "1.4.0", from }, ctx());
      expect(result.ok).toBe(false);
      expect(result.skipped[0]).toMatchObject({ locale: "de-DE", reason: "no-localization" });
      expect(result.skipped[0].hint).toMatch(/en-US/);
    } finally {
      stub.restore();
    }
  });

  it("clears the existing set first when asked to replace", async () => {
    const from = captureFixture([{}]);
    const stub = stubFetch([
      ...base,
      localizations,
      { match: /appStoreVersionLocalizations\/l1\/appScreenshotSets/, method: "GET", body: { data: [{ id: "set1", attributes: { screenshotDisplayType: "APP_IPHONE_67" } }] } },
      { match: /appScreenshotSets\/set1\/appScreenshots/, method: "GET", body: { data: [{ id: "old1" }, { id: "old2" }] } },
      { match: /appScreenshots\/old\d$/, method: "DELETE", body: {} },
      { match: /\/v1\/appScreenshots$/, method: "POST", body: { data: { id: "sc1", attributes: { uploadOperations: [{ method: "PUT", url: "https://upload.example/p", offset: 0, length: 5, requestHeaders: [] }] } } } },
      { match: /upload\.example/, method: "PUT", body: {} },
      { match: /appScreenshots\/sc1$/, method: "PATCH", body: { data: {} } },
    ]);
    try {
      const result: any = await asc.handle("asc_upload_screenshots", { version: "1.4.0", from, replace: true }, ctx());
      expect(result.uploaded[0].removed).toBe(2);
      // The existing set was reused, not duplicated
      expect(stub.calls.some((call) => call.method === "POST" && /appScreenshotSets$/.test(call.url))).toBe(false);
    } finally {
      stub.restore();
    }
  });

  it("leaves the Android captures of the same index alone", async () => {
    const from = captureFixture([{ target: "adb:emulator-5554" }]);
    const stub = stubFetch([...base, localizations]);
    try {
      await expect(asc.handle("asc_upload_screenshots", { version: "1.4.0", from }, ctx()))
        .rejects.toThrow(/No iOS capture/);
    } finally {
      stub.restore();
    }
  });
});

describe("Google Play screenshot upload", () => {
  const rsa = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const account = JSON.stringify({ client_email: "bot@acme.iam.gserviceaccount.com", private_key_id: "k1", private_key: rsa.privateKey });
  const ctx = () => ({
    config: { serviceAccount: account, packageName: "com.acme.app" },
    projectRoot: root,
    state: {} as Record<string, unknown>,
  });
  const token = { match: /oauth2\.googleapis\.com/, body: { access_token: "ya29.token", expires_in: 3600 } };

  it("uploads through the media endpoint and commits the edit", async () => {
    const from = captureFixture([{ target: "adb:emulator-5554" }, { target: "adb:emulator-5554" }]);
    const stub = stubFetch([
      token,
      { match: /\/edits$/, method: "POST", body: { id: "e1" } },
      { match: /:commit/, method: "POST", body: { id: "e1" } },
      { match: /upload\/androidpublisher/, method: "POST", body: { image: { id: "img1", sha256: "abc", url: "https://play/img1" } } },
      { match: /listings\/en-US\/phoneScreenshots$/, method: "GET", body: { images: [{ id: "img1" }, { id: "img2" }] } },
    ]);
    try {
      const result: any = await gplay.handle("gplay_upload_screenshots", { from }, ctx());
      expect(result).toMatchObject({ ok: true, count: 2 });
      expect(result.edit).toEqual({ id: "e1", committed: true });
      expect(result.listings[0]).toMatchObject({ language: "en-US", imageType: "phoneScreenshots", onListing: 2 });

      const uploads = stub.calls.filter((call) => call.url.includes("/upload/androidpublisher"));
      expect(uploads.length).toBe(2);
      expect(uploads[0].url).toContain("uploadType=media");
      expect(uploads[0].url).toContain("/listings/en-US/phoneScreenshots");
      expect(uploads[0].headers["content-type"]).toBe("image/png");
      expect(stub.calls.some((call) => call.method === "DELETE")).toBe(false);
    } finally {
      stub.restore();
    }
  });

  it("clears the form factor first when asked to replace", async () => {
    const from = captureFixture([{ target: "adb:emulator-5554" }]);
    const stub = stubFetch([
      token,
      { match: /\/edits$/, method: "POST", body: { id: "e1" } },
      { match: /:commit/, method: "POST", body: { id: "e1" } },
      { match: /listings\/en-US\/phoneScreenshots$/, method: "DELETE", body: {} },
      { match: /upload\/androidpublisher/, method: "POST", body: { image: { id: "img1" } } },
      { match: /listings\/en-US\/phoneScreenshots$/, method: "GET", body: { images: [{ id: "img1" }] } },
    ]);
    try {
      const result: any = await gplay.handle("gplay_upload_screenshots", { from, replace: true }, ctx());
      expect(result.listings[0].replaced).toBe(true);
      const deletion = stub.calls.find((call) => call.method === "DELETE");
      expect(deletion?.url).toContain("/listings/en-US/phoneScreenshots");
    } finally {
      stub.restore();
    }
  });

  it("throws the edit away when an upload fails, so no half-updated listing is committed", async () => {
    const from = captureFixture([{ target: "adb:emulator-5554" }]);
    const stub = stubFetch([
      token,
      { match: /\/edits$/, method: "POST", body: { id: "e1" } },
      { match: /upload\/androidpublisher/, method: "POST", status: 400, body: { error: { message: "Image is too small" } } },
      { match: /\/edits\/e1$/, method: "DELETE", body: {} },
    ]);
    try {
      await expect(gplay.handle("gplay_upload_screenshots", { from }, ctx())).rejects.toThrow(/Image is too small/);
      expect(stub.calls.some((call) => call.method === "DELETE" && call.url.endsWith("/edits/e1"))).toBe(true);
      expect(stub.calls.some((call) => /:commit/.test(call.url))).toBe(false);
    } finally {
      stub.restore();
    }
  });

  it("leaves the iOS captures of the same index alone", async () => {
    const from = captureFixture([{ target: "sim:UDID" }]);
    await expect(gplay.handle("gplay_upload_screenshots", { from }, ctx())).rejects.toThrow(/No Android capture/);
  });
});
