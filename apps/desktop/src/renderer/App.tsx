import type {
  ComponentStatus,
  ServiceState,
  SystemStatus,
} from "@innorder/contracts";
import { ConfigProvider, Tooltip } from "antd";
import {
  AlertTriangle,
  Boxes,
  CheckCircle2,
  CircleGauge,
  CircleHelp,
  ClipboardCheck,
  Clock3,
  FileCheck2,
  GitBranch,
  ListTodo,
  OctagonX,
  Settings,
  ShieldAlert,
  Sparkles,
  Workflow,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { startStatusPolling } from "./status-client";

const NAVIGATION: Array<{ label: string; icon: LucideIcon }> = [
  { label: "总览", icon: CircleGauge },
  { label: "今日任务", icon: ListTodo },
  { label: "流程", icon: Workflow },
  { label: "审核队列", icon: FileCheck2 },
  { label: "风险", icon: ShieldAlert },
  { label: "领域包", icon: Boxes },
  { label: "系统", icon: Settings },
];

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
  {
    id: "occ-core",
    label: "OCC Core",
    sourceService: "occ-core",
    componentId: "core-runtime",
    detail: "等待核心服务响应",
  },
  {
    id: "occ-ai",
    label: "AI Service",
    sourceService: "occ-ai",
    detail: "等待智能服务响应",
  },
  {
    id: "postgresql",
    label: "PostgreSQL",
    componentId: "postgresql",
    detail: "等待 Core 上报依赖状态",
  },
  {
    id: "flowable",
    label: "Flowable",
    componentId: "flowable",
    detail: "等待 Core 上报依赖状态",
  },
  {
    id: "opa",
    label: "OPA",
    componentId: "opa",
    detail: "等待 Core 上报依赖状态",
  },
  {
    id: "kafka",
    label: "Kafka",
    componentId: "kafka",
    detail: "等待 Core 上报依赖状态",
  },
  {
    id: "redis",
    label: "Redis",
    componentId: "redis",
    detail: "等待 Core 上报依赖状态",
  },
  {
    id: "minio",
    label: "MinIO",
    componentId: "minio",
    detail: "等待 Core 上报依赖状态",
  },
];

const STATE_META: Record<
  ServiceState,
  { label: string; icon: LucideIcon; className: string }
> = {
  READY: { label: "就绪", icon: CheckCircle2, className: "ready" },
  DEGRADED: { label: "降级", icon: AlertTriangle, className: "degraded" },
  UNREACHABLE: { label: "不可达", icon: OctagonX, className: "unreachable" },
  CHECKING: { label: "检查中", icon: CircleHelp, className: "checking" },
};

interface ServiceView {
  state: ServiceState;
  detail: string;
}

function findComponent(
  statuses: SystemStatus[],
  componentId: string,
): ComponentStatus | undefined {
  return statuses
    .find(({ service }) => service === "occ-core")
    ?.components.find((component) => component.id === componentId);
}

function serviceView(
  service: FixedService,
  statuses: SystemStatus[],
): ServiceView {
  if (service.sourceService) {
    const status = statuses.find(({ service: name }) => name === service.sourceService);
    if (status && service.componentId && status.state !== "UNREACHABLE") {
      const component = status.components.find(({ id }) => id === service.componentId);
      return component
        ? { state: component.state, detail: component.detail ?? `版本 ${status.version}` }
        : { state: "CHECKING", detail: service.detail };
    }
    return status
      ? {
          state: status.state,
          detail:
            status.state === "UNREACHABLE"
              ? "服务端点无响应"
              : `版本 ${status.version}`,
        }
      : { state: "CHECKING", detail: service.detail };
  }

  const core = statuses.find(({ service }) => service === "occ-core");
  if (core?.state === "UNREACHABLE") {
    return { state: "UNREACHABLE", detail: "Core 不可达，依赖状态未知" };
  }

  const component = service.componentId
    ? findComponent(statuses, service.componentId)
    : undefined;
  return component
    ? { state: component.state, detail: component.detail ?? "依赖状态已上报" }
    : { state: "CHECKING", detail: service.detail };
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

export function App() {
  const [statuses, setStatuses] = useState<SystemStatus[]>([]);

  useEffect(() => startStatusPolling(setStatuses), []);

  return (
    <ConfigProvider
      theme={{
        token: {
          colorPrimary: "#146c68",
          borderRadius: 6,
          fontFamily:
            'Inter, "Noto Sans SC", "Microsoft YaHei", system-ui, sans-serif',
        },
      }}
    >
      <div className="app-shell">
        <aside className="sidebar">
          <div className="brand">
            <span className="brand-mark">序</span>
            <div>
              <strong>创序 OCC</strong>
              <small>运营控制中心</small>
            </div>
          </div>
          <nav aria-label="主导航">
            {NAVIGATION.map(({ label, icon: Icon }, index) => (
              <button
                aria-current={index === 0 ? "page" : undefined}
                className={index === 0 ? "nav-item active" : "nav-item"}
                key={label}
                type="button"
              >
                <Icon aria-hidden="true" size={18} />
                <span>{label}</span>
              </button>
            ))}
          </nav>
          <div className="operator">
            <span className="operator-avatar">值</span>
            <div>
              <strong>值班席位</strong>
              <small>本地工作区</small>
            </div>
          </div>
        </aside>

        <main className="workspace">
          <header className="workspace-header">
            <div>
              <p className="section-kicker">运营控制中心</p>
              <h1>运行总览</h1>
            </div>
            <Tooltip title="状态由本地服务定时上报">
              <span className="poll-indicator" aria-label="状态自动轮询中">
                <span aria-hidden="true" />
                自动轮询
              </span>
            </Tooltip>
          </header>

          <section className="metric-grid" aria-label="关键指标">
            {METRICS.map(({ label, icon: Icon }) => (
              <article className="metric" key={label}>
                <div className="metric-label">
                  <Icon aria-hidden="true" size={17} />
                  <span>{label}</span>
                </div>
                <strong>--</strong>
                <small>暂无遥测</small>
              </article>
            ))}
          </section>

          <div className="overview-grid">
            <section className="panel status-panel" aria-labelledby="service-status-title">
              <div className="panel-heading">
                <div>
                  <h2 id="service-status-title">服务状态</h2>
                  <p>运行时与基础依赖</p>
                </div>
                <span className="row-count">8 项</span>
              </div>
              <div className="status-table" role="table" aria-label="服务状态">
                <div className="status-table-head" role="row">
                  <span role="columnheader">服务</span>
                  <span role="columnheader">状态</span>
                  <span role="columnheader">运行详情</span>
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
              <div className="panel-heading">
                <div>
                  <h2 id="workflow-title">活动流程</h2>
                  <p>当前执行摘要</p>
                </div>
              </div>
              <div className="empty-state">
                <Workflow aria-hidden="true" size={24} />
                <strong>等待流程遥测</strong>
                <span>尚未收到流程运行数据</span>
              </div>
            </section>

            <section className="panel intervention-panel" aria-labelledby="intervention-title">
              <div className="panel-heading">
                <div>
                  <h2 id="intervention-title">人工介入队列</h2>
                  <p>异常、审批与策略阻断</p>
                </div>
                <span className="row-count" aria-label="队列数量未知">--</span>
              </div>
              <div className="empty-state compact">
                <Sparkles aria-hidden="true" size={22} />
                <strong>等待介入队列遥测</strong>
                <span>尚未收到人工介入队列数据</span>
              </div>
            </section>
          </div>
        </main>
      </div>
    </ConfigProvider>
  );
}
