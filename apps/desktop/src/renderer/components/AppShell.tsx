import type { ComponentStatus, ServiceState, SystemStatus } from "@innorder/contracts";
import { Tooltip } from "antd";
import {
  AlertTriangle,
  CheckCircle2,
  CircleHelp,
  ClipboardCheck,
  Clock3,
  GitBranch,
  LogOut,
  OctagonX,
  Settings,
  Sparkles,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef } from "react";

import type { ProfileInput, ServerProfile } from "../../desktop-contract";
import type { AuthenticatedState, OfflineState, ReconnectingState } from "../app-controller";
import { resolveRoute, visibleRoutes } from "../routes";
import { ENVIRONMENT_LABELS } from "./Login";
import { ProfileBootstrap } from "./ProfileBootstrap";
import { StatusBanner } from "./StatusBanner";

type ShellState = AuthenticatedState | OfflineState | ReconnectingState;

interface AppShellProps {
  state: ShellState;
  statuses: SystemStatus[];
  onLogout(): void | Promise<void>;
  onProfileSelect(profile: ServerProfile): void | Promise<void>;
  onProfileSave(input: ProfileInput): Promise<unknown>;
  onRetry?(): void;
}

const METRICS = [
  { label: "进行中流程", icon: GitBranch },
  { label: "今日待办", icon: ClipboardCheck },
  { label: "待审核", icon: Clock3 },
  { label: "高风险", icon: AlertTriangle },
];

interface FixedService {
  id: string;
  label: string;
  sourceService?: string;
  componentId?: string;
  detail: string;
}

const SERVICES: FixedService[] = [
  { id: "occ-core", label: "OCC Core", sourceService: "occ-core", componentId: "core-runtime", detail: "等待核心服务响应" },
  { id: "occ-ai", label: "AI Service", sourceService: "occ-ai", detail: "等待智能服务响应" },
  { id: "postgresql", label: "PostgreSQL", componentId: "postgresql", detail: "等待 Core 上报依赖状态" },
  { id: "flowable", label: "Flowable", componentId: "flowable", detail: "等待 Core 上报依赖状态" },
  { id: "opa", label: "OPA", componentId: "opa", detail: "等待 Core 上报依赖状态" },
  { id: "kafka", label: "Kafka", componentId: "kafka", detail: "等待 Core 上报依赖状态" },
  { id: "redis", label: "Redis", componentId: "redis", detail: "等待 Core 上报依赖状态" },
  { id: "minio", label: "MinIO", componentId: "minio", detail: "等待 Core 上报依赖状态" },
];

const STATE_META: Record<ServiceState, { label: string; icon: LucideIcon; className: string }> = {
  READY: { label: "就绪", icon: CheckCircle2, className: "ready" },
  DEGRADED: { label: "降级", icon: AlertTriangle, className: "degraded" },
  UNREACHABLE: { label: "不可达", icon: OctagonX, className: "unreachable" },
  CHECKING: { label: "检查中", icon: CircleHelp, className: "checking" },
};

function findComponent(statuses: SystemStatus[], componentId: string): ComponentStatus | undefined {
  return statuses
    .find(({ service }) => service === "occ-core")
    ?.components.find((component) => component.id === componentId);
}

function serviceView(service: FixedService, statuses: SystemStatus[]) {
  if (service.sourceService) {
    const status = statuses.find(({ service: name }) => name === service.sourceService);
    if (status && service.componentId && status.state !== "UNREACHABLE") {
      const component = status.components.find(({ id }) => id === service.componentId);
      return component
        ? { state: component.state, detail: component.detail ?? `版本 ${status.version}` }
        : { state: "CHECKING" as const, detail: service.detail };
    }
    return status
      ? {
          state: status.state,
          detail: status.state === "UNREACHABLE" ? "服务端点无响应" : `版本 ${status.version}`,
        }
      : { state: "CHECKING" as const, detail: service.detail };
  }

  const core = statuses.find(({ service }) => service === "occ-core");
  if (core?.state === "UNREACHABLE") {
    return { state: "UNREACHABLE" as const, detail: "Core 不可达，依赖状态未知" };
  }
  const component = service.componentId ? findComponent(statuses, service.componentId) : undefined;
  return component
    ? { state: component.state, detail: component.detail ?? "依赖状态已上报" }
    : { state: "CHECKING" as const, detail: service.detail };
}

function StatusMark({ state }: { state: ServiceState }) {
  const meta = STATE_META[state];
  const Icon = meta.icon;
  return (
    <span className={`status-mark status-${meta.className}`}>
      <Icon aria-hidden="true" size={15} strokeWidth={2} />
      {meta.label}
    </span>
  );
}

