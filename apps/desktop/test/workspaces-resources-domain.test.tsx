import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { WorkspaceResult } from "../src/desktop-contract";
import { DomainDesign } from "../src/renderer/workspaces/DomainDesign";
import { Resources } from "../src/renderer/workspaces/Resources";

const fetchedAt = "2026-08-01T12:00:00.000Z";
const initialQuery = { search: "", filters: {}, sort: "name-asc" } as const;
const callbacks = () => ({
  onQueryChange: vi.fn(),
  onRefresh: vi.fn(),
  onExecute: vi.fn(),
  onConflictRefresh: vi.fn(),
});

const unavailableResources: WorkspaceResult = {
  state: "unavailable",
  reason: "UNAVAILABLE_CONTRACT",
  resourceGroups: ["/resources", "/reservations"],
  message: "资源 API 合同尚未集成",
};

const unavailableDomain: WorkspaceResult = {
  state: "unavailable",
  reason: "UNAVAILABLE_CONTRACT",
  resourceGroups: ["/packages", "/package-versions", "/policy-releases"],
  message: "领域包 API 合同尚未集成",
};

describe("Resources workspace", () => {
  it("composes canonical tabs, filters, and unavailable command forms", () => {
    const handlers = callbacks();
    render(<Resources
      result={unavailableResources}
      query={initialQuery}
      capabilities={["resources.create", "resources.change", "reservations.create", "reservations.cancel"]}
      online
      authenticated
      {...handlers}
    />);

    expect(screen.getByRole("heading", { name: "资源" })).toBeInTheDocument();
    expect(screen.queryByRole("main")).not.toBeInTheDocument();
    const tabs = screen.getByRole("tablist", { name: "资源视图" });
    expect(within(tabs).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["资源库存", "预留", "冲突"]);
    expect(screen.getByLabelText("资源类型")).toBeInTheDocument();
    expect(screen.getByLabelText("可用性")).toBeInTheDocument();
    expect(screen.getByLabelText("冲突")).toBeInTheDocument();
    expect(screen.getByLabelText("容量")).toBeInTheDocument();
    expect(screen.getByLabelText("开始时间")).toHaveAttribute("type", "datetime-local");
    expect(screen.getByLabelText("结束时间")).toHaveAttribute("type", "datetime-local");
    expect(screen.getByLabelText("独占预留")).toHaveAttribute("type", "checkbox");
    for (const name of ["创建资源", "变更资源", "创建预留", "取消预留"]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
    }
    expect(screen.getByLabelText("工作区合同不可用")).toHaveTextContent("/resources、/reservations");
    expect(document.body).not.toHaveTextContent(/sample|示例|成功/iu);
  });

  it("renders capacity and bounded conflict intervals without participant details", () => {
    const result: WorkspaceResult = {
      state: "ready",
      count: 1,
      fetchedAt,
      items: [{
        id: "resource-1",
        name: "电气安全实验台",
        type: "laboratory",
        state: "available",
        capacity: 4,
        availableCapacity: 1,
        reservation: { id: "reservation-1", start: "2026-08-02T08:00:00Z", end: "2026-08-02T10:00:00Z", capacity: 3, state: "active" },
        conflicts: [{ kind: "capacity", start: "2026-08-02T09:00:00Z", end: "2026-08-02T11:00:00Z", capacity: 2, requesterName: "REDACT-ME" }],
        authorizationDetail: "REDACT-SECRET",
      }],
    };
    render(<Resources
      result={result}
      query={initialQuery}
      capabilities={[]}
      online
      authenticated
      {...callbacks()}
    />);

    const inventory = screen.getByRole("region", { name: "资源库存详情" });
    expect(inventory).toHaveTextContent("电气安全实验台");
    expect(inventory).toHaveTextContent("可用容量 1 / 4");
    fireEvent.click(screen.getByRole("tab", { name: "冲突" }));
    const conflict = screen.getByRole("region", { name: "资源冲突详情" });
    expect(conflict).toHaveTextContent("容量冲突");
    expect(conflict).toHaveTextContent("2026-08-02T09:00:00Z");
    expect(conflict).toHaveTextContent("2026-08-02T11:00:00Z");
    expect(document.body).not.toHaveTextContent(/REDACT-ME|REDACT-SECRET/);
  });

  it("locks query and mutation controls offline and keeps semantic tab state", () => {
    render(<Resources
      result={{ state: "offline", count: 1, fetchedAt, items: [{ id: "resource-1", name: "实验台", type: "lab", state: "available", capacity: 1, availableCapacity: 1, conflicts: [] }] }}
      query={initialQuery}
      capabilities={["resources.create", "resources.change", "reservations.create", "reservations.cancel"]}
      online={false}
      authenticated
      {...callbacks()}
    />);

    expect(screen.getByLabelText("搜索")).toBeDisabled();
    expect(screen.getByRole("button", { name: "刷新" })).toBeDisabled();
    expect(screen.getByLabelText("资源名称")).toBeDisabled();
    const conflictTab = screen.getByRole("tab", { name: "冲突" });
    fireEvent.click(conflictTab);
    expect(conflictTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "冲突" })).toBeInTheDocument();
  });
});

