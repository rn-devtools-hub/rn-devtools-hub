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
  host project root, otherwise the Design panel shows the assets of the
  project the hub was launched from (the dashboard flags the mismatch).
  SEVERAL projects can now run at once: with no `--port`, a hub whose
  default port is taken walks 8974 to 8982, says so loudly in the banner
  and writes the port it got into `.rn-devtools/hub.json`, which the stdio
  bridge reads. The app side takes the port from
  `EXPO_PUBLIC_RN_DEVTOOLS_PORT` (Metro inlines it), so a second project
  sets one variable, or regenerates its glue with
  `init --force --port <n>`: an existing glue file keeps the port it was
  written with. An explicit `--port` still fails hard when it is taken:
  that port was asked for by name.
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
- Plugins are the only code here that talks to anything off the machine.
  A plugin declares the hosts it will contact, they are printed in the
  banner and returned by list_plugins, and a plugin with no credentials
  exposes NO tool: an agent does not pay context for a tool it cannot call.
  Secrets resolve at startup and stay in the process; what is reported is
  that a value is set and where it came from, never the value.
- A plugin does not reimplement a vendor API and does not wrap a CLI that
  does: it calls the vendor's own REST endpoints with the vendor's own
  auth, and the generic *_request tools keep everything else one call
  away. The price is drift, so a plugin DECLARES what it depends on in an
  exported CONTRACT (endpoints, fields, and why for each) and
  `npm run check:store-apis` verifies it against the specifications the
  vendors publish (Apple's OpenAPI document, Google's discovery
  document). Weekly in CI and on any PR touching server/plugins. A spec
  that cannot be downloaded is skipped, not reported as drift.
- A plugin tool that CHANGES something lives in writeTools and must carry
  {readOnlyHint:false, destructiveHint:true}, or the plugin is refused
  whole. Those flags are what an MCP client reads to decide whether to ask
  the human. Writes ship enabled, and the switch removes the tools rather
  than making them refuse: an agent never plans a step that does not exist.
- The skill lives in TWO trees and a packaging test asserts every skill is
  byte-identical between them. Adding one means adding it to both.
- Credentials are removed BEFORE they leave the device, headers and bodies
  alike, by name and by shape, and what was removed is named in the event.
  Anything the hub holds can end up in a model's context window, and
  truncating a payload is not redacting it.
- The SDK starts only when development is affirmed (`__DEV__ === true`, or
  NODE_ENV that is not production where the global does not exist). A tool
  that reads state and traffic fails closed.
- Measurement must work on BOTH architectures. On Fabric the host fiber's
  stateNode is not the instance: it holds `{ node, canonical }` and the
  measurable instance is `canonical.publicInstance`, created lazily, with
  `nativeFabricUIManager` as the fallback. Reading only `stateNode` returns
  null for every element on any New Architecture app, and handing
  `{ node, canonical }` to a caller looking for `setNativeProps` or
  `scrollToEnd` turns an action into a no-op that still answers ok.
- Measure the element's OWN box first: its public instance, then its own
  shadow node, and only then a neighbour. The public instance is created
  lazily, so walking outward first finds the enclosing ScrollView and
  returns ITS box for every row, which is why rects appeared not to move
  after a scroll. When a neighbour did answer, say so (`rectFrom`).
- No action path may swallow a missing method. A `callNative` that returns
  void hides both the absent method and the exception; on an action it must
  report failure, and the command must turn that into an explicit error.
- A screenshot is the weakest proof available here and the most expensive
  answer to read. `assert` exists for the three things pixels cannot show
  (a request that failed silently, a rejected promise, a value that never
  reached the field) and compare_snapshot answers the visual question with
  a diagnosis. The hub counts pixel bytes separately, says so on the
  SECOND capture taken with no assertion in between, and
  RN_DEVTOOLS_SCREENSHOTS=off or =<n> removes or budgets screenshot_native
  outright. Off REMOVES the tool: a switched-off capability must not be
  something an agent discovers halfway through a plan.
- A tool that answers `ok:false` is returned as an MCP error (`isError`),
  payload intact. A declared refusal that arrives looking like a result is
  invisible to a client that only reads the status, which is the same
  silence as a no-op reporting success.
