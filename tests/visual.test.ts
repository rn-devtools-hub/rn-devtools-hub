import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error untyped hub module
import * as pngModule from "../server/png.mjs";
// @ts-expect-error untyped hub module
import * as visualModule from "../server/visual.mjs";

interface Decoded {
  width: number;
  height: number;
  data: Uint8Array;
}

interface Diff {
  comparable: boolean;
  reason?: string;
  width?: number;
  height?: number;
  changedPixels: number | null;
  ratio: number | null;
  bbox: { x: number; y: number; width: number; height: number } | null;
  image?: Buffer | null;
}

const { decodePng, encodePng, diffImages } = pngModule as {
  decodePng: (bytes: Uint8Array | Buffer) => Decoded;
  encodePng: (width: number, height: number, rgba: Uint8Array) => Buffer;
  diffImages: (a: Decoded, b: Decoded, options?: Record<string, unknown>) => Diff;
};

const { centreInPoints, changesSince, explainDiff } = visualModule as {
  centreInPoints: (
    bbox: unknown,
    imageWidth: number,
    screenWidthPoints: number
  ) => { x: number; y: number; scale: number } | null;
  changesSince: (events: unknown[], sinceTs: number) => Array<Record<string, unknown>>;
  explainDiff: (diff: Diff, context?: Record<string, unknown>) => Promise<Record<string, any>>;
};

const solid = (width: number, height: number, colour: [number, number, number]): Uint8Array => {
  const data = new Uint8Array(width * height * 4);
  for (let index = 0; index < data.length; index += 4) {
    data[index] = colour[0];
    data[index + 1] = colour[1];
    data[index + 2] = colour[2];
    data[index + 3] = 255;
  }
  return data;
};

const withRect = (
  width: number,
  height: number,
  base: [number, number, number],
  rect: { x: number; y: number; w: number; h: number },
  colour: [number, number, number]
): Uint8Array => {
  const data = solid(width, height, base);
  for (let y = rect.y; y < rect.y + rect.h; y += 1) {
    for (let x = rect.x; x < rect.x + rect.w; x += 1) {
      const index = (y * width + x) * 4;
      data[index] = colour[0];
      data[index + 1] = colour[1];
      data[index + 2] = colour[2];
    }
  }
  return data;
};

describe("PNG round trip without a dependency", () => {
  it("decodes what it encoded, pixel for pixel", () => {
    const source = withRect(16, 12, [10, 20, 30], { x: 4, y: 3, w: 5, h: 4 }, [200, 100, 50]);
    const decoded = decodePng(encodePng(16, 12, source));
    expect(decoded.width).toBe(16);
    expect(decoded.height).toBe(12);
    expect(Array.from(decoded.data)).toEqual(Array.from(source));
  });

  it("survives a single-pixel image", () => {
    const decoded = decodePng(encodePng(1, 1, solid(1, 1, [7, 8, 9])));
    expect(Array.from(decoded.data)).toEqual([7, 8, 9, 255]);
  });

  // A round trip through our own encoder would pass even if both halves
  // were wrong in the same way. This decodes a PNG written by another
  // tool, exercising the adaptive scanline filters real encoders emit.
  it("decodes a PNG produced by another encoder", () => {
    const decoded = decodePng(readFileSync("assets/screenshots/overview.png"));
    expect(decoded.width).toBe(1620);
    expect(decoded.height).toBe(802);

    let sameAsLeft = 0;
    let total = 0;
    for (let y = 0; y < decoded.height; y += 1) {
      for (let x = 1; x < decoded.width; x += 1) {
        const index = (y * decoded.width + x) * 4;
        const left = index - 4;
        if (
          decoded.data[index] === decoded.data[left] &&
          decoded.data[index + 1] === decoded.data[left + 1] &&
          decoded.data[index + 2] === decoded.data[left + 2]
        ) {
          sameAsLeft += 1;
        }
        total += 1;
      }
    }
    // A screenshot of a UI is mostly flat colour; mis-applied filters
    // would produce noise and drive this near zero
    expect(sameAsLeft / total).toBeGreaterThan(0.5);
  });

  // Baselines live in the host project, so the bytes are not always ours.
  // A header can claim any dimensions and inflate can expand a tiny chunk
  // into gigabytes.
  it("refuses dimensions that would allocate gigabytes", () => {
    const png = encodePng(2, 2, solid(2, 2, [0, 0, 0]));
    png.writeUInt32BE(40000, 16); // width in IHDR
    png.writeUInt32BE(40000, 20); // height
    expect(() => decodePng(png)).toThrow(/pixel ceiling/);
  });

  it("rejects anything that is not a PNG with a clear message", () => {
    expect(() => decodePng(Buffer.from("not an image"))).toThrow(/Not a PNG/);
  });

  it("names the unsupported feature rather than returning wrong pixels", () => {
    const png = encodePng(2, 2, solid(2, 2, [0, 0, 0]));
    png[24] = 16; // bit depth in IHDR
    expect(() => decodePng(png)).toThrow(/8-bit/);
  });
});

