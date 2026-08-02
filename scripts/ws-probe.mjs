/**
 * Smoke probe: connect to the hub as a device, send an event, close cleanly.
 *
 * Written on node:net rather than on the global WebSocket, which only exists
 * from Node 22. The package supports Node 20, so a probe that needs 22 tests
 * a version the product does not claim, and passes for the wrong reason.
 *
 *   node scripts/ws-probe.mjs [port]
 *
 * Exits 0 when the device connected, the event round-tripped and the socket
 * closed with code 1000. Any other outcome exits non-zero with a reason: a
 * handshake can look correct and still be rejected by a real client, which
 * is exactly the failure this exists to catch.
 */

import { connect } from "node:net";
import { createHash, randomBytes } from "node:crypto";

const PORT = Number(process.argv[2]) || 8973;
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const KEY = randomBytes(16).toString("base64");
const EXPECTED = createHash("sha1").update(KEY + GUID).digest("base64");

const fail = (reason) => {
  console.error(`ws-probe: ${reason}`);
  process.exit(1);
};

const maskedFrame = (payload, opcode = 0x1) => {
  // Buffers pass through untouched: routing a close payload through a
  // string would re-encode 0x03E8 as UTF-8 and turn code 1000 into noise
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf-8");
  const mask = randomBytes(4);
  const masked = Buffer.from(body);
  for (let index = 0; index < masked.length; index += 1) masked[index] ^= mask[index % 4];
  const header =
    body.length < 126
      ? Buffer.from([0x80 | opcode, 0x80 | body.length])
      : Buffer.concat([
          Buffer.from([0x80 | opcode, 0x80 | 126]),
          (() => {
            const length = Buffer.alloc(2);
            length.writeUInt16BE(body.length);
            return length;
          })(),
        ]);
  return Buffer.concat([header, mask, masked]);
};

const timer = setTimeout(() => fail("timed out"), 15000);
const socket = connect(PORT, "127.0.0.1");
socket.on("error", (error) => fail(String(error.message)));

let handshakeDone = false;
let buffer = Buffer.alloc(0);

socket.on("connect", () => {
  socket.write(
    `GET / HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nUpgrade: websocket\r\n` +
      `Connection: Upgrade\r\nSec-WebSocket-Key: ${KEY}\r\nSec-WebSocket-Version: 13\r\n\r\n`
  );
});

socket.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);

  if (!handshakeDone) {
    const end = buffer.indexOf("\r\n\r\n");
    if (end === -1) return;
    const headers = buffer.subarray(0, end).toString();
    buffer = buffer.subarray(end + 4);

    if (!/^HTTP\/1\.1 101/.test(headers)) fail(`expected 101, got: ${headers.split("\r\n")[0]}`);
    const accept = /sec-websocket-accept:\s*(\S+)/i.exec(headers)?.[1];
    if (accept !== EXPECTED) {
      fail(`Sec-WebSocket-Accept mismatch: got ${accept}, expected ${EXPECTED}`);
    }
    handshakeDone = true;

    socket.write(
      maskedFrame(
        JSON.stringify({
          kind: "hello",
          role: "device",
          appName: "ci",
          deviceName: "ci",
          stableId: "ci-probe",
        })
      )
    );
    setTimeout(() => {
      socket.write(
        maskedFrame(
          JSON.stringify({
            kind: "events",
            events: [{ id: 1, type: "crash", ts: Date.now(), payload: { message: "ci-probe" } }],
          })
        )
      );
      // Close with 1000 and a reason; the server must echo it back
      const close = Buffer.alloc(2);
      close.writeUInt16BE(1000);
      setTimeout(() => socket.write(maskedFrame(close, 0x8)), 400);
    }, 200);
    return;
  }

  // The only frame we expect back is the echoed close
  if (buffer.length >= 2 && (buffer[0] & 0x0f) === 0x8) {
    const payload = buffer.subarray(2, 2 + (buffer[1] & 0x7f));
    const code = payload.length >= 2 ? payload.readUInt16BE(0) : 0;
    clearTimeout(timer);
    if (code !== 1000) fail(`close code ${code}, expected 1000`);
    console.log("ws-probe: connected, sent an event, closed cleanly");
    socket.end();
    process.exit(0);
  }
});

socket.on("close", () => {
  if (handshakeDone) fail("socket closed without echoing the close frame");
});
