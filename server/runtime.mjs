/**
 * Runtime compatibility: the hub on Bun or on Node.
 *
 * Requiring Bun to start the hub is a real barrier on a product whose main
 * argument is the absence of friction. Three Bun APIs stood in the way:
 * Bun.which, Bun.spawn and Bun.serve.
 *
 * The first two have direct Node equivalents. The third does not: Node has
 * a WebSocket CLIENT but no server, so the handshake and the framing are
 * implemented here, against RFC 6455. Roughly two hundred lines, versus
 * adding `ws` and contradicting the zero-dependency promise printed on the
 * box. The framing is pure and unit-tested; the socket handling is covered
 * by the hub smoke test on both runtimes.
 *
 * Only what the hub actually uses is implemented: text frames, close,
 * ping/pong and continuation. No extensions, no compression.
 */

import { createHash } from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import { createServer } from "node:http";
import { accessSync, constants } from "node:fs";
import { join, delimiter } from "node:path";

export const isBun = typeof globalThis.Bun !== "undefined";

// ====================================================================
// which
// ====================================================================

export const which = (command) => {
  if (isBun) return globalThis.Bun.which(command);
  const paths = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const directory of paths) {
    const candidate = join(directory, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here, keep looking
    }
  }
  return null;
};

// ====================================================================
// spawn
// ====================================================================

/**
 * Normalizes to the shape the hub already uses: `.stdout`, `.stderr`,
 * `.exited` and `.kill()`. On Node the streams are async iterables of
 * Buffers, which is what the callers consume.
 */
export const spawn = (argv, options = {}) => {
  if (isBun) return globalThis.Bun.spawn(argv, options);

  const [command, ...args] = argv;
  const child = nodeSpawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: [options.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
  });

  if (options.stdin !== undefined && child.stdin) {
    child.stdin.end(options.stdin);
  }

  return {
    stdout: child.stdout,
    stderr: child.stderr,
    exited: new Promise((resolve) => {
      child.on("close", (code) => resolve(code ?? 0));
      // A command that cannot be spawned at all still has to settle
      child.on("error", () => resolve(127));
    }),
    kill: (signal) => child.kill(signal),
  };
};

// ====================================================================
// WebSocket framing (RFC 6455), server side
// ====================================================================

// RFC 6455 §1.3. Taken from a reference implementation rather than from
// memory: a transposed character here produces a same-length, plausible
// string, a handshake the server believes it completed, and a client that
// drops the connection with 1006 and no diagnostic.
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export const acceptKey = (key) =>
  createHash("sha1").update(String(key) + GUID).digest("base64");

/** Server frames are never masked; only text and close are ever sent */
export const encodeFrame = (payload, opcode = 0x1) => {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf-8");
  const length = body.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    // 64-bit length: the high word is always zero at any size we send
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(length, 6);
  }
  header[0] = 0x80 | opcode; // FIN
  return Buffer.concat([header, body]);
};

/**
 * Pulls whole frames out of a buffer, returning what is left over.
 * A partial frame is normal: TCP splits wherever it likes.
 */
export const decodeFrames = (buffer) => {
  const frames = [];
  let offset = 0;
  for (;;) {
    if (buffer.length - offset < 2) break;
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let cursor = offset + 2;

    if (length === 126) {
      if (buffer.length - cursor < 2) break;
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (buffer.length - cursor < 8) break;
      // Anything above 2^32 is not a payload this hub will ever receive
      length = Number(buffer.readBigUInt64BE(cursor));
      cursor += 8;
    }

    let mask = null;
    if (masked) {
      if (buffer.length - cursor < 4) break;
      mask = buffer.subarray(cursor, cursor + 4);
      cursor += 4;
    }
    if (buffer.length - cursor < length) break;

    const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
    if (mask) {
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= mask[index % 4];
      }
    }
    frames.push({ fin, opcode, payload });
    offset = cursor + length;
  }
  return { frames, rest: buffer.subarray(offset) };
};

const OPCODES = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa };

/** Wraps a raw socket in the small surface the hub expects of a
 * connection: send, close, readyState and a free-form `data` bag. */
