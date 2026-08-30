# Benchmark

Two questions get asked about a hub that hands an agent 58 tools. What does
that cost the agent in context, and does the agent actually come back with the
right answer about the running app. Both are measurable, so neither is argued
here.

Everything below was measured against a real Expo app on a booted iOS
simulator, with a device connected to the hub, across the three CLIs the hub
targets. The numbers come from each client's own usage reporting, not from an
estimate.

## What the hub costs an agent in context

<svg viewBox="0 0 700 198" width="100%" role="img" aria-label="Prompt tokens added by attaching the hub (58 tools)" style="max-width:700px">
<title>Prompt tokens added by attaching the hub (58 tools)</title>
<text x="0" y="18" fill="#fff" font-family="system-ui,sans-serif" font-size="14" font-weight="600">Prompt tokens added by attaching the hub (58 tools)</text>
<text x="0" y="34" fill="#898781" font-family="system-ui,sans-serif" font-size="11">median of 3 runs per arm, identical trivial prompt, same session shape</text>
<text x="0" y="61" fill="#c3c2b7" font-family="system-ui,sans-serif" font-size="13">Claude Code</text>
<text x="0" y="75" fill="#898781" font-family="system-ui,sans-serif" font-size="10.5">24406 without, 25206 with</text>
<rect x="155.45000000000002" y="48" width="404.44999999999993" height="19" fill="#1a1a19" rx="3"/>
<rect x="155.45000000000002" y="48" width="404.4" height="19" fill="#3987e5" rx="3"/>
<text x="567.9" y="62" fill="#fff" font-family="ui-monospace,Menlo,monospace" font-size="12">+800  (13.8/tool)</text>
<text x="0" y="107" fill="#c3c2b7" font-family="system-ui,sans-serif" font-size="13">Codex CLI</text>
<text x="0" y="121" fill="#898781" font-family="system-ui,sans-serif" font-size="10.5">23773 without, 23923 with</text>
<rect x="155.45000000000002" y="94" width="404.44999999999993" height="19" fill="#1a1a19" rx="3"/>
<rect x="155.45000000000002" y="94" width="75.8" height="19" fill="#3987e5" rx="3"/>
<text x="239.284375" y="108" fill="#fff" font-family="ui-monospace,Menlo,monospace" font-size="12">+150  (2.6/tool)</text>
<text x="0" y="153" fill="#c3c2b7" font-family="system-ui,sans-serif" font-size="13">Cursor CLI</text>
<text x="0" y="167" fill="#898781" font-family="system-ui,sans-serif" font-size="10.5">17221 without, 17428 with</text>
<rect x="155.45000000000002" y="140" width="404.44999999999993" height="19" fill="#1a1a19" rx="3"/>
<rect x="155.45000000000002" y="140" width="104.7" height="19" fill="#3987e5" rx="3"/>
<text x="268.1014375" y="154" fill="#fff" font-family="ui-monospace,Menlo,monospace" font-size="12">+207  (3.6/tool)</text>
</svg>

Attaching the hub costs between 150 and 800 prompt tokens depending on the
client. On a 1M context window that is under a tenth of a percent. The tool
list also sits at the very front of the request, where it is the most cacheable
part of the prompt, and `tools/list` is byte-stable across calls, so the cache
prefix holds.

The cost scales with the *number* of tools, and it is close to linear.