describe("Domain Design workspace", () => {
  it("exposes package lifecycle surfaces without a graphical or source editor", () => {
    render(<DomainDesign
      result={unavailableDomain}
      query={{ search: "", filters: {}, sort: "updated-desc" }}
      capabilities={["packages.import", "packages.validate", "packages.diff", "packages.approve", "packages.publish"]}
      online
      authenticated
      {...callbacks()}
    />);

    expect(screen.getByRole("heading", { name: "领域设计" })).toBeInTheDocument();
    expect(screen.queryByRole("main")).not.toBeInTheDocument();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["草稿", "版本", "校验", "发布"]);
    expect(screen.getByText("包与版本资产")).toBeInTheDocument();
    expect(screen.getByText("校验与版本比较")).toBeInTheDocument();
    expect(screen.getByText("审批与发布职责分离")).toBeInTheDocument();
    expect(screen.getByText(/批准人与导入或修改该版本的人员必须不同/)).toBeInTheDocument();
    const archive = screen.getByLabelText("签名领域包归档");
    expect(archive).toHaveAttribute("type", "file");
    expect(archive).toHaveAttribute("accept", ".zip,application/zip");
    expect(screen.getByText(/最大 10 MiB/)).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /源码|BPMN|DMN|Rego/ })).not.toBeInTheDocument();
    expect(document.querySelector("textarea")).not.toBeInTheDocument();
    for (const name of ["导入", "校验", "比较版本", "批准", "发布"]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
    }
  });

  it("uses exact command capabilities and renders validated assets, diff, and approval state safely", () => {
    const result: WorkspaceResult = {
      state: "ready",
      count: 1,
      fetchedAt,
      items: [{
        id: "package-1",
        name: "embedded-medical-device-pilot",
        version: "1.0.0",
        status: "validated",
        assets: [{ name: "process.bpmn", kind: "BPMN", digest: "sha256:abc" }, { name: "rules.dmn", kind: "DMN", digest: "sha256:def" }],
        validation: { state: "passed", summary: "12 checks passed" },
        diff: { baseVersion: "0.9.0", summary: "2 assets changed" },
        approval: { state: "pending", actor: "REDACT-ACTOR" },
        source: "REDACT-SOURCE",
      }],
    };
    render(<DomainDesign
      result={result}
      query={{ search: "", filters: {}, sort: "updated-desc" }}
      capabilities={[]}
      online
      authenticated
      {...callbacks()}
    />);

    expect(screen.getByText("embedded-medical-device-pilot")).toBeInTheDocument();
    expect(screen.getByText("process.bpmn")).toBeInTheDocument();
    expect(screen.getByText("12 checks passed")).toBeInTheDocument();
    expect(screen.getByText("2 assets changed")).toBeInTheDocument();
    expect(screen.getByText("缺少能力：packages.approve")).toBeInTheDocument();
    expect(screen.getByText("缺少能力：packages.publish")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/REDACT-ACTOR|REDACT-SOURCE/);
  });
});
