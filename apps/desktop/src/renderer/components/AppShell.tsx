import type { SystemStatus } from "@innorder/contracts";
import { Tooltip } from "antd";
import { LogOut, Settings } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { ProfileInput, ServerProfile } from "../../desktop-contract";
import type { AuthenticatedState, OfflineState, ReconnectingState } from "../app-controller";
import { resolveRoute, visibleRoutes } from "../routes";
import type { WorkspaceId } from "../workspace-manifest";
import { ENVIRONMENT_LABELS } from "./Login";
import { StatusBanner } from "./StatusBanner";
import { WorkspaceRouter } from "./WorkspaceRouter";

export type ShellState = AuthenticatedState | OfflineState | ReconnectingState;

interface AppShellProps {
  state: ShellState;
  statuses: SystemStatus[];
  onLogout(): void | Promise<void>;
  onProfileSelect(profile: ServerProfile): void | Promise<void>;
  onProfileSave(input: ProfileInput): Promise<unknown>;
  onProfileRemove?(profileId: string): void | Promise<void>;
  onRetry?(): void;
}

export function AppShell({ state, statuses, onLogout, onProfileSelect, onProfileSave, onProfileRemove, onRetry }: AppShellProps) {
  const identity = state.mode === "authenticated" ? state.identity : state.cachedIdentity;
  const resolution = resolveRoute(state.route?.path ?? "", identity.capabilities);
  const contentRef = useRef<HTMLDivElement>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const title = resolution.kind === "route"
    ? resolution.route.title
    : resolution.kind === "access-denied"
      ? "访问被拒绝"
      : "页面不存在";

  useEffect(() => {
    if ((state.route?.focusToken ?? 0) <= 0) return;
    const heading = contentRef.current?.querySelector<HTMLElement>("h1, h2");
    if (heading) {
      heading.tabIndex = -1;
      heading.focus();
    }
  }, [state.route?.focusToken]);

  return (
    <div className="app-shell" inert={modalOpen ? true : undefined} aria-hidden={modalOpen ? true : undefined} onClickCapture={(event) => { if (modalOpen && event.currentTarget.contains(event.target as Node)) { event.preventDefault(); event.stopPropagation(); } }}>
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">序</span><div><strong>创序 OCC</strong><small>运营控制中心</small></div></div>
        <nav aria-label="主导航">
          {visibleRoutes(identity.capabilities).map(({ path, label, icon: Icon }) => (
            <Tooltip title={label} placement="right" key={path}>
              <a aria-current={state.route?.path === path ? "page" : undefined} aria-label={label} className={state.route?.path === path ? "nav-item active" : "nav-item"} href={`#${path}`}>
                <Icon aria-hidden="true" size={18} /><span>{label}</span>
              </a>
            </Tooltip>
          ))}
        </nav>
        <div className="operator">
          <span className="operator-avatar">{identity.displayName.slice(0, 1)}</span>
          <div><strong>{identity.displayName}</strong><small>{state.profile.name} · {ENVIRONMENT_LABELS[state.profile.environment]}</small></div>
          <div className="operator-actions">
            <Tooltip title="服务器配置"><a href="#/settings" aria-label="服务器配置"><Settings aria-hidden="true" size={16} /></a></Tooltip>
            <Tooltip title="退出登录"><button type="button" aria-label="退出登录" onClick={() => void onLogout()}><LogOut aria-hidden="true" size={16} /></button></Tooltip>
          </div>
        </div>
      </aside>

      <main className="workspace">
        <StatusBanner mode={state.mode} lastFreshAt={state.lastFreshAt} retryAvailable={state.mode === "reconnecting" && state.retryAvailable} {...(onRetry ? { onRetry } : {})} />
        <span className="sr-only" aria-live="polite" data-testid="page-announcement">{title}</span>
        <div className="workspace-content" ref={contentRef}>
          {resolution.kind === "access-denied" ? (
            <section className="access-state" role="alert"><h1>访问被拒绝</h1><strong>当前账户无权访问此页面。</strong></section>
          ) : resolution.kind === "not-found" ? (
            <section className="access-state"><h1>页面不存在</h1><strong>找不到请求的页面。</strong></section>
          ) : (
            <WorkspaceRouter
              key={`${state.profile.id}:${state.sessionGeneration}`}
              workspaceId={resolution.route.path.slice(1) as WorkspaceId}
              queryAllowed={resolution.queryAllowed}
              state={state}
              statuses={statuses}
              onLogout={onLogout}
              onProfileSelect={onProfileSelect}
              onProfileSave={onProfileSave}
              onModalOpenChange={setModalOpen}
              modalIsolationActive={modalOpen}
              {...(onProfileRemove ? { onProfileRemove } : {})}
            />
          )}
        </div>
      </main>
    </div>
  );
}