<svg viewBox="0 0 700 250" width="100%" role="img" aria-label="Claude Code: injected tokens against tool count" style="max-width:700px">
<title>Claude Code: injected tokens against tool count</title>
<text x="0" y="18" fill="#fff" font-family="system-ui,sans-serif" font-size="14" font-weight="600">Claude Code: injected tokens against tool count</text>
<text x="0" y="34" fill="#898781" font-family="system-ui,sans-serif" font-size="11">controlled MCP server serving a fixed slice of the hub's real tool definitions</text>
<line x1="56" y1="204" x2="684" y2="204" stroke="#4a4a46"/>
<text x="48" y="208" fill="#898781" text-anchor="end" font-family="ui-monospace,Menlo,monospace" font-size="10.5">0</text>
<line x1="56" y1="164.5" x2="684" y2="164.5" stroke="#2c2c2a"/>
<text x="48" y="168.5" fill="#898781" text-anchor="end" font-family="ui-monospace,Menlo,monospace" font-size="10.5">225</text>
<line x1="56" y1="125" x2="684" y2="125" stroke="#2c2c2a"/>
<text x="48" y="129" fill="#898781" text-anchor="end" font-family="ui-monospace,Menlo,monospace" font-size="10.5">450</text>
<line x1="56" y1="85.5" x2="684" y2="85.5" stroke="#2c2c2a"/>
<text x="48" y="89.5" fill="#898781" text-anchor="end" font-family="ui-monospace,Menlo,monospace" font-size="10.5">675</text>
<line x1="56" y1="46" x2="684" y2="46" stroke="#2c2c2a"/>
<text x="48" y="50" fill="#898781" text-anchor="end" font-family="ui-monospace,Menlo,monospace" font-size="10.5">900</text>
<polyline points="56.0,204.0 145.7,180.7 352.1,128.2 639.1,57.2" fill="none" stroke="#3987e5" stroke-width="2"/>
<circle cx="56.0" cy="204.0" r="4.5" fill="#3987e5"/>
<text x="56.0" y="192" fill="#fff" text-anchor="middle" font-family="ui-monospace,Menlo,monospace" font-size="11">+0</text>
<text x="56.0" y="224" fill="#c3c2b7" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11.5">0</text>
<circle cx="145.7" cy="180.7" r="4.5" fill="#3987e5"/>
<text x="145.7" y="168.6511111111111" fill="#fff" text-anchor="middle" font-family="ui-monospace,Menlo,monospace" font-size="11">+133</text>
<text x="145.7" y="224" fill="#c3c2b7" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11.5">10</text>
<circle cx="352.1" cy="128.2" r="4.5" fill="#3987e5"/>
<text x="352.1" y="116.16" fill="#fff" text-anchor="middle" font-family="ui-monospace,Menlo,monospace" font-size="11">+432</text>
<text x="352.1" y="224" fill="#c3c2b7" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11.5">33</text>
<circle cx="639.1" cy="57.2" r="4.5" fill="#3987e5"/>
<text x="639.1" y="45.23555555555555" fill="#fff" text-anchor="middle" font-family="ui-monospace,Menlo,monospace" font-size="11">+836</text>
<text x="639.1" y="224" fill="#c3c2b7" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11.5">65</text>
<text x="370" y="244" fill="#898781" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11">tools exposed</text>
<text x="12" y="125" fill="#898781" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11" transform="rotate(-90 12 125)">tokens</text>
</svg>

13.3, 13.1 and 12.9 tokens per tool at 10, 33 and 65 tools. The remaining
question is what those tokens are: the names, or the schemas.

