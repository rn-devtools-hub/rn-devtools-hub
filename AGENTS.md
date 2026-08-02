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
- `emit` truncates at 20 KB. Protocol binary types (`screen.frame`) are
  kept whole automatically, and anything else that gets truncated warns
  once with the fix, because silent corruption of a payload is worse than
  a dropped event: a truncated base64 frame is an undecodable image and a
  blank panel with no error anywhere. Use `emitRaw` for your own binary
  events.
- The hub reads app.json and the assets from its cwd: launch it from the
  host project root. With SEVERAL projects at once, launch one hub per
  project on distinct ports (`--port`), otherwise the Design panel shows
  the assets of the project the hub was launched from (the dashboard
  flags the mismatch).
- For AI agents: add `devtools.attachUiAutomation()` to the glue file and
  call `devtools.markScreenReady()` when a screen has its data. This
  enables the get_ui_tree / query_ui / ui_act / wait_for_event MCP tools.
- Optional attachments, each unlocking a family of tools:
  `attachDeterminism()` (freeze_time, mock_network),
  `attachOriginTracking()` (call-site frames on network events),
  `registerStore(name, adapter)` (get_state / set_state, with the
  zustandStore / reduxStore / reactQueryStore adapters),
  `registerPreview(name, factory)` (render_component). Previews also need
  a four-line outlet inside your providers:

  ```tsx
  function DevtoolsPreviewOutlet() {
    const [element, setElement] = useState(null);
    useEffect(() => devtools.onPreviewChange(setElement), []);
    return <View testID="devtools-preview">{element}</View>;
  }
  ```
- The hub runs on Bun or on Node 20+, whichever is present. The SDK
  itself needs nothing.
- `stableId` in init() prevents ghost sessions on every reload:
  use a stable device identifier.

## If you are working on this repo

Read CONTRIBUTING.md first. The invariants that must never be broken:

- src/client: ZERO external imports. Verify with `grep -r "from \"" src/`
  which must only show relative imports.
- server/dashboard.html: a single file, no build step, no CDN.
- Anything requiring native code or a system binary (adb, xcrun, view-shot,
  axe) must be probed and degrade cleanly with an explanatory message.
- ZERO runtime dependencies, hub included. That is why server/runtime.mjs
  implements the WebSocket handshake and framing by hand: Node has a
  WebSocket client but no server, and adding `ws` would contradict the
  argument the product is sold on. PNG decoding goes through
  node:zlib rather than pngjs; adding a package to compare two images
  would contradict the argument printed on the box.
- Sessions and baselines are written under `.rn-devtools/` in the host
  project, which is gitignored and never committed.
- Measurement must work on BOTH architectures. On Fabric the host fiber's
  stateNode is not the instance: it holds `{ node, canonical }` and the
  measurable instance is `canonical.publicInstance`, created lazily, with
  `nativeFabricUIManager` as the fallback. Reading only `stateNode` returns
  null for every element on any New Architecture app.
