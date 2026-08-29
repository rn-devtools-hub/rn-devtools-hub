# Hubflow scenarios

A `.hubflow` file is a versioned, reviewable scenario for React Native and
Expo. It records the action a person performed and the consequences the hub
can prove from inside the app: UI state, network events, stores, console
errors and crashes.

Scenario files normally live under `tests/hub/` and belong in Git. Run
reports and screenshots live under `.rn-devtools/flows/runs/` and stay local.

## Record and save

```text
start_recording  name: "checkout"
ui_act           action: "tap", by: "role", value: "button", name: "Order"
stop_recording
save_flow        path: "checkout.hubflow"
```

`save_flow` refuses an active recording and a recording that already
contains a failed request or crash. The final event cursor is captured by
`stop_recording`, so unrelated events that happen later cannot leak into
the last step.

For a typed secret, pass `recordAs` to `ui_act`:

```text
ui_act action: "type", by: "placeholder", value: "Password",
       text: "the live value", recordAs: "TEST_PASSWORD"
```

The live app receives the value, but the recording stores only
`${TEST_PASSWORD}`. Set that environment variable before replay.

## File format

```json
{
  "format": "rn-devtools-hub/flow",
  "version": 1,
  "name": "checkout",
  "setup": [
    {
      "tool": "freeze_time",
      "arguments": { "iso": "2026-08-29T10:00:00Z" }
    }
  ],
  "steps": [
    {
      "name": "Submit the order",
      "capture": true,
      "act": {
        "tool": "ui_act",
        "arguments": {
          "action": "tap",
          "by": "role",
          "value": "button",
          "name": "Order"
        }
      },
      "expect": [
        {
          "tool": "wait_for_event",
          "arguments": {
            "type": "screen.ready",
            "payloadContains": "Confirmation"
          }
        },
        {
          "tool": "assert",
          "arguments": {
            "kind": "no_console_error",
            "windowMs": 5000
          }
        }
      ]
    }
  ],
  "teardown": [
    { "tool": "restore_time", "arguments": {} }
  ],
  "visualEvidence": {
    "screenshots": "important-and-failure",
    "final": true
  }
}
```

The replay allowlist contains app-driving, assertion, deterministic state
and selected native setup tools. A scenario cannot invoke another flow,
modify store releases, build an app, run arbitrary commands or call an
unknown tool.

## Run

From an MCP client:

```text
run_flow path: "tests/hub/checkout.hubflow"
```

From a terminal or CI job while the app is connected:

```bash
npx rn-devtools-hub run tests/hub/checkout.hubflow
```

The command exits with a nonzero status when the scenario fails. The
dashboard Tests workspace can launch the same runner and shows live step
progress, assertions, failure diagnosis and visual evidence.

## Screenshot policy

The default `important-and-failure` policy saves:

- the starting state;
- steps carrying `"capture": true`;
- the validated final state;
- the state at the exact failing step.

Available policies are `off`, `failure-only`, `important-and-failure` and
`every-step`. Captures are written to disk and never returned as image
content to an agent. A missing native capture adapter is reported as an
evidence error and does not turn a functionally successful scenario into a
failure.

## Repair a changed target

A target mismatch can include up to five bounded candidates with testID,
role, accessible name and source location. The Tests workspace can create a
repair candidate, or an agent can call:

```text
propose_flow_repair path: "tests/hub/checkout.hubflow",
                    stepIndex: 1, candidateIndex: 0
```

The proposal is accepted only when testID, component or source file provides
strong identity evidence. It writes `checkout.candidate.hubflow`. It never
changes the original scenario, removes an assertion, changes an expected
HTTP status, accepts a console error or ignores a crash.

Review and replay the candidate before replacing the original file.
