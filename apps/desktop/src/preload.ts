import { contextBridge, ipcRenderer } from "electron";

import { DESKTOP_CHANNELS, notificationEventSchema, uploadProgressSchema, type OccApi } from "./ipc-contract";

function freezeApi<T extends object>(value: T): Readonly<T> {
  for (const child of Object.values(value)) {
    if (typeof child === "object" && child !== null) freezeApi(child);
  }
  return Object.freeze(value);
}

const api: OccApi = freezeApi({
  profiles: {
    list: () => ipcRenderer.invoke(DESKTOP_CHANNELS.profiles.list, undefined),
    current: () => ipcRenderer.invoke(DESKTOP_CHANNELS.profiles.current, undefined),
    save: (input) => ipcRenderer.invoke(DESKTOP_CHANNELS.profiles.save, input),
    select: (id) => ipcRenderer.invoke(DESKTOP_CHANNELS.profiles.select, id),
    remove: (id) => ipcRenderer.invoke(DESKTOP_CHANNELS.profiles.remove, id),
  },
  session: {
    restore: () => ipcRenderer.invoke(DESKTOP_CHANNELS.session.restore, undefined),
    login: (input) => ipcRenderer.invoke(DESKTOP_CHANNELS.session.login, input),
    logout: () => ipcRenderer.invoke(DESKTOP_CHANNELS.session.logout, undefined),
  },
  runtime: {
    statuses: () => ipcRenderer.invoke(DESKTOP_CHANNELS.runtime.statuses, undefined),
  },
  workspaces: { query: (input) => ipcRenderer.invoke(DESKTOP_CHANNELS.workspaces.query, input) },
  commands: { execute: (input) => ipcRenderer.invoke(DESKTOP_CHANNELS.commands.execute, input) },
  uploads: {
    start: (input) => ipcRenderer.invoke(DESKTOP_CHANNELS.uploads.start, input),
    cancel: (uploadId) => ipcRenderer.invoke(DESKTOP_CHANNELS.uploads.cancel, uploadId),
    subscribeProgress(listener) {
      const wrapped = (_event: unknown, input: unknown) => {
        const parsed = uploadProgressSchema.safeParse(input);
        if (parsed.success) listener(parsed.data);
      };
      ipcRenderer.on(DESKTOP_CHANNELS.uploads.progress, wrapped);
      return () => ipcRenderer.removeListener(DESKTOP_CHANNELS.uploads.progress, wrapped);
    },
  },
  notifications: {
    list: (cursor) => ipcRenderer.invoke(DESKTOP_CHANNELS.notifications.list, cursor),
    subscribe(listener) {
      const wrapped = (_event: unknown, input: unknown) => {
        const parsed = notificationEventSchema.safeParse(input);
        if (parsed.success) listener(parsed.data);
      };
      ipcRenderer.on(DESKTOP_CHANNELS.notifications.event, wrapped);
      return () => ipcRenderer.removeListener(DESKTOP_CHANNELS.notifications.event, wrapped);
    },
  },
});

contextBridge.exposeInMainWorld("occ", api);
