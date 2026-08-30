# Contributing to rn-devtools-hub

Thank you for your interest. This guide covers everything you need to contribute.

## 3-piece architecture

```
src/client/        SDK embedded in the app (TypeScript, ZERO dependencies)
  index.ts         Public API: init, emit, onCommand, attachAxios, wrapFetch,
                   registerAction, attachConsole, attachCrashReporting...
  transport.ts     WebSocket: batching, ring buffer, reconnection, commands
  types.ts         Types + truncation + redaction

server/
  server.mjs       Hub: WebSocket, per-device history, command relay,
                   MCP, Design and Mirror endpoints (adb/xcrun)
  plugins.mjs      Plugin registry: discovery, config resolution, dispatch
  plugins/         The plugins themselves (App Store Connect, Google Play)
  dashboard.html   Single-page dashboard (vanilla JS, NO build step)

bin/rn-devtools-hub.mjs   npx launcher (Bun if present, Node otherwise)
```

Non-negotiable principles:

1. **Zero mandatory dependencies.** A tool that requires a native build step
   dies of it, whatever else it does right. Any feature
   requiring native code or an external lib must be optional, probed via
   `require` with a clean fallback, and grayed out in the dashboard with an
   explanation.
2. **Inert in production.** `init()` checks `__DEV__` itself.
3. **Agnostic.** The SDK knows nothing about axios, React Query or Expo: it
   exposes primitives, apps wire up their own libs (see
   docs/integration.md). Any new feature must respect this.
4. **The dashboard stays a single HTML file with no build step.** Vanilla JS.
5. **Data never leaves the machine.** No telemetry, ever.

## Getting started

```bash
npm install        # also installs husky (git hooks)
npm test           # vitest
npm run typecheck  # strict tsc
npm run build      # dist/ (published to npm)
npm run hub        # starts the local hub (Bun; `node server/server.mjs` also works)
```

To test the dashboard without an app: `npm run hub` then open the printed URL.
To test with a real app: see docs/integration.md in an RN project.

## Commits and versions

- **Conventional Commits are mandatory** (checked by commitlint at commit time):
  `feat: ...` (minor), `fix: ...` (patch), `feat!:` or `BREAKING CHANGE:`
  (major), `docs:`, `chore:`, `test:`, `refactor:`.
- The pre-commit hook runs typecheck + tests. If it fails, the commit fails.
- CHANGELOG.md is generated automatically by release-it from the commits:
  never edit it by hand.

## What a version promises

A major bump exists to protect the things other people build against. Below is
what counts, so that "is this breaking?" is answered by a list rather than by a
judgement call at merge time.

**The public surface:**

- **The SDK entry point.** Everything `rn-devtools-hub/client` exports: the
  `devtools` object and its methods, the named helpers, and the exported types.
- **The MCP tool contract.** The name of every tool, the required fields of its
  input schema, and the result fields the skills and the docs tell an agent to
  read.
- **The CLI.** The `rn-devtools-hub` subcommands (`init`, `mcp`, `run`) and
  their flags.
- **The `.hubflow` format**, which additionally carries its own `format` and
  `version` fields, both checked on read, so a scenario written today keeps
  running or fails loudly.
- **The plugin contract**: `id`, `handle(name, args, ctx)`, `tools` and
  `writeTools`, and the rule that a tool name starts with its plugin id.

**What is deliberately not public**, and may change in any release:

- Everything else under `server/`. Those modules ship so the hub can run, not
  so anyone can import them.
- The dashboard: its markup, its element ids, its HTTP endpoints. It is a user
  interface and it moves.
- The wording of tool descriptions, failure hints and report text. An agent
  reads them; nothing should parse them.
- Event payload shapes that only ever travel between an SDK and a hub of the
  same version.

**Which increment applies:**

- Adding a tool, an optional input, or a field to a result is a `feat`.
- Widening an enum is a `feat`. `assert` gaining `kind: "count"` did not break
  a caller, because no existing scenario stopped working.
- Removing or renaming a tool, promoting an optional input to required,
  narrowing an enum, dropping a documented result field, or changing an SDK
  export is `feat!`.

## Branches

- `main`: released code. Protected, only receives merges from `develop`
  (or hotfix branches). Releases are cut from here.
- `develop`: integration branch, where day-to-day work lands.
- `feat/*`, `fix/*`: your working branches, opened from `develop`.

Flow: `feat/my-idea` -> PR to `develop` -> when ready to ship, PR
`develop` -> `main`, then run the Release workflow.

Hotfix: branch from `main`, PR back to `main`, then merge `main` into
`develop` so the fix is not lost.

## Proposing a change

1. Open an issue to discuss (unless trivial)
2. Fork + branch from `develop` (`feat/my-idea`)
3. Add tests (tests/ for the SDK; for the dashboard, verify at minimum
   `node --check` on the extracted script and a manual test documented
   in the PR)
4. PR against `develop` with a clear description: what, why, how to test

## Adding a panel to the dashboard

1. Define the event contract in docs/protocol.md (types, payloads)
2. Dashboard side: ingestion (switch in `ingest`), state in `deviceStore`,
   a `renderX` function called by `renderAll`, tab in `nav`
3. SDK side: nothing if `emit` is enough; otherwise a documented generic primitive
4. Document the integration recipe in docs/integration.md

## Adding a plugin

A plugin reaches a service around the app (a store API, a crash backend)
rather than the app itself. It lives in `server/plugins/`, declares the
hosts it contacts, exposes no tool until it is configured, and never
returns a credential.

It also does not reimplement the service: it calls the vendor's own API
with the vendor's own auth, and declares what it depends on in an exported
`CONTRACT` that `npm run check:store-apis` verifies against the
specification the vendor publishes. That check runs weekly and on any pull
request touching `server/plugins/`.

The full contract, the rules the loader enforces and the helpers in
`server/plugins/_api.mjs` are in [docs/plugins.md](docs/plugins.md).

## Release (maintainers)

Releases are automatic: every push to `main` runs the Release workflow,
which publishes only when the commits since the last tag contain a `feat`,
a `fix` or a `BREAKING CHANGE`. Merges that are purely docs, chore or CI
publish nothing.

To force a release (or pick the increment yourself):

```bash
gh workflow run release.yml --repo rn-devtools-hub/rn-devtools-hub
```

Locally (needs npm 2FA at the prompt):

```bash
npm run release   # release-it: version bump driven by commits, CHANGELOG,
                  # tag, GitHub Release, npm publish
```
