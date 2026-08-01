import { z } from "zod";

import {
  notificationEventSchema,
  notificationPageSchema,
  type NotificationEvent,
  type NotificationPage,
} from "./desktop-contract";
import { serializedSize } from "./serialized-size";

export interface NotificationStreamPersistence {
  read(): Promise<unknown>;
  write(value: unknown): Promise<void>;
}

export interface NotificationConnection {
  close(): void;
}

export interface NotificationConnectorRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly onMessage: (message: { data: string; lastEventId?: string }) => Promise<void>;
  readonly onError: () => void;
}

export type NotificationConnector = (request: NotificationConnectorRequest) => NotificationConnection;

interface NotificationScope {
  readonly profileId: string;
  readonly customerInstanceId: string;
  readonly principalId: string;
}

export interface NotificationSession {
  readonly scope: NotificationScope;
  readonly origin: string;
  readonly endpointAvailable: boolean;
}

interface NotificationStreamOptions {
  readonly connector: NotificationConnector;
  readonly persistence: NotificationStreamPersistence;
  readonly getAccessToken: () => string | null;
  readonly listFallback?: (cursor?: string) => Promise<NotificationPage>;
  readonly settleCommand?: (intentHandle: string, correlationId: string) => boolean;
  readonly setTimeout?: (callback: () => void, delay: number) => unknown;
  readonly clearTimeout?: (timer: unknown) => void;
  readonly random?: () => number;
  readonly now?: () => number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
}

const MAX_EVENT_BYTES = 2 * 1024 * 1024;
const scopeSchema = z.object({ profileId: z.uuid(), customerInstanceId: z.uuid(), principalId: z.uuid() }).strict();
const cursorFileSchema = z.object({ version: z.literal(1), cursors: z.record(z.string(), z.string().min(1).max(2048)) }).strict();

function exactHttpsOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || value !== url.origin) {
    throw new Error("Invalid notification origin");
  }
  return url.origin;
}

function scopeKey(scope: NotificationScope): string {
  const parsed = scopeSchema.parse(scope);
  return `${parsed.profileId}:${parsed.customerInstanceId}:${parsed.principalId}`;
}