const createConnection = (socket, data) => {
  const connection = {
    data,
    readyState: 1,
    send(message) {
      if (connection.readyState !== 1) return;
      socket.write(encodeFrame(message, OPCODES.text));
    },
    close(code = 1000, reason = "") {
      if (connection.readyState !== 1) return;
      connection.readyState = 3;
      const body = Buffer.alloc(2 + Buffer.byteLength(reason));
      body.writeUInt16BE(code, 0);
      body.write(reason, 2);
      try {
        socket.write(encodeFrame(body, OPCODES.close));
      } catch {
        // socket already gone
      }
      socket.end();
    },
  };
  return connection;
};

/**
 * Bun.serve, or the same contract on Node.
 *
 * The hub calls `server.upgrade(request)` inside `fetch`. On Node upgrades
 * never reach the request handler, so the shim answers false there and
 * handles them on the http server's own 'upgrade' event instead, with the
 * same initial `data`.
 */
export const serve = ({ port, idleTimeout, fetch: handleRequest, websocket }) => {
  if (isBun) {
    return globalThis.Bun.serve({ port, idleTimeout, fetch: handleRequest, websocket });
  }

  const addresses = new WeakMap();

  const server = createServer(async (incoming, response) => {
    const url = `http://${incoming.headers.host ?? "localhost"}${incoming.url}`;
    const body = ["GET", "HEAD"].includes(incoming.method)
      ? undefined
      : await new Promise((resolve) => {
          const chunks = [];
          incoming.on("data", (chunk) => chunks.push(chunk));
          incoming.on("end", () => resolve(Buffer.concat(chunks)));
        });

    const request = new Request(url, {
      method: incoming.method,
      headers: incoming.headers,
      body,
    });
    addresses.set(request, incoming.socket.remoteAddress ?? null);

    const shim = {
      // Upgrades are handled on the 'upgrade' event, never here
      upgrade: () => false,
      requestIP: (target) => ({ address: addresses.get(target) ?? null }),
    };

    let answer;
    try {
      answer = await handleRequest(request, shim);
    } catch (error) {
      response.writeHead(500);
      response.end(String(error?.message ?? error));
      return;
    }
    if (!answer) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(answer.status, Object.fromEntries(answer.headers));
    response.end(Buffer.from(await answer.arrayBuffer()));
  });

  server.on("upgrade", (incoming, socket) => {
    const key = incoming.headers["sec-websocket-key"];
    if (!key) {
      socket.destroy();
      return;
    }
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`
    );
    socket.setNoDelay(true);

    const connection = createConnection(socket, { role: null, deviceId: null });
    websocket.open?.(connection);

    let buffer = Buffer.alloc(0);
    let fragments = [];
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const { frames, rest } = decodeFrames(buffer);
      buffer = rest;
      for (const frame of frames) {
        if (frame.opcode === OPCODES.close) {
          // The close handshake is an exchange: a peer that ends the socket
          // without echoing the frame leaves the other side reporting 1006,
          // an abnormal closure, for what was a perfectly orderly goodbye
          try {
            socket.write(encodeFrame(frame.payload, OPCODES.close));
          } catch {
            // peer already gone
          }
          connection.readyState = 3;
          websocket.close?.(connection);
          socket.end();
          return;
        }
        if (frame.opcode === OPCODES.ping) {
          socket.write(encodeFrame(frame.payload, OPCODES.pong));
          continue;
        }
        if (frame.opcode === OPCODES.pong) continue;
        // Text arriving in pieces: hold until FIN, then deliver as one
        fragments.push(frame.payload);
        if (!frame.fin) continue;
        const message = Buffer.concat(fragments).toString("utf-8");
        fragments = [];
        try {
          websocket.message?.(connection, message);
        } catch {
          // one bad message must not take the hub down
        }
      }
    });

    const finish = () => {
      if (connection.readyState === 3) return;
      connection.readyState = 3;
      websocket.close?.(connection);
    };
    socket.on("close", finish);
    socket.on("error", finish);
  });

  if (idleTimeout) server.setTimeout(idleTimeout * 1000);
  server.listen(port);
  return { port, stop: () => server.close() };
};