<svg viewBox="0 0 700 198" width="100%" role="img" aria-label="Same tool count, different schema size" style="max-width:700px">
<title>Same tool count, different schema size</title>
<text x="0" y="18" fill="#fff" font-family="system-ui,sans-serif" font-size="14" font-weight="600">Same tool count, different schema size</text>
<text x="0" y="34" fill="#898781" font-family="system-ui,sans-serif" font-size="11">the payload grows 4.2x and the injected cost does not move</text>
<text x="0" y="61" fill="#c3c2b7" font-family="system-ui,sans-serif" font-size="13">40 KB of schema</text>
<rect x="138.2" y="48" width="483.79999999999995" height="19" fill="#1a1a19" rx="3"/>
<rect x="138.2" y="48" width="483.8" height="19" fill="#3987e5" rx="3"/>
<text x="630" y="62" fill="#fff" font-family="ui-monospace,Menlo,monospace" font-size="12">+836</text>
<text x="0" y="107" fill="#c3c2b7" font-family="system-ui,sans-serif" font-size="13">170 KB of schema</text>
<rect x="138.2" y="94" width="483.79999999999995" height="19" fill="#1a1a19" rx="3"/>
<rect x="138.2" y="94" width="483.8" height="19" fill="#3987e5" rx="3"/>
<text x="630" y="108" fill="#fff" font-family="ui-monospace,Menlo,monospace" font-size="12">+836</text>
<text x="0" y="153" fill="#c3c2b7" font-family="system-ui,sans-serif" font-size="13">40 KB, short names</text>
<rect x="138.2" y="140" width="483.79999999999995" height="19" fill="#1a1a19" rx="3"/>
<rect x="138.2" y="140" width="376.2" height="19" fill="#4a4a46" rx="3"/>
<text x="522.3602870813397" y="154" fill="#fff" font-family="ui-monospace,Menlo,monospace" font-size="12">+650</text>
</svg>

Inflating every description until the payload is 4.2 times larger changes the
injected cost by zero tokens. Shortening the tool names does move it. So the
client is loading tool schemas on demand and injecting only the names, and the
length of the MCP server name costs more across 65 tools than the entire 40 KB
of JSON Schema behind them.

The practical consequence is the opposite of the usual advice. Trimming tool
descriptions to save context saves nothing here. Only removing tools would, and
removing a third of them would recover about 400 tokens, which is not a reason
to remove anything.

## Whether an agent reads the app correctly through the hub

Nine questions about the running app, each answerable by one read-only hub
tool: the slowest endpoint by p95, how many endpoints are tracked, total calls,
how many endpoints have errors, the crash count, the connected device name, the
declared expo and react-native versions, the registered debug actions.

