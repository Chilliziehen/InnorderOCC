import { contextBridge, ipcRenderer } from "electron";

import { DESKTOP_CHANNELS, notificationEventSchema, type OccApi } from "./ipc-contract";
import { serializedSize } from "./serialized-size";

const MAX_NOTIFICATION_BYTES = 2 * 1024 * 1024;

function freezeApi<T extends object>(value: T): Readonly<T> {
  for (const child of Object.values(value)) {
    if (typeof child === "object" && child !== null) freezeApi(child);
  }
  return Object.freeze(value);
}

const api: OccApi = freezeApi({
  profiles: {
    list: () => ipcRenderer.invoke(DESKTOP_CHANNELS.profiles.list),
    save: (input) => ipcRenderer.invoke(DESKTOP_CHANNELS.profiles.save, input),
    select: (id) => ipcRenderer.invoke(DESKTOP_CHANNELS.profiles.select, id),
    remove: (id) => ipcRenderer.invoke(DESKTOP_CHANNELS.profiles.remove, id),
  },
  session: {
    restore: () => ipcRenderer.invoke(DESKTOP_CHANNELS.session.restore),
    login: (input) => ipcRenderer.invoke(DESKTOP_CHANNELS.session.login, input),
    logout: () => ipcRenderer.invoke(DESKTOP_CHANNELS.session.logout),
  },
  runtime: {
    statuses: () => ipcRenderer.invoke(DESKTOP_CHANNELS.runtime.statuses),
  },
  workspaces: { query: (input) => ipcRenderer.invoke(DESKTOP_CHANNELS.workspaces.query, input) },
  commands: { execute: (input) => ipcRenderer.invoke(DESKTOP_CHANNELS.commands.execute, input) },
  uploads: {
    start: (input) => ipcRenderer.invoke(DESKTOP_CHANNELS.uploads.start, input),
    cancel: (uploadId) => ipcRenderer.invoke(DESKTOP_CHANNELS.uploads.cancel, uploadId),
  },
  notifications: {
    list: (cursor) => ipcRenderer.invoke(DESKTOP_CHANNELS.notifications.list, cursor),
    subscribe(listener) {
      const wrapped = (_event: unknown, input: unknown) => {
        try {
          if (serializedSize(input) > MAX_NOTIFICATION_BYTES) return;
          const parsed = notificationEventSchema.safeParse(input);
          if (parsed.success) listener(parsed.data);
        } catch {
          // Malformed or unserializable events do not cross the preload boundary.
        }
      };
      ipcRenderer.on(DESKTOP_CHANNELS.notifications.event, wrapped);
      return () => ipcRenderer.removeListener(DESKTOP_CHANNELS.notifications.event, wrapped);
    },
  },
});

contextBridge.exposeInMainWorld("occ", api);