describe("diffImages", () => {
  const before = { width: 20, height: 20, data: solid(20, 20, [255, 255, 255]) };

  it("finds nothing between an image and itself", () => {
    const diff = diffImages(before, before);
    expect(diff.changedPixels).toBe(0);
    expect(diff.ratio).toBe(0);
    expect(diff.bbox).toBeNull();
  });

  it("bounds the changed region, which is what makes the diff explainable", () => {
    const after = {
      width: 20,
      height: 20,
      data: withRect(20, 20, [255, 255, 255], { x: 5, y: 6, w: 4, h: 3 }, [0, 0, 0]),
    };
    const diff = diffImages(before, after);
    expect(diff.changedPixels).toBe(12);
    expect(diff.bbox).toEqual({ x: 5, y: 6, width: 4, height: 3 });
  });

  it("refuses to compare different dimensions instead of guessing", () => {
    const diff = diffImages(before, { width: 10, height: 20, data: solid(10, 20, [255, 255, 255]) });
    expect(diff.comparable).toBe(false);
    expect(diff.reason).toContain("20x20");
  });

  it("ignores a change below the threshold", () => {
    const after = { width: 20, height: 20, data: solid(20, 20, [252, 252, 252]) };
    expect(diffImages(before, after, { threshold: 8 }).changedPixels).toBe(0);
    expect(diffImages(before, after, { threshold: 1 }).changedPixels).toBe(400);
  });

  it("returns a decodable diff image on request", () => {
    const after = {
      width: 20,
      height: 20,
      data: withRect(20, 20, [255, 255, 255], { x: 1, y: 1, w: 2, h: 2 }, [0, 0, 0]),
    };
    const diff = diffImages(before, after, { withImage: true });
    const decoded = decodePng(diff.image as Buffer);
    expect(decoded.width).toBe(20);
    // changed pixels are marked red
    const index = (1 * 20 + 1) * 4;
    expect([decoded.data[index], decoded.data[index + 1], decoded.data[index + 2]]).toEqual([255, 0, 0]);
  });
});

describe("centreInPoints", () => {
  it("converts device pixels back to the points the runtime measures in", () => {
    const point = centreInPoints({ x: 100, y: 200, width: 40, height: 20 }, 1170, 390);
    expect(point?.scale).toBe(3);
    expect(point?.x).toBeCloseTo(40);
    expect(point?.y).toBeCloseTo(70);
  });

  it("falls back to a scale of 1 when the screen width is unknown", () => {
    expect(centreInPoints({ x: 0, y: 0, width: 10, height: 10 }, 100, 0)?.scale).toBe(1);
  });

  it("returns null without a region", () => {
    expect(centreInPoints(null, 100, 100)).toBeNull();
  });
});

describe("changesSince", () => {
  const events = [
    { type: "ui.change", ts: 50, payload: { generation: 1 } },
    { type: "console", ts: 150, payload: {} },
    { type: "network.response", ts: 200, payload: { requestId: 4, status: 200 } },
    { type: "screen.ready", ts: 250, payload: { screen: "Orders" } },
  ];

  it("keeps only the change-bearing events after the baseline", () => {
    expect(changesSince(events, 100).map((entry) => entry.type)).toEqual([
      "network.response",
      "screen.ready",
    ]);
  });

  it("summarizes a response by its request and status", () => {
    expect(changesSince(events, 100)[0].detail).toBe("#4 200");
  });
});

describe("explainDiff", () => {
  const diff = (ratio: number): Diff => ({
    comparable: true,
    width: 100,
    height: 100,
    changedPixels: Math.round(ratio * 10000),
    ratio,
    bbox: { x: 10, y: 10, width: 20, height: 20 },
  });

  it("passes below the threshold without calling the runtime", async () => {
    let called = false;
    const result = await explainDiff(diff(0.0005), {
      hitTest: async () => {
        called = true;
        return null;
      },
    });
    expect(result.ok).toBe(true);
    expect(called).toBe(false);
  });

  it("names the component that owns the changed region", async () => {
    const result = await explainDiff(diff(0.04), {
      screenWidthPoints: 100,
      changes: [{ type: "network.response", detail: "#1 200" }],
      hitTest: async () => ({
        deepest: { type: "View", testID: "card", source: { file: "src/ServiceCard.tsx", line: 42 } },
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.owner.source.file).toBe("src/ServiceCard.tsx");
    expect(result.explanation).toContain("src/ServiceCard.tsx:42");
    expect(result.explanation).toContain("network.response");
  });

  it("still reports the diff when the runtime cannot be reached", async () => {
    const result = await explainDiff(diff(0.04), {
      hitTest: async () => {
        throw new Error("device gone");
      },
    });
    expect(result.ok).toBe(false);
    expect(result.owner).toBeNull();
    expect(result.explanation).toContain("no component could be attributed");
  });

  it("says the change predates the baseline when the bus recorded nothing", async () => {
    const result = await explainDiff(diff(0.04), { changes: [] });
    expect(result.explanation).toContain("predates it");
  });

  it("explains a size change instead of reporting a meaningless ratio", async () => {
    const result = await explainDiff({
      comparable: false,
      reason: "Different dimensions: baseline 100x200, current 100x300",
      changedPixels: null,
      ratio: null,
      bbox: null,
    });
    expect(result.comparable).toBe(false);
    expect(result.hint).toContain("Re-take the baseline");
  });
});
