import { z } from "zod";

export const DESKTOP_CHANNELS = {
  profiles: {
    list: "profiles:list", current: "profiles:current", save: "profiles:save", select: "profiles:select", remove: "profiles:remove",
  },
  session: { restore: "session:restore", login: "session:login", logout: "session:logout" },
  runtime: { statuses: "system-statuses:get" },
  workspaces: { query: "workspaces:query" },
  commands: { execute: "commands:execute" },
  uploads: { start: "uploads:start", cancel: "uploads:cancel" },
  notifications: { list: "notifications:list", event: "notifications:event" },
} as const;

export const SYSTEM_STATUSES_CHANNEL = DESKTOP_CHANNELS.runtime.statuses;
export const noInputSchema = z.undefined();
export const idInputSchema = z.string().min(1).max(256);
export const optionalCursorSchema = z.string().min(1).max(2048).optional();
export const voidOutputSchema = z.undefined();

export * from "./desktop-contract";
