<p align="center">
  <img src="assets/logo.svg" width="120" alt="rn-devtools-hub">
</p>

<h1 align="center">rn-devtools-hub</h1>

<p align="center">
  Local inspector for React Native and Expo apps: network, crashes, storage,
  SQLite, screen mirror, remote actions and an MCP server, streamed to a web
  dashboard. Zero native dependencies. A Flipper alternative that fits in a
  devDependency.
</p>

<p align="center">
  <a href="https://rn-devtools-hub.github.io/rn-devtools-hub/">Documentation</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#integration-guide">Integration</a> ·
  <a href="#contributing">Contributing</a>
</p>

## Why

Flipper died from its mandatory native dependencies. Reactotron requires a
desktop app. Expo DevTools plugins open one tab per tool. Cloud alternatives
(Vexo, LogRocket) send your data elsewhere.

rn-devtools-hub takes the opposite path: a pure JavaScript SDK in the app
(inert in production), a local hub in a single process, a dashboard in the
browser. Your data never leaves your machine.

## Features

| Panel | What you see |
| --- | --- |
| Overview | KPI tiles, JS thread lag, HTTP statuses, duration distribution |
| Crashes | Fatal errors, JS errors, unhandled promise rejections, stacks |
| Network | Request/response inspector (colored methods, durations, sizes), copy as cURL, secrets redacted |
| Uploads | Live upload queue (if your app emits the events, see the protocol) |
| Cache | React Query snapshot: keys, statuses, freshness, data |
| Storage | AsyncStorage keys, sizes, values, live write timestamps |
| Screens | Navigation journey, time spent per screen |
| Logs | console.log/info/warn/error, colorized JSON, filters |
| SQLite | Read-only SQL console (SELECT/PRAGMA) on your app's database |
| Endpoints | Map of declared endpoints, calls, latencies |
| Actions | Buttons driving the app: reload, clear caches, your custom actions |
| Design | Icon, splash, fonts, sounds, identity (read from app.json and the assets) |
| Mirror | Live app screen (view-shot), full Android via adb (tap, swipe, keyboard, Wi-Fi), iOS simulator via xcrun |

Plus: multi-device with merged sessions, bug report export in Markdown (ready
for a GitHub issue), real-time capability badges, and a local MCP server to
drive everything from Claude, Cursor or any MCP client (`list_devices`,
`get_recent_network`, `get_crashes`, `query_sqlite`, `run_action`...).

## Quick start

Prerequisites: Node 20+, and [Bun](https://bun.sh) for the hub. Optional
capabilities (adb mirror, iOS simulator, Wi-Fi) have their own prerequisites:
see the [integration guide](docs/integration.md#prerequisites-by-capability).

```bash
# 1. In your React Native / Expo project, as a devDependency:
npm install --save-dev rn-devtools-hub

# 2. Wire it up automatically (detects your libraries, writes the glue,
#    hooks the entry point, adds the `devtools` script):
npx rn-devtools-hub init

# 3. Start the hub (Bun required)
npm run devtools
# -> Dashboard: http://localhost:8973/?token=... (URL printed at startup)
```

`init` inspects your project and generates only the code it can actually
run: axios interception if you use axios, the Storage panel if you have
AsyncStorage, device info if you have expo-device, and so on. It never
overwrites an existing glue file (use `--force`), and `--dry-run` shows
what it would change.

That's it: logs, crashes and performance already flow in. Every additional
integration (network, cache, storage, SQLite, mirror...) is a recipe of a few
lines: see the [integration guide](docs/integration.md).

## Integration guide

The SDK is agnostic: it exposes generic primitives that you wire to YOUR
libraries. All the recipes are in
[docs/integration.md](docs/integration.md), notably:

- `devtools.attachAxios(instance, "api")`: any axios instance
- `devtools.wrapFetch(fetch, "uploads")`: any fetch-based client
- `devtools.emit(type, payload)`: feed any panel
- `devtools.onCommand(name, handler)`: respond to the dashboard (e.g. SQLite)
- `devtools.registerAction({name, label, danger, requiresNative}, handler)`
- The complete events and commands protocol:
  [docs/protocol.md](docs/protocol.md). It is the contract: any tool (or any
  LLM) can integrate a panel by implementing it.

### Host project dependencies

The SDK imposes NOTHING. Depending on the features you want, add to YOUR
project:

| Feature | Install in your project | Type |
| --- | --- | --- |
| The package itself | `rn-devtools-hub` | `devDependencies` |
| App mirror (screen stream) | `react-native-view-shot` | `dependencies` (included in Expo Go) |
| Storage panel | `@react-native-async-storage/async-storage` | already present in most apps |
| SQLite console | `expo-sqlite` (or your driver + a `sqlite.query` handler) | depends on your app |
| Enriched device info | `expo-device`, `expo-application`, `expo-network` | `dependencies` |
| Full Android mirror | `adb` on the dev machine (not in the app) | system tool |
| iOS simulator mirror | Xcode command line tools (dev machine) | system tool |

## Security

- The SDK is inert outside `__DEV__` (double guard: yours and the SDK's)
- The dashboard requires a token (printed at startup, `RN_DEVTOOLS_TOKEN` to pin it)
- Sensitive headers (Authorization, cookies, x-api-key) are redacted before leaving the device
- The SQLite console only accepts SELECT and PRAGMA
- The MCP server only listens on localhost, with Origin verification
- Design panel assets are confined to the project root, with whitelisted extensions

## Contributing

Contributions are welcome. The full guide is in
[CONTRIBUTING.md](CONTRIBUTING.md). In short:

```bash
git clone https://github.com/rn-devtools-hub/rn-devtools-hub
cd rn-devtools-hub
npm install          # also installs the husky hooks
npm test             # vitest
npm run typecheck
npm run hub          # starts the local hub to test the dashboard
```

- Commits follow [Conventional Commits](https://www.conventionalcommits.org)
  (`feat:`, `fix:`, `docs:`...): the changelog and versions derive from them
  automatically (release-it), and commitlint checks them at commit time
- The pre-commit hooks run typecheck + tests
- Release: `npm run release` (maintainers)

For AI agents: read [AGENTS.md](AGENTS.md) and [llms.txt](llms.txt).

## License

[MIT](LICENSE)
