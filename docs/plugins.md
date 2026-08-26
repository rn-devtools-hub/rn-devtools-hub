# Hub plugins

MIT, like the rest of the package. They live in `server/plugins/`.

Every other tool in this hub reads a running JavaScript runtime, or the OS
underneath it. A release lives where neither can look: App Store Connect
knows whether the build that just finished uploading is usable yet, Google
Play knows what production is actually serving. An agent that just shipped
has no way to find out, and until now the answer was a browser tab.

A plugin is how the hub reaches those services. It is the one place where
this hub stops being local-only, so the design says so out loud:

- A plugin **declares every host it will contact**. The hub prints them at
  startup and `list_plugins` returns them. Nothing is discovered in a proxy
  log afterwards.
- A plugin with no credentials is **not an error and not a crash**. It is
  listed as not configured, with the exact keys it wants and where to put
  them, and it exposes **no tool at all**: ten tools nobody can call would
  be ten tool definitions every agent pays for on every request.
- Credentials resolve inside the hub process and stay there. `list_plugins`
  says a value is set and where it was read from, never what it is.
- Configuration is read once, at startup. MCP clients are told
  `listChanged: false`, so a tool list that grew mid-session would be a tool
  the client never learns about. Set the credentials, restart the hub, read
  the banner.
- A plugin separates the tools that **read** from the tools that **change
  something**, and the registry knows which is which. Writes ship enabled:
  a release tool that can only look at a release is half a tool.

## Not a reimplementation

These plugins do not rebuild App Store Connect or Play Console, and they
do not wrap a CLI that does. Every call is the vendor's **own REST API**,
with the vendor's **own authentication**: an ES256 token signed with the
`.p8` Apple issued, a service-account assertion exchanged for a Google
access token. No scraping, no vendored client, no fork of anyone's
tooling, nothing to keep in step with a third-party wrapper's release
cycle.

What this hub adds is the other half, the one the vendors cannot have:
the app seen from inside its own runtime. The coupling is by **extension**
rather than by replacement, and it shows in two places.

- **Nothing is fenced off.** `asc_request` and `gplay_request` (and their
  `*_write_request` counterparts) reach any endpoint of either API, so
  the parts these plugins do not model are still one call away. The
  named tools exist because they resolve the app from `app.json`,
  validate the combinations the vendor rejects with an unhelpful message,
  and clean up the Play edit they open, not to be the only way in.
- **The vendor keeps owning their API.** When Apple adds an endpoint it
  is usable here the day it ships, without a release of this package.

### The price of that, and what pays it

Drift. Apple renames an attribute between API versions, Google moves a
method, and the failure would otherwise surface as a 400 in the middle of
someone's release.

So each plugin **declares** what it depends on, next to the code that
depends on it:

```js
export const CONTRACT = {
  spec: { kind: "openapi", url: "https://developer.apple.com/..." },
  endpoints: [{ method: "POST", path: "/v1/reviewSubmissions", why: "asc_submit_for_review opens one" }],
  fields: [{ schema: "Build", read: ["version", "processingState", "uploadedDate"] }],
};
```

And a check verifies that declaration against the machine-readable
specification each vendor publishes: Apple's OpenAPI document and
Google's discovery document.

```bash
npm run check:store-apis
```

It runs weekly in CI and on any pull request touching `server/plugins/`.
A specification that cannot be downloaded is reported as **skipped**, not
as drift: a check that goes red because `developer.apple.com` was slow is
a check people learn to ignore. Every endpoint and every field a plugin
reads is covered, `why` included, so an entry nobody can justify is an
entry that can be deleted.

`read` fields must exist. `tolerated` ones may or may not: those are the
names a vendor has already renamed once, which the code projects
defensively, keeping whichever the account's API actually returns.
`appStoreState` and `appVersionState` are the same field on either side of
one of those renames, and the check only complains when they all vanish.

## Turning writes off

Every mutating tool carries `destructiveHint`, so an MCP client asks before
running one. If that is not enough for your team, one variable removes them:

```bash
export RN_DEVTOOLS_PLUGIN_WRITES=off      # every plugin
export RN_DEVTOOLS_GPLAY_WRITES=off       # only Google Play
```

Off means the tools are **not exposed at all**, not exposed and refusing.
An agent never plans a step that does not exist, which is worth more than a
refusal it has to discover halfway through. `list_plugins` reports the state
and the variable responsible, and the startup banner says
`CAN CHANGE releases` or `read only` on the plugin's own line.

## The skills come with it

Installing the hub's plugin installs two skills, so there is nothing else to
add: `rn-devtools-hub` teaches an agent to drive the running app, and
`rn-devtools-release` teaches it to ship one, which is the same agent in the
same session. That is the point of putting the stores behind the hub rather
than behind a separate tool: the decision to widen a rollout and the crash
evidence for it are in one place.

