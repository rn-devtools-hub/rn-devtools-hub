# Bug-fix pilot: protocol

The published benchmark measures whether the hub delivers correct live facts
about a running app and whether an agent reads them. It does not measure
whether that information changes the outcome of a debugging session. This
document is the protocol for a pilot that does. It becomes frozen only when the
protocol, candidate manifest and analysis script are committed before the first
run; an uncommitted draft is not a preregistration.

It is a preregistration. Everything that could be tuned after seeing a result
is decided here instead: which bugs, what counts as fixed, how long an attempt
may run, and how the numbers are analysed. Anything changed after the first run
is recorded in the deviations section at the end, with the reason.

## The question

Does attaching the hub change the rate at which an agent fixes a real bug in a
React Native app, when nothing else about the session differs?

Null hypothesis: the two arms resolve the same set of bugs, and the discordant
pairs split evenly.

## Scale, and what it can and cannot show

Eight bugs, two arms, three repetitions, one client. 48 attempts.

With eight paired bugs, an exact McNemar test reaches p < 0.05 only if at least
six discordant pairs fall the same way. The pilot is a screen for a large
effect, not a confirmatory test. Its primary output is an effect size with an
interval, and a decision on whether the full study is worth building. A result
that lands near zero is a usable answer and gets published as one.

One client only, Claude Code, at a pinned version. Cross-client comparison is
the full study's job, not the pilot's.

## Bug selection

Bugs come from the reference app's own git history: commits that fixed a real
defect are reverted into a branch, one bug per branch. Bugs are not invented
for the benchmark, because invented bugs get written toward whatever the hub
happens to expose.

The list of candidate commits is frozen before anyone checks what the hub shows
for each one. That order matters and is the point of preregistering: choosing
bugs after seeing the hub's coverage would decide the result at selection time.
The committed candidate manifest records the reference repository revision,
candidate fix commits, exclusions with reasons, final eight bugs and the hash
of every hidden target test.

Inclusion criteria, all required:

- The fix commit touches application code, not configuration, tooling or
  dependency bumps.
- The defect is observable by using the app, and can be written up as a
  user-facing symptom with no file name and no stack trace.
- A test can be written that fails on the reverted branch and passes on the
  original fix.
- The defect reproduces on at least 9 of 10 cold app launches. Reproduction
  rate is measured before admission and recorded. Anything below the threshold
  is rejected, because a bug that appears two thirds of the time contaminates
  both arms and inflates the variance in favour of noise.
- Reverting it leaves the rest of the regression suite green.

Composition, fixed in advance: of the eight bugs, at least two must be ones the
hub is not expected to help with. Candidates are a purely visual layout defect,
a bug in code that runs before the SDK connects, and a build or configuration
mismatch with no runtime signal. A suite where every bug plays to the hub's
strengths produces a number nobody should believe, and including the losing
categories is what makes the winning ones mean something.

The remaining six are drawn across categories without balancing them by hand:
state, network, navigation, event handling, timing, platform-specific
behaviour. Whatever the history offers is what gets used.

## The two arms

Identical in every respect except one: whether the hub's MCP server is attached
to the client.

Both arms get:

- The same fresh git worktree at the reverted commit.
- The app already running on the same booted simulator, with the bug
  reproducible.
- Metro output, the ability to edit source, run the test suite, add logging,
  reload the app and take a simulator screenshot.
- The same byte-identical prompt.

The prompt is byte-identical across arms. It must not mention the hub, tools,
devtools or debugging strategy, in either arm. A prompt that names the hub in
the hub arm cues the agent and turns the study into a measurement of the
prompt. The only difference between arms is the MCP server declaration in the
client configuration.

The no-hub arm is a working debugging environment, not a blindfolded agent. If
the baseline cannot run the app and observe it, the comparison is not worth
running.

The prompt is a bug report written the way a user would file it: the symptom,
the steps to see it, and nothing else. No file paths, no stack traces, no
component names.

## What counts as resolved

Two conditions, both checked by exit code, never by a model:

