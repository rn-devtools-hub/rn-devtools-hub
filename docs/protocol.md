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
| `ui.query` | { by: testID/text/label/type, value, exact?, limit?, includeHidden? } | { generation, count, matches: [{type, testID, label, text, rect}] } |
| `ui.act` | { action: tap/longPress/type/clear/submit/scrollTo/scrollToEnd, by, value, text?, clear?, index?, x?, y?, includeHidden? } | { ok, action, detail, target } |

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