export function createNotificationStream(options: NotificationStreamOptions) {
  const schedule = options.setTimeout ?? ((callback: () => void, delay: number) => globalThis.setTimeout(callback, delay));
  const cancel = options.clearTimeout ?? ((timer: unknown) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>));
  const random = options.random ?? Math.random;
  const baseDelayMs = options.baseDelayMs ?? 1_000;
  const maxDelayMs = options.maxDelayMs ?? 30_000;
  const listeners = new Set<(event: NotificationEvent) => void>();
  let session: NotificationSession | null = null;
  let connection: NotificationConnection | undefined;
  let reconnectTimer: unknown;
  let reconnectAttempt = 0;
  let disposed = false;
  let generation = 0;
  let tail = Promise.resolve();
  let connectFlight: Promise<void> | undefined;
  const seenEventIds = new Set<string>();
  const seenCursors = new Set<string>();

  const serialized = (operation: () => Promise<void>) => {
    const result = tail.then(operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
  const readCursors = async (): Promise<Record<string, string>> => {
    try {
      const value = await options.persistence.read();
      return value === undefined ? {} : cursorFileSchema.parse(value).cursors;
    } catch {
      return {};
    }
  };
  const persistCursor = async (scope: NotificationScope, cursor: string) => {
    const cursors = await readCursors();
    await options.persistence.write(cursorFileSchema.parse({
      version: 1,
      cursors: { ...cursors, [scopeKey(scope)]: z.string().min(1).max(2048).parse(cursor) },
    }));
  };
  const remember = (values: Set<string>, value: string) => {
    values.add(value);
    if (values.size > 2_000) values.delete(values.values().next().value!);
  };
  const emitValidated = (raw: unknown, eventCursor?: string, expectedGeneration = generation) => serialized(async () => {
    if (serializedSize(raw) > MAX_EVENT_BYTES) return;
    const parsed = notificationEventSchema.safeParse(raw);
    if (!parsed.success || !session || expectedGeneration !== generation) return;
    const cursor = eventCursor || parsed.data.cursor;
    if (!cursor) return;
    if (seenEventIds.has(parsed.data.id) || seenCursors.has(cursor)) return;
    const activeScope = session.scope;
    await persistCursor(activeScope, cursor);
    if (!session || expectedGeneration !== generation) return;
    remember(seenEventIds, parsed.data.id);
    remember(seenCursors, cursor);
    if (parsed.data.commandState && parsed.data.intentHandle && parsed.data.correlationId) {
      options.settleCommand?.(parsed.data.intentHandle, parsed.data.correlationId);
    }
    for (const listener of listeners) listener(parsed.data);
  });
  const disconnect = () => {
    connection?.close();
    connection = undefined;
    if (reconnectTimer !== undefined) cancel(reconnectTimer);
    reconnectTimer = undefined;
  };

  const performConnect = async (reconnecting: boolean, expectedGeneration: number) => {
    if (disposed || connection || listeners.size === 0 || !session?.endpointAvailable || expectedGeneration !== generation) return;
    const origin = exactHttpsOrigin(session.origin);
    const token = options.getAccessToken();
    if (!token) return;
    let cursor = (await readCursors())[scopeKey(session.scope)];
    if (!session || expectedGeneration !== generation) return;
    if (options.listFallback) {
      try {
        const page = notificationPageSchema.parse(await options.listFallback(cursor));
        for (const item of page.items) await emitValidated(item, item.cursor, expectedGeneration);
        if (page.nextCursor && session && expectedGeneration === generation) {
          const catchUpScope = session.scope;
          await serialized(async () => {
            if (!session || expectedGeneration !== generation) return;
            await persistCursor(catchUpScope, page.nextCursor!);
          });
        }
        if (session && expectedGeneration === generation) cursor = (await readCursors())[scopeKey(session.scope)];
      } catch {
        // The persisted cursor still permits a live connection when catch-up is unavailable.
      }
    }
    if (!session || expectedGeneration !== generation) return;
    connection = options.connector({
      url: `${origin}/api/v1/notifications/stream`,
      headers: {
        authorization: `Bearer ${token}`,
        ...(cursor ? { "last-event-id": cursor } : {}),
      },
      onMessage: async ({ data, lastEventId }) => {
        if (Buffer.byteLength(data, "utf8") > MAX_EVENT_BYTES) return;
        try {
          await emitValidated(JSON.parse(data), lastEventId, expectedGeneration);
          reconnectAttempt = 0;
        } catch {
          // Malformed or unpersistable events are never emitted.
        }
      },
      onError: () => {
        if (expectedGeneration !== generation) return;
        connection?.close();
        connection = undefined;
        if (!session?.endpointAvailable || listeners.size === 0 || disposed || reconnectTimer !== undefined) return;
        const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** reconnectAttempt);
        const jitter = 0.5 + random();
        const delay = Math.min(maxDelayMs, Math.round(exponential * jitter));
        reconnectAttempt += 1;
        reconnectTimer = schedule(() => {
          reconnectTimer = undefined;
          void connect(true, expectedGeneration);
        }, delay);
      },
    });
  };
  const connect = (reconnecting: boolean, expectedGeneration = generation): Promise<void> => {
    if (connectFlight) return connectFlight;
    const flight = performConnect(reconnecting, expectedGeneration);
    const tracked = flight.finally(() => {
      if (connectFlight === tracked) connectFlight = undefined;
    });
    connectFlight = tracked;
    return connectFlight;
  };

  return {
    async setSession(next: NotificationSession | null): Promise<void> {
      generation += 1;
      const expectedGeneration = generation;
      disconnect();
      seenEventIds.clear();
      seenCursors.clear();
      reconnectAttempt = 0;
      if (next) {
        session = { ...next, scope: scopeSchema.parse(next.scope), origin: exactHttpsOrigin(next.origin) };
      } else {
        session = null;
      }
      await connect(false, expectedGeneration);
      if (session && expectedGeneration === generation && !connection) {
        await connect(false, expectedGeneration);
      }
    },
    subscribe(listener: (event: NotificationEvent) => void): () => void {
      if (disposed) throw new Error("Notification stream disposed");
      listeners.add(listener);
      void connect(false);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        listeners.delete(listener);
        if (listeners.size === 0) disconnect();
      };
    },
    idle: async () => {
      await connectFlight;
      await tail;
      await new Promise<void>((resolve) => queueMicrotask(resolve));
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      generation += 1;
      disconnect();
      listeners.clear();
      session = null;
    },
  };
}