```
Claude Code: /plugin marketplace add rn-devtools-hub/rn-devtools-hub
Codex:       codex plugin marketplace add rn-devtools-hub/rn-devtools-hub
```

## Configuring

Two ways, and they can be mixed. Environment variables win over the file.

### Environment variables

```bash
# App Store Connect
export ASC_KEY_ID=XXXXXXXXXX
export ASC_ISSUER_ID=69a6de70-xxxx-xxxx-xxxx-xxxxxxxxxxxx
export ASC_KEY_PATH=~/keys/AuthKey_XXXXXXXXXX.p8

# Google Play
export GOOGLE_SERVICE_ACCOUNT_KEY_PATH=~/keys/play-service-account.json
```

The names fastlane and EAS already use are accepted too
(`APP_STORE_CONNECT_API_KEY_KEY_ID`, `EXPO_ASC_API_KEY_PATH`,
`EXPO_ANDROID_SERVICE_ACCOUNT_KEY_PATH`, `GOOGLE_APPLICATION_CREDENTIALS`),
so a project that already sets them for a release script needs nothing new.

### `.rn-devtools/plugins.json`

For settings you would rather not export in every shell. The hub writes a
self-ignoring `.gitignore` into `.rn-devtools/` the first time it runs, so
the directory never reaches a commit with or without the project's
cooperation. Treat the file as a credential anyway: it holds a path to a
private key, and can hold the key itself.

```json
{
  "asc": {
    "keyId": "XXXXXXXXXX",
    "issuerId": "69a6de70-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "privateKeyPath": "~/keys/AuthKey_XXXXXXXXXX.p8"
  },
  "gplay": {
    "serviceAccountPath": "~/keys/play-service-account.json"
  }
}
```

Any key accepts a `Path` sibling (`privateKey` or `privateKeyPath`): the
first is the value, the second is a file to read it from. `~` is expanded,
and a relative path resolves from the project root.

### What you do not have to configure

The bundle identifier and the Android package name are read from
`app.json` (`expo.ios.bundleIdentifier`, `expo.android.package`). Passing
`bundleId` or `packageName` to a tool still wins, which is what a monorepo
with several apps needs.

## App Store Connect (`asc`)

Create the key in App Store Connect under Users and Access, then
Integrations, then App Store Connect API. Apple lets the `.p8` be
downloaded exactly once. A key with the Developer role is enough for
everything below; App Manager is needed to read some version states.

Contacts `api.appstoreconnect.apple.com`. Authentication is a short-lived
ES256 token signed locally with the `.p8`, minted every twenty minutes and
never stored.

| Tool | What it answers |
| --- | --- |
| `asc_list_apps` | Which apps this key can see. Call it when a bundle identifier is refused: the key may be scoped elsewhere |
| `asc_list_builds` | Is the build I just uploaded usable yet: build number, version, `processingState`, expiry |
| `asc_list_versions` | Where a version stands: `PREPARE_FOR_SUBMISSION`, `WAITING_FOR_REVIEW`, `IN_REVIEW`, `PENDING_DEVELOPER_RELEASE`, `READY_FOR_SALE`, `REJECTED` |
| `asc_list_beta_groups` | The TestFlight groups, internal and external, with their public links |
| `asc_request` | Signed GET against any other App Store Connect endpoint |

And what it changes:

| Tool | What it does |
| --- | --- |
| `asc_set_whats_new` | Writes the "What to Test" note, creating the localization when there is none. TestFlight refuses an external distribution without one |
| `asc_distribute_build` | Hands a build to a TestFlight group, or takes it back, and can request the beta review an external group needs |
| `asc_expire_build` | Expires a build. Irreversible, and it disappears for every tester |
| `asc_prepare_version` | Creates the version, attaches the build, writes the release notes. Idempotent: run it twice and read `steps` |
| `asc_submit_for_review` | Submits to App Review. Reuses an open submission instead of creating a second Apple would refuse |
| `asc_release_version` | Releases an approved version to the App Store. Refused, with the state, unless it is `PENDING_DEVELOPER_RELEASE` |
| `asc_phased_release` | Start, pause, resume, complete or cancel the phased release. Pausing is the only lever that acts immediately |
| `asc_write_request` | POST, PATCH or DELETE against any other endpoint. It does exactly what it is told |

`asc_list_versions` passes Apple's state field through under the name Apple
used. It has changed between API versions, and renaming it here would make
the answer disagree with Apple's own documentation.

## Google Play (`gplay`)

Create a service account in Google Cloud on the project linked to your Play
Console, download its JSON key, then grant it access in Play Console under
Users and permissions. The Play side of that grant is the step that is
easy to forget: without it every call answers 403, and the message says so.

