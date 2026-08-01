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
    workspaces: { query: vi.fn().mockResolvedValue({
      state: "unavailable",
      reason: "UNAVAILABLE_CONTRACT",
      resourceGroups: ["/me", "/tasks", "/processes", "/risks"],
      message: "总览业务 API 合同尚未集成",
    }) },
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
  it("renders capability navigation and the integrated overview controls", async () => {
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

    expect(screen.getByRole("tablist", { name: "运行总览视图" })).toBeInTheDocument();
    expect(screen.getByRole("form", { name: "查询工具" })).toBeInTheDocument();
    expect(await screen.findByText("总览业务 API 合同尚未集成")).toBeInTheDocument();
  });

  it("passes profile-scoped statuses to the integrated overview", async () => {
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

    expect(await within(await screen.findByRole("row", { name: /occ-core/ })).findByText("就绪")).toBeInTheDocument();
    expect(within(screen.getByRole("row", { name: /occ-ai/ })).getByText("不可达")).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /occ-core/ })).toHaveTextContent("pilot");
  });

  it("presents unavailable business telemetry as unknown", async () => {
    mockStatuses([]);
    render(<App />);

    await screen.findByText("进行中流程");
    for (const label of ["关注事项", "时限", "风险", "进行中流程"]) {
      const metric = screen.getByRole("heading", { level: 2, name: label }).closest("article");
      expect(metric).not.toBeNull();
      expect(within(metric as HTMLElement).getByText("--")).toBeInTheDocument();
      expect(within(metric as HTMLElement).getByText("不可用")).toBeInTheDocument();
    }
    expect(await screen.findByText("总览业务 API 合同尚未集成")).toBeInTheDocument();
  });
});
