import type { CurrentUser, SystemStatus } from "@innorder/contracts";
import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/renderer/App";
import type { OccApi, ServerProfile } from "../src/desktop-contract";

const checkedAt = "2026-07-28T08:00:00.000Z";
const profile: ServerProfile = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Pilot",
  origin: "https://pilot.example.test",
  environment: "pilot",
};
const user: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000002",
  username: "operator",
  displayName: "值班操作员",
  status: "ACTIVE",
  capabilities: ["occ.read", "occ.admin"],
};

function status(
  service: string,
  state: SystemStatus["state"],
  components: SystemStatus["components"] = [],
): SystemStatus {
  const canonical = service === "occ-core" && state !== "UNREACHABLE" && !components.some(({ id }) => id === "core-runtime")
    ? [{ id: "core-runtime", label: "Core Runtime", state: "READY" as const, checkedAt }, ...components]
    : components;
  return { service, version: "0.1.0", state, checkedAt, components: canonical };
}

function mockStatuses(statuses: SystemStatus[]): void {
  const api: OccApi = {
    profiles: {
      list: vi.fn().mockResolvedValue([profile]),
      current: vi.fn().mockResolvedValue(profile),
      save: vi.fn().mockResolvedValue(profile),
      select: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    },
    session: {
      restore: vi.fn().mockResolvedValue({
        state: "authenticated",
        user,
        expiresAt: "2099-08-01T13:00:00.000Z",
      }),
      login: vi.fn(),
      logout: vi.fn().mockResolvedValue(undefined),
    },
    runtime: { statuses: vi.fn().mockResolvedValue(statuses) },
    workspaces: { query: vi.fn() },
    commands: { execute: vi.fn() },
    uploads: { start: vi.fn(), cancel: vi.fn() },
    notifications: {
      list: vi.fn().mockResolvedValue({ items: [] }),
      subscribe: vi.fn(() => vi.fn()),
    },
  };
  Object.defineProperty(window, "occ", {
    configurable: true,
    value: api,
  });
  window.location.hash = "#/overview";
}

afterEach(() => {
  vi.useRealTimers();
});

describe("OCC operations workspace", () => {
  it("renders capability navigation, metrics, and service rows", async () => {
    mockStatuses([]);
    render(<App />);

    for (const item of [
      "总览",
      "我的工作",
      "流程",
      "介入中心",
      "风险",
      "资源",
      "领域设计",
      "管理",
      "系统",
      "设置",
    ]) {
      expect(await screen.findByRole("navigation")).toHaveTextContent(item);
    }

    for (const metric of ["进行中流程", "今日待办", "待审核", "高风险"]) {
      expect(screen.getByText(metric)).toBeInTheDocument();
    }

    for (const service of [
      "OCC Core",
      "AI Service",
      "PostgreSQL",
      "Flowable",
      "OPA",
      "Kafka",
      "Redis",
      "MinIO",
    ]) {
      expect(screen.getByRole("row", { name: new RegExp(service) })).toBeInTheDocument();
    }
  });

  it("renders READY, DEGRADED, and UNREACHABLE as semantic text", async () => {
    mockStatuses([
      status("occ-core", "READY", [
        {
          id: "postgresql",
          label: "PostgreSQL",
          state: "DEGRADED",
          detail: "连接池容量受限",
          checkedAt,
        },
      ]),
      status("occ-ai", "UNREACHABLE"),
    ]);
    render(<App />);

    expect(await within(await screen.findByRole("row", { name: /OCC Core/ })).findByText("就绪")).toBeInTheDocument();
    expect(within(screen.getByRole("row", { name: /PostgreSQL/ })).getByText("降级")).toBeInTheDocument();
    expect(within(screen.getByRole("row", { name: /AI Service/ })).getByText("不可达")).toBeInTheDocument();
  });

  it("uses canonical core-runtime telemetry instead of aggregate dependency state", async () => {
    mockStatuses([
      status("occ-core", "DEGRADED", [
        { id: "core-runtime", label: "Core Runtime", state: "READY", checkedAt },
        { id: "opa", label: "OPA", state: "UNREACHABLE", checkedAt },
      ]),
      status("occ-ai", "READY"),
    ]);
    render(<App />);

    expect(await within(await screen.findByRole("row", { name: /OCC Core/ })).findByText("就绪")).toBeInTheDocument();
    expect(within(screen.getByRole("row", { name: /OPA/ })).getByText("不可达")).toBeInTheDocument();
  });

  it("does not use AI components as Core dependency telemetry", async () => {
    mockStatuses([
      status("occ-core", "READY"),
      status("occ-ai", "READY", [
        { id: "opa", label: "OPA", state: "READY", checkedAt },
      ]),
    ]);
    render(<App />);

    expect(await within(await screen.findByRole("row", { name: /OCC Core/ })).findByText("就绪")).toBeInTheDocument();
    expect(within(screen.getByRole("row", { name: /OPA/ })).getByText("检查中")).toBeInTheDocument();
  });

  it("marks Core dependencies unreachable when Core is unreachable", async () => {
    mockStatuses([
      status("occ-core", "UNREACHABLE"),
      status("occ-ai", "READY"),
    ]);
    render(<App />);

    expect(await within(await screen.findByRole("row", { name: /OCC Core/ })).findByText("不可达")).toBeInTheDocument();
    for (const dependency of ["PostgreSQL", "Flowable", "OPA", "Kafka", "Redis", "MinIO"]) {
      expect(
        within(screen.getByRole("row", { name: new RegExp(dependency) })).getByText(
          "不可达",
        ),
      ).toBeInTheDocument();
    }
  });

  it("keeps omitted dependency telemetry checking while Core is reachable", async () => {
    mockStatuses([
      status("occ-core", "READY"),
      status("occ-ai", "READY"),
    ]);
    render(<App />);

    expect(await within(await screen.findByRole("row", { name: /OCC Core/ })).findByText("就绪")).toBeInTheDocument();
    for (const dependency of ["PostgreSQL", "Flowable", "OPA", "Kafka", "Redis", "MinIO"]) {
      expect(
        within(screen.getByRole("row", { name: new RegExp(dependency) })).getByText(
          "检查中",
        ),
      ).toBeInTheDocument();
    }
  });

  it("presents unavailable business telemetry as unknown", async () => {
    mockStatuses([]);
    render(<App />);

    await screen.findByText("进行中流程");
    for (const label of ["进行中流程", "今日待办", "待审核", "高风险"]) {
      const metric = screen.getByText(label).closest("article");
      expect(metric).not.toBeNull();
      expect(within(metric as HTMLElement).getByText("--")).toBeInTheDocument();
      expect(within(metric as HTMLElement).getByText("暂无遥测")).toBeInTheDocument();
    }

    expect(screen.getByText("等待流程遥测")).toBeInTheDocument();
    expect(screen.getByText("等待介入队列遥测")).toBeInTheDocument();
    expect(screen.queryByText("暂无运行中的流程")).not.toBeInTheDocument();
    expect(screen.queryByText("暂无待人工介入事项")).not.toBeInTheDocument();
    expect(screen.queryByText("0 项")).not.toBeInTheDocument();
  });
});
