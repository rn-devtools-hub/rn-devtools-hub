# Integration guide

This guide is written to be followed by a human OR by an AI agent, recipe by
recipe. Each recipe is independent: take the ones you need. The SDK is
agnostic: it knows no library, you wire up your own.

## Prerequisites

- `npm install --save-dev rn-devtools-hub` in the host project (devDependency)
- Nothing else: the hub runs on Node 20+, or on [Bun](https://bun.sh) if you have it
- Start the hub FROM THE ROOT of the host project: `npx rn-devtools-hub`

## Prerequisites by capability

The core panels (logs, crashes, network, performance) need nothing beyond the
SDK and the hub. The optional capabilities below each have their own setup.

### Runtime for the hub (Node 20+, or Bun)

The hub runs on Node 20 or newer, which you already have if you develop with
React Native. Nothing to install, and the SDK in the app needs nothing either.

`npx rn-devtools-hub` uses Bun when it finds it, because it starts faster, and
Node otherwise. If you want Bun:

```bash
curl -fsSL https://bun.sh/install | bash
# or
npm install -g bun
```

### adb: full Android mirror (tap, swipe, keyboard)

Install the Android platform-tools on the dev machine:

- macOS: `brew install android-platform-tools`
- Windows/Linux: download platform-tools from
  [developer.android.com](https://developer.android.com/tools/releases/platform-tools)
  and add the folder to your PATH

On the phone: enable Developer options (Settings, About phone, tap
"Build number" 7 times), then enable USB debugging. Plug in via USB and
accept the fingerprint prompt on the phone. Verify with:

```bash
adb devices   # the device must be listed as "device", not "unauthorized"
```

### adb over Wi-Fi (no cable)

Android 11+: Developer options, Wireless debugging, "Pair device with
pairing code", then use the dashboard's built-in wizard (Mirror tab,
advanced options) which runs `adb pair` + `adb connect` for you.

Alternative with a one-time cable: plug in via USB, run `adb tcpip 5555`,
unplug, then connect to `phone-ip:5555`. The phone and the dev machine must
be on the same network.

### xcrun: iOS Simulator mirror

macOS only. Requires the Xcode Command Line Tools (`xcode-select --install`)
or full Xcode, and a booted simulator. Physical iPhones are NOT supported by
this path: use the in-app view-shot stream instead (Recipe 7), which works
over Wi-Fi in Expo Go.

### TypeScript resolution

The package ships types for both worlds: the `exports` map for modern
setups (`moduleResolution: bundler`, `node16`, `nodenext`) and
`typesVersions` for projects still on `moduleResolution: node` (node10),
which ignores `exports`. Importing `rn-devtools-hub/client` typechecks
either way, no tsconfig change required on your side.

### Network requirements for the app SDK

The device and the dev machine must be on the same LAN, with port 8973
reachable (check your firewall if the device never appears in the selector).

### Capability matrix

| Capability | Dev machine requirement | Phone requirement | Platforms |
| --- | --- | --- | --- |
| Hub + dashboard | Bun or Node 20+ | none | all |
| Core panels (logs, crashes, network, perf) | none | same LAN, port 8973 open | iOS, Android |
| App mirror (view-shot) | none | `react-native-view-shot` in the app | iOS, Android (incl. Expo Go) |
| Full Android mirror (tap, swipe, wheel, keyboard) | adb (platform-tools) | USB debugging enabled | Android |
| adb over Wi-Fi | adb (platform-tools) | Wireless debugging (Android 11+) or one-time `adb tcpip` | Android |
| iOS Simulator mirror | macOS + Xcode CLT, booted simulator | n/a (simulator) | macOS only |

## Automatic setup (recommended)

```bash
npm install --save-dev rn-devtools-hub
npx rn-devtools-hub init
npm run devtools
```

`init` is a codemod: it detects your project shape (Expo or bare React
Native, TypeScript or JavaScript, entry point) and which libraries are
installed, then:

- generates `devtools.setup.ts` (or `.js`) wired to exactly those libraries
- hooks it into your entry point behind a `__DEV__` guard (for Expo Router
  it creates `index.js` and points `package.json` main at it, the documented
  Expo custom-entry pattern)
- adds a `devtools` script to your package.json so `npm run devtools`
  starts the hub

Flags: `--dry-run` (show what would change), `--force` (regenerate the glue).
It is idempotent: running it twice changes nothing.

Two integrations need one extra line from you because they depend on objects
the codemod cannot reach: React Query (call `attachQueryClient(queryClient)`
where you create your client) and navigation (call `useDevtoolsNavigation()`
in your root layout). The generated file exports both with instructions.

The recipes below explain the manual equivalent, useful if you prefer wiring
things yourself or if your setup is unusual.

## Recipe 0: the glue file (required)

Create `src/devtools.setup.ts` (the name does not matter):

```ts
import { devtools } from "rn-devtools-hub/client";

// Hub IP resolution. With Expo, Metro's IP is the right machine:
import Constants from "expo-constants";
const host = Constants.expoConfig?.hostUri?.split(":")[0] ?? "localhost";
// Without Expo: hardcode your dev machine's IP or use an env var.

// The hub listens on 8973, and moves to the next free port when that one
// is taken by another project. Metro inlines EXPO_PUBLIC_* variables, so
// pointing a second project at its own hub is one line in its .env.
const port = process.env.EXPO_PUBLIC_RN_DEVTOOLS_PORT ?? "8973";

devtools.init({
  serverUrl: `ws://${host}:${port}`,
  appName: "my-app",
  deviceName: "device",     // ideally the real model (expo-device)
  stableId: "a-stable-id",  // prevents ghost sessions on every reload
});

