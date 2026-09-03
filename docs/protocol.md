# Protocol: events and commands reference

The contract between the app (SDK), the hub and the dashboard. Implementing
these types is enough to feed the panels: this is the reference to give an
LLM to integrate any app.

## Transport

- The app opens a WebSocket to the hub and sends
  `{kind:"hello", role:"device", appName, deviceName, stableId}`
- Events are sent in batches: `{kind:"events", events: DevtoolsEvent[]}`
- `DevtoolsEvent = { id: number, type: string, ts: epochMs, payload: object }`
- The dashboard sends `{kind:"hello", role:"dashboard", token}` (token required)
- Dashboard -> app commands: `{kind:"command", deviceId, requestId, command, payload}`
  relayed by the hub; the app replies `{kind:"commandResult", requestId, result?, error?}`

## Events (app to dashboard)

| type | payload | Panel |
| --- | --- | --- |
| `app.info` | appName, appVersion, buildVersion, platform, osName, osVersion, modelName, brand, totalMemoryMb, jsEngine, devMode, nativeCapable | Overview, badges, export |
| `net.info` | type (WIFI/CELLULAR...), isConnected, isInternetReachable, ipAddress | Connection tile |
| `network.request` | requestId, source, method, url, headers (already redacted), body | Network |
| `network.response` | requestId, source, status, durationMs, headers, body | Network |
| `network.error` | requestId, source, status or null, durationMs, message, body | Network |
| `console` | level (log/info/warn/error), args[] | Logs |
| `crash` | kind (fatal/error/unhandledRejection), message, stack, isFatal | Crashes |
| `perf.sample` | jsLagAvgMs, jsLagP95Ms, jsLagMaxMs, uptimeMs | Overview |
| `nav.screen` | screen, previousScreen, previousDurationMs | Screens |
| `query.cache` | queries: [{queryKey, status, isStale, observers, dataUpdatedAt, data}] | Cache |
| `storage.write` | op (set/remove), key, size, preview | Storage (stream) |
| `upload.progress` | scanId, status, percentage, uploadedFiles, failedFiles, totalFiles | Uploads |
| `upload.stats` | pendingUploads, activeUploads, failedUploads, totalInQueue | Uploads |
| `endpoints` | { group: { NAME: "/path" } } | Endpoints |
| `actions.register` | actions: [{name, label, danger?, requiresNative?}] | Actions |
| `capabilities` | viewShotAvailable, ... | Feature gating |
| `screen.frame` | format ("jpg"), base64 (WITHOUT truncation: use emitRaw) | Mirror |
| `screen.ready` | screen or null (emit via `devtools.markScreenReady("Login")`) | Agents: replaces sleeps after a reload or navigation |
| `ui.change` | generation (auto, throttled, requires `attachUiAutomation()`) | Agents: signals that the UI committed new content |

## Commands (dashboard to app)

| command | payload | Expected response |
| --- | --- | --- |
| `query.snapshot` | (none) | same as `query.cache` |
| `storage.keys` | (none) | { keys: [{key, size, lastWriteAt}] } |
| `storage.get` | { key } | { key, size, value } |
| `sqlite.query` | { sql } (SELECT/PRAGMA only) | { rows: object[] } |
| `action.run` | { name } | free-form (shown on click) |
| `screen.capture` | (none) | { format, base64 } |
| `screen.stream.start` | { fps? 1..5 } | { ok, fps } |
| `screen.stream.stop` | (none) | { ok } |
| `ui.tree` | { maxDepth?, maxNodes?, includeHidden? } | { generation, truncated, hiddenSubtrees, roots: UiNode[][] } (requires `attachUiAutomation()`) |
| `ui.query` | { by: testID/text/label/placeholder/type/role, value, name?, exact?, within?, limit?, includeHidden? } | { generation, count, truncated, matches: [{index, type, testID, label, text, rect, rectFrom?}], absence? } |
| `overlay.get` | (none) | { ok, visible, preferences } or { ok: false, reason: "dev-menu-unavailable", note } |
| `overlay.set` | { visible } | { ok, visible, verified } or { ok: false, reason: "dev-menu-unavailable" / "unchanged" / "set-failed", note } |
| `context.runtime` | (none) | the runtime half of `get_project_context` (engine, Fabric, bridgeless, native versions) |
| `context.instrumentation` | (none) | { network: {instrumented, wraps}, uiAutomation, determinism, originTracking, console, stores, actions, previews } |
| `ui.act` | { action: tap/longPress/type/clear/submit/scrollTo/scrollToEnd/scrollBy/focus/blur, by, value, name?, within?, text?, clear?, index?, x?, y?, dx?, dy?, includeHidden? } | { ok, action, detail, target, actedOn?, verified?, note?, result? } or { ok: false, reason: "ambiguous" / "index-out-of-range" / "value-unchanged", candidates? } |