1. The target test for that bug passes. The target test is written before the
   pilot starts, from the original fix commit, and is not visible in the
   worktree the agent works in.
2. The regression suite passes. Any test that passed before the attempt and
   fails after it is a regression, and a regression makes the attempt
   unresolved regardless of the target test.

The agent is not told about the target test and cannot run it. It may write and
run its own tests.

An attempt where the agent declares success and the target test fails is
unresolved, and is additionally counted as a false claim.

## Budget and termination

Each attempt stops at the first of:

- 40 tool calls, or
- 20 minutes of wall clock, or
- the agent producing a final answer.

An attempt that hits a cap is unresolved. Without a cap, time to resolution is
unbounded and the weaker arm simply runs longer, which turns a resolution-rate
question into an endurance question.

## Metrics

Primary: resolution, per bug per arm. A bug counts as resolved in an arm when
at least two of its three repetitions resolved. This majority rule is fixed
here so it cannot be chosen later to suit the data.

Secondary, all recorded per attempt:

- Tool calls to resolution.
- Wall clock to resolution.
- Tokens, taken from the client's own usage object, summing fresh, cache write
  and cache read, consistent with the published benchmark.
- False diagnosis: the final answer names a root cause in a file or mechanism
  the original fix commit did not touch. Scored from the recorded transcript
  against the fix commit.
- Regressions introduced, counted as tests that flipped from pass to fail.
- False claims of success, as defined above.

Secondary metrics are reported on resolved attempts only where a duration or a
call count would otherwise be truncated by the cap, and that restriction is
stated wherever they appear.

## Analysis plan

Primary analysis: exact McNemar on the eight paired bugs. Report the number of
discordant pairs in each direction, the exact p, and the difference in
resolution rates with a 95% paired cluster-bootstrap interval over bugs using
10,000 deterministic resamples from the public seed. Concordant pairs carry no
information in McNemar's test and are still reported.

Secondary analysis: the same test over all 24 repetition-level pairs, reported
with the explicit caveat that repetitions within a bug are not independent and
the interval is therefore optimistic. It is reported because dropping it after
seeing the primary result would be selective reporting.

Secondary metrics are compared within bug, as paired differences, and reported
as medians with the full per-bug table. No significance test is claimed on
them at this sample size.

Alpha is 0.05, two-sided, on the primary analysis only. No subgroup analysis by
bug category is performed at this sample size; the per-category outcomes are
published as a table without inference, to inform the full study's design.

## Controls

- Fresh worktree per attempt. No attempt sees another attempt's edits.
- The app is relaunched and the hub's state reset between attempts, so no
  attempt inherits another's network history or crash log.
- Arm order is randomised per bug and per repetition.
- All 48 attempts run inside a single window with pinned client and model
  versions, recorded in the results. A model update mid-study invalidates the
  comparison and forces a rerun.
- Every attempt records the full transcript, all tool calls with timestamps,
  the resulting diff, and both test runs.
- The committed run manifest records the byte-exact prompt, random seed, arm
  order, client version, exact model identifier and model settings. Raw
  artifacts are written before aggregate tables are generated.
- The reproduction of each bug is verified immediately before each attempt.
  An attempt where the bug does not reproduce at the start is discarded and
  rerun, for both arms of that pair, and the discard is counted.

The last control comes from the published benchmark's own failure: grading
against a reference captured earlier gave three clients the same wrong answer
at once. The equivalent mistake here is scoring an attempt against a bug that
was not present, so the check happens per attempt rather than per session.

## What would falsify the claim

If the discordant pairs split roughly evenly, the hub does not change bug
resolution on this suite, and the pilot says so in those words. If the hub arm
loses on the two bugs it was not expected to help with, that is expected and
reported as such. If the hub arm loses overall, the study is published anyway.

## Not measured

Multi-agent workflows, long autonomous sessions, other clients, other apps, and
anything about developer experience. The pilot measures one client fixing eight
bugs in one app under a fixed budget, and the write-up says nothing broader
than that.

## Deviations

Any change made to this protocol after the first attempt runs is recorded here
with its date and its reason, before the results are published.

None yet.