- Source locations on React 19 resolve to owner stacks, which are BUNDLE
  positions. The hub symbolicates them against Metro before an agent sees
  them; one stack is not enough, the owner chain must be walked, or every
  answer lands in node_modules.
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
RN_DEVTOOLS_TOKEN=dev node server/server.mjs & # the hub must pass on BOTH runtimes
```

## Driving a running app (MCP)

The hub exposes an MCP server at http://127.0.0.1:8973/mcp (localhost
only). Tools:

- Inspection: list_devices, get_app_info, get_recent_network, get_crashes,
  get_endpoint_stats, query_sqlite (SELECT/PRAGMA).
- Dev actions: list_actions (discover what the app registered, with
  argsSchema), run_action with typed args. Conventions: `nav:*` jump to a
  screen, `auth:*` instant session, `seed:*` fixtures, `reset:*`
  deterministic state. This is the fastest way to skip fragile UI paths.
- Perception and action (the app must call `devtools.attachUiAutomation()`):
  get_ui_tree (semantic tree of the VISIBLE components), query_ui (find by
  role+name, testID, text, label or type, scoped with `within`, measured
  rects), ui_act (tap, longPress, type with exact text, clear, submit,
  scrollTo; ambiguous matches return the candidates with rects).
  Selector preference: role+accessible name, then testID, then run_action.
  Every node and match carries `source` ({file, line, column,
  componentName, via}) when React still knows where it was written.
  `via` states how it was resolved; `via:"stack"` means BUNDLE
  coordinates, which still need symbolication against Metro.
- Project truth: get_project_context returns what the project declares
  (installed versions, Expo SDK, New Architecture, JS engine), what the
  app actually runs (engine, Fabric, bridgeless, native React Native
  version, mounted renderer) and the contradictions. Call it FIRST when
  anything behaves impossibly: it catches stale native builds, Expo Go
  running a plugin project and release bundles before any other work.
- Proof: assert({kind}). Element kinds (visible, absent, text) retry until
  timeoutMs; event kinds (network_ok, no_console_error, no_crash) look
  back over a window given by `since` (a cursor) or windowMs, and prove
  what a screenshot cannot show. Failures carry their evidence.
- Determinism (needs `attachDeterminism()`): freeze_time, advance_time,
  restore_time, mock_network. JS level only: Date and the instrumented
  fetch. Native animations and Reanimated are unaffected.
- State (needs `registerStore`): get_state, set_state. Writing puts the
  app into an exact state without walking ten screens.
- Previews (needs `registerPreview` and the outlet): list_previews,
  render_component, unmount_component. The component mounts inside the
  running app, under its real providers, so nothing has to be mocked.
- Visual: snapshot_baseline, compare_snapshot. The comparison EXPLAINS the
  difference: changed ratio, bounding box, the component owning that
  region with its source, and what the bus recorded since the baseline.
- Sessions and flows: list_sessions, export_session (one correlated
  timeline, markdown pastes into an issue), start_recording,
  stop_recording, export_flow (actions paired with the consequences they
  caused; format:"mcp" returns the calls to replay it).
- Accessibility: get_accessibility_tree (what the OS exposes; Android via
  uiautomator, iOS needs AXe), audit_accessibility (the DIFFERENCE
  between what React renders and what accessibility exposes).
- Build: build_app delegates to expo run / eas build and streams the
  failures onto the same bus as the crashes.
- Event flow: get_events_since (cursor-based polling without missing
  events), wait_for_event (blocks until a matching event, e.g.
  `screen.ready` after `devtools.markScreenReady()` or a
  `network.response`; replaces every sleep).
- Native adapter (host-side simctl/adb; targets come from list_targets and
  are `sim:<udid>` / `adb:<serial>`, distinct from the JS deviceId):
  set_permission (pre-grant so popups never appear; iOS cannot pre-grant
  notifications or camera), launch_app (zero-dialog dev-client launch:
  `--initialUrl` on iOS, explicit component on Android), terminate_app,
  open_url, screenshot_native (pixels, complements the tree),
  tap_native (last resort: adb / AXe / idb), boot_device, shutdown_device,
  set_location (simulated GPS), set_animations (Android determinism),
  send_push (iOS simulated push), set_appearance (dark mode),
  install_app, uninstall_app, set_orientation and get_orientation
  (Android only), start_screen_recording and stop_screen_recording
  (startedAt is on the bus clock: video offset = event.ts - startedAt).
- session_start: one-call bootstrap = resolve target, pre-grant
  permissions, cold-launch on the Metro server with onboarding skipped,
  wait until the app connects to the hub.

Two transports. The hub speaks streamable HTTP; `npx rn-devtools-hub mcp`
bridges stdio to it for clients that speak nothing else, starting the hub
on demand in the current directory.

Registration on the Claude Code side, either:
`claude mcp add rn-devtools --transport http http://127.0.0.1:8973/mcp`
or install the plugin, which registers it and adds the skill.
Claude Code: `/plugin marketplace add rn-devtools-hub/rn-devtools-hub`
Codex: `codex plugin marketplace add rn-devtools-hub/rn-devtools-hub`, or
`[mcp_servers.rn-devtools] url = "http://127.0.0.1:8973/mcp"` in
`~/.codex/config.toml`.

Cursor has no marketplace, so its setup is documented rather than
automated: the user declares the server in `.cursor/mcp.json` and copies
`templates/cursor-rule.mdc` into `.cursor/rules/`. The rule sets
`alwaysApply: false` on purpose, because a rule that is always in context
costs tokens on every request, including the ones with nothing to do with
the app. `init` deliberately does NOT write these: it already touches the
entry point and package.json, and writing into someone's editor config on
top of that is further than an install command should reach.

The skill lives in TWO places because the two agents look in different
ones: `plugins/rn-devtools-hub/skills/` for Claude Code and
`.agents/skills/` for Codex. The format is identical and a packaging test
asserts the files are byte-for-byte equal, because a skill that drifts
between the two silently teaches two different things.

The dashboard's Overview panel leads with the same project context the
`get_project_context` tool returns, and with whatever the project and the
running app disagree on. Check it before debugging anything that behaves
impossibly.

Recommended agent loop: `session_start`, then `ui_act` (by role/testID),
then `wait_for_event` on the expected effect, then `query_ui` to verify.
No pixel coordinates, no sleeps, no manual simctl/idb.
