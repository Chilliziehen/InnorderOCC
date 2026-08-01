import { contextBridge, ipcRenderer } from "electron";

import { SYSTEM_STATUSES_CHANNEL, type OccApi } from "./ipc-contract";

const api: Pick<OccApi, "runtime"> = {
  runtime: {
    statuses: () => ipcRenderer.invoke(SYSTEM_STATUSES_CHANNEL),
  },
};

contextBridge.exposeInMainWorld("occ", api);
