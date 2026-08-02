---
name: rn-devtools-hub
description: Drive a running React Native or Expo app from inside its JS runtime. Use whenever working on an RN/Expo app with the rn-devtools-hub MCP server connected, and specifically when you need to see what is on screen, act on it without coordinates, find which file produced an element, prove a change worked, reproduce a scenario deterministically, or investigate a bug after the fact. Triggers on "check it works in the app", "tap the button", "why is this screen empty", "which file renders this", "did I break the layout", "make this test reproducible", "the app behaves impossibly".
license: MIT
metadata:
  author: rn-devtools-hub
  version: "1.0.0"
  tags: react-native, expo, mcp, ui-automation, testing, agent
---

# rn-devtools-hub

The SDK runs **inside the app's JavaScript runtime**. That is the whole
reason this tool exists, and it changes how you should work: you are not
looking at pixels, you are reading React's own state and calling the app's
own handlers.

Three habits follow, and they are the difference between an agent that
guesses and one that knows.

1. **Never verify with a screenshot.** Use `assert`. A screenshot cannot
   show a request that failed silently or a promise that rejected.
2. **Never sleep.** Use `wait_for_event`. Sleeping is a race you lose on
   a slow machine and waste time on a fast one.
3. **Never grep the repo for a component you can see.** Every node carries
   `source` with its file and line.

## Before anything else

If the app behaves impossibly (a library is missing, a prop does nothing, a
feature that worked is gone), call `get_project_context` **first**. It
returns what the project declares, what the app actually runs, and the
contradictions between them.

```
divergence: [{ field: "newArchitecture", declared: true, runtime: false,
               severity: "high",
               hint: "the native build predates the change. Rebuild." }]
```

Most "impossible" bugs are a stale native binary. Spending twenty minutes
reading code before checking this is the single most common waste.

## The loop

```
session_start        launch, pre-grant permissions, wait until connected
query_ui             find the element by role + accessible name
ui_act               tap / type / scroll through the app's own props
wait_for_event       block on the consequence, never sleep
assert               prove the outcome, with evidence on failure
```

Selector preference, best first: **role + accessible name**, then `testID`,
then `text`. If a selector is ambiguous, `ui_act` returns the candidates
with their rects instead of guessing: pass `index`, or narrow with `within`.

If a UI path is long or fragile, skip it. `list_actions` shows what the app
registered (`nav:*`, `auth:*`, `seed:*`, `reset:*`) and `run_action` jumps
straight there. `set_state` goes further and puts the app in an exact state
without walking any screen at all.

## Which tool answers which question

| Question | Tool |
|---|---|
| Why does this behave impossibly? | `get_project_context` |
| What is on screen? | `get_ui_tree`, `query_ui` |
| Which file renders this? | the `source` field on any node or match |
| Act on it | `ui_act`, or `run_action` to skip the path |
| Did it work? | `assert` |
| Did anything break that has no pixel? | `assert` kind `network_ok`, `no_console_error`, `no_crash` |
| What happened after my action? | `get_events_since`, `wait_for_event` |
| Did I break the layout? | `snapshot_baseline` then `compare_snapshot` |
| Does this component render correctly? | `render_component` |
| Why did it fail an hour ago? | `export_session` |
| Make this repeatable | `freeze_time`, `mock_network`, `set_state` |
| Turn what I just did into a test | `start_recording`, `export_flow` |
| Is it usable with a screen reader? | `audit_accessibility` |

## Chains that matter

### Verify a change you just made

```
wait_for_event  type: "ui.change"          # the reload landed
query_ui        by: "role", value: "button", name: "Commander"
ui_act          action: "tap", by: "role", value: "button", name: "Commander"
wait_for_event  type: "network.response", payloadContains: "/orders"
assert          kind: "visible", by: "text", value: "Commande confirmée"
assert          kind: "network_ok", since: <cursor from before the tap>
```

The last line is what a screenshot would have missed. Take the cursor from
`get_events_since` **before** acting, so the window covers exactly your step
and nothing else.

