import { describe, expect, it } from "vitest";
// @ts-expect-error untyped hub module
import * as runtime from "../server/runtime.mjs";

const { acceptKey, encodeFrame, decodeFrames, which } = runtime as {
  acceptKey: (key: string) => string;
  encodeFrame: (payload: string | Buffer, opcode?: number) => Buffer;
  decodeFrames: (buffer: Buffer) => {
    frames: Array<{ fin: boolean; opcode: number; payload: Buffer }>;
    rest: Buffer;
  };
  which: (command: string) => string | null;
};

/** A client frame is masked; the server never masks its own */
const clientFrame = (text: string, opcode = 0x1, fin = true): Buffer => {
  const body = Buffer.from(text, "utf-8");
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const masked = Buffer.from(body);
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];
  const header =
    body.length < 126
      ? Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | body.length])
      : Buffer.concat([
          Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | 126]),
          (() => {
            const b = Buffer.alloc(2);
            b.writeUInt16BE(body.length);
            return b;
          })(),
        ]);
  return Buffer.concat([header, mask, masked]);
};

describe("acceptKey", () => {
  /**
   * The value that matters, checked against a reference implementation.
   * A transposed character in the RFC GUID yields a same-length, plausible
   * string, a handshake the server believes it completed, and a client that
   * drops the connection with 1006 and no diagnostic whatsoever.
   */
  it("matches the RFC 6455 example", () => {
    expect(acceptKey("dGhlIHNhbXBsZSBub25jZQ==")).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  });

  it("is stable and key-dependent", () => {
    expect(acceptKey("abc")).toBe(acceptKey("abc"));
    expect(acceptKey("abc")).not.toBe(acceptKey("abd"));
  });
});

describe("frame encoding", () => {
  it("marks FIN and the text opcode, and never masks", () => {
    const frame = encodeFrame("hi");
    expect(frame[0]).toBe(0x81);
    expect(frame[1] & 0x80).toBe(0); // unmasked
    expect(frame[1] & 0x7f).toBe(2);
  });

  it("switches to a 16-bit length past 125 bytes", () => {
    const frame = encodeFrame("x".repeat(200));
    expect(frame[1] & 0x7f).toBe(126);
    expect(frame.readUInt16BE(2)).toBe(200);
  });

  it("switches to a 64-bit length past 65535 bytes", () => {
    const frame = encodeFrame("x".repeat(70000));
    expect(frame[1] & 0x7f).toBe(127);
    expect(frame.readUInt32BE(6)).toBe(70000);
  });

  it("measures bytes, not characters", () => {
    // Three-byte characters: a length in characters would under-read
    const frame = encodeFrame("日本語");
    expect(frame[1] & 0x7f).toBe(9);
  });
});

describe("frame decoding", () => {
  it("unmasks a client frame", () => {
    const { frames, rest } = decodeFrames(clientFrame("hello"));
    expect(frames).toHaveLength(1);
    expect(frames[0].payload.toString()).toBe("hello");
    expect(rest.length).toBe(0);
  });

  it("reads several frames out of one chunk", () => {
    const { frames } = decodeFrames(Buffer.concat([clientFrame("a"), clientFrame("b")]));
    expect(frames.map((f) => f.payload.toString())).toEqual(["a", "b"]);
  });

  it("keeps a partial frame for the next chunk instead of misreading it", () => {
    const whole = clientFrame("hello");
    const first = decodeFrames(whole.subarray(0, 6));
    expect(first.frames).toHaveLength(0);
    expect(first.rest.length).toBe(6);

    const second = decodeFrames(Buffer.concat([first.rest, whole.subarray(6)]));
    expect(second.frames[0].payload.toString()).toBe("hello");
  });

  it("stops before a header it has not fully received", () => {
    expect(decodeFrames(Buffer.from([0x81])).frames).toHaveLength(0);
  });

  it("reports FIN so continuation frames can be joined", () => {
    const { frames } = decodeFrames(
      Buffer.concat([clientFrame("par", 0x1, false), clientFrame("tie", 0x0, true)])
    );
    expect(frames.map((f) => f.fin)).toEqual([false, true]);
    expect(Buffer.concat(frames.map((f) => f.payload)).toString()).toBe("partie");
  });

  it("surfaces control opcodes", () => {
    expect(decodeFrames(clientFrame("", 0x9)).frames[0].opcode).toBe(0x9);
    expect(decodeFrames(clientFrame("", 0x8)).frames[0].opcode).toBe(0x8);
  });

  it("round-trips a 16-bit length payload", () => {
    const text = "x".repeat(300);
    expect(decodeFrames(clientFrame(text)).frames[0].payload.toString()).toBe(text);
  });
});

describe("which", () => {
  it("finds a command that exists on PATH", () => {
    expect(which("node")).toContain("node");
  });

  it("returns null for a command that does not", () => {
    expect(which("definitely-not-a-real-binary-xyz")).toBeNull();
  });
});