Selector notes: `by:"role"` matches `role` (precedence) or
`accessibilityRole`, bridging both naming families (img/image,
heading/header, searchbox/search, slider/adjustable); `name` filters on
the accessible name (aria-label / accessibilityLabel / alt /
placeholder, then rendered text); Text hosts carry an implicit `text`
role; `by:"placeholder"` matches on substring unless `exact`, and is the
stable way to address a TextInput that carries neither testID nor
accessibilityLabel, which is the common case in a form; `within` is a
nested selector restricting the search to a container's subtree.

`ui.query` and `ui.act` walk the same tree in the same order, so each
match carries the `index` that addresses it in `ui.act` for the same
selector. Read a position from one, pass it to the other.

`ui.act` answers for the element it TOUCHED, not only for the one the
selector matched:

- `target` is the match, re-read after the commit for `type` and `clear`.
- `actedOn` appears when the action landed somewhere else: the input
  inside the container that matched, the Pressable above the view. It
  carries `relation: "descendant" | "ancestor"`.
- `verified` is returned for `type` and `clear`: `exact` (the input holds
  the text), `transformed` (the app rewrote it: mask, maxLength, trim) or
  `unverifiable` (uncontrolled input, or the element left the screen).
  When the value did not move at all, the answer is `ok: false` with
  `reason: "value-unchanged"` rather than a success.
- `result` carries what the action measured: scroll offsets, the number
  of `scrollToEnd` passes, whether the end was reached.
- `index` beyond the number of matches is refused with
  `reason: "index-out-of-range"` and the candidates. It is never rounded
  down to the last match.
- `committed` only says React rendered something, anywhere. It is not a
  proof that the action reached its target; `verified` is.

`rect` is the element's own box when `rectFrom` is absent. When the
element has no measurable instance of its own, the closest measurable
neighbour answers and `rectFrom` states whether it was a `descendant` or
an `ancestor`, which makes the value an approximation. On the New
Architecture a position comes from the shadow tree, and a ScrollView's
content offset only reaches it through an asynchronous state update: a
measurement taken while a scroll is still settling can lag by a frame.

When `count` is 0, `ui.query` adds `absence` ({reason, exposedBy,
present, note}). `reason` separates the three ways a query returns
nothing: `attribute-absent` (the app sets that prop nowhere, so every
query of this family answers zero and retrying is pointless),
`value-absent` (the attribute exists, this value does not, and `present`
samples what does), `name-absent` (the role exists, the accessible name
missed). `context.instrumentation` plays the same role for the event
bus: it is what lets the hub answer "nothing is watching" instead of
returning an empty list that reads as "nothing happened".

Navigators keep previous screens MOUNTED (stack cards, inactive tabs).
The `ui.*` commands therefore skip hidden subtrees by default, detected
through the signals the navigators set on inactive scenes
(`importantForAccessibility="no-hide-descendants"`,
`accessibilityElementsHidden`, RNSScreen `activityState: 0`,
`display: none`). Pass `includeHidden: true` to inspect them anyway;
`hiddenSubtrees` tells how many were skipped.