Contacts `androidpublisher.googleapis.com` and `oauth2.googleapis.com`.
Authentication is the standard service-account flow: an RS256 assertion
signed locally, exchanged for an access token cached until it expires.

| Tool | What it answers |
| --- | --- |
| `gplay_list_tracks` | What each track is serving: version codes, release status, staged rollout fraction, release notes |
| `gplay_get_track` | The same for one track, when only production matters |
| `gplay_list_artifacts` | Which bundles and APKs actually reached Play, and the version code each was given |
| `gplay_list_reviews` | What users wrote: rating, text, device, OS and app version. Reviews name the crashes a reporter never receives |
| `gplay_request` | Authenticated GET against any other Play Developer v3 endpoint |

And what it changes:

| Tool | What it does |
| --- | --- |
| `gplay_update_track` | Writes a track's release and commits it: start a staged rollout, widen it, halt it, or send it to everyone. Omit `versionCodes` and the track keeps the ones it serves, which makes widening and halting one call |
| `gplay_promote_release` | Moves what one track serves into another, carrying the release notes over. Internal to beta, beta to production |
| `gplay_reply_review` | Publishes a public reply under a review, signed as the developer |
| `gplay_write_request` | POST, PUT, PATCH or DELETE against any other endpoint |

`completed` reaches every user and refuses a `userFraction`; `inProgress`
and `halted` require one strictly between 0 and 1. Play rejects the other
combinations with a message naming neither field, so they are refused here
with a sentence instead.

Nearly everything about a release lives behind an "edit", a transaction the
API makes you open, change, then commit or throw away. That makes the
difference between a read and a write literal: **a read deletes its edit in
a `finally`, a write commits it**, and a write that fails still deletes it.
An edit left open holds a lock on the listing that someone has to find and
clear by hand later, which is why both `gplay_request` and
`gplay_write_request` refuse paths under `/edits`.

Play only exposes reviews from roughly the last week, and none at all for
an app that has never been published. An empty answer there is a fact about
Play, not about the app.

## Reading a failure

Both plugins translate the vendor's own error document into one line, and
add what the status means for the credentials in play:

```
Google Play answered 403 (authenticated, but this key has no access to that
resource): The caller does not have permission
```

That is a service account that exists and signed correctly but was never
granted access in Play Console. An `401 (the credentials were rejected)` is
the opposite: the key itself is wrong, or expired.

## Writing a plugin

Point `RN_DEVTOOLS_PLUGINS` at a file or a directory (comma separated,
resolved from the project root). Discovery is deliberately explicit: the
hub does not load whatever happens to be sitting in a folder.

```js
export default {
  id: "sentry",                     // 2 to 16 lowercase letters or digits
  title: "Sentry",
  summary: "Recent issues for this app's release.",
  hosts: ["sentry.io"],             // every host, declared
  setupHint: "Set SENTRY_TOKEN, then restart the hub.",
  config: [
    { key: "token", env: ["SENTRY_TOKEN"], secret: true, description: "Auth token" },
    { key: "project", env: ["SENTRY_PROJECT"], required: false,
      derive: ({ appConfig }) => appConfig?.slug ?? null },
  ],
  tools: [{
    name: "sentry_list_issues",     // must start with `${id}_`
    description: "...",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  }],
  writeTools: [{                    // the ones that CHANGE something
    name: "sentry_resolve_issue",
    description: "...",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true },
  }],
  async handle(name, args, ctx) {
    // ctx = { config, projectRoot, state, appConfig() }
    // ctx.state is yours, and lives as long as the hub: cache tokens in it
  },
};
```

The rules the loader enforces, each because breaking it is worse than not
loading the plugin:

- every tool name starts with `${id}_`, so a tool log full of plugin calls
  still says who owns each one;
- a tool name that collides with a hub tool or with another plugin's is
  refused outright, because an agent calling `assert` and reaching a plugin
  is the worst failure available here;
- a plugin that throws while loading is disabled with the reason, and the
  hub starts anyway;
- a tool in `writeTools` must carry `{readOnlyHint: false, destructiveHint:
  true}`, or the plugin is refused. Those two flags are what an MCP client
  reads to decide whether to ask the human, and a tool that changes
  something at Apple while calling itself read-only is the one
  mislabelling that must never ship.

`server/plugins/_api.mjs` has what a vendor API needs and nothing else:
`signJwt` (ES256 and RS256, built on `node:crypto` because a package to
sign a JWT would contradict the zero-dependency promise), `apiJson` (fetch
with timeouts and translated failures), `query` and `project`. Files whose
name starts with `_` are helpers, and the loader skips them.
