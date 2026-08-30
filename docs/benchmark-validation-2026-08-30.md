# Benchmark validation, 2026-08-30

This is an independent validation pass performed after the 0.17 review. It is
not a replacement for the published benchmark sample. It records one fresh,
non-resumed session per client against the same live hub.

## Environment

- Hub: rn-devtools-hub 0.17.0 at `http://127.0.0.1:8973/mcp`
- App: `@example/mobile`
- Device: iPhone 16 Pro Max simulator
- Claude Code: 2.1.251, canonical model `claude-opus-5`, 1M context
- Codex CLI: 0.151.0, model selected by the clean CLI configuration
- Cursor Agent: 2026.08.25-3e8eec8, model `gpt-5.6-sol-high`

The byte-equivalent task asked each client for nine facts using live MCP data
only: slowest endpoint by p95, endpoint count, total calls, endpoints with
errors, crash count, device name, declared Expo range, declared React Native
range and registered action names.

## Results

| Client | Correct | Duration | Reported prompt usage | Notes |
|---|---:|---:|---:|---|
| Claude Code | 9/9 | 13.2 s | 82,189 input plus cache tokens | Structured output, no project reads |
| Cursor Agent | 9/9 | 38.6 s | 120,683 input plus cache tokens | Live state had changed since the Claude round |
| Codex CLI | 9/9 | 28.3 s | 171,417 input tokens, 145,920 cached | Read the mandatory local skill before using MCP |

Claude observed three endpoints, eight calls and no registered actions. Before
the later rounds the app reconnected and emitted more traffic. Cursor and Codex
correctly observed six endpoints, eleven calls and the actions `reload`,
`reset-navigation` and `invalidate-queries`. Codex's ground truth was unchanged
immediately before and after its round.

## What this confirms

- All three current clients can connect to the 0.17 MCP endpoint.
- All three can select and combine the required read-only tools.
- All three interpreted every returned field correctly in this validation.
- A changing live app can legitimately produce different correct answers in
  consecutive rounds. Ground truth must bracket every round.

## What this does not confirm

- One run per client does not estimate a failure rate.
- This pass did not reproduce the published 17 or 20 round samples.
- Client-reported token totals are not comparable context measurements. Codex
  loaded the repository skill because its system instructions required it,
  while Cursor ran in an empty temporary workspace.
- The old schema-size experiment cannot be reproduced because its controlled
  server, raw usage objects and exact model identifiers were not retained.
- This is a live-read test, not evidence that the hub improves bug-fix success.

## Release decision

The live-read path is confirmed for the tested environment. Claims about rare
failure rates, schema loading internals, general debugging effectiveness and
cross-client context cost remain unconfirmed. They require a committed runner,
raw artifacts and repeated trials before being used as release claims.