// The dependency-free hooks:
devtools.attachConsole();          // Logs panel
devtools.attachCrashReporting();   // Crashes panel (ErrorUtils + Hermes)
devtools.startPerformanceSampler(); // JS lag in the Overview
devtools.attachUiAutomation();     // UI perception/actions for AI agents (MCP)
```

For agents, also call `devtools.markScreenReady("ScreenName")` once a
screen has loaded its data (no skeletons left): agents wait on that event
through the `wait_for_event` MCP tool instead of sleeping.

Load it in the entry point, ALWAYS behind a guard:

```ts
if (__DEV__) {
  require("./src/devtools.setup");
}
```

The SDK also checks `__DEV__` itself: double safety, nothing runs in
production.

## Recipe 1: network (Network panel)

```ts
// Any axios instance:
import axios from "axios";
import { api } from "./services/api";
devtools.attachAxios(api, "api");
devtools.attachAxios(axios, "axios-global");

// Any fetch-based client (S3 uploads, expo/fetch...):
import { fetch as expoFetch } from "expo/fetch";
export const trackedFetch = devtools.wrapFetch(expoFetch, "uploads");
```

Sensitive headers (Authorization, x-api-key, cookies) are redacted before
leaving the device. Binary bodies are not serialized.

Order matters: `wrapFetch` and `attachAxios` return the client UNCHANGED
when `init()` has not run yet, so a module-scope wrap in a file imported
before the devtools setup instruments nothing, and the panel stays empty
with no error anywhere. The SDK records the attempt either way, and
`get_recent_network` says so instead of returning an empty list that
reads like "the app sent no request".

## Recipe 2: React Query cache (Cache panel)

```ts
import { queryClient } from "./queryClient";

const snapshot = () => ({
  queries: queryClient.getQueryCache().getAll().map((q) => ({
    queryKey: q.queryKey,
    status: q.state.status,
    isStale: q.isStale(),
    observers: q.getObserversCount(),
    dataUpdatedAt: q.state.dataUpdatedAt,
    data: q.state.data,
  })),
});
devtools.onCommand("query.snapshot", snapshot);
// Optional: push a throttled snapshot when the cache changes
queryClient.getQueryCache().subscribe(throttle(() => {
  devtools.emit("query.cache", snapshot());
}, 2000));
```

## Recipe 3: AsyncStorage (Storage panel)

```ts
import AsyncStorage from "@react-native-async-storage/async-storage";

