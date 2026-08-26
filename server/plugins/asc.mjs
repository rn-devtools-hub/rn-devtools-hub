/**
 * App Store Connect: the half of a release the app cannot see, and the
 * half an agent could not act on.
 *
 * A build that finished uploading is not a build that finished
 * processing, and a version that was submitted is not a version that
 * passed review. None of it exists anywhere in the running app, so an
 * agent that just shipped has to be told, and then has to be able to do
 * something about it: set what to test, hand the build to a TestFlight
 * group, attach it to a version, submit, release, hold the rollout.
 *
 * Reading and writing are separated because the registry treats them
 * differently: every mutating tool lives in writeTools, carries
 * destructiveHint, and disappears entirely when writes are switched off
 * (RN_DEVTOOLS_ASC_WRITES=off). A tool that is not exposed is a step an
 * agent never plans, which is worth more than a tool that exists and
 * refuses.
 *
 * Auth is a short-lived ES256 JWT signed with the .p8 issued in App Store
 * Connect. The key is read once, kept in this process, and never returned
 * by anything.
 */

import { apiJson, project, query, signJwt } from "./_api.mjs";

const BASE = "https://api.appstoreconnect.apple.com";
const LABEL = "App Store Connect";
/** Apple refuses a token that lives longer than 20 minutes */
const TOKEN_TTL_SECONDS = 1200;

const explain = (data) =>
  (Array.isArray(data?.errors) ? data.errors : [])
    .map((error) => [error.title, error.detail].filter(Boolean).join(": "))
    .join(" | ") || null;

const token = (ctx) => {
  const now = Math.floor(Date.now() / 1000);
  if (ctx.state.token && ctx.state.tokenExpiresAt - 60 > now) return ctx.state.token;
  ctx.state.token = signJwt({
    algorithm: "ES256",
    header: { kid: ctx.config.keyId },
    claims: { iss: ctx.config.issuerId, iat: now, exp: now + TOKEN_TTL_SECONDS, aud: "appstoreconnect-v1" },
    privateKey: ctx.config.privateKey,
  });
  ctx.state.tokenExpiresAt = now + TOKEN_TTL_SECONDS;
  return ctx.state.token;
};

