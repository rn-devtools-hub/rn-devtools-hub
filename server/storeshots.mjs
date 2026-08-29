/**
 * Store screenshots, captured from the app the hub already knows.
 *
 * The hard part of store screenshots is not taking the picture. It is
 * putting the app in the SAME state twice: the same account, the same
 * cart, the same date on the receipt, on four device sizes and in three
 * languages, again next release. Doing that by hand is why store
 * listings rot, and why the screenshots on most stores are two versions
 * old.
 *
 * Everything needed is already here: dev actions to reach a screen
 * without walking the UI, a frozen clock, mocked network, `screen.ready`
 * to know the screen has its data, and simctl/adb to capture at the
 * device's native resolution. This is the manifest that ties them
 * together, and the loop that runs it.
 *
 * Two deliberate choices:
 *
 * - The pixels NEVER enter the agent's context. Files are written to
 *   disk and the answer is a manifest of paths and sizes. That is also
 *   why this does not count against the screenshot budget in tools.mjs:
 *   those bytes are an asset, not a verification an agent is paying to
 *   look at.
 * - Nothing is resized. A capture taken on the right simulator is
 *   already the size that store accepts; resizing one that is not is how
 *   an asset gets rejected after the upload appears to work. A size the
 *   table does not recognise is reported as such, with the sizes it does.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MANIFEST_FILE = join(".rn-devtools", "store-screenshots.json");
export const DEFAULT_OUTPUT = join(".rn-devtools", "store-screenshots");
export const INDEX_FILE = "index.json";

/**
 * Sizes each store accepts, and the name it calls them.
 *
 * A convenience, not an authority: the display types come from Apple's
 * own enum (checked by scripts/check-store-apis.mjs) but the pixel sizes
 * are not in any machine-readable document, so an unknown size is
 * reported rather than guessed, and every upload tool takes an explicit
 * override.
 */
export const APPLE_SIZES = [
  { size: "1320x2868", displayType: "APP_IPHONE_67", note: "iPhone 16 Pro Max class" },
  { size: "1290x2796", displayType: "APP_IPHONE_67", note: "iPhone 15 Pro Max class" },
  { size: "1284x2778", displayType: "APP_IPHONE_65", note: "iPhone 12 Pro Max class" },
  { size: "1242x2688", displayType: "APP_IPHONE_65", note: "iPhone 11 Pro Max class" },
  { size: "1206x2622", displayType: "APP_IPHONE_61", note: "iPhone 16 class" },
  { size: "1179x2556", displayType: "APP_IPHONE_61", note: "iPhone 15 class" },
  { size: "1242x2208", displayType: "APP_IPHONE_55", note: "iPhone 8 Plus class" },
  { size: "2064x2752", displayType: "APP_IPAD_PRO_3GEN_129", note: "iPad Pro 13 inch" },
  { size: "2048x2732", displayType: "APP_IPAD_PRO_3GEN_129", note: "iPad Pro 12.9 inch" },
  { size: "1668x2388", displayType: "APP_IPAD_PRO_3GEN_11", note: "iPad Pro 11 inch" },
];

/** Play sorts by the shortest side rather than by an exact size */
export const playImageType = ({ width, height }) => {
  const shortest = Math.min(width, height);
  if (shortest >= 1600) return "tenInchScreenshots";
  if (shortest >= 1100) return "sevenInchScreenshots";
  return "phoneScreenshots";
};

export const appleDisplayType = ({ width, height }) => {
  const key = `${width}x${height}`;
  const portrait = APPLE_SIZES.find((entry) => entry.size === key);
  if (portrait) return portrait.displayType;
  // A landscape capture is the same device turned over
  const flipped = APPLE_SIZES.find((entry) => entry.size === `${height}x${width}`);
  return flipped ? flipped.displayType : null;
};

const asArray = (value) => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]);

/**
 * The manifest, from the project or from the call.
 *
 * Living in the repo is the point: a screenshot set that is not
 * reproducible next release is the problem this is trying to solve.
 */
export const readManifest = (projectRoot, inline) => {
  if (inline && typeof inline === "object") return { manifest: inline, from: "the call" };
  const path = join(projectRoot, MANIFEST_FILE);
  if (!existsSync(path)) {
    throw new Error(
      `No screenshot manifest: write ${MANIFEST_FILE} (devices, locales, screens) or pass one as manifest. See docs/plugins.md.`,
    );
  }
  try {
    return { manifest: JSON.parse(readFileSync(path, "utf-8")), from: MANIFEST_FILE };
  } catch (error) {
    throw new Error(`${MANIFEST_FILE} is not readable: ${error?.message ?? error}`);
  }
};