devtools.onCommand("storage.keys", async () => {
  const keys = await AsyncStorage.getAllKeys();
  const pairs = await AsyncStorage.multiGet([...keys]);
  return { keys: pairs.map(([key, value]) => ({ key, size: value?.length ?? 0, lastWriteAt: null })) };
});
devtools.onCommand("storage.get", async (payload) => {
  const key = String((payload as any)?.key ?? "");
  const value = await AsyncStorage.getItem(key);
  try { return { key, size: value?.length ?? 0, value: value ? JSON.parse(value) : value }; }
  catch { return { key, size: value?.length ?? 0, value }; }
});
// For live write timestamps: intercept setItem/removeItem
// and emit devtools.emit("storage.write", { op, key, size, preview }).
```

## Recipe 4: SQLite (SQL console)

```ts
// With expo-sqlite (adapt to your driver):
devtools.onCommand("sqlite.query", async (payload) => {
  const sql = String((payload as any)?.sql ?? "");
  if (!/^\s*(select|pragma)\b/i.test(sql)) {
    throw new Error("Read-only: SELECT or PRAGMA only");
  }
  const rows = await db.getAllAsync(sql);
  return { rows };
});
```

## Recipe 5: navigation (Screens panel)

```ts
// With expo-router (or adapt to your navigation lib):
import { usePathname } from "expo-router";
export function useDevtoolsNavigation() {
  const pathname = usePathname();
  const prev = useRef<{ screen: string; since: number } | null>(null);
  useEffect(() => {
    if (!devtools.enabled) return;
    devtools.emit("nav.screen", {
      screen: pathname,
      previousScreen: prev.current?.screen,
      previousDurationMs: prev.current ? Date.now() - prev.current.since : undefined,
    });
    prev.current = { screen: pathname, since: Date.now() };
  }, [pathname]);
}
// Mount this hook once in the root layout.
```

## Recipe 6: remote actions (Actions panel)

```ts
import { DevSettings } from "react-native";

devtools.registerAction({ name: "reload", label: "Reload the app" }, () => {
  setTimeout(() => DevSettings.reload(), 300);
  return { ok: true };
});
devtools.registerAction(
  { name: "clear-storage", label: "Clear AsyncStorage", danger: true },
  async () => { await AsyncStorage.clear(); return { ok: true }; }
);
// danger: true -> confirmation in the dashboard
// requiresNative: true -> grayed out if the app runs in Expo Go
```

## Recipe 7: app mirror (screen stream)

```bash
npx expo install react-native-view-shot   # included in Expo Go, no build
```

```ts
let captureScreen: any = null;
try { captureScreen = require("react-native-view-shot").captureScreen; } catch {}

devtools.onCommand("screen.capture", async () => {
  if (!captureScreen) throw new Error("react-native-view-shot not installed");
  return { format: "jpg", base64: await captureScreen({ format: "jpg", quality: 0.6, result: "base64" }) };
});

let timer: any = null;
devtools.onCommand("screen.stream.start", (p) => {
  if (!captureScreen) throw new Error("react-native-view-shot not installed");
  const fps = Math.min(Math.max(Number((p as any)?.fps) || 2, 1), 5);
  clearInterval(timer);
  timer = setInterval(async () => {
    try {
      const base64 = await captureScreen({ format: "jpg", quality: 0.4, result: "base64" });
      devtools.emitRaw("screen.frame", { format: "jpg", base64 }); // emitRaw: no truncation
    } catch {}
  }, Math.round(1000 / fps));
  setTimeout(() => clearInterval(timer), 5 * 60 * 1000);
  return { ok: true, fps };
});
devtools.onCommand("screen.stream.stop", () => { clearInterval(timer); return { ok: true }; });
devtools.emit("capabilities", { viewShotAvailable: !!captureScreen });
```

The full Android mirror (whole phone, tap, keys) and the iOS simulator
require NOTHING in the app: the hub uses adb and xcrun on the dev machine,
with automatic detection and an adb Wi-Fi guide built into the dashboard.

## Recipe 8: device and connection info (full profile)

```ts
import * as Device from "expo-device";
import * as Application from "expo-application";
import * as Network from "expo-network";