const call = (ctx, method, path, { params, body } = {}) =>
  apiJson(`${BASE}${path}${query(params)}`, {
    label: LABEL,
    explain,
    method,
    headers: {
      authorization: `Bearer ${token(ctx)}`,
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const get = (ctx, path, params) => call(ctx, "GET", path, { params });

/** The JSON:API shape every relationship in this API is written with */
const ref = (type, id) => ({ data: { type, id: String(id) } });

/**
 * Which app, without being told.
 *
 * The project already declares its bundle identifier, so asking an agent
 * for it again is asking it to guess. An explicit bundleId still wins,
 * because a monorepo has several.
 */
const resolveApp = async (ctx, bundleId) => {
  const wanted = String(bundleId ?? ctx.config.bundleId ?? "").trim();
  if (!wanted) {
    throw new Error(
      "No bundle identifier: pass bundleId, set ASC_BUNDLE_ID, or declare expo.ios.bundleIdentifier in app.json",
    );
  }
  ctx.state.apps ??= new Map();
  if (ctx.state.apps.has(wanted)) return ctx.state.apps.get(wanted);

  const data = await get(ctx, "/v1/apps", { "filter[bundleId]": wanted, limit: 1 });
  const found = data?.data?.[0];
  if (!found) {
    throw new Error(
      `No app with bundle id ${wanted} on this App Store Connect account. asc_list_apps shows what the key can see.`,
    );
  }
  const app = { id: found.id, bundleId: found.attributes?.bundleId ?? wanted, name: found.attributes?.name ?? null };
  ctx.state.apps.set(wanted, app);
  return app;
};

/**
 * A build, by id or by number.
 *
 * `filter[version]` on a build is its BUILD number, and
 * `preReleaseVersion.version` is the marketing version. Getting those two
 * the wrong way round returns another build and every later step then
 * acts on it, which is the one failure this file must not produce.
 */
const resolveBuild = async (ctx, app, { buildId, buildNumber, version }) => {
  if (buildId) return { id: String(buildId), buildNumber: null };
  if (buildNumber === undefined || buildNumber === null || buildNumber === "") {
    throw new Error("Pass buildId or buildNumber: asc_list_builds returns both");
  }
  const data = await get(ctx, "/v1/builds", {
    "filter[app]": app.id,
    "filter[version]": String(buildNumber),
    "filter[preReleaseVersion.version]": version,
    limit: 1,
  });
  const found = data?.data?.[0];
  if (!found) {
    throw new Error(
      `No build ${buildNumber}${version ? ` of version ${version}` : ""} for ${app.bundleId}. asc_list_builds shows what is uploaded.`,
    );
  }
  return {
    id: found.id,
    buildNumber: found.attributes?.version ?? String(buildNumber),
    processingState: found.attributes?.processingState ?? null,
  };
};

const resolveGroup = async (ctx, app, group) => {
  const wanted = String(group ?? "").trim();
  if (!wanted) throw new Error("Pass group: a TestFlight group name or id, from asc_list_beta_groups");
  const data = await get(ctx, `/v1/apps/${app.id}/betaGroups`, { limit: 200 });
  const groups = data?.data ?? [];
  const match = groups.find((entry) => entry.id === wanted)
    ?? groups.find((entry) => entry.attributes?.name === wanted);
  if (!match) {
    const names = groups.map((entry) => entry.attributes?.name).filter(Boolean).join(", ");
    throw new Error(`No TestFlight group "${wanted}" on ${app.bundleId}. Groups: ${names || "none"}`);
  }
  return { id: match.id, name: match.attributes?.name ?? null, internal: match.attributes?.isInternalGroup === true };
};

const resolveVersion = async (ctx, app, versionString, platform = "IOS") => {
  const wanted = String(versionString ?? "").trim();
  if (!wanted) throw new Error("Pass version: the marketing version string, e.g. 1.4.0");
  const data = await get(ctx, `/v1/apps/${app.id}/appStoreVersions`, {
    "filter[versionString]": wanted,
    "filter[platform]": platform,
    limit: 1,
  });
  const found = data?.data?.[0];
  if (!found) {
    throw new Error(
      `No App Store version ${wanted} (${platform}) for ${app.bundleId}. asc_prepare_version creates it; asc_list_versions shows what exists.`,
    );
  }
  return { id: found.id, versionString: found.attributes?.versionString ?? wanted, attributes: found.attributes ?? {} };
};

const clamp = (value, fallback, max) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(Math.trunc(parsed), max)) : fallback;
};

/**
 * Attributes are projected rather than requested with fields[].
 *
 * Apple renames attributes between API versions (appStoreState became a
 * state enum on the version resource), and a fields[] naming one that
 * moved is a 400 on a call that had nothing wrong with it. Asking for the
 * resource and keeping the keys that exist degrades to a smaller answer
 * instead of an error.
 */
const BUILD_KEYS = ["processingState", "uploadedDate", "expired", "minOsVersion", "usesNonExemptEncryption"];
const VERSION_KEYS = ["versionString", "appStoreState", "state", "appVersionState", "platform", "releaseType", "createdDate", "downloadable"];
const GROUP_KEYS = ["name", "isInternalGroup", "publicLinkEnabled", "publicLink", "publicLinkLimit", "createdDate"];

/**
 * Apple spells pre-release versions two different ways, and both are
 * load-bearing: the OpenAPI schema is `PrereleaseVersion`, the JSON:API
 * type inside a payload is `preReleaseVersions`. Aligning them would
 * break whichever lookup was "corrected".
 */
const included = (data, type, id) =>
  (data?.included ?? []).find((entry) => entry.type === type && entry.id === id) ?? null;

/** Upsert one localization row, which this API always makes a two-step */
const upsertLocalization = async (ctx, { list, path, type, parent, locale, attributes }) => {
  const existing = (list?.data ?? []).find((entry) => entry.attributes?.locale === locale);
  if (existing) {
    await call(ctx, "PATCH", `/v1/${path}/${existing.id}`, {
      body: { data: { type, id: existing.id, attributes } },
    });
    return { locale, action: "updated", id: existing.id };
  }
  const created = await call(ctx, "POST", `/v1/${path}`, {
    body: { data: { type, attributes: { locale, ...attributes }, relationships: parent } },
  });
  return { locale, action: "created", id: created?.data?.id ?? null };
};

const requirePath = (path) => {
  if (!/^\/v\d+\/[A-Za-z0-9]/.test(path) || path.includes("..")) {
    throw new Error(`Invalid path ${JSON.stringify(path)}: expected an absolute API path such as /v1/apps`);
  }
  return path;
};

/**
 * What this plugin depends on, upstream.
 *
 * Nothing here reimplements App Store Connect: every call is Apple's own
 * REST API, with Apple's own auth. The risk of that choice is drift, so
 * the dependency is DECLARED rather than left implicit in the code, and
 * scripts/check-store-apis.mjs verifies every line of it against the
 * OpenAPI specification Apple publishes. A renamed attribute becomes a
 * failing check instead of a 400 in someone's release.
 *
 * `read` must exist. `tolerated` may or may not: those are the fields
 * Apple has renamed across API versions and that the code projects
 * defensively, keeping whichever one the account's API actually returns.
 */
export const CONTRACT = {
  spec: {
    kind: "openapi",
    url: "https://developer.apple.com/sample-code/app-store-connect/app-store-connect-openapi-specification.zip",
    name: "App Store Connect OpenAPI specification",
  },
  endpoints: [
    { method: "GET", path: "/v1/apps", why: "asc_list_apps, and resolving a bundle id" },
    { method: "GET", path: "/v1/builds", why: "asc_list_builds, and resolving a build number" },
    { method: "PATCH", path: "/v1/builds/{id}", why: "asc_expire_build" },
    { method: "GET", path: "/v1/apps/{id}/appStoreVersions", why: "asc_list_versions" },
    { method: "GET", path: "/v1/apps/{id}/betaGroups", why: "asc_list_beta_groups, and resolving a group name" },
    { method: "GET", path: "/v1/builds/{id}/betaBuildLocalizations", why: "asc_set_whats_new reads before it writes" },
    { method: "POST", path: "/v1/betaBuildLocalizations", why: "asc_set_whats_new, first time for a locale" },
    { method: "PATCH", path: "/v1/betaBuildLocalizations/{id}", why: "asc_set_whats_new, locale already there" },
    { method: "POST", path: "/v1/betaGroups/{id}/relationships/builds", why: "asc_distribute_build add" },
    { method: "DELETE", path: "/v1/betaGroups/{id}/relationships/builds", why: "asc_distribute_build remove" },
    { method: "POST", path: "/v1/betaAppReviewSubmissions", why: "asc_distribute_build submitForReview" },
    { method: "POST", path: "/v1/appStoreVersions", why: "asc_prepare_version creates the version" },
    { method: "PATCH", path: "/v1/appStoreVersions/{id}", why: "asc_prepare_version sets the release type" },
    { method: "PATCH", path: "/v1/appStoreVersions/{id}/relationships/build", why: "asc_prepare_version attaches the build" },
    { method: "GET", path: "/v1/appStoreVersions/{id}/appStoreVersionLocalizations", why: "asc_prepare_version reads before it writes" },
    { method: "POST", path: "/v1/appStoreVersionLocalizations", why: "asc_prepare_version, first release notes for a locale" },
    { method: "PATCH", path: "/v1/appStoreVersionLocalizations/{id}", why: "asc_prepare_version, locale already there" },
    { method: "GET", path: "/v1/apps/{id}/reviewSubmissions", why: "asc_submit_for_review reuses an open submission" },
    { method: "POST", path: "/v1/reviewSubmissions", why: "asc_submit_for_review opens one" },
    { method: "GET", path: "/v1/reviewSubmissions/{id}/items", why: "asc_submit_for_review checks the version is in it" },
    { method: "POST", path: "/v1/reviewSubmissionItems", why: "asc_submit_for_review adds the version" },
    { method: "PATCH", path: "/v1/reviewSubmissions/{id}", why: "asc_submit_for_review submits" },
    { method: "POST", path: "/v1/appStoreVersionReleaseRequests", why: "asc_release_version" },
    { method: "GET", path: "/v1/appStoreVersions/{id}/appStoreVersionPhasedRelease", why: "asc_phased_release reads the current state" },
    { method: "POST", path: "/v1/appStoreVersionPhasedReleases", why: "asc_phased_release start" },
    { method: "PATCH", path: "/v1/appStoreVersionPhasedReleases/{id}", why: "asc_phased_release pause, resume, complete" },
    { method: "DELETE", path: "/v1/appStoreVersionPhasedReleases/{id}", why: "asc_phased_release cancel" },
  ],
  fields: [
    { schema: "App", read: ["name", "bundleId", "sku", "primaryLocale"] },
    { schema: "Build", read: ["version", "processingState", "uploadedDate", "expired", "minOsVersion", "usesNonExemptEncryption"] },
    { schema: "PrereleaseVersion", read: ["version", "platform"] },
    {
      schema: "AppStoreVersion",
      read: ["versionString", "platform", "releaseType", "createdDate", "downloadable"],
      // appStoreState is the old name, appVersionState the new one, and
      // "state" is what a future rename would most likely be called
      tolerated: ["appStoreState", "appVersionState", "state"],
    },
    { schema: "BetaGroup", read: ["name", "isInternalGroup", "publicLinkEnabled", "publicLink", "publicLinkLimit", "createdDate"] },
    { schema: "AppStoreVersionPhasedRelease", read: ["phasedReleaseState", "startDate", "currentDayNumber", "totalPauseDuration"] },
  ],
};

export default {
  id: "asc",
  title: "App Store Connect",
  summary: "TestFlight and App Store releases for the iOS app this project declares: read them, and drive them.",
  license: "MIT",
  hosts: ["api.appstoreconnect.apple.com"],
  docs: "docs/plugins.md",
  setupHint:
    'Create an API key in App Store Connect (Users and Access, Integrations), then set ASC_KEY_ID, ASC_ISSUER_ID and ASC_KEY_PATH (the .p8 file), or fill "asc" in .rn-devtools/plugins.json. Restart the hub afterwards.',
  config: [
    {
      key: "keyId",
      env: ["ASC_KEY_ID", "APP_STORE_CONNECT_API_KEY_KEY_ID"],
      description: "Key ID of the App Store Connect API key (the XXXXXXXXXX in AuthKey_XXXXXXXXXX.p8)",
    },
    {
      key: "issuerId",
      env: ["ASC_ISSUER_ID", "APP_STORE_CONNECT_API_KEY_ISSUER_ID"],
      description: "Issuer ID shown above the key list in App Store Connect",
    },
    {
      key: "privateKey",
      env: ["ASC_PRIVATE_KEY"],
      pathEnv: ["ASC_KEY_PATH", "APP_STORE_CONNECT_API_KEY_PATH", "EXPO_ASC_API_KEY_PATH"],
      secret: true,
      description: "Contents of the .p8 private key, or a path to it (ASC_KEY_PATH). Apple lets it be downloaded once.",
    },
    {
      key: "bundleId",
      env: ["ASC_BUNDLE_ID"],
      required: false,
      description: "Default bundle identifier; read from expo.ios.bundleIdentifier in app.json when absent",
      derive: ({ appConfig }) => appConfig?.ios?.bundleIdentifier ?? null,
    },
  ],

  tools: [
    {
      name: "asc_list_apps",
      description:
        "Lists the apps this App Store Connect key can see (id, name, bundleId, sku). Call it when a bundle identifier is refused: the key may be scoped to other apps.",
      inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 200 } }, additionalProperties: false },
      annotations: { readOnlyHint: true },
    },
    {
      name: "asc_list_builds",
      description:
        "Lists recent TestFlight builds, newest first: build number, the version they belong to, processingState (PROCESSING, VALID, FAILED, INVALID) and whether they expired. This is the answer to \"is the build I just uploaded usable yet\", which nothing inside the app can give. Defaults to the bundle identifier the project declares.",
      inputSchema: {
        type: "object",
        properties: {
          bundleId: { type: "string" },
          version: { type: "string", description: "Keep only the builds of this marketing version (e.g. 1.4.0)" },
          limit: { type: "integer", minimum: 1, maximum: 200 },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: "asc_list_versions",
      description:
        "Lists the App Store versions and the state each one is in (PREPARE_FOR_SUBMISSION, WAITING_FOR_REVIEW, IN_REVIEW, PENDING_DEVELOPER_RELEASE, READY_FOR_SALE, REJECTED...), with the build attached to each. The state field Apple returns is passed through under the name it used, because it has changed between API versions.",
      inputSchema: {
        type: "object",
        properties: {
          bundleId: { type: "string" },
          platform: { type: "string", enum: ["IOS", "MAC_OS", "TV_OS", "VISION_OS"] },
          limit: { type: "integer", minimum: 1, maximum: 50 },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: "asc_list_beta_groups",
      description:
        "Lists the TestFlight groups of the app: name, internal or external, and the public link when one is enabled. Internal groups get a build immediately; external ones need a beta review first.",
      inputSchema: {
        type: "object",
        properties: { bundleId: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 200 } },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: "asc_request",
      description:
        "Signed GET against any App Store Connect endpoint, for what the other tools do not cover (app info localizations, sales reports, custom filters). path is an absolute API path such as /v1/apps/{id}/appStoreVersions; query is passed through, including filter[...] and include. Reads only: asc_write_request is the one that changes things.",
      inputSchema: {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string", description: "API path starting with /v1/ or /v2/" },
          query: { type: "object", description: "Query parameters, e.g. {\"limit\": 10, \"filter[app]\": \"123\"}" },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
  ],

  writeTools: [
    {
      name: "asc_set_whats_new",
      description:
        "Sets the \"What to Test\" note testers read on a build, creating the localization if it does not exist yet. TestFlight refuses an external distribution without one, so this is usually the step before asc_distribute_build.",
      inputSchema: {
        type: "object",
        required: ["text"],
        properties: {
          bundleId: { type: "string" },
          buildId: { type: "string", description: "From asc_list_builds" },
          buildNumber: { type: "string", description: "Build number, resolved against the app when buildId is absent" },
          version: { type: "string", description: "Marketing version, to disambiguate a build number reused across versions" },
          locale: { type: "string", description: "Default en-US" },
          text: { type: "string", maxLength: 4000 },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    {
      name: "asc_distribute_build",
      description:
        "Hands a build to a TestFlight group, or takes it back (action: add or remove). An internal group receives it immediately; an external one needs a beta review, which submitForReview requests in the same call. The group is matched by name or id, and an unknown name is refused with the list of real ones rather than guessed.",
      inputSchema: {
        type: "object",
        required: ["group"],
        properties: {
          bundleId: { type: "string" },
          buildId: { type: "string" },
          buildNumber: { type: "string" },
          version: { type: "string" },
          group: { type: "string", description: "Group name or id, from asc_list_beta_groups" },
          action: { type: "string", enum: ["add", "remove"], description: "Default add" },
          submitForReview: { type: "boolean", description: "Also submit the build for TestFlight beta review (required for external groups)" },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    {
      name: "asc_expire_build",
      description:
        "Expires a build, which removes it from TestFlight for every tester. Irreversible: an expired build cannot be un-expired, only replaced by a new upload.",
      inputSchema: {
        type: "object",
        properties: {
          bundleId: { type: "string" },
          buildId: { type: "string" },
          buildNumber: { type: "string" },
          version: { type: "string" },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    {
      name: "asc_prepare_version",
      description:
        "Brings an App Store version to the point where it can be submitted, in one idempotent call: creates the version if it does not exist, attaches the build, and writes the release notes for a locale. Safe to run twice; the answer lists what it actually changed and what was already right. Nothing is submitted here, asc_submit_for_review does that.",
      inputSchema: {
        type: "object",
        required: ["version"],
        properties: {
          bundleId: { type: "string" },
          version: { type: "string", description: "Marketing version string, e.g. 1.4.0" },
          platform: { type: "string", enum: ["IOS", "MAC_OS", "TV_OS", "VISION_OS"], description: "Default IOS" },
          buildId: { type: "string" },
          buildNumber: { type: "string", description: "Build to attach to this version" },
          releaseNotes: { type: "string", description: "What's New text for the locale", maxLength: 4000 },
          locale: { type: "string", description: "Default en-US" },
          releaseType: { type: "string", enum: ["MANUAL", "AFTER_APPROVAL", "SCHEDULED"], description: "MANUAL keeps the release in your hands after approval" },
          earliestReleaseDate: { type: "string", description: "ISO date, only with releaseType SCHEDULED" },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    {
      name: "asc_submit_for_review",
      description:
        "Submits a prepared version to App Review. This is the step a human normally takes deliberately: after it, the version leaves your hands and Apple starts reviewing. It reuses an open review submission when there is one rather than creating a second, and returns the submission with its state.",
      inputSchema: {
        type: "object",
        required: ["version"],
        properties: {
          bundleId: { type: "string" },
          version: { type: "string" },
          platform: { type: "string", enum: ["IOS", "MAC_OS", "TV_OS", "VISION_OS"], description: "Default IOS" },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    {
      name: "asc_release_version",
      description:
        "Releases a version that Apple has approved and that is waiting on you (PENDING_DEVELOPER_RELEASE). It goes to the App Store, for everyone. Refused with the current state when the version is not actually waiting for a release.",
      inputSchema: {
        type: "object",
        required: ["version"],
        properties: {
          bundleId: { type: "string" },
          version: { type: "string" },
          platform: { type: "string", enum: ["IOS", "MAC_OS", "TV_OS", "VISION_OS"], description: "Default IOS" },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    {
      name: "asc_phased_release",
      description:
        "Drives the phased release of a version: start it, pause it when something looks wrong, resume it, complete it to reach everyone at once, or cancel it. Apple advances the phases on its own daily schedule; this only controls the state.",
      inputSchema: {
        type: "object",
        required: ["version", "action"],
        properties: {
          bundleId: { type: "string" },
          version: { type: "string" },
          platform: { type: "string", enum: ["IOS", "MAC_OS", "TV_OS", "VISION_OS"], description: "Default IOS" },
          action: { type: "string", enum: ["start", "pause", "resume", "complete", "cancel", "state"] },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    {
      name: "asc_write_request",
      description:
        "Signed POST, PATCH or DELETE against any App Store Connect endpoint, for the parts of the release this file does not model (pricing, in-app purchases, app info, territories). body is the JSON:API document Apple expects. The blunt instrument: it will do exactly what it is told, including things no other tool here will do.",
      inputSchema: {
        type: "object",
        required: ["method", "path"],
        properties: {
          method: { type: "string", enum: ["POST", "PATCH", "DELETE"] },
          path: { type: "string", description: "API path starting with /v1/ or /v2/" },
          body: { type: "object", description: "JSON:API document, e.g. {\"data\": {\"type\": \"builds\", \"id\": \"...\", \"attributes\": {...}}}" },
          query: { type: "object" },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
  ],

  async handle(name, args, ctx) {
    // ---- reads ----
    if (name === "asc_list_apps") {
      const data = await get(ctx, "/v1/apps", { limit: clamp(args.limit, 50, 200) });
      return {
        count: data?.data?.length ?? 0,
        apps: (data?.data ?? []).map((app) => ({
          id: app.id,
          ...project(app.attributes, ["name", "bundleId", "sku", "primaryLocale"]),
        })),
      };
    }

    if (name === "asc_list_builds") {
      const app = await resolveApp(ctx, args.bundleId);
      const data = await get(ctx, "/v1/builds", {
        "filter[app]": app.id,
        "filter[preReleaseVersion.version]": args.version,
        sort: "-uploadedDate",
        include: "preReleaseVersion",
        limit: clamp(args.limit, 20, 200),
      });
      const builds = (data?.data ?? []).map((build) => {
        const link = build.relationships?.preReleaseVersion?.data;
        const pre = link ? included(data, "preReleaseVersions", link.id) : null;
        return {
          id: build.id,
          buildNumber: build.attributes?.version ?? null,
          version: pre?.attributes?.version ?? null,
          platform: pre?.attributes?.platform ?? null,
          ...project(build.attributes, BUILD_KEYS),
        };
      });
      return { app, count: builds.length, builds };
    }

    if (name === "asc_list_versions") {
      const app = await resolveApp(ctx, args.bundleId);
      const data = await get(ctx, `/v1/apps/${app.id}/appStoreVersions`, {
        "filter[platform]": args.platform,
        include: "build",
        limit: clamp(args.limit, 10, 50),
      });
      const versions = (data?.data ?? []).map((version) => {
        const link = version.relationships?.build?.data;
        const build = link ? included(data, "builds", link.id) : null;
        return {
          id: version.id,
          ...project(version.attributes, VERSION_KEYS),
          build: build ? { id: build.id, buildNumber: build.attributes?.version ?? null } : null,
        };
      });
      return { app, count: versions.length, versions };
    }

    if (name === "asc_list_beta_groups") {
      const app = await resolveApp(ctx, args.bundleId);
      const data = await get(ctx, `/v1/apps/${app.id}/betaGroups`, { limit: clamp(args.limit, 50, 200) });
      return {
        app,
        count: data?.data?.length ?? 0,
        groups: (data?.data ?? []).map((group) => ({ id: group.id, ...project(group.attributes, GROUP_KEYS) })),
      };
    }

    if (name === "asc_request") return get(ctx, requirePath(String(args.path ?? "")), args.query ?? {});

    // ---- writes ----
    if (name === "asc_set_whats_new") {
      const app = await resolveApp(ctx, args.bundleId);
      const build = await resolveBuild(ctx, app, args);
      const locale = String(args.locale ?? "en-US");
      const list = await get(ctx, `/v1/builds/${build.id}/betaBuildLocalizations`, { limit: 200 });
      const result = await upsertLocalization(ctx, {
        list,
        path: "betaBuildLocalizations",
        type: "betaBuildLocalizations",
        parent: { build: ref("builds", build.id) },
        locale,
        attributes: { whatsNew: String(args.text) },
      });
      return { ok: true, app, build, ...result };
    }

    if (name === "asc_distribute_build") {
      const app = await resolveApp(ctx, args.bundleId);
      const build = await resolveBuild(ctx, app, args);
      const group = await resolveGroup(ctx, app, args.group);
      const action = args.action === "remove" ? "remove" : "add";
      await call(ctx, action === "add" ? "POST" : "DELETE", `/v1/betaGroups/${group.id}/relationships/builds`, {
        body: { data: [{ type: "builds", id: build.id }] },
      });

      let betaReview = null;
      if (action === "add" && args.submitForReview) {
        try {
          const submission = await call(ctx, "POST", "/v1/betaAppReviewSubmissions", {
            body: { data: { type: "betaAppReviewSubmissions", relationships: { build: ref("builds", build.id) } } },
          });
          betaReview = { submitted: true, state: submission?.data?.attributes?.betaReviewState ?? null };
        } catch (error) {
          // The distribution itself succeeded, and saying otherwise would
          // send an agent to redo a step that is already done
          betaReview = { submitted: false, error: String(error?.message ?? error) };
        }
      }
      return {
        ok: true,
        app,
        build,
        group,
        action,
        betaReview,
        note: action === "add" && !group.internal && !args.submitForReview
          ? "External group: testers only receive the build once it passes beta review. Call again with submitForReview, or submit it in App Store Connect."
          : null,
      };
    }

    if (name === "asc_expire_build") {
      const app = await resolveApp(ctx, args.bundleId);
      const build = await resolveBuild(ctx, app, args);
      await call(ctx, "PATCH", `/v1/builds/${build.id}`, {
        body: { data: { type: "builds", id: build.id, attributes: { expired: true } } },
      });
      return { ok: true, app, build, expired: true };
    }

    if (name === "asc_prepare_version") {
      const app = await resolveApp(ctx, args.bundleId);
      const platform = String(args.platform ?? "IOS");
      const versionString = String(args.version);
      const steps = [];

      let version = null;
      try {
        version = await resolveVersion(ctx, app, versionString, platform);
        steps.push({ step: "version", action: "reused", id: version.id, state: version.attributes.appStoreState ?? version.attributes.state ?? null });
      } catch {
        const created = await call(ctx, "POST", "/v1/appStoreVersions", {
          body: {
            data: {
              type: "appStoreVersions",
              attributes: {
                platform,
                versionString,
                ...(args.releaseType ? { releaseType: args.releaseType } : {}),
                ...(args.earliestReleaseDate ? { earliestReleaseDate: args.earliestReleaseDate } : {}),
              },
              relationships: { app: ref("apps", app.id) },
            },
          },
        });
        version = { id: created?.data?.id, versionString, attributes: created?.data?.attributes ?? {} };
        steps.push({ step: "version", action: "created", id: version.id });
      }

      if (args.releaseType && steps[0].action === "reused") {
        await call(ctx, "PATCH", `/v1/appStoreVersions/${version.id}`, {
          body: {
            data: {
              type: "appStoreVersions",
              id: version.id,
              attributes: {
                releaseType: args.releaseType,
                ...(args.earliestReleaseDate ? { earliestReleaseDate: args.earliestReleaseDate } : {}),
              },
            },
          },
        });
        steps.push({ step: "releaseType", action: "set", value: args.releaseType });
      }

      if (args.buildId || args.buildNumber) {
        const build = await resolveBuild(ctx, app, args);
        await call(ctx, "PATCH", `/v1/appStoreVersions/${version.id}/relationships/build`, {
          body: ref("builds", build.id),
        });
        steps.push({ step: "build", action: "attached", ...build });
      }

      if (args.releaseNotes) {
        const locale = String(args.locale ?? "en-US");
        const list = await get(ctx, `/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations`, { limit: 200 });
        const result = await upsertLocalization(ctx, {
          list,
          path: "appStoreVersionLocalizations",
          type: "appStoreVersionLocalizations",
          parent: { appStoreVersion: ref("appStoreVersions", version.id) },
          locale,
          attributes: { whatsNew: String(args.releaseNotes) },
        });
        steps.push({ step: "releaseNotes", ...result });
      }

      return { ok: true, app, version: { id: version.id, versionString, platform }, steps };
    }

    if (name === "asc_submit_for_review") {
      const app = await resolveApp(ctx, args.bundleId);
      const platform = String(args.platform ?? "IOS");
      const version = await resolveVersion(ctx, app, args.version, platform);

      // A second open submission for the same app is refused by Apple with
      // a message that says nothing about the first one, so reuse it
      const open = await get(ctx, `/v1/apps/${app.id}/reviewSubmissions`, {
        "filter[state]": "READY_FOR_REVIEW",
        "filter[platform]": platform,
        limit: 1,
      });
      let submissionId = open?.data?.[0]?.id ?? null;
      let reused = Boolean(submissionId);
      if (!submissionId) {
        const created = await call(ctx, "POST", "/v1/reviewSubmissions", {
          body: {
            data: {
              type: "reviewSubmissions",
              attributes: { platform },
              relationships: { app: ref("apps", app.id) },
            },
          },
        });
        submissionId = created?.data?.id;
      }
      if (!submissionId) throw new Error("App Store Connect returned no review submission to submit");

      const items = await get(ctx, `/v1/reviewSubmissions/${submissionId}/items`, { limit: 50 });
      const alreadyThere = (items?.data ?? []).some(
        (item) => item.relationships?.appStoreVersion?.data?.id === version.id,
      );
      if (!alreadyThere) {
        await call(ctx, "POST", "/v1/reviewSubmissionItems", {
          body: {
            data: {
              type: "reviewSubmissionItems",
              relationships: {
                reviewSubmission: ref("reviewSubmissions", submissionId),
                appStoreVersion: ref("appStoreVersions", version.id),
              },
            },
          },
        });
      }

      const submitted = await call(ctx, "PATCH", `/v1/reviewSubmissions/${submissionId}`, {
        body: { data: { type: "reviewSubmissions", id: submissionId, attributes: { submitted: true } } },
      });
      return {
        ok: true,
        app,
        version: { id: version.id, versionString: version.versionString, platform },
        submissionId,
        reusedOpenSubmission: reused,
        state: submitted?.data?.attributes?.state ?? null,
        submittedDate: submitted?.data?.attributes?.submittedDate ?? null,
      };
    }

    if (name === "asc_release_version") {
      const app = await resolveApp(ctx, args.bundleId);
      const platform = String(args.platform ?? "IOS");
      const version = await resolveVersion(ctx, app, args.version, platform);
      const state = version.attributes.appStoreState ?? version.attributes.state ?? version.attributes.appVersionState ?? null;
      if (state && !String(state).includes("PENDING_DEVELOPER_RELEASE")) {
        // Refusing with the state beats a 409 whose message names neither
        // the version nor what it is actually waiting for
        return {
          ok: false,
          reason: "not-pending-release",
          app,
          version: { id: version.id, versionString: version.versionString, state },
          hint: "Only a version Apple approved and left waiting on you can be released. asc_list_versions shows the state of each one.",
        };
      }
      const request = await call(ctx, "POST", "/v1/appStoreVersionReleaseRequests", {
        body: {
          data: {
            type: "appStoreVersionReleaseRequests",
            relationships: { appStoreVersion: ref("appStoreVersions", version.id) },
          },
        },
      });
      return {
        ok: true,
        app,
        version: { id: version.id, versionString: version.versionString, platform },
        releaseRequestId: request?.data?.id ?? null,
        released: true,
      };
    }

    if (name === "asc_phased_release") {
      const app = await resolveApp(ctx, args.bundleId);
      const platform = String(args.platform ?? "IOS");
      const version = await resolveVersion(ctx, app, args.version, platform);
      const current = await get(ctx, `/v1/appStoreVersions/${version.id}/appStoreVersionPhasedRelease`);
      const existing = current?.data ?? null;
      const action = String(args.action);

      if (action === "state") {
        return {
          ok: true,
          app,
          version: { id: version.id, versionString: version.versionString },
          phasedRelease: existing ? { id: existing.id, ...project(existing.attributes, ["phasedReleaseState", "startDate", "totalPauseDuration", "currentDayNumber"]) } : null,
        };
      }

      if (action === "cancel") {
        if (!existing) return { ok: false, reason: "no-phased-release", hint: "This version has no phased release to cancel." };
        await call(ctx, "DELETE", `/v1/appStoreVersionPhasedReleases/${existing.id}`);
        return { ok: true, app, version: { id: version.id, versionString: version.versionString }, action, phasedRelease: null };
      }

      const wanted = { start: "ACTIVE", resume: "ACTIVE", pause: "PAUSED", complete: "COMPLETE" }[action];
      if (!wanted) throw new Error(`Unknown phased release action: ${action}`);

      const response = existing
        ? await call(ctx, "PATCH", `/v1/appStoreVersionPhasedReleases/${existing.id}`, {
            body: { data: { type: "appStoreVersionPhasedReleases", id: existing.id, attributes: { phasedReleaseState: wanted } } },
          })
        : await call(ctx, "POST", "/v1/appStoreVersionPhasedReleases", {
            body: {
              data: {
                type: "appStoreVersionPhasedReleases",
                attributes: { phasedReleaseState: wanted },
                relationships: { appStoreVersion: ref("appStoreVersions", version.id) },
              },
            },
          });

      return {
        ok: true,
        app,
        version: { id: version.id, versionString: version.versionString },
        action,
        phasedRelease: {
          id: response?.data?.id ?? existing?.id ?? null,
          ...project(response?.data?.attributes ?? {}, ["phasedReleaseState", "startDate", "currentDayNumber"]),
        },
      };
    }

    if (name === "asc_write_request") {
      const method = String(args.method ?? "").toUpperCase();
      if (!["POST", "PATCH", "DELETE"].includes(method)) {
        throw new Error(`Unsupported method ${args.method}: use POST, PATCH or DELETE, or asc_request to read`);
      }
      return call(ctx, method, requirePath(String(args.path ?? "")), { params: args.query, body: args.body });
    }

    throw new Error(`Unknown App Store Connect tool: ${name}`);
  },
};