const SAFE_NAME = /^[A-Za-z0-9._-]{1,64}$/;

export const validateManifest = (manifest) => {
  const problems = [];
  const devices = asArray(manifest?.devices);
  const screens = asArray(manifest?.screens);
  const locales = asArray(manifest?.locales);

  if (devices.length === 0) problems.push("devices is empty: each entry needs {target, label} from list_targets");
  if (screens.length === 0) problems.push("screens is empty: each entry needs {name} and a way to reach it");

  for (const device of devices) {
    if (!device?.target) problems.push(`a device has no target: ${JSON.stringify(device)}`);
    if (!SAFE_NAME.test(String(device?.label ?? ""))) {
      problems.push(`device label ${JSON.stringify(device?.label ?? null)} must be 1 to 64 letters, digits, dot, dash or underscore: it becomes a directory`);
    }
  }
  for (const screen of screens) {
    if (!SAFE_NAME.test(String(screen?.name ?? ""))) {
      problems.push(`screen name ${JSON.stringify(screen?.name ?? null)} must be 1 to 64 letters, digits, dot, dash or underscore: it becomes a file name`);
    }
  }
  for (const locale of locales) {
    const code = typeof locale === "string" ? locale : locale?.code;
    if (!SAFE_NAME.test(String(code ?? ""))) problems.push(`locale ${JSON.stringify(code ?? null)} is not a usable directory name`);
  }
  return problems;
};

const normaliseLocales = (manifest) => {
  const locales = asArray(manifest?.locales);
  if (locales.length === 0) return [{ code: "default", actions: [] }];
  return locales.map((locale) =>
    typeof locale === "string"
      ? { code: locale, actions: [] }
      : { code: locale.code, actions: asArray(locale.action ? { name: locale.action, args: locale.args } : locale.actions) });
};

/**
 * Runs the steps that put the app where the screenshot should be taken.
 *
 * Dev actions rather than taps: `nav:cart` lands on the cart in one call
 * and cannot break because a button moved. `waitFor` is an event, not a
 * duration, because a sleep long enough for a slow machine is wasted on
 * every fast one, and a sleep short enough is a blank screenshot.
 */
const reachScreen = async (steps, screen, helpers) => {
  const taken = [];
  for (const step of steps) {
    if (!step?.name) continue;
    const result = await helpers.runAction(step.name, step.args ?? {});
    taken.push({ action: step.name, ok: result?.ok !== false });
  }
  if (screen?.waitFor) {
    const wait = typeof screen.waitFor === "string" ? { type: screen.waitFor } : screen.waitFor;
    const outcome = await helpers.waitForEvent({
      type: wait.type,
      payloadContains: wait.payloadContains,
      timeoutMs: Math.min(Math.max(Number(wait.timeoutMs) || 15000, 500), 120000),
    });
    taken.push({ waitFor: wait.type ?? wait.payloadContains, timedOut: outcome?.timedOut === true });
  }
  if (screen?.waitForUi) {
    const found = await helpers.queryUi({ ...screen.waitForUi, timeoutMs: screen.waitForUi.timeoutMs ?? 10000 });
    taken.push({ waitForUi: screen.waitForUi.value ?? null, matched: (found?.count ?? 0) > 0 });
  }
  return taken;
};

/**
 * Devices x locales x screens, captured to disk.
 *
 * A step that fails does not stop the run: the report says which shot is
 * missing and why, because losing eleven good captures to one broken
 * screen is worse than a report with a hole in it.
 */
