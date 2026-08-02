/**
 * Visual regression, explained.
 *
 * A pixel diff on its own returns a percentage and an image, which tells
 * an agent that something moved but not what to edit. Anyone with a
 * screenshot tool can produce that.
 *
 * Here the diff is only the first of three answers. The bounding box
 * locates the change, the source-mapped hit test names the component that
 * owns that region, and the event bus says what happened since the
 * baseline was taken:
 *
 *   The 4% difference sits in the region rendered by ServiceCard.tsx:42,
 *   and the only ui.change since the baseline follows a /services
 *   response with a different payload.
 *
 * That is a diagnosis. The other two thirds of it need to be inside the
 * runtime.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodePng, diffImages } from "./png.mjs";
import { ensureArtifactDir } from "./session.mjs";

const BASELINE_DIR = join(".rn-devtools", "baselines");
const CHANGE_TYPES = new Set(["ui.change", "network.response", "network.error", "nav", "screen.ready"]);
const MAX_CHANGES_REPORTED = 12;

const safeName = (name) => {
  const cleaned = String(name ?? "").replace(/[^A-Za-z0-9._-]/g, "");
  if (!cleaned) throw new Error("A baseline needs a name (letters, digits, dot, dash, underscore)");
  return cleaned;
};

export const baselineRoot = (projectRoot) => join(projectRoot, BASELINE_DIR);
export const baselinePath = (projectRoot, name) =>
  join(baselineRoot(projectRoot), `${safeName(name)}.png`);

export const writeBaseline = (projectRoot, name, bytes) => {
  const root = baselineRoot(projectRoot);
  ensureArtifactDir(root);
  const file = baselinePath(projectRoot, name);
  writeFileSync(file, bytes);
  return file;
};

/**
 * Turns pixel coordinates into the point coordinates the runtime measures
 * in. Screenshots come back in device pixels; measureInWindow answers in
 * points, and forgetting the scale is how a hit test lands in the wrong
 * component on every retina device.
 */
export const centreInPoints = (bbox, imageWidth, screenWidthPoints) => {
  if (!bbox) return null;
  const scale = screenWidthPoints > 0 ? imageWidth / screenWidthPoints : 1;
  return {
    x: (bbox.x + bbox.width / 2) / scale,
    y: (bbox.y + bbox.height / 2) / scale,
    scale,
  };
};

/** What happened between the baseline and now, in the words of the bus */
export const changesSince = (events, sinceTs) => {
  const list = Array.isArray(events) ? events : [];
  return list
    .filter((event) => CHANGE_TYPES.has(event.type) && (event.ts ?? 0) >= sinceTs)
    .slice(-MAX_CHANGES_REPORTED)
    .map((event) => ({
      t: event.ts ?? null,
      type: event.type,
      detail:
        event.type === "network.response" || event.type === "network.error"
          ? `#${event.payload?.requestId ?? "?"} ${event.payload?.status ?? "error"}`
          : event.payload?.screen ?? event.payload?.generation ?? null,
    }));
};

/**
 * Assembles the verdict. Kept pure and injected so the explanation logic
 * is testable without a simulator: `hitTest` is the runtime call that
 * names the component under the changed region.
 */
export const explainDiff = async (diff, context = {}) => {
  if (!diff.comparable) {
    return {
      ok: false,
      comparable: false,
      reason: diff.reason,
      hint: "The screen size changed between the baseline and now. Re-take the baseline on the same device and orientation.",
    };
  }

  const threshold = Number.isFinite(Number(context.maxRatio)) ? Number(context.maxRatio) : 0.001;
  const passed = diff.ratio <= threshold;
  const point = centreInPoints(diff.bbox, diff.width, context.screenWidthPoints ?? diff.width);

  let owner = null;
  if (!passed && point && typeof context.hitTest === "function") {
    try {
      const hit = await context.hitTest(point.x, point.y);
      owner = hit?.deepest ?? null;
    } catch {
      // A hit test needs a live runtime; its absence must not void the diff
    }
  }

  return {
    ok: passed,
    comparable: true,
    ratio: diff.ratio,
    changedPixels: diff.changedPixels,
    threshold,
    region: diff.bbox,
    regionCentrePoints: point ? { x: point.x, y: point.y } : null,
    scale: point?.scale ?? null,
    // The three answers, in the order an agent uses them
    owner: owner
      ? { type: owner.type ?? null, testID: owner.testID ?? null, text: owner.text ?? null, source: owner.source ?? null }
      : null,
    changesSinceBaseline: context.changes ?? [],
    explanation: passed
      ? "No visible change beyond the threshold."
      : buildExplanation(diff, owner, context.changes ?? []),
  };
};

const buildExplanation = (diff, owner, changes) => {
  const percent = `${(diff.ratio * 100).toFixed(2)}%`;
  const where = owner?.source?.file
    ? `the region rendered by ${owner.source.file}${owner.source.line ? `:${owner.source.line}` : ""}`
    : owner?.testID
      ? `the region of testID "${owner.testID}"`
      : "a region no component could be attributed to";
  const because = changes.length
    ? ` The bus recorded ${changes.length} change(s) since the baseline, most recently ${changes[changes.length - 1].type}.`
    : " Nothing was recorded on the bus since the baseline, so the change likely predates it.";
  return `${percent} of the pixels differ, inside ${where}.${because}`;
};

export const readBaseline = (projectRoot, name) => {
  const file = baselinePath(projectRoot, name);
  if (!existsSync(file)) {
    throw new Error(`No baseline named "${name}". Take one first with snapshot_baseline.`);
  }
  return decodePng(readFileSync(file));
};

export const baselineTakenAt = (projectRoot, name) => {
  const file = baselinePath(projectRoot, name);
  if (!existsSync(file)) return null;
  try {
    return statSync(file).mtimeMs;
  } catch {
    return null;
  }
};

export { decodePng, diffImages };

export const VISUAL_TOOLS = [
  {
    name: "snapshot_baseline",
    description:
      "Captures the current screen and stores it as the named visual baseline. Take it on the device and orientation the comparison will use.",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string" },
        target: { type: "string", description: "sim:<udid> or adb:<serial>; omitted = the single booted target" },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: "compare_snapshot",
    description:
      "Compares the current screen with a named baseline and EXPLAINS the difference: the changed ratio, the bounding box, the component that owns that region with its source file and line, and what the event bus recorded since the baseline. A percentage alone says something moved; this says what to edit.",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        deviceId: { type: "string" },
        name: { type: "string" },
        target: { type: "string" },
        maxRatio: { type: "number", minimum: 0, maximum: 1, description: "Tolerated changed-pixel ratio (default 0.001)" },
        withImage: { type: "boolean", description: "Return the diff image as well" },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
];
