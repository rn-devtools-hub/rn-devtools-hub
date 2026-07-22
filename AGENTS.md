# AGENTS.md: guide for AI agents

This file is addressed to AI agents (Claude Code, Cursor, Copilot...) that
work ON this repo or that INTEGRATE this package into an app.

## If you are integrating rn-devtools-hub into a React Native/Expo app

Follow docs/integration.md to the letter. Summary of the reliable procedure:

1. `npm install --save-dev rn-devtools-hub` (devDependency, never dependency)
2. Create a glue file (e.g. `src/devtools.setup.ts`) that calls
   `devtools.init({serverUrl, appName})` then the desired `attach*` calls.
   The hub URL is derived from Metro's IP:
   `Constants.expoConfig?.hostUri?.split(":")[0]` + port 8973.
3. Load the glue via a guarded require:
   `if (__DEV__) { require("./devtools.setup"); }` in the entry point.
   NEVER import it statically without a guard.
4. Each panel has an event contract documented in docs/protocol.md:
   to feed a panel, emit exactly those event types with
   `devtools.emit(type, payload)`. To respond to the dashboard (SQLite,
   cache snapshot), register the commands with `devtools.onCommand`.
5. Verification: run `npx rn-devtools-hub` at the host project root,
   open the printed URL (with token), start the app in dev: the device must
   appear in the selector within 5 seconds.

Known pitfalls:
- Never put large data in `emit` (truncated at 20 KB); for legitimate
  binary data (screen frames), use `emitRaw`.
- The hub reads app.json and the assets from its cwd: launch it from the
  host project root. With SEVERAL projects at once, launch one hub per
  project on distinct ports (`--port`), otherwise the Design panel shows
  the assets of the project the hub was launched from (the dashboard
  flags the mismatch).
- For AI agents: add `devtools.attachUiAutomation()` to the glue file and
  call `devtools.markScreenReady()` when a screen has its data. This
  enables the get_ui_tree / query_ui / ui_act / wait_for_event MCP tools.
- The hub requires Bun. The SDK itself needs nothing.
- `stableId` in init() prevents ghost sessions on every reload:
  use a stable device identifier.

## If you are working on this repo

Read CONTRIBUTING.md first. The invariants that must never be broken:

- src/client: ZERO external imports. Verify with `grep -r "from \"" src/`
  which must only show relative imports.
- server/dashboard.html: a single file, no build step, no CDN.
- Anything requiring native code or a system binary (adb, xcrun, view-shot)
  must be probed and degrade cleanly with an explanatory message.
- Commits follow Conventional Commits (commitlint rejects them otherwise).
- Branch from `develop` and open PRs against `develop`; `main` only receives
  release merges and hotfixes.
- Before finishing: `npm run typecheck && npm test && npm run build`, and
  for the dashboard: extract the script and run `node --check`.

Full validation commands:

```bash
npm run typecheck && npm test && npm run build
perl -ne 'print if /<script>/../<\/script>/' server/dashboard.html \
  | grep -v "^<script>$" | grep -v "^</script>$" > /tmp/dash.js && node --check /tmp/dash.js
RN_DEVTOOLS_TOKEN=dev bun server/server.mjs &  # then curl the dashboard and /mcp
```

## Driving a running app (MCP)

The hub exposes an MCP server at http://127.0.0.1:8973/mcp (localhost
only). Tools:

- Inspection: list_devices, get_app_info, get_recent_network, get_crashes,
  get_endpoint_stats, query_sqlite (SELECT/PRAGMA), run_action.
- Perception and action (the app must call `devtools.attachUiAutomation()`):
  get_ui_tree (semantic tree of mounted components), query_ui (find by
  testID/text/label/type, with measured rects), ui_act (tap, longPress,
  type with exact text, clear, submit, scrollTo).
- Event flow: get_events_since (cursor-based polling without missing
  events), wait_for_event (blocks until a matching event, e.g.
  `screen.ready` after `devtools.markScreenReady()` or a
  `network.response`; replaces every sleep).

Registration on the Claude Code side:
`claude mcp add rn-devtools --transport http http://127.0.0.1:8973/mcp`

Recommended agent loop: `ui_act` (tap by testID), then `wait_for_event`
on the expected effect, then `query_ui`/`get_ui_tree` to verify the
screen. No pixel coordinates, no idb, works in CI without a simulator.
