/**
 * WebSocket transport of the devtools SDK.
 * - Event batching (periodic flush)
 * - Offline ring buffer (events are never lost as long as the buffer
 *   is not full, the oldest ones are evicted)
 * - Automatic reconnection with backoff
 * - Bidirectional command channel (dashboard to app)
 */

import {
  CommandHandler,
  DevtoolsEvent,
  DevtoolsInitOptions,
  IncomingCommand,
} from "./types";

const DEFAULT_MAX_BUFFER = 1000;
/** 256 KB: large enough for a screen frame, small enough not to freeze
 * the JS thread when a backlog drains after a reconnection */
const DEFAULT_MAX_BATCH_BYTES = 262144;
const DEFAULT_FLUSH_MS = 300;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 10000;
const HEARTBEAT_INTERVAL_MS = 5000;
const CONNECTION_STALE_MS = 15000;

export class DevtoolsTransport {
  private ws: WebSocket | null = null;
  private buffer: DevtoolsEvent[] = [];
  private nextEventId = 1;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempt = 0;
  private connectionStartedAt = 0;
  private lastServerActivity = 0;
  private heartbeatConfirmed = false;
  private stopped = false;
  private commandHandlers = new Map<string, CommandHandler>();

  private readonly options: Required<
    Pick<
      DevtoolsInitOptions,
      "serverUrl" | "appName" | "maxBufferSize" | "flushIntervalMs" | "maxBatchBytes"
    >
  > & { deviceName: string; stableId: string | null };

  constructor(options: DevtoolsInitOptions) {
    this.options = {
      serverUrl: options.serverUrl,
      appName: options.appName,
      deviceName: options.deviceName ?? "device",
      stableId: options.stableId ?? null,
      maxBufferSize: options.maxBufferSize ?? DEFAULT_MAX_BUFFER,
      flushIntervalMs: options.flushIntervalMs ?? DEFAULT_FLUSH_MS,
      maxBatchBytes: Math.max(1024, options.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES),
    };
  }

