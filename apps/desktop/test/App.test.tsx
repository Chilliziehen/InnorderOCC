import type { SystemStatus } from "@innorder/contracts";
import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/renderer/App";

const checkedAt = "2026-07-28T08:00:00.000Z";

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
  Object.defineProperty(window, "occ", {
    configurable: true,
    value: { runtime: { statuses: vi.fn().mockResolvedValue(statuses) } },
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("OCC operations workspace", () => {
  it("renders fixed navigation, metrics, and service rows", () => {
    mockStatuses([]);
    render(<App />);

    for (const item of [
      "总览",
      "今日任务",
      "流程",
      "审核队列",
      "风险",
      "领域包",
      "系统",
    ]) {
      expect(screen.getByRole("navigation")).toHaveTextContent(item);
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

    expect(await within(screen.getByRole("row", { name: /OCC Core/ })).findByText("就绪")).toBeInTheDocument();
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

    expect(await within(screen.getByRole("row", { name: /OCC Core/ })).findByText("就绪")).toBeInTheDocument();
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

    expect(await within(screen.getByRole("row", { name: /OCC Core/ })).findByText("就绪")).toBeInTheDocument();
    expect(within(screen.getByRole("row", { name: /OPA/ })).getByText("检查中")).toBeInTheDocument();
  });

  it("marks Core dependencies unreachable when Core is unreachable", async () => {
    mockStatuses([
      status("occ-core", "UNREACHABLE"),
      status("occ-ai", "READY"),
    ]);
    render(<App />);

    await within(screen.getByRole("row", { name: /OCC Core/ })).findByText("不可达");
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

    await within(screen.getByRole("row", { name: /OCC Core/ })).findByText("就绪");
    for (const dependency of ["PostgreSQL", "Flowable", "OPA", "Kafka", "Redis", "MinIO"]) {
      expect(
        within(screen.getByRole("row", { name: new RegExp(dependency) })).getByText(
          "检查中",
        ),
      ).toBeInTheDocument();
    }
  });

  it("presents unavailable business telemetry as unknown", () => {
    mockStatuses([]);
    render(<App />);

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