The `ui.*` commands are served by the SDK (`devtools.attachUiAutomation()`),
which reads the mounted React tree through the React DevTools hook and acts
through JS props (onPress, onChangeText). Typing places the exact string
given: no autocapitalize interference. This is runtime-level automation
(like React Native Testing Library), not native touch injection.

## Native adapter (host-side MCP tools)

The hub also exposes OS-level tools that shell out to `xcrun simctl`
and `adb` on the host machine (validated argv arrays, no shell). They
take a `target` (`sim:<udid>` or `adb:<serial>`, from `list_targets`),
which is deliberately distinct from the JS `deviceId`: the runtime
cannot know which simulator it runs on.

| Tool | Role |
| --- | --- |
| `list_targets` | booted simulators and adb devices with their state |
| `set_permission` | pre-grant/revoke permissions so popups never appear (iOS cannot pre-grant notifications or camera) |
| `launch_app` | zero-dialog launch: `simctl launch --initialUrl` (iOS), explicit-component `am start` (Android), dev-menu onboarding skipped |
| `terminate_app` / `open_url` | lifecycle and deep links |
| `screenshot_native` | pixel PNG returned as MCP image content |
| `get_native_logs` | native device logs with looping duplicates collapsed: adb logcat dump (fast), iOS unified log dump (slow, ~10-30 s per minute of window); also in the dashboard Logs panel via "Device logs" |
| `tap_native` | last-resort tap: adb input tap, or AXe/idb on iOS |
| `boot_device` / `shutdown_device` | simulator lifecycle |
| `set_location` | simulated GPS (`simctl location`, `adb emu geo fix`, longitude first internally) |
| `set_animations` | Android animation scales on/off for deterministic captures |
| `send_push` | simulated APNs push on iOS simulators |
| `set_appearance` | light/dark mode switch |
| `session_start` | bootstrap or app switch: permissions + cold launch on the selected Metro server + wait for the expected `appName`; Android derives the development-client scheme from `app.json` |

## Event cursor (agents)

The hub stamps every history event with a monotonic per-device `seq`.
The MCP tools `get_events_since {cursor}` and `wait_for_event {type,
payloadContains, timeoutMs}` use it to follow the stream without polling
races: an agent taps, then waits for the matching `network.response` or
`screen.ready` instead of sleeping.

## Hub HTTP endpoints

| Route | Method | Auth | Role |
| --- | --- | --- | --- |
| `/` | GET | token via WS | Dashboard |
| `/mcp` | POST | localhost + Origin | MCP server (JSON-RPC) |
| `/design/manifest` | GET | token | parsed app.json (icon, splash, fonts, sounds, identity) |
| `/design/asset?path=` | GET | token | Project file (confined, whitelisted extensions) |
| `/mirror/sources?quick=1` | GET | token | adb devices + booted simulators |
| `/mirror/frame?source=` | GET | token | PNG capture (adb screencap / simctl) |
| `/mirror/input` | POST | token | Android input: `{type:"tap",x,y}`, `{type:"swipe",x1,y1,x2,y2,durationMs}`, `{type:"text",text}`, `{type:"key",key}` (back, home, recents, menu, enter, delete, tab, escape, power, volume_up, volume_down) |
| `/mirror/adb-pair` | POST | token | adb pair (wireless debugging) |
| `/mirror/adb-connect` | POST | token | adb connect ip:port |

## Rules

- Every payload passed to `emit` is truncated (~20 KB per string) and
  sensitive headers must be redacted BEFORE emitting (the SDK does it for its
  network integrations). `emitRaw` is reserved for legitimate binary data.
- Unknown events are ignored by the dashboard: you can emit your own types
  without breaking anything, then contribute a panel.
- The hub history keeps ~3000 events per device; `screen.frame` events never
  enter it (broadcast live only).
