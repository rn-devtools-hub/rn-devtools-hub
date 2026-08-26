/**
 * Store screenshots.
 *
 * The value of this loop is that it produces the SAME set twice, so what
 * is asserted is the reproducible part: the app is put in the right state
 * before each capture, a screen that fails does not take the other eleven
 * down with it, nothing is resized, and a size no store recognises is
 * reported rather than uploaded as the wrong device class.
 *
 * No device and no PNG decoder here: the loop takes both as helpers,
 * which is also how it stays testable.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";
// @ts-expect-error plain JS module, no types
import { appleDisplayType, captureStoreScreenshots, playImageType, readIndex, readManifest, validateManifest } from "../server/storeshots.mjs";

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rn-devtools-shots-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const manifest = {
  devices: [{ target: "sim:UDID", label: "iphone-67" }],
  locales: ["en-US", "fr-FR"],
  before: [{ name: "auth:demo" }],
  screens: [
    { name: "01-home", action: "nav:home", waitFor: "screen.ready" },
    { name: "02-cart", actions: [{ name: "seed:cart" }, { name: "nav:cart" }], waitFor: { type: "screen.ready", timeoutMs: 5000 } },
  ],
};

/** A device that always answers, and remembers what it was asked */
const fakeDevice = (overrides: Record<string, unknown> = {}) => {
  const calls: string[] = [];
  return {
    calls,
    helpers: {
      projectRoot: root,
      decodePng: () => ({ width: 1290, height: 2796 }),
      screenshot: async ({ target }: any) => {
        calls.push(`shot:${target}`);
        return { __mcpImage: { data: Buffer.from("PNGBYTES").toString("base64"), mimeType: "image/png" } };
      },
      runAction: async (name: string) => { calls.push(`action:${name}`); return { ok: true }; },
      queryUi: async () => ({ count: 1, matches: [{}] }),
      waitForEvent: async ({ type }: any) => { calls.push(`wait:${type}`); return { timedOut: false }; },
      ...overrides,
    },
  };
};

describe("size tables", () => {
  it("maps a capture to the App Store display type Apple actually declares", () => {
    expect(appleDisplayType({ width: 1290, height: 2796 })).toBe("APP_IPHONE_67");
    expect(appleDisplayType({ width: 2048, height: 2732 })).toBe("APP_IPAD_PRO_3GEN_129");
    // A landscape capture is the same device turned over
    expect(appleDisplayType({ width: 2796, height: 1290 })).toBe("APP_IPHONE_67");
    expect(appleDisplayType({ width: 800, height: 600 })).toBeNull();
  });

  it("sorts a Play capture by its shortest side, which is how Play sorts them", () => {
    expect(playImageType({ width: 1080, height: 2400 })).toBe("phoneScreenshots");
    expect(playImageType({ width: 1200, height: 1920 })).toBe("sevenInchScreenshots");
    expect(playImageType({ width: 1600, height: 2560 })).toBe("tenInchScreenshots");
  });
});

describe("the manifest", () => {
  it("refuses names that would escape the output directory", () => {
    // The label and the screen name become a directory and a file name
    const problems = validateManifest({
      devices: [{ target: "sim:1", label: "../../etc" }],
      screens: [{ name: "a/b" }],
    });
    expect(problems.join(" ")).toMatch(/device label/);
    expect(problems.join(" ")).toMatch(/screen name/);
  });

  it("says what an empty manifest is missing", () => {
    const problems = validateManifest({});
    expect(problems.join(" ")).toMatch(/devices is empty/);
    expect(problems.join(" ")).toMatch(/screens is empty/);
  });

  it("reads the project's manifest, and points at it when there is none", () => {
    expect(() => readManifest(root, null)).toThrow(/No screenshot manifest/);
    mkdirSync(join(root, ".rn-devtools"), { recursive: true });
    writeFileSync(join(root, ".rn-devtools", "store-screenshots.json"), JSON.stringify(manifest));
    expect(readManifest(root, null).manifest.devices[0].label).toBe("iphone-67");
  });
});