devtools.emit("app.info", {
  appName: "my-app",
  appVersion: Application.nativeApplicationVersion,
  buildVersion: Application.nativeBuildVersion,
  platform: Platform.OS, osName: Device.osName, osVersion: Device.osVersion,
  modelName: Device.modelName, brand: Device.brand,
  totalMemoryMb: Device.totalMemory ? Math.round(Device.totalMemory / 1048576) : null,
  jsEngine: (globalThis as any)?.HermesInternal ? "hermes" : "jsc",
  devMode: "Expo Go" /* or "Development build" */,
  nativeCapable: false /* true outside Expo Go */,
});
setInterval(async () => {
  const state = await Network.getNetworkStateAsync();
  devtools.emit("net.info", {
    type: state.type, isConnected: state.isConnected,
    isInternetReachable: state.isInternetReachable,
    ipAddress: await Network.getIpAddressAsync().catch(() => null),
  });
}, 15000);
```

## MCP: drive the app from an AI agent {#mcp}

The hub exposes http://127.0.0.1:8973/mcp (localhost only).

```bash
claude mcp add rn-devtools --transport http http://127.0.0.1:8973/mcp
```

Tools: `list_devices`, `get_app_info`, `get_recent_network`, `get_crashes`,
`get_endpoint_stats`, `query_sqlite`, `run_action`.

### The dev-menu bubble covering the app

`expo-dev-menu` draws a floating action button over the app. On iOS it
lives in its own `UIWindow`, above everything, which has two consequences
for an agent: it never appears in `get_ui_tree`, and it can cover a native
control underneath it, typically the button in the top right corner of the
system photo picker.

On iOS simulators, `launch_app` and `session_start` hide it by default
(`hideDevMenuFab`), by writing `EXDevMenuShowFloatingActionButton` into the
app sandbox exactly like the onboarding key. The result is reported as a
`fab-hidden` step. The preference persists across launches, including the
ones you start by hand, so to get the bubble back either pass
`hideDevMenuFab: false` on the next `launch_app`, or write it yourself:

```bash
PLIST="$(xcrun simctl get_app_container <udid> <bundleId> data)/Library/Preferences/<bundleId>.plist"
xcrun simctl spawn <udid> defaults write "$PLIST" EXDevMenuShowFloatingActionButton -bool true
```

On Android the switch is the `EXDevMenuShowFloatingActionButton` meta-data
of the application manifest, so it belongs to the app rather than to the
hub: set it to `false` in `AndroidManifest.xml` on a bare project, or
through a config plugin using `withAndroidManifest` on a managed one.

The bubble is also draggable on both platforms, so moving it out of the way
by hand works for a one-off run.

## Final check

1. `npx rn-devtools-hub` from the project root: the URL with token is printed
2. Open the URL, start the app in dev
3. The device appears in the selector within 5 seconds
4. The panels matching your recipes fill up

If the device does not appear: same Wi-Fi network as the dev machine,
port 8973 reachable, and check the IP resolved in the glue file.

### Several projects at once

Run one hub per project, from each project root. With no `--port`, a hub
whose default port is taken walks up to 8982, prints the port it got, and
records it in `.rn-devtools/hub.json` (which the `mcp` stdio bridge reads,
so it always talks to its own project's hub). Point the app at it with
`EXPO_PUBLIC_RN_DEVTOOLS_PORT=8974` in that project's `.env`, or write the
port into the glue with `npx rn-devtools-hub init --force --port 8974`. A
glue file generated before this existed hardcodes 8973, and `init` leaves
an existing one alone unless you pass `--force`. An explicit `--port`
still fails when it is taken, rather than moving somewhere you did not ask
for. For an HTTP MCP client, register the second hub on its own URL:

```bash
claude mcp add rn-devtools-other --transport http http://127.0.0.1:8974/mcp
```