  start(): void {
    this.stopped = false;
    this.connect();
    if (!this.flushTimer) {
      this.flushTimer = setInterval(() => this.flush(), this.options.flushIntervalMs);
    }
    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => this.checkConnection(), HEARTBEAT_INTERVAL_MS);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    try {
      this.ws?.close();
    } catch {
      // already closed
    }
    this.ws = null;
  }

  get isConnected(): boolean {
    return !!this.ws && this.ws.readyState === 1; // OPEN
  }

  get bufferedCount(): number {
    return this.buffer.length;
  }

  /** Enqueues an event (ring buffer: oldest evicted when full) */
  enqueue(type: string, payload: unknown): DevtoolsEvent {
    const event: DevtoolsEvent = {
      id: this.nextEventId++,
      type,
      ts: Date.now(),
      payload,
    };
    this.buffer.push(event);
    if (this.buffer.length > this.options.maxBufferSize) {
      this.buffer.splice(0, this.buffer.length - this.options.maxBufferSize);
    }
    return event;
  }

  /** Registers a handler for a command coming from the dashboard */
  onCommand(command: string, handler: CommandHandler): void {
    this.commandHandlers.set(command, handler);
  }

  /**
   * Sends the current batch if connected.
   *
   * The buffer was bounded by a COUNT and drained whole, so a thousand
   * events of a few bytes and a thousand network responses of twenty
   * kilobytes produced the same "one batch": after a disconnection, the
   * reconnect flush serialized the entire backlog in one JSON.stringify
   * on the JS thread. The batch is now bounded in bytes as well, and what
   * does not fit stays in the buffer for the next tick, in order.
   */
  flush(): void {
    if (!this.isConnected || this.buffer.length === 0) return;

    const limit = this.options.maxBatchBytes;
    const parts: string[] = [];
    let size = 0;
    let taken = 0;
    for (const event of this.buffer) {
      let serialized: string;
      try {
        serialized = JSON.stringify(event);
      } catch {
        taken += 1; // unserializable: drop it rather than block the queue
        continue;
      }
      // Always send at least one event, even one over the limit on its
      // own: holding it back forever would be a silent stall
      if (parts.length && size + serialized.length > limit) break;
      parts.push(serialized);
      size += serialized.length + 1;
      taken += 1;
    }
    if (!parts.length) {
      this.buffer.splice(0, taken);
      return;
    }

    const events = this.buffer.splice(0, taken);
    try {
      this.ws!.send(`{"kind":"events","events":[${parts.join(",")}]}`);
    } catch {
      // Requeue at the head on send failure (without exceeding capacity)
      this.buffer = [...events, ...this.buffer].slice(-this.options.maxBufferSize);
      return;
    }
    // More waiting: drain on the next tick rather than in this one
    if (this.buffer.length) setTimeout(() => this.flush(), 0);
  }

  private connect(): void {
    if (this.stopped) return;

    try {
      this.connectionStartedAt = Date.now();
      this.ws = new WebSocket(this.options.serverUrl);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.lastServerActivity = Date.now();
      this.heartbeatConfirmed = false;
      try {
        this.ws?.send(
          JSON.stringify({
            kind: "hello",
            role: "device",
            appName: this.options.appName,
            deviceName: this.options.deviceName,
            stableId: this.options.stableId,
          })
        );
      } catch {
        // hello failed, reconnection will take care of it
      }
      this.flush();
    };

    this.ws.onmessage = (message: { data: unknown }) => {
      this.lastServerActivity = Date.now();
      this.handleIncoming(message.data);
    };

    this.ws.onerror = () => {
      // onclose will follow, reconnection is handled there
    };

    this.ws.onclose = () => {
      this.ws = null;
      this.scheduleReconnect();
    };
  }

  /** Detects half-open sockets. Mobile networks, a restarted hub and an app
   * returning from a suspended native activity can leave readyState looking
   * open even though no command can cross it. The application-level ping is
   * portable across the React Native WebSocket implementations. */
  private checkConnection(): void {
    if (this.stopped || !this.ws) return;
    const now = Date.now();
    if (this.ws.readyState === 0 && now - this.connectionStartedAt > CONNECTION_STALE_MS) {
      try { this.ws.close(); } catch { this.ws = null; this.scheduleReconnect(); }
      return;
    }
    if (!this.isConnected) return;
    // Older hubs ignore the application heartbeat. Preserve SDK backwards
    // compatibility by enforcing the deadline only after this hub proved it
    // understands pong messages.
    if (this.heartbeatConfirmed && now - this.lastServerActivity > CONNECTION_STALE_MS) {
      try { this.ws.close(); } catch { this.ws = null; this.scheduleReconnect(); }
      return;
    }
    try {
      this.ws.send(JSON.stringify({ kind: "ping", ts: now }));
    } catch {
      try { this.ws.close(); } catch { this.ws = null; this.scheduleReconnect(); }
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempt++),
      RECONNECT_MAX_MS
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private async handleIncoming(raw: unknown): Promise<void> {
    let parsed: IncomingCommand & { kind?: string };
    try {
      parsed = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (parsed?.kind === "pong") {
      this.heartbeatConfirmed = true;
      return;
    }
    if (parsed?.type !== "command" || !parsed.command) return;

    const handler = this.commandHandlers.get(parsed.command);
    let result: unknown;
    let error: string | undefined;

    if (!handler) {
      error = `Unknown command: ${parsed.command}`;
    } else {
      try {
        result = await handler(parsed.payload);
      } catch (e: unknown) {
        error = e instanceof Error ? e.message : String(e);
      }
    }

    if (parsed.requestId && this.isConnected) {
      try {
        this.ws!.send(
          JSON.stringify({
            kind: "commandResult",
            requestId: parsed.requestId,
            command: parsed.command,
            result,
            error,
          })
        );
      } catch {
        // the dashboard will ask again
      }
    }
  }
}
