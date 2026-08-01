import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { CommandReceipt, ProfileInput, ServerProfile, WorkspaceCommand } from "../src/desktop-contract";
import { Administration } from "../src/renderer/workspaces/Administration";
import { Settings } from "../src/renderer/workspaces/Settings";

const fetchedAt = "2026-08-01T12:00:00.000Z";
const current: ServerProfile = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Pilot",
  origin: "https://pilot.example.com",
  environment: "pilot",
  caFingerprint: "A".repeat(64),
};
const secondary: ServerProfile = {
  id: "00000000-0000-4000-8000-000000000002",
  name: "Production",
  origin: "https://occ.example.com",
  environment: "production",
};

const query = { search: "", filters: {}, sort: "updated-desc" } as const;
const execute = async (_command: WorkspaceCommand): Promise<CommandReceipt> => ({
  state: "completed",
  commandId: "00000000-0000-4000-8000-000000000003",
  correlationId: "00000000-0000-4000-8000-000000000004",
});

describe("Administration", () => {
  const renderAdministration = (overrides = {}) => render(<Administration
    result={{ state: "empty", fetchedAt }}
    query={query}
    capabilities={[]}
    connectivity="online"
    authenticated
    onQueryChange={vi.fn()}
    onRefresh={vi.fn()}
    onExecute={execute}
    {...overrides}
  />);

  it("exposes the approved administration tabs and their named controls", () => {
    renderAdministration();
    const tabs = screen.getByRole("tablist", { name: "管理分类" });
    expect(within(tabs).getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "人员", "关系", "角色", "策略发布", "智能服务", "知识", "保留策略", "审计",
    ]);

    expect(screen.getByRole("button", { name: "创建人员" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "停用人员" })).toBeDisabled();
    fireEvent.click(screen.getByRole("tab", { name: "关系" }));
    expect(screen.getByRole("button", { name: "分配角色" })).toBeDisabled();
    fireEvent.click(screen.getByRole("tab", { name: "策略发布" }));
    expect(screen.getByRole("button", { name: "发布策略" })).toBeDisabled();
    fireEvent.click(screen.getByRole("tab", { name: "智能服务" }));
    expect(screen.getByRole("button", { name: "测试智能服务" })).toBeDisabled();
    expect(screen.getByText("智能服务测试 API 合同尚未集成")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "知识" }));
    expect(screen.getByRole("button", { name: "导入知识" })).toBeDisabled();
    fireEvent.click(screen.getByRole("tab", { name: "审计" }));
    expect(screen.getByRole("button", { name: "检查审计" })).toBeDisabled();
  });

  it("rejects records containing provider secrets instead of echoing them", () => {
    renderAdministration({
      result: {
        state: "ready",
        items: [{ subject: "Provider", type: "ai", status: "disabled", updatedAt: fetchedAt, apiKey: "raw-provider-secret" }],
        count: 1,
        fetchedAt,
      },
    });
    expect(screen.getByLabelText("数据校验错误")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("raw-provider-secret");
  });

  it("uses semantic tabs and blocks forced offline command submission", () => {
    const onExecute = vi.fn(execute);
    const { container } = renderAdministration({ connectivity: "reconnecting", capabilities: ["people.manage"], onExecute });
    const selected = screen.getByRole("tab", { name: "人员" });
    expect(selected).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveAccessibleName("人员");
    for (const form of container.querySelectorAll(".command-panel")) fireEvent.submit(form);
    expect(onExecute).not.toHaveBeenCalled();
    expect(screen.getAllByText("重新连接时更改操作已锁定").length).toBeGreaterThan(0);
  });
});

describe("Settings", () => {
  const callbacks = () => ({
    onSelect: vi.fn(async (_id: string) => undefined),
    onSave: vi.fn(async (_input: ProfileInput) => undefined),
    onRemove: vi.fn(async (_id: string) => undefined),
    onPreferencesChange: vi.fn(async (_preferences: { theme: string; reducedMotion: boolean }) => undefined),
    onLogout: vi.fn(async () => undefined),
  });

  it("selects and edits profiles through explicit callbacks", () => {
    const handlers = callbacks();
    render(<Settings profiles={[current, secondary]} current={current} connectivity="online" {...handlers} />);
    fireEvent.click(screen.getByRole("button", { name: "使用 Production" }));
    expect(handlers.onSelect).toHaveBeenCalledWith(secondary.id);

    fireEvent.change(screen.getByLabelText("配置名称"), { target: { value: "Pilot updated" } });
    fireEvent.submit(screen.getByRole("form", { name: "编辑服务器配置" }));
    expect(handlers.onSave).toHaveBeenCalledWith(expect.objectContaining({ id: current.id, name: "Pilot updated" }));
    fireEvent.click(screen.getByRole("tab", { name: "TLS 信任" }));
    expect(screen.getByText(current.caFingerprint!)).toBeInTheDocument();
    expect(screen.getByText("已固定 SHA-256 指纹")).toBeInTheDocument();
  });

  it("warns and requires explicit confirmation before deleting the selected profile", () => {
    const handlers = callbacks();
    render(<Settings profiles={[current]} current={current} connectivity="online" {...handlers} />);
    fireEvent.click(screen.getByRole("button", { name: "移除 Pilot" }));
    const dialog = screen.getByRole("dialog", { name: "确认移除配置" });
    expect(dialog).toHaveTextContent("当前选中的配置");
    expect(handlers.onRemove).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "确认移除" }));
    expect(handlers.onRemove).toHaveBeenCalledWith(current.id);
  });

  it.each(["offline", "reconnecting"] as const)("handler-guards every mutation while %s", (connectivity) => {
    const handlers = callbacks();
    const { container } = render(<Settings profiles={[current, secondary]} current={current} connectivity={connectivity} {...handlers} />);
    fireEvent.click(screen.getByRole("button", { name: "使用 Production" }));
    fireEvent.submit(screen.getByRole("form", { name: "编辑服务器配置" }));
    fireEvent.click(screen.getByRole("button", { name: "移除 Pilot" }));
    fireEvent.click(screen.getByRole("tab", { name: "偏好" }));
    fireEvent.change(screen.getByLabelText("主题"), { target: { value: "dark" } });
    fireEvent.click(screen.getByRole("tab", { name: "会话" }));
    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
    for (const form of container.querySelectorAll("form")) fireEvent.submit(form);
    expect(handlers.onSelect).not.toHaveBeenCalled();
    expect(handlers.onSave).not.toHaveBeenCalled();
    expect(handlers.onRemove).not.toHaveBeenCalled();
    expect(handlers.onPreferencesChange).not.toHaveBeenCalled();
    expect(handlers.onLogout).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent(connectivity === "offline" ? "离线" : "重新连接");
  });

  it("updates preferences, logs out, and exposes no certificate-store or shell controls", () => {
    const handlers = callbacks();
    render(<Settings profiles={[secondary]} current={secondary} connectivity="online" {...handlers} />);
    fireEvent.click(screen.getByRole("tab", { name: "偏好" }));
    fireEvent.change(screen.getByLabelText("主题"), { target: { value: "dark" } });
    expect(handlers.onPreferencesChange).toHaveBeenCalledWith({ theme: "dark", reducedMotion: false });
    fireEvent.click(screen.getByLabelText("减少动态效果"));
    expect(handlers.onPreferencesChange).toHaveBeenLastCalledWith({ theme: "dark", reducedMotion: true });
    fireEvent.click(screen.getByRole("tab", { name: "会话" }));
    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
    expect(handlers.onLogout).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: /证书|certificate|shell|终端/i })).not.toBeInTheDocument();
  });
});
