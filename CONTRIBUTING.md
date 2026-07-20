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
  server.mjs       Bun hub: WebSocket, per-device history, command relay,
                   MCP, Design and Mirror endpoints (adb/xcrun)
  dashboard.html   Single-page dashboard (vanilla JS, NO build step)

bin/rn-devtools-hub.mjs   npx launcher (checks Bun, delegates to the server)
```

Non-negotiable principles:

1. **Zero mandatory dependencies.** That is what killed Flipper. Any feature
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
npm run hub        # starts the local hub (requires Bun)
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