<svg viewBox="0 0 700 260" width="100%" role="img" aria-label="Correct answers about the live app, by client" style="max-width:700px">
<title>Correct answers about the live app, by client</title>
<text x="0" y="18" fill="#fff" font-family="system-ui,sans-serif" font-size="14" font-weight="600">Correct answers about the live app, by client</text>
<text x="0" y="34" fill="#898781" font-family="system-ui,sans-serif" font-size="11">95% Wilson interval, one tool call per question, ground truth captured around every round</text>
<line x1="46" y1="206" x2="688" y2="206" stroke="#4a4a46" stroke-width="1"/>
<text x="38" y="210" fill="#898781" text-anchor="end" font-family="ui-monospace,Menlo,monospace" font-size="10.5">0</text>
<line x1="46" y1="166" x2="688" y2="166" stroke="#2c2c2a" stroke-width="1"/>
<text x="38" y="170" fill="#898781" text-anchor="end" font-family="ui-monospace,Menlo,monospace" font-size="10.5">25</text>
<line x1="46" y1="126" x2="688" y2="126" stroke="#2c2c2a" stroke-width="1"/>
<text x="38" y="130" fill="#898781" text-anchor="end" font-family="ui-monospace,Menlo,monospace" font-size="10.5">50</text>
<line x1="46" y1="86" x2="688" y2="86" stroke="#2c2c2a" stroke-width="1"/>
<text x="38" y="90" fill="#898781" text-anchor="end" font-family="ui-monospace,Menlo,monospace" font-size="10.5">75</text>
<line x1="46" y1="46" x2="688" y2="46" stroke="#2c2c2a" stroke-width="1"/>
<text x="38" y="50" fill="#898781" text-anchor="end" font-family="ui-monospace,Menlo,monospace" font-size="10.5">100</text>
<rect x="105.0" y="46.0" width="96.0" height="160.0" fill="#3987e5" rx="3"/>
<line x1="153" y1="75.5" x2="153" y2="46.0" stroke="#fff" stroke-width="1.5" opacity="0.75"/>
<line x1="144" y1="75.5" x2="162" y2="75.5" stroke="#fff" stroke-width="1.5" opacity="0.75"/>
<line x1="144" y1="46.0" x2="162" y2="46.0" stroke="#fff" stroke-width="1.5" opacity="0.75"/>
<text x="153" y="196.0" fill="#0d0d0d" text-anchor="middle" font-family="ui-monospace,Menlo,monospace" font-size="12" font-weight="600">100%</text>
<text x="153" y="228" fill="#c3c2b7" text-anchor="middle" font-family="system-ui,sans-serif" font-size="12.5">Claude Code</text>
<text x="153" y="243" fill="#898781" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10.5">17/17</text>
<rect x="319.0" y="46.0" width="96.0" height="160.0" fill="#3987e5" rx="3"/>
<line x1="367" y1="75.5" x2="367" y2="46.0" stroke="#fff" stroke-width="1.5" opacity="0.75"/>
<line x1="358" y1="75.5" x2="376" y2="75.5" stroke="#fff" stroke-width="1.5" opacity="0.75"/>
<line x1="358" y1="46.0" x2="376" y2="46.0" stroke="#fff" stroke-width="1.5" opacity="0.75"/>
<text x="367" y="196.0" fill="#0d0d0d" text-anchor="middle" font-family="ui-monospace,Menlo,monospace" font-size="12" font-weight="600">100%</text>
<text x="367" y="228" fill="#c3c2b7" text-anchor="middle" font-family="system-ui,sans-serif" font-size="12.5">Codex CLI</text>
<text x="367" y="243" fill="#898781" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10.5">17/17</text>
<rect x="533.0" y="46.0" width="96.0" height="160.0" fill="#3987e5" rx="3"/>
<line x1="581" y1="77.0" x2="581" y2="46.0" stroke="#fff" stroke-width="1.5" opacity="0.75"/>
<line x1="572" y1="77.0" x2="590" y2="77.0" stroke="#fff" stroke-width="1.5" opacity="0.75"/>
<line x1="572" y1="46.0" x2="590" y2="46.0" stroke="#fff" stroke-width="1.5" opacity="0.75"/>
<text x="581" y="196.0" fill="#0d0d0d" text-anchor="middle" font-family="ui-monospace,Menlo,monospace" font-size="12" font-weight="600">100%</text>
<text x="581" y="228" fill="#c3c2b7" text-anchor="middle" font-family="system-ui,sans-serif" font-size="12.5">Cursor CLI</text>
<text x="581" y="243" fill="#898781" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10.5">16/16</text>
</svg>

Every client answered every retained round correctly.

The interesting part is what it took to measure this honestly. A first run
scored 50 to 65 percent, and the failures were identical across all three
clients, which is not how three different models fail. They were not failures:
the app kept running, and the reference values captured at the start had gone
stale. The slowest endpoint had moved, the crash history had rolled over on an
app restart, the endpoint count had changed. The agents were reporting the
truth at the moment they were asked, and the benchmark was grading them against
the truth from forty minutes earlier.

So ground truth is now captured directly from the hub immediately before and
immediately after each round. When it moves during the round, that round is
discarded for all three clients at once, because the fact changed rather than
the agent being wrong. One round out of 18 was discarded that way.

That volatility is visible in the retained data and is the point: between the
two repetitions the slowest endpoint went from `GET /v1/express/config` to
`POST /v1/auth/login` and the tracked endpoint count went from 11 to 14. Every
client tracked the change both times. A hub that returned a cached or stale
view would have scored well against a fixed reference and badly here.

## Two devices at once

The questions above were asked of a single connected device. Adding a second
one changes the problem: a hub that holds two apps has to be asked *which*
app, and an agent has to work that out.

So a physical **Samsung Galaxy A16 5G (SM-A165M), Android 16** was added next to the
**iPhone 16 Pro Max, iOS 18.4**, both running the same app, both connected to the
same hub. The Android side is a development build (the app depends on
expo-dev-client and native modules Expo Go does not carry), installed over
USB with Metro and the hub reached through reversed ports.