describe("capturing", () => {
  it("walks devices, locales and screens, and writes every file to disk", async () => {
    const device = fakeDevice();
    const result: any = await captureStoreScreenshots({ manifest }, device.helpers);

    expect(result.ok).toBe(true);
    expect(result.count).toBe(4);
    for (const shot of result.shots) {
      expect(existsSync(shot.file)).toBe(true);
      expect(readFileSync(shot.file, "utf-8")).toBe("PNGBYTES");
      expect(shot.appleDisplayType).toBe("APP_IPHONE_67");
    }
    expect(result.shots.map((shot: any) => `${shot.locale}/${shot.screen}`)).toEqual([
      "en-US/01-home", "en-US/02-cart", "fr-FR/01-home", "fr-FR/02-cart",
    ]);
  });

  it("never puts a pixel in the answer", async () => {
    // The whole point: the files are on disk and the answer is paths
    const result = await captureStoreScreenshots({ manifest }, fakeDevice().helpers);
    expect(JSON.stringify(result)).not.toContain(Buffer.from("PNGBYTES").toString("base64"));
  });

  it("runs the setup once per locale and the screen steps before each capture", async () => {
    const device = fakeDevice();
    await captureStoreScreenshots({ manifest, locale: "en-US" }, device.helpers);
    expect(device.calls).toEqual([
      "action:auth:demo",
      "action:nav:home", "wait:screen.ready", "shot:sim:UDID",
      "action:seed:cart", "action:nav:cart", "wait:screen.ready", "shot:sim:UDID",
    ]);
  });

  it("writes an index the upload tools can read back", async () => {
    const result: any = await captureStoreScreenshots({ manifest }, fakeDevice().helpers);
    const index = readIndex(root, result.output);
    expect(index.shots.length).toBe(4);
    expect(index.shots[0]).toMatchObject({ device: "iphone-67", width: 1290, height: 2796 });
    // The trace of how each screen was reached stays out of the index
    expect(index.shots[0].trace).toBeUndefined();
  });

  it("keeps the good captures when one screen fails", async () => {
    let calls = 0;
    const device = fakeDevice({
      runAction: async (name: string) => {
        calls += 1;
        if (name === "nav:cart") throw new Error("no such action");
        return { ok: true };
      },
    });
    const result: any = await captureStoreScreenshots({ manifest, locale: "en-US" }, device.helpers);
    expect(result.ok).toBe(false);
    expect(result.count).toBe(1);
    expect(result.failures[0]).toMatchObject({ shot: "iphone-67/en-US/02-cart" });
    expect(result.failures[0].error).toMatch(/no such action/);
    expect(calls).toBeGreaterThan(0);
  });

  it("names a size no store recognises instead of shipping it as another device", async () => {
    const device = fakeDevice({ decodePng: () => ({ width: 640, height: 480 }) });
    const result: any = await captureStoreScreenshots({ manifest, locale: "en-US", screen: "01-home" }, device.helpers);
    expect(result.unrecognisedSizes[0].size).toBe("640x480");
    expect(result.note).toMatch(/not a size the App Store table knows/);
  });

  it("narrows to one device, locale or screen so a set can be iterated on", async () => {
    const result: any = await captureStoreScreenshots(
      { manifest, locale: "fr-FR", screen: "02-cart" },
      fakeDevice().helpers,
    );
    expect(result.count).toBe(1);
    expect(result.shots[0]).toMatchObject({ locale: "fr-FR", screen: "02-cart" });
    await expect(captureStoreScreenshots({ manifest, device: "pixel" }, fakeDevice().helpers))
      .rejects.toThrow(/No device/);
  });

  it("refuses a manifest that would write outside the output directory", async () => {
    await expect(captureStoreScreenshots(
      { manifest: { devices: [{ target: "sim:1", label: "../escape" }], screens: [{ name: "home" }] } },
      fakeDevice().helpers,
    )).rejects.toThrow(/not usable/);
  });

  it("points at the capture step when no index exists yet", () => {
    expect(() => readIndex(root, undefined)).toThrow(/run capture_store_screenshots first/);
  });
});