export const captureStoreScreenshots = async (args, helpers) => {
  const { manifest, from } = readManifest(helpers.projectRoot, args.manifest);
  const problems = validateManifest(manifest);
  if (problems.length) throw new Error(`The screenshot manifest is not usable:\n- ${problems.join("\n- ")}`);

  const devices = asArray(manifest.devices).filter((device) =>
    !args.device || device.label === args.device || device.target === args.device);
  if (devices.length === 0) throw new Error(`No device ${JSON.stringify(args.device)} in the manifest`);

  const locales = normaliseLocales(manifest).filter((locale) => !args.locale || locale.code === args.locale);
  if (locales.length === 0) throw new Error(`No locale ${JSON.stringify(args.locale)} in the manifest`);

  const screens = asArray(manifest.screens).filter((screen) => !args.screen || screen.name === args.screen);
  if (screens.length === 0) throw new Error(`No screen ${JSON.stringify(args.screen)} in the manifest`);

  const outputRoot = join(helpers.projectRoot, manifest.output ?? DEFAULT_OUTPUT);
  const shots = [];
  const failures = [];

  for (const device of devices) {
    for (const locale of locales) {
      // The setup runs once per device and locale, not per screen: an
      // account and a frozen clock are the same for the whole set
      const setup = await reachScreen([...asArray(manifest.before), ...locale.actions], null, helpers);

      for (const screen of screens) {
        const label = `${device.label}/${locale.code}/${screen.name}`;
        try {
          const steps = [
            ...(screen.action ? [{ name: screen.action, args: screen.args }] : []),
            ...asArray(screen.actions),
          ];
          const trace = await reachScreen(steps, screen, helpers);
          const image = await helpers.screenshot({ target: device.target });
          const bytes = Buffer.from(image.__mcpImage.data, "base64");
          const decoded = helpers.decodePng(bytes);

          const directory = join(outputRoot, device.label, locale.code);
          mkdirSync(directory, { recursive: true });
          const file = join(directory, `${screen.name}.png`);
          writeFileSync(file, bytes);

          shots.push({
            device: device.label,
            target: device.target,
            locale: locale.code,
            screen: screen.name,
            file,
            width: decoded.width,
            height: decoded.height,
            bytes: bytes.length,
            appleDisplayType: appleDisplayType(decoded),
            playImageType: playImageType(decoded),
            trace,
          });
        } catch (error) {
          failures.push({ shot: label, error: String(error?.message ?? error) });
        }
      }
      setup.length = 0;
    }
  }

  const unknown = shots.filter((shot) => !shot.appleDisplayType && /^sim:/.test(shot.target));
  const index = {
    takenAt: Date.now(),
    manifestFrom: from,
    output: outputRoot,
    shots: shots.map(({ trace, ...rest }) => rest),
  };
  mkdirSync(outputRoot, { recursive: true });
  writeFileSync(join(outputRoot, INDEX_FILE), `${JSON.stringify(index, null, 2)}\n`);

  return {
    ok: failures.length === 0,
    output: outputRoot,
    index: join(outputRoot, INDEX_FILE),
    count: shots.length,
    shots,
    failures,
    // Named rather than silently uploaded later as the wrong device class
    unrecognisedSizes: unknown.map((shot) => ({ file: shot.file, size: `${shot.width}x${shot.height}` })),
    note: unknown.length
      ? `${unknown.length} capture(s) are not a size the App Store table knows (${APPLE_SIZES.map((entry) => entry.size).join(", ")}). Capture on a simulator of the right device class, or pass displayType explicitly when uploading.`
      : null,
    next: "asc_upload_screenshots and gplay_upload_screenshots read this index.",
  };
};

/** The index a capture wrote, which the upload tools read back */
export const readIndex = (projectRoot, given) => {
  const path = given
    ? (given.endsWith(".json") ? given : join(given, INDEX_FILE))
    : join(projectRoot, DEFAULT_OUTPUT, INDEX_FILE);
  const full = path.startsWith("/") ? path : join(projectRoot, path);
  if (!existsSync(full)) {
    throw new Error(`No capture index at ${full}: run capture_store_screenshots first, or pass the directory it wrote.`);
  }
  try {
    const index = JSON.parse(readFileSync(full, "utf-8"));
    if (!Array.isArray(index?.shots) || index.shots.length === 0) throw new Error("it lists no screenshot");
    return { ...index, path: full };
  } catch (error) {
    throw new Error(`The capture index at ${full} is not usable: ${error?.message ?? error}`);
  }
};

export const STORE_SHOT_TOOL = {
  name: "capture_store_screenshots",
  description:
    "Captures the App Store and Play Store screenshots from the running app, driven by a manifest (devices from list_targets, locales, screens). Each screen is reached with the app's own dev actions (nav:*, seed:*, auth:*) and waited on with an event rather than a sleep, so the same set can be regenerated identically next release. Files are written to disk at the device's native resolution and NOTHING is resized: the answer is a manifest of paths and sizes, never the images, so this costs no context. Reports the sizes it does not recognise instead of uploading them as the wrong device class. Upload with asc_upload_screenshots and gplay_upload_screenshots.",
  inputSchema: {
    type: "object",
    properties: {
      deviceId: { type: "string" },
      manifest: { type: "object", description: `The manifest itself; read from ${MANIFEST_FILE} when absent` },
      device: { type: "string", description: "Only this device label or target from the manifest" },
      locale: { type: "string", description: "Only this locale from the manifest" },
      screen: { type: "string", description: "Only this screen from the manifest, to iterate on one" },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
};