### Fix an element you can see

`query_ui` returns `source: { file, line, column, componentName, via }`.
Edit that file directly. Read `via` before trusting it:

| `via` | Meaning |
|---|---|
| `debugSource`, `sourceProp`, `inspector` | Exact source location |
| `owner` | The location of the component that rendered it, usually what you want |
| `stack` | **Bundle** coordinates, not source: symbolicate before using |
| `componentOnly` | No location, but the component name is searchable |

### Build a component without navigating to it

```
list_previews                                   # is the outlet mounted?
render_component  name: "ServiceCard", props: { title: "Test" }
                                                # returns rect + rendered tree
unmount_component
```

The component mounts inside the running app under its real providers, so
nothing has to be mocked. It needs `devtools.registerPreview` in the app
plus a four-line outlet; `list_previews` says so if it is missing.

### Make a scenario reproducible

```
freeze_time    iso: "2026-01-15T10:00:00Z"     # kills relative-date drift
mock_network   action: "rules", rules: [{ urlContains: "/orders", status: 201, body: {...} }]
set_state      store: "auth", value: { user: { id: 1 } }   # skip the login
... run the scenario ...
restore_time
mock_network   action: "reset"
```

Deterministic at the **JS level only**: `Date` and the instrumented fetch.
Native animations and Reanimated read native clocks. If a test still
flickers, that is why; use `set_animations` on Android.

### Turn exploration into a regression test

```
start_recording  name: "checkout"
... drive the app with ui_act ...
stop_recording
export_flow      format: "mcp"
```

Each action comes back paired with what it caused. If `clean: false`, the
recording captured a failure: fix it before treating it as a test.

### Investigate after the fact

```
list_sessions
export_session  format: "markdown"
```

One timeline: network, console, crashes, navigation. Pastes into an issue
unedited. Sessions survive hub restarts and app reloads.

### Check a layout regression

```
snapshot_baseline  name: "cart"
... make the change ...
compare_snapshot   name: "cart"
```

The answer names the component that owns the changed region, with its
source file, and what the bus recorded since the baseline. Not a
percentage: a diagnosis.

## Reading failures

| Symptom | What it actually means |
|---|---|
| "React DevTools hook unavailable" | Release bundle, or `attachUiAutomation()` missing. Check `get_project_context` for `dev: false` |
| "No React root observed yet" | `attachUiAutomation()` runs too late. It belongs at startup, before the first render |
| `ui_act` returns `ok: false, reason: "ambiguous"` | Several matches, listed with rects. Pass `index` or scope with `within` |
| Element in `get_ui_tree` but not in `query_ui` | It is in a hidden navigator screen. Only pass `includeHidden` if you know why |
| `assert` fails with an empty `evidence` | The window was wrong. Pass `since` from a cursor taken before the action |
| `source` is `null` everywhere | Production build, or a React version without dev bookkeeping |
| `audit_accessibility` returns `conclusive: false` | One of the two trees came back empty; the report is not a clean bill of health |

## Writing or editing the glue file

`devtools.emit` truncates payloads at 20 KB. That is right for logs and
network bodies and wrong for anything binary: a truncated base64 frame is
an undecodable image and a blank panel, with no error anywhere.

`screen.frame` is kept whole automatically, and any other type that gets
truncated warns once naming `emitRaw`. For your own binary events, reach
for `devtools.emitRaw(type, payload)` directly.

## What not to do

- Do not take a screenshot to check a result. `assert` is faster, cheaper
  and sees what pixels cannot.
- Do not use `tap_native` unless a native dialog is genuinely in the way.
  It is coordinate-based and fragile. `set_permission` before launching
  removes most dialogs entirely.
- Do not poll in a loop. `wait_for_event` blocks properly.
- Do not pass `includeHidden: true` to make a selector match. It usually
  means you are targeting the screen the user just left.
- Do not read `get_ui_tree` in full when you want one element. `query_ui`
  is scoped and far cheaper in tokens.