With two devices attached, every device-scoped tool stops answering and says
so, naming both candidates:

```
2 devices are connected, so the target is ambiguous: pass deviceId.
Connected: s-SimulatoriOS-...-ios (@example/mobile on iPhone 16 Pro Max),
           s-SM-A165M-...-andr (@example/mobile on Galaxy A16)
```

That refusal is the feature under test. Ten questions were asked, each naming
its target device, with no hint in the prompt that disambiguation would be
needed. The agents had to hit the refusal, resolve the device themselves and
retry scoped.

<svg viewBox="0 0 700 260" width="100%" role="img" aria-label="Correct answers with two devices connected, by client" style="max-width:700px">
<title>Correct answers with two devices connected, by client</title>
<text x="0" y="18" fill="#fff" font-family="system-ui,sans-serif" font-size="14" font-weight="600">Correct answers with two devices connected, by client</text>
<text x="0" y="34" fill="#898781" font-family="system-ui,sans-serif" font-size="11">an Android phone and an iOS simulator on one hub; every device-scoped question names its target</text>
<line x1="46" y1="206" x2="688" y2="206" stroke="#4a4a46" stroke-width="1"/>
<text x="38" y="210" fill="#898781" text-anchor="end" font-family="ui-monospace,Menlo,monospace" font-size="10.5">0</text>
<line x1="46" y1="166" x2="688" y2="166" stroke="#2c2c2a" stroke-width="1"/>
<text x="38" y="170" fill="#898781" text-anchor="end" font-family="ui-monospace,Menlo,monospace" font-size="10.5">25</text>
<line x1="46" y1="126" x2="688" y2="126" stroke="#2c2c2a" stroke-width="1"/>
<text x="38" y="130" fill="#898781" text-anchor="end" font-family="ui-monospace,Menlo,monospace" font-size="10.5">50</text>
<line x1="46" y1="86" x2="688" y2="86" stroke="#2c2c2a" stroke-width="1"/>
<text x="38" y="90" fill="#898781" text-anchor="end" font-family="ui-monospace,Menlo,monospace" font-size="10.5">75</text>
<line x1="46" y1="46" x2="688" y2="46" stroke="#2c2c2a" stroke-width="1"/>
<text x="38" y="50" fill="#898781" text-anchor="end" font-family="ui-monospace,Menlo,monospace" font-size="10.5">100</text>
<rect x="105.0" y="46.0" width="96.0" height="160.0" fill="#3987e5" rx="3"/>
<line x1="153" y1="71.8" x2="153" y2="46.0" stroke="#fff" stroke-width="1.5" opacity="0.75"/>
<line x1="144" y1="71.8" x2="162" y2="71.8" stroke="#fff" stroke-width="1.5" opacity="0.75"/>
<line x1="144" y1="46.0" x2="162" y2="46.0" stroke="#fff" stroke-width="1.5" opacity="0.75"/>
<text x="153" y="196.0" fill="#0d0d0d" text-anchor="middle" font-family="ui-monospace,Menlo,monospace" font-size="12" font-weight="600">100%</text>
<text x="153" y="228" fill="#c3c2b7" text-anchor="middle" font-family="system-ui,sans-serif" font-size="12.5">Claude Code</text>
<text x="153" y="243" fill="#898781" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10.5">20/20</text>
<rect x="319.0" y="46.0" width="96.0" height="160.0" fill="#3987e5" rx="3"/>
<line x1="367" y1="71.8" x2="367" y2="46.0" stroke="#fff" stroke-width="1.5" opacity="0.75"/>
<line x1="358" y1="71.8" x2="376" y2="71.8" stroke="#fff" stroke-width="1.5" opacity="0.75"/>
<line x1="358" y1="46.0" x2="376" y2="46.0" stroke="#fff" stroke-width="1.5" opacity="0.75"/>
<text x="367" y="196.0" fill="#0d0d0d" text-anchor="middle" font-family="ui-monospace,Menlo,monospace" font-size="12" font-weight="600">100%</text>
<text x="367" y="228" fill="#c3c2b7" text-anchor="middle" font-family="system-ui,sans-serif" font-size="12.5">Codex CLI</text>
<text x="367" y="243" fill="#898781" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10.5">20/20</text>
<rect x="533.0" y="54.0" width="96.0" height="152.0" fill="#3987e5" rx="3"/>
<line x1="581" y1="83.8" x2="581" y2="47.4" stroke="#fff" stroke-width="1.5" opacity="0.75"/>
<line x1="572" y1="83.8" x2="590" y2="83.8" stroke="#fff" stroke-width="1.5" opacity="0.75"/>
<line x1="572" y1="47.4" x2="590" y2="47.4" stroke="#fff" stroke-width="1.5" opacity="0.75"/>
<text x="581" y="196.0" fill="#0d0d0d" text-anchor="middle" font-family="ui-monospace,Menlo,monospace" font-size="12" font-weight="600">95%</text>
<text x="581" y="228" fill="#c3c2b7" text-anchor="middle" font-family="system-ui,sans-serif" font-size="12.5">Cursor CLI</text>
<text x="581" y="243" fill="#898781" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10.5">19/20</text>
</svg>