function Overview({ statuses }: { statuses: SystemStatus[] }) {
  return (
    <>
      <section className="metric-grid" aria-label="关键指标">
        {METRICS.map(({ label, icon: Icon }) => (
          <article className="metric" key={label}>
            <div className="metric-label"><Icon aria-hidden="true" size={17} /><span>{label}</span></div>
            <strong>--</strong>
            <small>暂无遥测</small>
          </article>
        ))}
      </section>
      <div className="overview-grid">
        <section className="panel status-panel" aria-labelledby="service-status-title">
          <div className="panel-heading">
            <div><h2 id="service-status-title">服务状态</h2><p>运行时与基础依赖</p></div>
            <span className="row-count">8 项</span>
          </div>
          <div className="status-table" role="table" aria-label="服务状态">
            <div className="status-table-head" role="row">
              <span role="columnheader">服务</span><span role="columnheader">状态</span><span role="columnheader">运行详情</span>
            </div>
            {SERVICES.map((service) => {
              const view = serviceView(service, statuses);
              return (
                <div className="status-row" role="row" key={service.id}>
                  <strong role="cell">{service.label}</strong>
                  <span role="cell"><StatusMark state={view.state} /></span>
                  <span className="status-detail" role="cell">{view.detail}</span>
                </div>
              );
            })}
          </div>
        </section>
        <section className="panel workflow-panel" aria-labelledby="workflow-title">
          <div className="panel-heading"><div><h2 id="workflow-title">活动流程</h2><p>当前执行摘要</p></div></div>
          <div className="empty-state"><Workflow aria-hidden="true" size={24} /><strong>等待流程遥测</strong><span>尚未收到流程运行数据</span></div>
        </section>
        <section className="panel intervention-panel" aria-labelledby="intervention-title">
          <div className="panel-heading"><div><h2 id="intervention-title">人工介入队列</h2><p>异常、审批与策略阻断</p></div><span className="row-count" aria-label="队列数量未知">--</span></div>
          <div className="empty-state compact"><Sparkles aria-hidden="true" size={22} /><strong>等待介入队列遥测</strong><span>尚未收到人工介入队列数据</span></div>
        </section>
      </div>
    </>
  );
}

export function AppShell({ state, statuses, onLogout, onProfileSave, onRetry }: AppShellProps) {
  const identity = state.mode === "authenticated" ? state.identity : state.cachedIdentity;
  const resolution = resolveRoute(state.route?.path ?? "", identity.capabilities);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const title = resolution.kind === "route"
    ? resolution.route.title
    : resolution.kind === "access-denied"
      ? "访问被拒绝"
      : "页面不存在";

  useEffect(() => {
    if ((state.route?.focusToken ?? 0) > 0) headingRef.current?.focus();
  }, [state.route?.focusToken]);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">序</span>
          <div><strong>创序 OCC</strong><small>运营控制中心</small></div>
        </div>
        <nav aria-label="主导航">
          {visibleRoutes(identity.capabilities).map(({ path, label, icon: Icon }) => (
            <Tooltip title={label} placement="right" key={path}>
              <a
                aria-current={state.route?.path === path ? "page" : undefined}
                aria-label={label}
                className={state.route?.path === path ? "nav-item active" : "nav-item"}
                href={`#${path}`}
              >
                <Icon aria-hidden="true" size={18} /><span>{label}</span>
              </a>
            </Tooltip>
          ))}
        </nav>
        <div className="operator">
          <span className="operator-avatar">{identity.displayName.slice(0, 1)}</span>
          <div>
            <strong>{identity.displayName}</strong>
            <small>{state.profile.name} · {ENVIRONMENT_LABELS[state.profile.environment]}</small>
          </div>
          <div className="operator-actions">
            <Tooltip title="服务器配置"><a href="#/settings" aria-label="服务器配置"><Settings aria-hidden="true" size={16} /></a></Tooltip>
            <Tooltip title="退出登录"><button type="button" aria-label="退出登录" onClick={() => void onLogout()}><LogOut aria-hidden="true" size={16} /></button></Tooltip>
          </div>
        </div>
      </aside>

      <main className="workspace">
        <StatusBanner
          mode={state.mode}
          lastFreshAt={state.lastFreshAt}
          retryAvailable={state.mode === "reconnecting" && state.retryAvailable}
          {...(onRetry ? { onRetry } : {})}
        />
        <header className="workspace-header">
          <div>
            <p className="section-kicker">{resolution.kind === "route" ? resolution.route.description : "运营控制中心"}</p>
            <h1 ref={headingRef} tabIndex={-1}>{title}</h1>
          </div>
        </header>
        <span className="sr-only" aria-live="polite" data-testid="page-announcement">{title}</span>

        {resolution.kind === "access-denied" ? (
          <section className="access-state" role="alert"><strong>当前账户无权访问此页面。</strong></section>
        ) : resolution.kind === "not-found" ? (
          <section className="access-state"><strong>找不到请求的页面。</strong></section>
        ) : resolution.route.path === "/overview" ? (
          <Overview statuses={statuses} />
        ) : resolution.route.path === "/settings" ? (
          <ProfileBootstrap
            profiles={state.profiles}
            profile={state.profile}
            disabled={state.mode !== "authenticated"}
            onSave={onProfileSave}
            onSelect={() => undefined}
          />
        ) : (
          <section className="panel unavailable-workspace">
            <strong>工作区数据接口尚不可用</strong>
            <p>所需资源：{resolution.route.unavailableResourceGroups.join("、")}</p>
          </section>
        )}
      </main>
    </div>
  );
}
