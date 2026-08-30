#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { analyzePilot, buildPilotPlan } from "../server/benchmark-pilot.mjs";

const readJson = (path) => JSON.parse(readFileSync(path, "utf-8"));
const readJsonLines = (path) => readFileSync(path, "utf-8")
  .split(/\r?\n/)
  .filter((line) => line.trim())
  .map((line, index) => {
    try { return JSON.parse(line); }
    catch (error) { throw new Error(`${path}:${index + 1}: ${error.message}`); }
  });

const [command, manifestPath, resultsPath] = process.argv.slice(2);

try {
  if (command === "plan" && manifestPath) {
    process.stdout.write(`${JSON.stringify(buildPilotPlan(readJson(manifestPath)), null, 2)}\n`);
  } else if (command === "analyze" && manifestPath && resultsPath) {
    process.stdout.write(`${JSON.stringify(analyzePilot(readJson(manifestPath), readJsonLines(resultsPath)), null, 2)}\n`);
  } else {
    throw new Error(
      "Usage: node scripts/benchmark-pilot.mjs plan <manifest.json>\n"
      + "   or: node scripts/benchmark-pilot.mjs analyze <manifest.json> <attempts.jsonl>"
    );
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
