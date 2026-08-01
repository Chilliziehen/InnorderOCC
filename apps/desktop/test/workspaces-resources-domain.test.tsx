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
const archiveCallbacks = () => ({
  ...callbacks(),
  maxArchiveBytes: 10 * 1024 * 1024,
  onArchiveUpload: vi.fn(),
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
      const button = screen.getByRole("button", { name });
      expect(button).toBeDisabled();
      fireEvent.submit(button.closest("form")!);
    }
    expect(screen.getByText("资源名称、类型或总容量无效")).toBeInTheDocument();
    expect(screen.getByText("资源编号、版本或容量无效")).toBeInTheDocument();
    expect(screen.getByText("预留资源、时间区间、容量或版本无效")).toBeInTheDocument();
    expect(screen.getByText("预留编号或版本无效")).toBeInTheDocument();
    expect(handlers.onExecute).not.toHaveBeenCalled();
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
        capacity: 4.5,
        availableCapacity: 1.25,
        reservations: [
          { id: "reservation-1", start: "2026-08-02T08:00:00Z", end: "2026-08-02T10:00:00Z", capacity: 3.25, state: "active" },
          { id: "reservation-2", start: "2026-08-03T08:00:00Z", end: "2026-08-03T09:00:00Z", capacity: 0.5, state: "pending" },
        ],
        conflicts: [{ kind: "capacity", start: "2026-08-02T09:00:00Z", end: "2026-08-02T11:00:00Z", capacity: 0.75, requesterName: "REDACT-ME" }],
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
    expect(inventory).toHaveTextContent("可用容量 1.25 / 4.5");
    fireEvent.click(screen.getByRole("tab", { name: "预留" }));
    const reservations = screen.getByRole("region", { name: "资源预留详情" });
    expect(reservations).toHaveTextContent("reservation-1");
    expect(reservations).toHaveTextContent("reservation-2");
    fireEvent.click(screen.getByRole("tab", { name: "冲突" }));
    const conflict = screen.getByRole("region", { name: "资源冲突详情" });
    expect(conflict).toHaveTextContent("容量冲突");
    expect(conflict).toHaveTextContent("2026-08-02T09:00:00Z");
    expect(conflict).toHaveTextContent("2026-08-02T11:00:00Z");
    expect(document.body).not.toHaveTextContent(/REDACT-ME|REDACT-SECRET/);
  });

  it("locks query and mutation controls offline and keeps semantic tab state", () => {
    render(<Resources
      result={{ state: "offline", count: 1, fetchedAt, items: [{ id: "resource-1", name: "实验台", type: "lab", state: "available", capacity: 1, availableCapacity: 1, reservations: [], conflicts: [] }] }}
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

  it("rejects invalid resource capacity contracts without rendering unsafe fields", () => {
    render(<Resources
      result={{ state: "ready", count: 1, fetchedAt, items: [{ id: "resource-1", name: "实验台", type: "lab", state: "available", capacity: 1, availableCapacity: 2, reservations: [], conflicts: [], secret: "REDACT-CAPACITY" }] }}
      query={initialQuery}
      capabilities={[]}
      online
      authenticated
      {...callbacks()}
    />);

    expect(screen.getByRole("region", { name: "数据校验错误" })).toHaveTextContent("数据格式无效");
    expect(document.body).not.toHaveTextContent("REDACT-CAPACITY");
  });

  it("accepts a strictly valid resource draft but still stops at the unavailable command contract", () => {
    render(<Resources
      result={unavailableResources}
      query={initialQuery}
      capabilities={["resources.create"]}
      online
      authenticated
      {...callbacks()}
    />);
    const section = screen.getByRole("heading", { name: "创建资源", level: 3 }).closest("section")!;
    const name = within(section).getByLabelText("资源名称");
    const type = within(section).getByLabelText("新资源类型");
    const capacity = within(section).getByLabelText("容量");
    expect(within(section).queryByLabelText("初始可用容量")).not.toBeInTheDocument();
    expect(name).toBeEnabled();

    fireEvent.change(name, { target: { value: "实验台" } });
    fireEvent.change(type, { target: { value: "laboratory" } });
    fireEvent.change(capacity, { target: { value: "0" } });
    expect(within(section).getByText("资源名称、类型或总容量无效")).toBeInTheDocument();
    fireEvent.change(capacity, { target: { value: "1.5" } });

    expect(within(section).queryByText("资源名称、类型或总容量无效")).not.toBeInTheDocument();
    expect(within(section).getByText("资源创建 API 合同尚未集成")).toBeInTheDocument();
    expect(within(section).getByRole("button", { name: "创建资源" })).toBeDisabled();
  });

  it("accepts positive fractional reservation capacity and blocks zero", () => {
    render(<Resources result={unavailableResources} query={initialQuery} capabilities={["reservations.create"]} online authenticated {...callbacks()} />);
    const section = screen.getByRole("heading", { name: "创建预留", level: 3 }).closest("section")!;
    fireEvent.change(within(section).getByLabelText("预留资源编号"), { target: { value: "resource-1" } });
    fireEvent.change(within(section).getByLabelText("开始时间"), { target: { value: "2026-08-02T08:00" } });
    fireEvent.change(within(section).getByLabelText("结束时间"), { target: { value: "2026-08-02T09:00" } });
    fireEvent.change(within(section).getByLabelText("资源预期版本"), { target: { value: "2" } });
    const capacity = within(section).getByLabelText("预留容量");
    fireEvent.change(capacity, { target: { value: "0" } });
    expect(within(section).getByText("预留资源、时间区间、容量或版本无效")).toBeInTheDocument();
    fireEvent.change(capacity, { target: { value: "0.25" } });
    expect(within(section).queryByText("预留资源、时间区间、容量或版本无效")).not.toBeInTheDocument();
    expect(within(section).getByText("资源预留 API 合同尚未集成")).toBeInTheDocument();
  });

  it("uses roving tab focus with Arrow, Home, End, and labelled panels", () => {
    render(<Resources result={unavailableResources} query={initialQuery} capabilities={[]} online authenticated {...callbacks()} />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);
    fireEvent.keyDown(tabs[0]!, { key: "ArrowRight" });
    expect(tabs[1]).toHaveFocus();
    expect(tabs[1]).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", tabs[1]!.id);
    fireEvent.keyDown(tabs[1]!, { key: "End" });
    expect(tabs[2]).toHaveFocus();
    fireEvent.keyDown(tabs[2]!, { key: "Home" });
    expect(tabs[0]).toHaveFocus();
  });
});

describe("Domain Design workspace", () => {
  it("exposes package lifecycle surfaces without a graphical or source editor", () => {
    const handlers = archiveCallbacks();
    render(<DomainDesign
      result={unavailableDomain}
      query={{ search: "", filters: {}, sort: "updated-desc" }}
      capabilities={["packages.import", "packages.validate", "packages.diff", "packages.approve", "packages.publish"]}
      online
      authenticated
      {...handlers}
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
      const button = screen.getByRole("button", { name });
      expect(button).toBeDisabled();
      fireEvent.submit(button.closest("form")!);
    }
    expect(screen.getByText("包名称、版本、类型或上传引用无效")).toBeInTheDocument();
    expect(screen.getByText("领域包或版本目标无效")).toBeInTheDocument();
    expect(screen.getByText("比较目标或基准版本无效")).toBeInTheDocument();
    expect(screen.getAllByText("版本目标或预期版本无效")).toHaveLength(2);
    expect(handlers.onExecute).not.toHaveBeenCalled();
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
      {...archiveCallbacks()}
    />);

    expect(screen.getByText("embedded-medical-device-pilot")).toBeInTheDocument();
    expect(screen.getByText("process.bpmn")).toBeInTheDocument();
    expect(screen.getByText("12 checks passed")).toBeInTheDocument();
    expect(screen.getByText("2 assets changed")).toBeInTheDocument();
    expect(screen.getByText("缺少能力：packages.approve")).toBeInTheDocument();
    expect(screen.getByText("缺少能力：packages.publish")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/REDACT-ACTOR|REDACT-SOURCE/);
  });

  it("does not select or upload an archive while packages.import is unavailable", () => {
    const onArchiveUpload = vi.fn();
    render(<DomainDesign
      result={unavailableDomain}
      query={{ search: "", filters: {}, sort: "updated-desc" }}
      capabilities={["packages.import"]}
      online
      authenticated
      maxArchiveBytes={8}
      onArchiveUpload={onArchiveUpload}
      {...callbacks()}
    />);
    const file = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x01])], "pilot.zip", { type: "application/zip" });

    const input = screen.getByLabelText("签名领域包归档");
    expect(input).toBeDisabled();
    fireEvent.change(input, { target: { files: [file] } });
    const upload = screen.getByRole("button", { name: "上传归档" });
    expect(upload).toBeDisabled();
    fireEvent.click(upload);
    expect(onArchiveUpload).not.toHaveBeenCalled();
    expect(screen.queryByText("归档上传完成")).not.toBeInTheDocument();
  });

  it("uses roving focus for domain tabs", () => {
    render(<DomainDesign result={unavailableDomain} query={{ search: "", filters: {}, sort: "updated-desc" }} capabilities={[]} online authenticated {...archiveCallbacks()} />);
    const tabs = screen.getAllByRole("tab");
    fireEvent.keyDown(tabs[0]!, { key: "ArrowLeft" });
    expect(tabs[3]).toHaveFocus();
    expect(tabs[3]).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", tabs[3]!.id);
  });
});
