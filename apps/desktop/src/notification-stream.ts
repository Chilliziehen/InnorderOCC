import { z } from "zod";

import {
  notificationEventSchema,
  notificationConnectionStateSchema,
  notificationPageSchema,
  type NotificationEvent,
  type NotificationConnectionState,
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
  readonly maxCatchUpPages?: number;
  readonly maxCatchUpEvents?: number;
  readonly maxCursorScopes?: number;
  readonly maxCursorBytes?: number;
}

const MAX_EVENT_BYTES = 2 * 1024 * 1024;
const scopeSchema = z.object({ profileId: z.uuid(), customerInstanceId: z.uuid(), principalId: z.uuid() }).strict();
const cursorFileSchema = z.object({ version: z.literal(1), cursors: z.record(z.string(), z.string().min(1).max(2048)) }).strict();
const DEFAULT_MAX_CURSOR_SCOPES = 1_000;
const DEFAULT_MAX_CURSOR_BYTES = 256 * 1024;

function persistedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

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
  const maxCatchUpPages = options.maxCatchUpPages ?? 20;
  const maxCatchUpEvents = options.maxCatchUpEvents ?? 2_000;
  const maxCursorScopes = options.maxCursorScopes ?? DEFAULT_MAX_CURSOR_SCOPES;
  const maxCursorBytes = options.maxCursorBytes ?? DEFAULT_MAX_CURSOR_BYTES;
  const listeners = new Set<(event: NotificationEvent) => void>();
  const stateListeners = new Set<(state: NotificationConnectionState) => void>();
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
  let currentState: NotificationConnectionState | undefined;
  let lastEventAt: string | undefined;

  const publishState = (state: NotificationConnectionState["state"]) => {
    const parsed = notificationConnectionStateSchema.parse({
      state,
      changedAt: new Date((options.now ?? Date.now)()).toISOString(),
      ...(lastEventAt ? { lastEventAt } : {}),
    });
    currentState = parsed;
    for (const listener of stateListeners) listener(parsed);
  };

  const serialized = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
  const readCursors = async (): Promise<Record<string, string>> => {
    try {
      const value = await options.persistence.read();
      if (value === undefined || persistedBytes(value) > maxCursorBytes) return {};
      const cursors = cursorFileSchema.parse(value).cursors;
      return Object.keys(cursors).length <= maxCursorScopes ? cursors : {};
    } catch {
      return {};
    }
  };
  const persistCursor = async (scope: NotificationScope, cursor: string) => {
    const cursors = await readCursors();
    const key = scopeKey(scope);
    delete cursors[key];
    cursors[key] = z.string().min(1).max(2048).parse(cursor);
    let keys = Object.keys(cursors);
    while (keys.length > maxCursorScopes) {
      delete cursors[keys.shift()!];
    }
    let file = cursorFileSchema.parse({ version: 1, cursors });
    keys = Object.keys(cursors);
    while (keys.length > 1 && persistedBytes(file) > maxCursorBytes) {
      delete cursors[keys.shift()!];
      file = cursorFileSchema.parse({ version: 1, cursors });
    }
    if (persistedBytes(file) > maxCursorBytes) throw new Error("Notification cursor exceeds byte limit");
    await options.persistence.write(file);
  };
  const remember = (values: Set<string>, value: string) => {
    values.add(value);
    if (values.size > 2_000) values.delete(values.values().next().value!);
  };
  const emitValidated = (raw: unknown, eventCursor?: string, expectedGeneration = generation) => serialized(async (): Promise<boolean> => {
    if (serializedSize(raw) > MAX_EVENT_BYTES) return false;
    const parsed = notificationEventSchema.safeParse(raw);
    if (!parsed.success || !session || expectedGeneration !== generation) return false;
    const cursor = eventCursor || parsed.data.cursor;
    if (!cursor) return false;
    if (seenEventIds.has(parsed.data.id) || seenCursors.has(cursor)) return false;
    const activeScope = session.scope;
    await persistCursor(activeScope, cursor);
    if (!session || expectedGeneration !== generation) return false;
    remember(seenEventIds, parsed.data.id);
    remember(seenCursors, cursor);
    if (parsed.data.commandState && parsed.data.intentHandle && parsed.data.correlationId) {
      options.settleCommand?.(parsed.data.intentHandle, parsed.data.correlationId);
    }
    for (const listener of listeners) listener(parsed.data);
    lastEventAt = new Date((options.now ?? Date.now)()).toISOString();
    if (currentState) publishState(currentState.state);
    return true;
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
    if (!token) {
      publishState("unavailable");
      return;
    }
    publishState(reconnecting ? "reconnecting" : "connecting");
    let cursor = (await readCursors())[scopeKey(session.scope)];
    if (!session || expectedGeneration !== generation) return;
    if (options.listFallback) {
      try {
        let requestCursor = cursor;
        let eventCount = 0;
        for (let pageIndex = 0; pageIndex < maxCatchUpPages && eventCount < maxCatchUpEvents; pageIndex += 1) {
          const page = notificationPageSchema.parse(await options.listFallback(requestCursor));
          for (const item of page.items) {
            if (eventCount >= maxCatchUpEvents) break;
            await emitValidated(item, item.cursor, expectedGeneration);
            eventCount += 1;
          }
          if (!page.nextCursor || !session || expectedGeneration !== generation) break;
          requestCursor = page.nextCursor;
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
        publishState("reconnecting");
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
    publishState("online");
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
      lastEventAt = undefined;
      if (next) {
        session = { ...next, scope: scopeSchema.parse(next.scope), origin: exactHttpsOrigin(next.origin) };
      } else {
        session = null;
      }
      if (!next?.endpointAvailable) publishState("unavailable");
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
    subscribeState(listener: (state: NotificationConnectionState) => void): () => void {
      if (disposed) throw new Error("Notification stream disposed");
      stateListeners.add(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        stateListeners.delete(listener);
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
      stateListeners.clear();
      session = null;
    },
  };
}
