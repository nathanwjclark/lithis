/**
 * A minimal Chrome DevTools Protocol client over Bun's built-in WebSocket —
 * no new dependencies (the Slack Socket Mode client is the precedent). This is
 * transport only: what may be sent is decided by the browserhost broker on the
 * other end of the wire, which is the security boundary (ADR-003).
 */

export interface CdpEventFrame {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

export interface CdpTransport {
  /** Issue a command; resolves with `result`, rejects with the CDP `error`. */
  send(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<Record<string, unknown>>;
  /** Subscribe to a CDP event by method name. Returns an unsubscribe fn. */
  on(method: string, handler: (frame: CdpEventFrame) => void): () => void;
  close(): Promise<void>;
}

/** A CDP command was refused or failed — carries the protocol error verbatim. */
export class CdpError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
    readonly data?: string,
  ) {
    super(`CDP ${method} failed (${code}): ${message}${data === undefined ? "" : ` [${data}]`}`);
    this.name = "CdpError";
  }
}

interface Pending {
  method: string;
  resolve: (result: Record<string, unknown>) => void;
  reject: (err: Error) => void;
}

export interface CdpConnectOptions {
  /** How long a single command may take before rejecting (default 30s). */
  commandTimeoutMs?: number;
  /** Injectable socket factory (tests). Defaults to Bun's global WebSocket. */
  createSocket?: (url: string) => WebSocket;
}

/** Connect to a brokered CDP websocket URL. */
export async function connectCdp(
  url: string,
  opts: CdpConnectOptions = {},
): Promise<CdpTransport> {
  const commandTimeoutMs = opts.commandTimeoutMs ?? 30_000;
  const socket = (opts.createSocket ?? ((u: string) => new WebSocket(u)))(url);
  const pending = new Map<number, Pending>();
  const handlers = new Map<string, Set<(frame: CdpEventFrame) => void>>();
  let nextId = 1;
  let closedReason: string | undefined;

  socket.addEventListener("message", (ev: MessageEvent) => {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(String(ev.data)) as Record<string, unknown>;
    } catch {
      return; // A non-JSON frame cannot be routed; the broker never sends one.
    }
    const id = frame["id"];
    if (typeof id === "number") {
      const waiter = pending.get(id);
      if (waiter === undefined) return;
      pending.delete(id);
      const error = frame["error"] as { code?: number; message?: string; data?: string } | undefined;
      if (error !== undefined) {
        waiter.reject(
          new CdpError(
            waiter.method,
            error.code ?? -1,
            error.message ?? "unknown error",
            error.data,
          ),
        );
      } else {
        waiter.resolve((frame["result"] ?? {}) as Record<string, unknown>);
      }
      return;
    }
    const method = frame["method"];
    if (typeof method !== "string") return;
    const eventFrame: CdpEventFrame = {
      method,
      params: (frame["params"] ?? {}) as Record<string, unknown>,
      ...(typeof frame["sessionId"] === "string" ? { sessionId: frame["sessionId"] } : {}),
    };
    for (const handler of handlers.get(method) ?? []) handler(eventFrame);
  });

  const failAll = (reason: string): void => {
    closedReason = reason;
    for (const [, waiter] of pending) waiter.reject(new Error(reason));
    pending.clear();
  };
  socket.addEventListener("close", () => failAll("CDP connection closed"));
  socket.addEventListener("error", () => failAll("CDP connection errored"));

  await new Promise<void>((resolve, reject) => {
    if (socket.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () =>
      reject(new Error(`could not open a CDP connection to the brokered endpoint`)),
    );
  });

  return {
    send(method, params, sessionId): Promise<Record<string, unknown>> {
      if (closedReason !== undefined) return Promise.reject(new Error(closedReason));
      const id = nextId++;
      const frame = {
        id,
        method,
        ...(params !== undefined ? { params } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
      };
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP ${method} timed out after ${commandTimeoutMs}ms`));
        }, commandTimeoutMs);
        pending.set(id, {
          method,
          resolve: (result) => {
            clearTimeout(timer);
            resolve(result);
          },
          reject: (err) => {
            clearTimeout(timer);
            reject(err);
          },
        });
        socket.send(JSON.stringify(frame));
      });
    },

    on(method, handler): () => void {
      const set = handlers.get(method) ?? new Set();
      set.add(handler);
      handlers.set(method, set);
      return () => {
        set.delete(handler);
      };
    },

    async close(): Promise<void> {
      failAll("CDP connection closed");
      socket.close();
    },
  };
}
