import type { AuthenticatedState, OfflineState, ReconnectingState } from "../app-controller";

type ConnectedMode = AuthenticatedState["mode"] | OfflineState["mode"] | ReconnectingState["mode"];

interface StatusBannerProps {
  mode: ConnectedMode;
  lastFreshAt: number;
}

function ageLabel(ageMs: number): string {
  const seconds = Math.max(0, Math.floor(ageMs / 1_000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  return `${Math.floor(minutes / 60)} 小时`;
}

export function StatusBanner({ mode, lastFreshAt }: StatusBannerProps) {
  const age = ageLabel(Date.now() - lastFreshAt);
  const state = mode === "authenticated" ? "在线" : mode === "reconnecting" ? "正在重新连接" : "离线";

  return (
    <div
      className={`status-banner connectivity-${mode}`}
      role="status"
      aria-label="连接状态"
      aria-live="polite"
    >
      <strong>{state}</strong>
      <span>数据距上次更新 {age}</span>
      {mode !== "authenticated" ? (
        <span className="mutation-lock">{mode === "offline" ? "只读模式，更改操作已锁定" : "更改操作已锁定"}</span>
      ) : null}
    </div>
  );
}