- What is described must be what was acted on. Any gap between the fiber
  the selector matched, the fiber resolved from it (the input inside a
  container, the handler on an ancestor) and the fiber described in the
  answer must appear in the answer, and a target that cannot be resolved
  must be refused rather than guessed.
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
npm run check:store-apis   # plugins only: are Apple's and Google's APIs still what the contracts say
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
  role+name, testID, placeholder, text, label or type, scoped with
  `within`, measured rects), ui_act (tap, longPress, type with exact text,
  clear, submit, scrollTo, scrollBy, scrollToEnd, focus, blur; ambiguous
  matches return the candidates with rects). ui_act answers for the element
  it TOUCHED: `actedOn` when the action landed on an input or a handler
  next to the match, `verified` after a type (exact / transformed /
  unverifiable), `ok:false` with `value-unchanged` when the field did not
  move, and `index-out-of-range` rather than acting on the last match.
  Selector preference: role+accessible name, then testID, then placeholder
  for an uninstrumented form field, then run_action.
  Every node and match carries `source` ({file, line, column,
  componentName, via}) when React still knows where it was written.
  `via` states how it was resolved; `via:"stack"` means BUNDLE
  coordinates, which still need symbolication against Metro.
- Overlays: set_overlay and get_overlay show or hide the expo-dev-menu
  floating button at runtime, without relaunching. It lives in its own
  window, so no UI tree shows it and it swallows the taps meant for the
  native controls underneath, the iOS photo picker button first. Runtime
  switch on iOS, Expo Go included; on Android the manifest meta-data
  EXDevMenuShowFloatingActionButton, or launch_app hideDevMenuFab before
  a dev-build launch.
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
- Store assets: capture_store_screenshots drives the app through a
  manifest (devices from list_targets, locales via a dev action, screens
  via nav:*) and writes the captures to disk at native resolution. The
  images NEVER enter the answer, so it costs no context and does not touch
  the RN_DEVTOOLS_SCREENSHOTS budget, which is about verifying. Nothing is
  resized: an unrecognised size is reported rather than uploaded as the
  wrong device class. asc_upload_screenshots and gplay_upload_screenshots
  read the index it writes.
- Plugins (the services around the app, not the app): list_plugins says
  which ones exist, whether they are configured, which tools CHANGE
  something, whether writes are enabled, and every host they will contact.
  Configured ones add their tools, unconfigured ones add none. App Store
  Connect reads (asc_list_builds, asc_list_versions, asc_list_beta_groups,
  asc_list_apps, asc_request) and drives (asc_set_whats_new,
  asc_distribute_build, asc_expire_build, asc_prepare_version,
  asc_submit_for_review, asc_release_version, asc_phased_release,
  asc_write_request). Google Play reads (gplay_list_tracks, gplay_get_track,
  gplay_list_artifacts, gplay_list_reviews, gplay_request) and drives
  (gplay_update_track, gplay_promote_release, gplay_reply_review,
  gplay_write_request). Every mutating tool carries destructiveHint and
  disappears entirely under RN_DEVTOOLS_PLUGIN_WRITES=off (or
  RN_DEVTOOLS_<ID>_WRITES). Credentials come from env vars or
  .rn-devtools/plugins.json, are read once at startup (configure, then
  RESTART the hub) and are never returned. The rn-devtools-release skill
  ships with the plugin and teaches the release loop. See docs/plugins.md.
- Event flow: get_events_since (cursor-based polling without missing
  events), wait_for_event (blocks until a matching event, e.g.
  `screen.ready` after `devtools.markScreenReady()` or a
  `network.response`; replaces every sleep).
- Native adapter (host-side simctl/adb; targets come from list_targets and
  are `sim:<udid>` / `adb:<serial>`, distinct from the JS deviceId):
  set_permission (pre-grant so popups never appear; iOS cannot pre-grant
  notifications or camera), launch_app (zero-dialog dev-client launch:
  `--initialUrl` on iOS, explicit component on Android, and
  `hideDevMenuFab` so the expo-dev-menu bubble stops covering the native
  controls in the top corner: it lives in its own window, so no UI tree
  ever shows it), terminate_app, open_url, screenshot_native (pixels,
  complements the tree, and the answer says what it cost: use assert to
  VERIFY, not this), tap_native and swipe_native (last resort, and the
  only way to exercise a real gesture: adb / AXe / idb), boot_device,
  shutdown_device,
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

The dashboard's Tools panel measures the MCP traffic itself: calls per
tool, failures grouped by message, empty answers with the reason the tool
gave, bytes returned (the context an agent pays to read an answer),
selector families used, and a timeline putting the calls next to what the
app did in response. It is fed by `/tools/stats`, held in memory only and
wiped when the hub restarts.

The dashboard's Overview panel leads with the same project context the
`get_project_context` tool returns, and with whatever the project and the
running app disagree on. Check it before debugging anything that behaves
impossibly.

Recommended agent loop: `session_start`, then `ui_act` (by role/testID),
then `wait_for_event` on the expected effect, then `query_ui` to verify.
No pixel coordinates, no sleeps, no manual simctl/idb.
