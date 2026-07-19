# Integration guide

This guide is written to be followed by a human OR by an AI agent, recipe by
recipe. Each recipe is independent: take the ones you need. The SDK is
agnostic: it knows no library, you wire up your own.

## Prerequisites

- `npm install --save-dev rn-devtools-hub` in the host project (devDependency)
- [Bun](https://bun.sh) installed on the dev machine (for the hub only)
- Start the hub FROM THE ROOT of the host project: `npx rn-devtools-hub`

## Prerequisites by capability

The core panels (logs, crashes, network, performance) need nothing beyond the
SDK and the hub. The optional capabilities below each have their own setup.

### Bun (required, for the hub only)

The hub runs on Bun's native WebSocket server. The SDK in the app needs
nothing. Install on macOS, Linux or Windows (WSL):

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

### Network requirements for the app SDK

The device and the dev machine must be on the same LAN, with port 8973
reachable (check your firewall if the device never appears in the selector).

### Capability matrix

| Capability | Dev machine requirement | Phone requirement | Platforms |
| --- | --- | --- | --- |
| Hub + dashboard | Bun | none | all |
| Core panels (logs, crashes, network, perf) | none | same LAN, port 8973 open | iOS, Android |
| App mirror (view-shot) | none | `react-native-view-shot` in the app | iOS, Android (incl. Expo Go) |
| Full Android mirror (tap, swipe, wheel, keyboard) | adb (platform-tools) | USB debugging enabled | Android |
| adb over Wi-Fi | adb (platform-tools) | Wireless debugging (Android 11+) or one-time `adb tcpip` | Android |
| iOS Simulator mirror | macOS + Xcode CLT, booted simulator | n/a (simulator) | macOS only |

## Recipe 0: the glue file (required)

Create `src/devtools.setup.ts` (the name does not matter):

```ts
import { devtools } from "rn-devtools-hub/client";

// Hub IP resolution. With Expo, Metro's IP is the right machine:
import Constants from "expo-constants";
const host = Constants.expoConfig?.hostUri?.split(":")[0] ?? "localhost";
// Without Expo: hardcode your dev machine's IP or use an env var.

devtools.init({
  serverUrl: `ws://${host}:8973`,
  appName: "my-app",
  deviceName: "device",     // ideally the real model (expo-device)
  stableId: "a-stable-id",  // prevents ghost sessions on every reload
});

// The three dependency-free hooks:
devtools.attachConsole();          // Logs panel
devtools.attachCrashReporting();   // Crashes panel (ErrorUtils + Hermes)
devtools.startPerformanceSampler(); // JS lag in the Overview
```

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

## Final check

1. `npx rn-devtools-hub` from the project root: the URL with token is printed
2. Open the URL, start the app in dev
3. The device appears in the selector within 5 seconds
4. The panels matching your recipes fill up

If the device does not appear: same Wi-Fi network as the dev machine,
port 8973 reachable, and check the IP resolved in the glue file.
