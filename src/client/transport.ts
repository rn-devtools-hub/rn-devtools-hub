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
const DEFAULT_FLUSH_MS = 300;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 10000;

export class DevtoolsTransport {
  private ws: WebSocket | null = null;
  private buffer: DevtoolsEvent[] = [];
  private nextEventId = 1;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private stopped = false;
  private commandHandlers = new Map<string, CommandHandler>();

  private readonly options: Required<
    Pick<DevtoolsInitOptions, "serverUrl" | "appName" | "maxBufferSize" | "flushIntervalMs">
  > & { deviceName: string; stableId: string | null };

  constructor(options: DevtoolsInitOptions) {
    this.options = {
      serverUrl: options.serverUrl,
      appName: options.appName,
      deviceName: options.deviceName ?? "device",
      stableId: options.stableId ?? null,
      maxBufferSize: options.maxBufferSize ?? DEFAULT_MAX_BUFFER,
      flushIntervalMs: options.flushIntervalMs ?? DEFAULT_FLUSH_MS,
    };
  }

  start(): void {
    this.stopped = false;
    this.connect();
    if (!this.flushTimer) {
      this.flushTimer = setInterval(() => this.flush(), this.options.flushIntervalMs);
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

  /** Sends the current batch if connected */
  flush(): void {
    if (!this.isConnected || this.buffer.length === 0) return;

    const events = this.buffer.splice(0, this.buffer.length);
    try {
      this.ws!.send(JSON.stringify({ kind: "events", events }));
    } catch {
      // Requeue at the head on send failure (without exceeding capacity)
      this.buffer = [...events, ...this.buffer].slice(-this.options.maxBufferSize);
    }
  }

  private connect(): void {
    if (this.stopped) return;

    try {
      this.ws = new WebSocket(this.options.serverUrl);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.reconnectAttempt = 0;
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
    let parsed: IncomingCommand;
    try {
      parsed = JSON.parse(String(raw));
    } catch {
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
