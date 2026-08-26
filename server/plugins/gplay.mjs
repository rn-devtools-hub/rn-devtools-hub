/**
 * Google Play: what the Android half of a release is doing, and how to
 * move it.
 *
 * Which version code production is on, whether the staged rollout is at
 * 10% or 100%, what the last uploaded bundle was, what users wrote in the
 * reviews the crash reporter never sees, and then: promote internal to
 * production, widen the rollout, halt it when the crash rate moves,
 * answer a review. None of it is reachable from inside the app, and all
 * of it is what happens right after a build.
 *
 * Nearly everything about a release lives behind an "edit", a transaction
 * you open, change, then either commit or throw away. That makes the
 * difference between a read and a write literal here: a read opens an
 * edit and DELETES it in a finally, a write commits it. Both paths clean
 * up, because an edit left open holds a lock on the listing that someone
 * has to find and clear by hand later.
 *
 * Mutating tools live in writeTools, carry destructiveHint, and disappear
 * entirely when RN_DEVTOOLS_GPLAY_WRITES=off.
 *
 * Auth is the standard service-account flow: an RS256 assertion signed
 * locally, exchanged for an access token cached until it expires.
 */

import { readFileSync } from "node:fs";
import { apiJson, oneLine, project, query, signJwt } from "./_api.mjs";
import { readIndex } from "../storeshots.mjs";

const BASE = "https://androidpublisher.googleapis.com/androidpublisher/v3";
// Media goes to the same host under a different prefix, which is why the
// declared hosts do not change when screenshots are uploaded
const UPLOAD_BASE = "https://androidpublisher.googleapis.com/upload/androidpublisher/v3";
const SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const DEFAULT_TOKEN_URL = "https://oauth2.googleapis.com/token";
const LABEL = "Google Play";
const PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const TRACK = /^[A-Za-z0-9_.:-]{1,64}$/;

const explain = (data) => data?.error?.message ?? data?.error_description ?? null;

const serviceAccount = (ctx) => {
  if (ctx.state.account) return ctx.state.account;
  let parsed;
  try {
    parsed = JSON.parse(ctx.config.serviceAccount);
  } catch {
    throw new Error(
      "The service account credential is not JSON. GOOGLE_SERVICE_ACCOUNT_KEY_PATH must point at the key file Google Cloud generated, not at a p12 or a client id.",
    );
  }
  if (!parsed?.client_email || !parsed?.private_key) {
    throw new Error("The service account JSON has no client_email or private_key: it is not a service account key file.");
  }
  ctx.state.account = parsed;
  return parsed;
};

/**
 * An access token, minted from the key and kept until it expires.
 *
 * Signing on every call would be correct and wasteful; Google issues
 * these for an hour and says so, so the expiry it returns is what we
 * trust, minus a minute of clock slack.
 */
const accessToken = async (ctx) => {
  const now = Math.floor(Date.now() / 1000);
  if (ctx.state.accessToken && ctx.state.accessTokenExpiresAt - 60 > now) return ctx.state.accessToken;

  const account = serviceAccount(ctx);
  const tokenUrl = account.token_uri || DEFAULT_TOKEN_URL;
  const assertion = signJwt({
    algorithm: "RS256",
    header: { kid: account.private_key_id },
    claims: { iss: account.client_email, scope: SCOPE, aud: tokenUrl, iat: now, exp: now + 3600 },
    privateKey: account.private_key,
  });

  const granted = await apiJson(tokenUrl, {
    label: `${LABEL} sign-in`,
    explain,
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
  });
  if (!granted?.access_token) throw new Error(`${LABEL} returned no access token`);

  ctx.state.accessToken = granted.access_token;
  ctx.state.accessTokenExpiresAt = now + (Number(granted.expires_in) || 3600);
  return ctx.state.accessToken;
};