The two devices held different data, which is what makes a wrong answer
visible: the hub had statistics for 13 endpoints on the simulator and
1 on the phone. An agent that scoped to the wrong device answers
13 where 1 is correct, and none did.

The single miss is real rather than a scoring artifact: on one round Cursor
answered that one device was connected when two were. It is the only genuine
wrong answer across both accuracy experiments, and it is left in the count.

Nothing drifted during these 20 rounds, so none were discarded.

## Method

- App: an Expo delivery app, React Native 0.86, Expo SDK 57. Connected to the
  hub over WebSocket from an iPhone 16 Pro Max simulator and, for the
  two-device section, from a physical Samsung Galaxy A16 5G on Android 16
  running an EAS development build installed over USB.
- Clients: Claude Code 2.1.251, Codex CLI 0.147.0, Cursor CLI 3.9.16, each
  connected to the same hub over the local MCP endpoint.
- Injection cost: same trivial prompt with and without the MCP server declared,
  3 runs per arm, median reported. Prompt tokens are the sum of fresh, cache
  write and cache read from each client's usage object.
- Tool count and schema size: a controlled MCP server serving a chosen slice of
  the hub's own tool definitions, so the names and schemas are the real ones.
- Accuracy: 9 questions, 2 repetitions, three clients per round,
  run in parallel against one hub. Agents were restricted to read-only tools
  and to a single call, and were told not to read project files.
- Two devices: 10 questions, 2 repetitions. The single-call restriction is
  lifted, because resolving a device takes a call of its own, and the prompt
  says nothing about disambiguation.
- Scoring: the expected pattern is derived from the captured value, never
  written by hand.

## Limits

These are single-tool lookups, not multi-step debugging. They measure whether
the hub delivers correct live facts to an agent and whether the agent reads
them, which is the hub's contract. They do not measure whether an agent can
diagnose a bug.

With 17 retained rounds per client, a 100% score carries a 95% interval
reaching down to about 82%. The result rules out a broken path, not a rare
failure mode. One Cursor run out of 18 exceeded a 260 second deadline and was
counted as missing rather than wrong.

All of it is one app on one machine. Another app with different traffic would
be a different sample, and the injection numbers belong to the client versions
listed above, which change often.

The scoring code is itself a source of error, and was twice: an early version
graded three questions against a pattern built from a non-numeric value, which
turned three correct answers into failures across every client at once. It now
refuses to build a matcher it has no rule for instead of quietly producing one
that can never match. Both accuracy sections were scored again from the same
recorded answers after that fix; no agent was re-run to improve a number.
