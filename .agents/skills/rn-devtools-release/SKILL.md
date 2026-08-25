---
name: rn-devtools-release
description: Ship a React Native or Expo app to TestFlight, the App Store and Google Play from the hub, and read where a release actually stands. Use when the app is being released, promoted, halted or investigated after shipping. Triggers on "ship it", "send it to TestFlight", "submit for review", "is the build ready", "promote to production", "roll it out to 10%", "halt the rollout", "why is the build stuck", "what are users saying", "release notes".
license: MIT
metadata:
  author: rn-devtools-hub
  version: "1.0.0"
  tags: react-native, expo, release, app-store-connect, google-play, testflight, mcp
---

# Releasing with rn-devtools-hub

The hub already sees the app from the inside: the React tree, the network,
the crashes, the project's real configuration. The `asc` and `gplay`
plugins add the half that lives at Apple and Google. Same agent, same
session, so the decision to ship and the evidence for it are in one place
instead of two.

That is the whole point, and it is also the discipline: **prove, then
ship**. A rollout is the most expensive place to discover something a
local assertion would have caught.

## Before anything else

```
list_plugins
```

It tells you three things you cannot guess:

- which plugins are **configured**. An unconfigured one exposes no tool at
  all, so a missing `asc_*` is a credentials problem, not a hub problem;
- whether **writes are enabled**. `writeTools` lists what would change
  something, and `writes.enabled` says whether those tools exist in this
  session. When they do not, propose the command; do not look for another
  way in;
- the **hosts** each plugin contacts. This hub is otherwise local.

Credentials are read once, at hub startup. If a user has just set them,
the hub has to be restarted before the tools appear.

## Ship an iOS build

```
asc_list_builds                            processingState must be VALID
asc_set_whats_new     text: "..."          TestFlight refuses without it
asc_distribute_build  group: "QA"          internal: testers get it now
asc_distribute_build  group: "Public", submitForReview: true
```

`PROCESSING` means Apple has not finished with the upload. It is not an
error and it is not something to retry: call `asc_list_builds` again.

Then the App Store, which is three distinct steps on purpose:

```
asc_prepare_version   version: "1.4.0", buildNumber: "104", releaseNotes: "..."
asc_submit_for_review version: "1.4.0"     leaves your hands here
asc_release_version   version: "1.4.0"     only after Apple approves
```

`asc_prepare_version` is idempotent: run it again after a change and read
`steps` to see what it actually did. `asc_release_version` refuses with
the current state unless the version is `PENDING_DEVELOPER_RELEASE`, so a
refusal there is information, not a failure.

Hold a bad release with `asc_phased_release action: "pause"`. Apple
advances the phases on its own schedule; pausing is the only lever that
acts immediately.

## Ship an Android release

```
gplay_list_tracks                                   what each track serves
gplay_promote_release from: "internal", to: "production",
                      status: "inProgress", userFraction: 0.05
```

Then widen, or stop:

```
gplay_update_track track: "production", userFraction: 0.2
gplay_update_track track: "production", status: "halted", userFraction: 0.2
gplay_update_track track: "production", status: "completed"
```

Omit `versionCodes` and the track keeps the ones it already serves, which
is what makes widening and halting one call. `completed` reaches every
user and refuses a `userFraction`; `inProgress` and `halted` require one.
Every one of these commits a Play edit, which is what makes it live.

## Prove before you widen

The reason to do this from the hub rather than from two consoles: the
evidence is already here.

```
assert kind: "no_crash",         windowMs: 3600000
assert kind: "no_console_error", windowMs: 3600000
get_endpoint_stats                        error rates per endpoint
gplay_list_reviews                        what users actually hit
get_crashes
```

Reviews and crash counts move before any dashboard does. A one-star review
naming a screen is a reproduction: `query_ui` that screen, read the
`source` of the element, fix, and only then touch the rollout.

## Reading failures

| Symptom | What it actually means |
|---|---|
| No `asc_*` or `gplay_*` tool exists | The plugin has no credentials, so it exposes nothing. `list_plugins` names the keys; the hub reads them at startup and must be restarted |
| A write tool is missing but the reads are there | Writes are switched off for this hub (`RN_DEVTOOLS_PLUGIN_WRITES` or `RN_DEVTOOLS_<ID>_WRITES`). Say so, do not work around it |
| `401 (the credentials were rejected)` | The key itself is wrong, revoked or expired |
| `403 (authenticated, but this key has no access)` | On Play, almost always the service account exists but was never granted access in Play Console, under Users and permissions |
| `asc_list_builds` shows `PROCESSING` | Apple has not finished with the upload. Wait and call again; nothing here can speed it up |
| `asc_release_version` answers `not-pending-release` | The version is not waiting on you. The state in the answer says who it is waiting on |
| `No TestFlight group "X"` | The answer lists the real group names. Use one of those |
| A rollout status is refused | `completed` reaches everyone and takes no fraction; `inProgress` and `halted` need one strictly between 0 and 1 |
| Play returns no review at all | Play only exposes about a week of reviews, and none for an app never published. That is a fact about Play, not about the app |

## What not to do

- Do not promote to `production` with `status: "completed"` as a first
  step. That is every user at once. Start staged, widen deliberately.
- Do not submit a version to review to "see what happens". Review is not a
  build check, and a rejection costs days.
- Do not call `asc_expire_build` to tidy up. It is irreversible and takes
  the build away from every tester.
- Do not use `asc_write_request` or `gplay_write_request` when a named
  tool exists. The named ones validate their arguments, resolve the app
  from the project, and clean up the Play edit they open.
- Do not publish a review reply without being asked. It is public, signed
  as the developer, and it replaces any previous reply.
- Do not report a release as done because a call returned. Read the state
  back: `asc_list_versions`, `gplay_list_tracks`.