const call = async (ctx, method, path, { params, body } = {}) =>
  apiJson(`${BASE}${path}${query(params)}`, {
    label: LABEL,
    explain,
    method,
    headers: {
      authorization: `Bearer ${await accessToken(ctx)}`,
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    timeoutMs: 30000,
  });

const get = (ctx, path, params) => call(ctx, "GET", path, { params });

const packageName = (ctx, given) => {
  const wanted = String(given ?? ctx.config.packageName ?? "").trim();
  if (!wanted) {
    throw new Error(
      "No package name: pass packageName, set GOOGLE_PLAY_PACKAGE_NAME, or declare expo.android.package in app.json",
    );
  }
  if (!PACKAGE.test(wanted)) throw new Error(`Invalid Android package name: ${wanted}`);
  return wanted;
};

const trackName = (given) => {
  const wanted = String(given ?? "").trim();
  if (!TRACK.test(wanted)) throw new Error(`Invalid track name: ${given}`);
  return wanted;
};

/**
 * Opens an edit, runs through it, and always cleans up after itself.
 *
 * commit:false deletes the edit, so a read changes nothing. commit:true
 * publishes what was written, and a failure to commit still deletes the
 * edit rather than leaving a lock behind. On a read, a failed delete is
 * swallowed on purpose: the caller asked for data, and "could not clean
 * up" instead of the answer turns a successful read into an error.
 */
const withEdit = async (ctx, pkg, run, { commit = false, changesNotSentForReview = false } = {}) => {
  const edit = await call(ctx, "POST", `/applications/${pkg}/edits`);
  if (!edit?.id) throw new Error(`${LABEL} did not open an edit for ${pkg}`);
  let committed = false;
  try {
    const result = await run(edit.id);
    if (commit) {
      const done = await call(ctx, "POST", `/applications/${pkg}/edits/${edit.id}:commit`, {
        params: changesNotSentForReview ? { changesNotSentForReview: "true" } : undefined,
      });
      committed = true;
      return { result, edit: { id: edit.id, committed: true, ...project(done ?? {}, ["id"]) } };
    }
    return { result, edit: { id: edit.id, committed: false } };
  } finally {
    if (!committed) {
      try {
        await call(ctx, "DELETE", `/applications/${pkg}/edits/${edit.id}`);
      } catch {
        // An abandoned edit expires by itself; the operation is what mattered
      }
    }
  }
};

/**
 * One image, into a listing.
 *
 * A media upload does not go through the JSON endpoint: same host,
 * /upload prefix, uploadType=media, and the bytes as the body. The edit
 * it happens in is committed by the caller, so nothing is live until the
 * whole set landed.
 */
const uploadImage = async (ctx, { pkg, editId, language, imageType, file }) => {
  const bytes = readFileSync(file);
  const url = `${UPLOAD_BASE}/applications/${pkg}/edits/${editId}/listings/${encodeURIComponent(language)}/${imageType}?uploadType=media`;
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${await accessToken(ctx)}`, "content-type": "image/png" },
    body: bytes,
    signal: AbortSignal.timeout(120000),
  });
  const text = await response.text();
  if (!response.ok) {
    let detail = oneLine(text, 200);
    try { detail = explain(JSON.parse(text)) ?? detail; } catch { /* the body was not JSON */ }
    throw new Error(`${LABEL} refused ${file.split("/").pop()} (${response.status}): ${detail}`);
  }
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  return { file, bytes: bytes.length, ...project(parsed?.image ?? {}, ["id", "sha256", "url"]) };
};

const RELEASE_KEYS = ["name", "versionCodes", "status", "userFraction", "countryTargeting", "inAppUpdatePriority"];

const readTrack = (track) => ({
  track: track?.track ?? null,
  releases: (track?.releases ?? []).map((release) => ({
    ...project(release, RELEASE_KEYS),
    releaseNotes: (release.releaseNotes ?? []).map((note) => ({ language: note.language, text: note.text })),
  })),
});

/** The release a track is actually serving: the one with a version code */
const activeRelease = (track) =>
  (track?.releases ?? []).find((release) => (release.versionCodes ?? []).length > 0) ?? null;

const clamp = (value, fallback, max) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(Math.trunc(parsed), max)) : fallback;
};

/**
 * Builds the release object Play expects, and refuses the combinations it
 * rejects with a message that names neither field.
 */
const buildRelease = ({ versionCodes, status, userFraction, releaseNotes, name }) => {
  const codes = (versionCodes ?? []).map((code) => String(code));
  if (codes.length === 0) throw new Error("No version code for this release: pass versionCodes, or target a track that already has one");

  const wanted = String(status ?? "completed");
  if (!["completed", "inProgress", "halted", "draft"].includes(wanted)) {
    throw new Error(`Invalid status ${status}: use completed, inProgress, halted or draft`);
  }
  const staged = wanted === "inProgress" || wanted === "halted";
  const fraction = userFraction === undefined || userFraction === null ? null : Number(userFraction);

  if (staged && (fraction === null || !(fraction > 0 && fraction < 1))) {
    throw new Error(
      `status "${wanted}" is a staged rollout and needs userFraction strictly between 0 and 1 (0.1 is 10% of users). For everyone, use status "completed".`,
    );
  }
  if (!staged && fraction !== null) {
    throw new Error(`status "${wanted}" reaches every user, so it cannot carry a userFraction. Use status "inProgress" for a staged rollout.`);
  }

  return {
    versionCodes: codes,
    status: wanted,
    ...(staged ? { userFraction: fraction } : {}),
    ...(name ? { name: String(name) } : {}),
    ...(releaseNotes ? { releaseNotes: releaseNotes.map((note) => ({ language: String(note.language), text: String(note.text) })) } : {}),
  };
};

/**
 * What this plugin depends on, upstream.
 *
 * Google publishes a discovery document for this API, which names every
 * method by id and every schema by field. So the dependency is declared
 * here as those ids rather than as URLs, and
 * scripts/check-store-apis.mjs verifies it against the live document. A
 * method Google moves becomes a failing check instead of a 404 during a
 * rollout.
 */
export const CONTRACT = {
  spec: {
    kind: "discovery",
    url: "https://androidpublisher.googleapis.com/$discovery/rest?version=v3",
    name: "Google Play Android Developer API discovery document",
  },
  endpoints: [
    { id: "androidpublisher.edits.insert", why: "every track read and write opens an edit" },
    { id: "androidpublisher.edits.delete", why: "a read throws its edit away, and so does a failed write" },
    { id: "androidpublisher.edits.commit", why: "gplay_update_track and gplay_promote_release make it live" },
    { id: "androidpublisher.edits.tracks.list", why: "gplay_list_tracks" },
    { id: "androidpublisher.edits.tracks.get", why: "gplay_get_track, and reading before a write" },
    { id: "androidpublisher.edits.tracks.update", why: "gplay_update_track, gplay_promote_release" },
    { id: "androidpublisher.edits.bundles.list", why: "gplay_list_artifacts" },
    { id: "androidpublisher.edits.apks.list", why: "gplay_list_artifacts" },
    { id: "androidpublisher.reviews.list", why: "gplay_list_reviews" },
    { id: "androidpublisher.reviews.reply", why: "gplay_reply_review" },
    { id: "androidpublisher.edits.images.upload", why: "gplay_upload_screenshots" },
    { id: "androidpublisher.edits.images.deleteall", why: "gplay_upload_screenshots replace" },
    { id: "androidpublisher.edits.images.list", why: "gplay_upload_screenshots reports what the listing holds after" },
  ],
  fields: [
    { schema: "TrackRelease", read: ["name", "versionCodes", "status", "userFraction", "countryTargeting", "inAppUpdatePriority", "releaseNotes"] },
    { schema: "Track", read: ["track", "releases"] },
    { schema: "Review", read: ["reviewId", "authorName", "comments"] },
    { schema: "UserComment", read: ["text", "starRating", "lastModified", "appVersionName", "appVersionCode", "androidOsVersion", "deviceMetadata"], tolerated: ["device"] },
    { schema: "Bundle", read: ["versionCode", "sha256", "sha1"] },
    { schema: "Apk", read: ["versionCode", "binary"] },
    { schema: "Image", read: ["id", "url", "sha256"] },
  ],
};

export default {
  id: "gplay",
  title: "Google Play",
  summary: "Tracks, staged rollouts, artifacts and store reviews for the Android app this project declares: read them, and drive them.",
  license: "MIT",
  hosts: ["androidpublisher.googleapis.com", "oauth2.googleapis.com"],
  docs: "docs/plugins.md",
  setupHint:
    "Create a service account in Google Cloud, grant it access in Play Console (Users and permissions), download its JSON key and set GOOGLE_SERVICE_ACCOUNT_KEY_PATH, or fill \"gplay\" in .rn-devtools/plugins.json. Restart the hub afterwards.",
  config: [
    {
      key: "serviceAccount",
      env: ["GOOGLE_SERVICE_ACCOUNT_KEY"],
      pathEnv: [
        "GOOGLE_SERVICE_ACCOUNT_KEY_PATH",
        "ANDROID_SERVICE_ACCOUNT_KEY_PATH",
        "EXPO_ANDROID_SERVICE_ACCOUNT_KEY_PATH",
        "GOOGLE_APPLICATION_CREDENTIALS",
      ],
      secret: true,
      description: "Service account JSON key with Play Developer API access, or a path to it (GOOGLE_SERVICE_ACCOUNT_KEY_PATH)",
    },
    {
      key: "packageName",
      env: ["GOOGLE_PLAY_PACKAGE_NAME", "ANDROID_PACKAGE_NAME"],
      required: false,
      description: "Default Android package name; read from expo.android.package in app.json when absent",
      derive: ({ appConfig }) => appConfig?.android?.package ?? null,
    },
  ],

  tools: [
    {
      name: "gplay_list_tracks",
      description:
        "Lists every Play track (production, beta, alpha, internal and any custom one) with the releases sitting in it: version codes, status (completed, inProgress, draft, halted), staged rollout fraction and release notes. This is where a rollout still at 10% shows up, which no signal inside the app reports. Reads through an edit that is opened and immediately discarded, never committed.",
      inputSchema: { type: "object", properties: { packageName: { type: "string" } }, additionalProperties: false },
      annotations: { readOnlyHint: true },
    },
    {
      name: "gplay_get_track",
      description: "Same as gplay_list_tracks for a single track, when only production or only internal matters.",
      inputSchema: {
        type: "object",
        required: ["track"],
        properties: {
          track: { type: "string", description: "production, beta, alpha, internal, or a custom track name" },
          packageName: { type: "string" },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: "gplay_list_artifacts",
      description:
        "Lists the app bundles and APKs uploaded to Play, with their version codes and sha256. Answers whether the artifact a build just produced actually reached Play, and which version code it was given.",
      inputSchema: { type: "object", properties: { packageName: { type: "string" } }, additionalProperties: false },
      annotations: { readOnlyHint: true },
    },
    {
      name: "gplay_list_reviews",
      description:
        "Returns recent Play Store reviews with their star rating, text, device, Android version and the app version they were written against. Reviews name the crashes a reporter never receives and the regressions that only happen on one OEM. Play only exposes reviews from the last week or so, and none at all for an app that has never been published.",
      inputSchema: {
        type: "object",
        properties: {
          packageName: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 100 },
          translationLanguage: { type: "string", description: "BCP-47 code, e.g. \"en\", to get reviews translated" },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: "gplay_request",
      description:
        "Authenticated GET against any Play Developer API v3 endpoint, for what the other tools do not cover (subscriptions, in-app products, device tier configs). path is relative to androidpublisher/v3, e.g. /applications/{packageName}/reviews/{reviewId}. Paths under /edits are refused: an edit read outside the tools that manage one would be left open on the listing.",
      inputSchema: {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string", description: "Path under androidpublisher/v3, starting with /" },
          query: { type: "object", description: "Query parameters passed through" },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
  ],

  writeTools: [
    {
      name: "gplay_update_track",
      description:
        "Writes the release of a track and COMMITS it, which is what makes it live: start a staged rollout (status inProgress with userFraction 0.1), widen it, halt it when something looks wrong, or send it to everyone (status completed). Omit versionCodes to keep the ones the track already serves, which is how a rollout is paused or widened without repeating them. The answer carries the track before and after, because \"what was it at\" is the question asked right after a halt.",
      inputSchema: {
        type: "object",
        required: ["track"],
        properties: {
          packageName: { type: "string" },
          track: { type: "string", description: "production, beta, alpha, internal, or a custom track" },
          versionCodes: { type: "array", items: { type: ["string", "integer"] }, description: "Defaults to what the track already serves" },
          status: { type: "string", enum: ["completed", "inProgress", "halted", "draft"], description: "Default completed, which reaches every user" },
          userFraction: { type: "number", minimum: 0, maximum: 1, description: "Required by inProgress and halted, refused by completed. 0.1 is 10% of users" },
          releaseNotes: {
            type: "array",
            description: "Per language, e.g. [{\"language\": \"en-US\", \"text\": \"...\"}]",
            items: { type: "object", required: ["language", "text"], properties: { language: { type: "string" }, text: { type: "string" } }, additionalProperties: false },
          },
          name: { type: "string", description: "Release name shown in Play Console" },
          changesNotSentForReview: { type: "boolean", description: "Commit without sending the listing changes for review (only valid for apps where that applies)" },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    {
      name: "gplay_promote_release",
      description:
        "Takes what a track is serving and puts it in another one, then commits: internal to beta, beta to production. Release notes are carried over unless new ones are given. Promoting to production with status completed ships to every user, so the usual first step is status inProgress with a userFraction.",
      inputSchema: {
        type: "object",
        required: ["from", "to"],
        properties: {
          packageName: { type: "string" },
          from: { type: "string", description: "Source track, e.g. internal" },
          to: { type: "string", description: "Target track, e.g. production" },
          status: { type: "string", enum: ["completed", "inProgress", "halted", "draft"], description: "Default completed" },
          userFraction: { type: "number", minimum: 0, maximum: 1, description: "Required by inProgress and halted" },
          releaseNotes: {
            type: "array",
            items: { type: "object", required: ["language", "text"], properties: { language: { type: "string" }, text: { type: "string" } }, additionalProperties: false },
          },
          changesNotSentForReview: { type: "boolean" },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    {
      name: "gplay_reply_review",
      description:
        "Publishes a public reply under a Play Store review, signed as the developer and visible to everyone. One reply per review: sending another replaces the previous one.",
      inputSchema: {
        type: "object",
        required: ["reviewId", "text"],
        properties: {
          packageName: { type: "string" },
          reviewId: { type: "string", description: "From gplay_list_reviews" },
          text: { type: "string", maxLength: 350, description: "Play caps a reply at 350 characters" },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    {
      name: "gplay_upload_screenshots",
      description:
        "Uploads the screenshots capture_store_screenshots wrote to the Play listing, grouped by language and by form factor (phone, seven inch, ten inch, read from the shortest side of each capture). replace clears the existing images of that form factor first, which is what a new release usually wants. Everything happens in one Play edit that is committed at the end, so a listing is never left half updated. Only the Android captures in the index are considered.",
      inputSchema: {
        type: "object",
        properties: {
          packageName: { type: "string" },
          from: { type: "string", description: "Directory or index.json written by capture_store_screenshots (default .rn-devtools/store-screenshots)" },
          language: { type: "string", description: "Only this language from the capture, e.g. en-US" },
          imageType: { type: "string", enum: ["phoneScreenshots", "sevenInchScreenshots", "tenInchScreenshots", "tvScreenshots", "wearScreenshots"], description: "Force the form factor instead of reading it from the capture size" },
          replace: { type: "boolean", description: "Delete the images already on the listing for each form factor before uploading (default false)" },
          changesNotSentForReview: { type: "boolean" },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    {
      name: "gplay_write_request",
      description:
        "Authenticated POST, PUT, PATCH or DELETE against any Play Developer API v3 endpoint, for the parts of the console this file does not model (in-app products, subscriptions, testers). Paths under /edits stay refused even here: an edit opened outside gplay_update_track is a lock nobody closes.",
      inputSchema: {
        type: "object",
        required: ["method", "path"],
        properties: {
          method: { type: "string", enum: ["POST", "PUT", "PATCH", "DELETE"] },
          path: { type: "string", description: "Path under androidpublisher/v3, starting with /" },
          body: { type: "object" },
          query: { type: "object" },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
  ],

  async handle(name, args, ctx) {
    // ---- reads ----
    if (name === "gplay_list_tracks") {
      const pkg = packageName(ctx, args.packageName);
      const { result } = await withEdit(ctx, pkg, (editId) => get(ctx, `/applications/${pkg}/edits/${editId}/tracks`));
      const tracks = (result?.tracks ?? []).map(readTrack);
      return { packageName: pkg, count: tracks.length, tracks };
    }

    if (name === "gplay_get_track") {
      const pkg = packageName(ctx, args.packageName);
      const track = trackName(args.track);
      const { result } = await withEdit(ctx, pkg, (editId) =>
        get(ctx, `/applications/${pkg}/edits/${editId}/tracks/${encodeURIComponent(track)}`));
      return { packageName: pkg, ...readTrack(result) };
    }

    if (name === "gplay_list_artifacts") {
      const pkg = packageName(ctx, args.packageName);
      const { result } = await withEdit(ctx, pkg, async (editId) => {
        const [bundles, apks] = await Promise.all([
          get(ctx, `/applications/${pkg}/edits/${editId}/bundles`),
          get(ctx, `/applications/${pkg}/edits/${editId}/apks`),
        ]);
        return {
          bundles: (bundles?.bundles ?? []).map((bundle) => project(bundle, ["versionCode", "sha256", "sha1"])),
          apks: (apks?.apks ?? []).map((apk) => ({
            versionCode: apk.versionCode,
            ...project(apk.binary ?? {}, ["sha256", "sha1"]),
          })),
        };
      });
      return { packageName: pkg, ...result };
    }

    if (name === "gplay_list_reviews") {
      const pkg = packageName(ctx, args.packageName);
      const data = await get(ctx, `/applications/${pkg}/reviews`, {
        maxResults: clamp(args.limit, 20, 100),
        translationLanguage: args.translationLanguage,
      });
      const reviews = (data?.reviews ?? []).map((review) => {
        const latest = review.comments?.[0]?.userComment ?? {};
        return {
          reviewId: review.reviewId,
          authorName: review.authorName ?? null,
          starRating: latest.starRating ?? null,
          text: latest.text ?? null,
          lastModified: latest.lastModified?.seconds ? Number(latest.lastModified.seconds) * 1000 : null,
          appVersionName: latest.appVersionName ?? null,
          appVersionCode: latest.appVersionCode ?? null,
          androidOsVersion: latest.androidOsVersion ?? null,
          device: latest.deviceMetadata?.productName ?? latest.device ?? null,
          hasDeveloperReply: (review.comments ?? []).some((comment) => comment.developerComment),
        };
      });
      return { packageName: pkg, count: reviews.length, reviews };
    }

    if (name === "gplay_request") {
      const path = String(args.path ?? "");
      if (!path.startsWith("/") || path.includes("..")) {
        throw new Error(`Invalid path ${JSON.stringify(path)}: expected a path under androidpublisher/v3, e.g. /applications/{packageName}/reviews`);
      }
      if (/\/edits(\/|:|$)/.test(path)) {
        throw new Error("Paths under /edits are refused here: use gplay_list_tracks or gplay_update_track, which close the edit they open.");
      }
      return get(ctx, path, args.query ?? {});
    }

    // ---- writes ----
    if (name === "gplay_update_track") {
      const pkg = packageName(ctx, args.packageName);
      const track = trackName(args.track);
      const { result, edit } = await withEdit(ctx, pkg, async (editId) => {
        const before = await get(ctx, `/applications/${pkg}/edits/${editId}/tracks/${encodeURIComponent(track)}`);
        const current = activeRelease(before);
        const release = buildRelease({
          versionCodes: args.versionCodes ?? current?.versionCodes,
          status: args.status,
          userFraction: args.userFraction,
          releaseNotes: args.releaseNotes,
          name: args.name,
        });
        const after = await call(ctx, "PUT", `/applications/${pkg}/edits/${editId}/tracks/${encodeURIComponent(track)}`, {
          body: { track, releases: [release] },
        });
        return { before: readTrack(before), after: readTrack(after) };
      }, { commit: true, changesNotSentForReview: args.changesNotSentForReview === true });

      return { ok: true, packageName: pkg, track, edit, ...result };
    }

    if (name === "gplay_promote_release") {
      const pkg = packageName(ctx, args.packageName);
      const from = trackName(args.from);
      const to = trackName(args.to);
      if (from === to) throw new Error(`from and to are the same track (${from}): use gplay_update_track to change a track in place`);

      const { result, edit } = await withEdit(ctx, pkg, async (editId) => {
        const source = await get(ctx, `/applications/${pkg}/edits/${editId}/tracks/${encodeURIComponent(from)}`);
        const current = activeRelease(source);
        if (!current) throw new Error(`Track ${from} has no release to promote. gplay_list_tracks shows what each track serves.`);
        const release = buildRelease({
          versionCodes: current.versionCodes,
          status: args.status,
          userFraction: args.userFraction,
          releaseNotes: args.releaseNotes ?? current.releaseNotes,
          name: current.name,
        });
        const before = await get(ctx, `/applications/${pkg}/edits/${editId}/tracks/${encodeURIComponent(to)}`);
        const after = await call(ctx, "PUT", `/applications/${pkg}/edits/${editId}/tracks/${encodeURIComponent(to)}`, {
          body: { track: to, releases: [release] },
        });
        return { promoted: project(release, ["versionCodes", "status", "userFraction"]), before: readTrack(before), after: readTrack(after) };
      }, { commit: true, changesNotSentForReview: args.changesNotSentForReview === true });

      return { ok: true, packageName: pkg, from, to, edit, ...result };
    }

    if (name === "gplay_reply_review") {
      const pkg = packageName(ctx, args.packageName);
      const reviewId = String(args.reviewId ?? "").trim();
      if (!reviewId) throw new Error("Pass reviewId, from gplay_list_reviews");
      const text = String(args.text ?? "");
      if (!text.trim()) throw new Error("An empty reply would be published as an empty reply: pass text");
      if (text.length > 350) throw new Error(`Play caps a reply at 350 characters, this one is ${text.length}`);

      const replied = await call(ctx, "POST", `/applications/${pkg}/reviews/${encodeURIComponent(reviewId)}:reply`, {
        body: { replyText: text },
      });
      return {
        ok: true,
        packageName: pkg,
        reviewId,
        published: true,
        lastEdited: replied?.result?.lastEdited?.seconds ? Number(replied.result.lastEdited.seconds) * 1000 : null,
      };
    }

    if (name === "gplay_upload_screenshots") {
      const pkg = packageName(ctx, args.packageName);
      const index = readIndex(ctx.projectRoot, args.from);

      // iOS captures live in the same index; they belong to App Store Connect
      const wanted = index.shots
        .filter((shot) => !/^sim:/.test(String(shot.target ?? "")))
        .filter((shot) => !args.language || shot.locale === args.language)
        .sort((left, right) => String(left.file).localeCompare(String(right.file)));
      if (wanted.length === 0) {
        throw new Error(`No Android capture in ${index.path}${args.language ? ` for language ${args.language}` : ""}`);
      }

      const groups = new Map();
      for (const shot of wanted) {
        const imageType = args.imageType ?? shot.playImageType ?? "phoneScreenshots";
        const key = `${shot.locale}|${imageType}`;
        if (!groups.has(key)) groups.set(key, { language: shot.locale, imageType, shots: [] });
        groups.get(key).shots.push(shot);
      }

      const { result, edit } = await withEdit(ctx, pkg, async (editId) => {
        const done = [];
        for (const group of groups.values()) {
          if (args.replace) {
            await call(ctx, "DELETE", `/applications/${pkg}/edits/${editId}/listings/${encodeURIComponent(group.language)}/${group.imageType}`);
          }
          const images = [];
          for (const shot of group.shots) {
            images.push(await uploadImage(ctx, { pkg, editId, language: group.language, imageType: group.imageType, file: shot.file }));
          }
          const listing = await get(ctx, `/applications/${pkg}/edits/${editId}/listings/${encodeURIComponent(group.language)}/${group.imageType}`);
          done.push({
            language: group.language,
            imageType: group.imageType,
            replaced: args.replace === true,
            uploaded: images,
            onListing: (listing?.images ?? []).length,
          });
        }
        return done;
      }, { commit: true, changesNotSentForReview: args.changesNotSentForReview === true });

      return {
        ok: true,
        packageName: pkg,
        from: index.path,
        edit,
        count: result.reduce((total, group) => total + group.uploaded.length, 0),
        listings: result,
      };
    }

    if (name === "gplay_write_request") {
      const method = String(args.method ?? "").toUpperCase();
      if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
        throw new Error(`Unsupported method ${args.method}: use POST, PUT, PATCH or DELETE, or gplay_request to read`);
      }
      const path = String(args.path ?? "");
      if (!path.startsWith("/") || path.includes("..")) {
        throw new Error(`Invalid path ${JSON.stringify(path)}: expected a path under androidpublisher/v3`);
      }
      if (/\/edits(\/|:|$)/.test(path)) {
        throw new Error("Paths under /edits are refused: an edit opened here is a lock nobody closes. gplay_update_track opens, writes and commits one.");
      }
      return call(ctx, method, path, { params: args.query, body: args.body });
    }

    throw new Error(`Unknown Google Play tool: ${name}`);
  },
};
