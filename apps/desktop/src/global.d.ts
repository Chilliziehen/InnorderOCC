import type { OccApi } from "./ipc-contract";

declare global {
  interface Window {
    occ: OccApi;
  }

  const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
  const MAIN_WINDOW_VITE_NAME: string;
}

export {};
