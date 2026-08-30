# Bug-fix pilot

This directory turns `docs/benchmark-pilot.md` into a versioned experimental
contract. The benchmark must not start from `manifest.template.json`.

Before the first attempt:

1. Copy the template to `manifest.json`.
2. Pin the reference repository and revision, client version and exact model.
3. Select eight historical bugs before inspecting what the hub exposes.
4. Include at least two negative controls where the hub is not expected to
   help.
5. Add the byte-exact user report, reproduction command, hidden target-test
   command, regression command and SHA-256 of the hidden test for every bug.
6. Commit `manifest.json`, the hidden-test hashes and the analysis code.
7. Generate the fixed order with `npm run benchmark:pilot -- plan
   benchmarks/pilot/manifest.json` and commit that output as `plan.json`.

Each completed attempt is one JSON object in `attempts.jsonl`:

```json
{"attemptId":"bug-01:r1:hub","resolved":true,"targetTestPassed":true,"regressionPassed":true,"declaredSuccess":true,"termination":"final","durationMs":420000,"toolCalls":18,"tokens":85000,"falseDiagnosis":false,"falseClaim":false,"regressions":0}
```

The analyzer refuses duplicate, missing and unexpected attempt IDs:

```bash
npm run benchmark:pilot -- analyze benchmarks/pilot/manifest.json attempts.jsonl
```

Raw transcripts, diffs and test logs belong under
`.rn-devtools/benchmarks/bugfix-pilot/`. That directory is local and ignored.
The published result must include a content hash for each raw artifact so an
auditor can verify that aggregate tables came from the recorded attempts.
