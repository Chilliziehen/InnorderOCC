import { contextBridge, ipcRenderer } from "electron";

import { SYSTEM_STATUSES_CHANNEL, type OccApi } from "./ipc-contract";

const api: OccApi = {
  getSystemStatuses: () => ipcRenderer.invoke(SYSTEM_STATUSES_CHANNEL),
};

contextBridge.exposeInMainWorld("occ", api);
