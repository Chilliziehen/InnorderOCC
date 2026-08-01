import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

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

  const expectTabControlsToResolve = () => {
    for (const tab of screen.getAllByRole("tab")) {
      const panelId = tab.getAttribute("aria-controls");
      expect(panelId).toBeTruthy();
      expect(document.getElementById(panelId!)).toBeInTheDocument();
    }
  };

  it("resolves every tab control to the active panel", () => {
    renderAdministration();
    expectTabControlsToResolve();
    fireEvent.click(screen.getByRole("tab", { name: "智能服务" }));
    expectTabControlsToResolve();
    expect(screen.getByRole("tabpanel")).toHaveAccessibleName("智能服务");
  });

  it("renders labelled, tab-specific administration fields", () => {
    renderAdministration();
    expect(screen.getByLabelText("人员姓名")).toBeInTheDocument();
    expect(screen.getByLabelText("人员邮箱")).toBeInTheDocument();
    expect(screen.getByLabelText("停用人员 ID")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "关系" }));
    expect(screen.getByLabelText("关系主体 ID")).toBeInTheDocument();
    expect(screen.getByLabelText("关系对象 ID")).toBeInTheDocument();
    expect(screen.getByLabelText("关系类型")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "角色" }));
    expect(screen.getByLabelText("人员 ID")).toBeInTheDocument();
    expect(screen.getByLabelText("角色 ID")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "策略发布" }));
    expect(screen.getByLabelText("策略发布 ID")).toBeInTheDocument();
    expect(screen.getByLabelText("策略版本")).toBeInTheDocument();
    expect(screen.getByLabelText("已批准发布")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "智能服务" }));
    expect(screen.getByLabelText("服务地址")).toHaveAttribute("type", "url");
    expect(screen.getByLabelText("服务密钥")).toHaveAttribute("type", "password");

    fireEvent.click(screen.getByRole("tab", { name: "知识" }));
    expect(screen.getByLabelText("上传引用")).toBeInTheDocument();
    expect(screen.getByLabelText("知识目标")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "保留策略" }));
    expect(screen.getByLabelText("保留天数")).toBeInTheDocument();
    expect(screen.getByLabelText("法律保留")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "审计" }));
    expect(screen.getByLabelText("审计目标")).toBeInTheDocument();
  });

  it("rejects non-HTTPS provider configuration and clears secrets when leaving the tab", () => {
    const onExecute = vi.fn(execute);
    renderAdministration({ capabilities: ["providers.manage"], onExecute });
    fireEvent.click(screen.getByRole("tab", { name: "智能服务" }));
    fireEvent.change(screen.getByLabelText("服务配置 ID"), { target: { value: "provider-1" } });
    fireEvent.change(screen.getByLabelText("服务地址"), { target: { value: "http://provider.example.com" } });
    fireEvent.change(screen.getByLabelText("服务模型"), { target: { value: "model-1" } });
    fireEvent.change(screen.getByLabelText("服务密钥"), { target: { value: "raw-provider-secret" } });
    fireEvent.submit(within(screen.getByRole("region", { name: "测试智能服务操作" })).getByRole("button", { name: "测试智能服务" }).closest("form")!);
    expect(onExecute).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("HTTPS");
    expect(document.body).not.toHaveTextContent("raw-provider-secret");

    fireEvent.click(screen.getByRole("tab", { name: "审计" }));
    fireEvent.click(screen.getByRole("tab", { name: "智能服务" }));
    expect(screen.getByLabelText("服务密钥")).toHaveValue("");
  });

  it("clears provider secrets when a controlled active tab transitions away", () => {
    const props = {
      result: { state: "empty" as const, fetchedAt },
      query,
      capabilities: ["providers.manage"],
      connectivity: "online" as const,
      authenticated: true,
      onQueryChange: vi.fn(),
      onRefresh: vi.fn(),
      onExecute: execute,
    };
    const { rerender } = render(<Administration {...props} activeTab="providers" />);
    fireEvent.change(screen.getByLabelText("服务密钥"), { target: { value: "controlled-provider-secret" } });

    rerender(<Administration {...props} activeTab="audit" />);
    expect(document.body).not.toHaveTextContent("controlled-provider-secret");
    rerender(<Administration {...props} activeTab="providers" />);
    expect(screen.getByLabelText("服务密钥")).toHaveValue("");
  });

  it("exposes the approved administration tabs and their named controls", () => {
    renderAdministration();
    const tabs = screen.getByRole("tablist", { name: "管理分类" });
    expect(within(tabs).getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "人员", "关系", "角色", "策略发布", "智能服务", "知识", "保留策略", "审计",
    ]);

    expect(screen.getByRole("button", { name: "创建人员" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "停用人员" })).toBeDisabled();
    fireEvent.click(screen.getByRole("tab", { name: "关系" }));
    expect(screen.getByRole("button", { name: "分配关系" })).toBeDisabled();
    expect(screen.getByText("缺少能力：relationships.manage")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "角色" }));
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

  it("supports wrapping Arrow keys plus Home and End in its tablist", () => {
    renderAdministration();
    const first = screen.getByRole("tab", { name: "人员" });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: "审计" })).toHaveFocus();
    expect(screen.getByRole("tabpanel")).toHaveAccessibleName("审计");
    fireEvent.keyDown(screen.getByRole("tab", { name: "审计" }), { key: "Home" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "End" });
    expect(screen.getByRole("tab", { name: "审计" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("tab", { name: "审计" }), { key: "ArrowRight" });
    expect(first).toHaveFocus();
  });
});

describe("Settings", () => {
  const callbacks = () => ({
    onSelect: vi.fn(async (_id: string): Promise<void> => undefined),
    onSave: vi.fn(async (_input: ProfileInput): Promise<void> => undefined),
    onRemove: vi.fn(async (_id: string): Promise<void> => undefined),
    onPreferencesChange: vi.fn(async (_preferences: { theme: string; reducedMotion: boolean }): Promise<void> => undefined),
    onLogout: vi.fn(async (): Promise<void> => undefined),
  });

  it("resolves every settings tab control to the active panel", () => {
    const handlers = callbacks();
    render(<Settings profiles={[current]} current={current} connectivity="online" {...handlers} />);
    for (const tab of screen.getAllByRole("tab")) {
      expect(document.getElementById(tab.getAttribute("aria-controls")!)).toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole("tab", { name: "会话" }));
    expect(screen.getByRole("tabpanel")).toHaveAccessibleName("会话");
  });

  it("strictly blocks invalid forced profile submissions and sends normalized valid input", () => {
    const handlers = callbacks();
    render(<Settings profiles={[]} current={null} connectivity="online" {...handlers} />);
    fireEvent.submit(screen.getByRole("form", { name: "编辑服务器配置" }));
    expect(handlers.onSave).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("配置名称"), { target: { value: "  Pilot  " } });
    fireEvent.change(screen.getByLabelText("服务器源地址"), { target: { value: "https://pilot.example.com/" } });
    fireEvent.submit(screen.getByRole("form", { name: "编辑服务器配置" }));
    expect(handlers.onSave).toHaveBeenCalledWith(expect.objectContaining({
      name: "Pilot",
      origin: "https://pilot.example.com/",
    }));
  });

  it("selects and edits profiles through explicit callbacks", async () => {
    const handlers = callbacks();
    render(<Settings profiles={[current, secondary]} current={current} connectivity="online" {...handlers} />);
    fireEvent.click(screen.getByRole("button", { name: "使用 Production" }));
    expect(handlers.onSelect).toHaveBeenCalledWith(secondary.id);
    await waitFor(() => expect(screen.getByRole("button", { name: "使用 Production" })).toBeEnabled());

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

  it.each(["offline", "reconnecting"] as const)("guards remote mutations but permits local logout while %s", (connectivity) => {
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
    expect(handlers.onLogout).toHaveBeenCalledOnce();
    expect(screen.getByRole("status")).toHaveTextContent(connectivity === "offline" ? "离线" : "重新连接");
  });

  it("shows the exact unavailable preferences contract and guards its handler", () => {
    const handlers = callbacks();
    render(<Settings profiles={[secondary]} current={secondary} connectivity="online" {...handlers} />);
    fireEvent.click(screen.getByRole("tab", { name: "偏好" }));
    expect(screen.getByText("个人偏好 API 合同尚未集成")).toBeInTheDocument();
    expect(screen.getByText("所需 API：/me")).toBeInTheDocument();
    expect(screen.getByLabelText("主题")).toBeDisabled();
    fireEvent.change(screen.getByLabelText("主题"), { target: { value: "dark" } });
    fireEvent.click(screen.getByLabelText("减少动态效果"));
    fireEvent.submit(screen.getByRole("form", { name: "偏好设置" }));
    expect(handlers.onPreferencesChange).not.toHaveBeenCalled();
  });

  it("logs out online and exposes no certificate-store or shell controls", () => {
    const handlers = callbacks();
    render(<Settings profiles={[secondary]} current={secondary} connectivity="online" {...handlers} />);
    fireEvent.click(screen.getByRole("tab", { name: "会话" }));
    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
    expect(handlers.onLogout).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: /证书|certificate|shell|终端/i })).not.toBeInTheDocument();
  });

  it("bounds profile selection and reports rejection without raw detail", async () => {
    const handlers = callbacks();
    const selection = deferred<void>();
    handlers.onSelect.mockReturnValueOnce(selection.promise);
    render(<Settings profiles={[current, secondary]} current={current} connectivity="online" {...handlers} />);
    fireEvent.click(screen.getByRole("button", { name: "使用 Production" }));
    expect(screen.getByRole("button", { name: "正在选择 Production" })).toBeDisabled();
    selection.reject(new Error("token raw-selection-secret"));
    expect(await screen.findByRole("alert")).toHaveTextContent("无法选择服务器配置");
    expect(document.body).not.toHaveTextContent("raw-selection-secret");
    expect(screen.getByRole("button", { name: "使用 Production" })).toBeEnabled();
  });

  it("bounds profile save and catches callback failures", async () => {
    const handlers = callbacks();
    const saving = deferred<void>();
    handlers.onSave.mockReturnValueOnce(saving.promise);
    render(<Settings profiles={[current]} current={current} connectivity="online" {...handlers} />);
    fireEvent.submit(screen.getByRole("form", { name: "编辑服务器配置" }));
    expect(screen.getByRole("button", { name: "正在保存" })).toBeDisabled();
    saving.reject(new Error("raw-save-secret"));
    expect(await screen.findByRole("alert")).toHaveTextContent("无法保存服务器配置");
    expect(document.body).not.toHaveTextContent("raw-save-secret");
    expect(screen.getByRole("button", { name: "保存配置" })).toBeEnabled();
  });

  it("keeps removal open on failure and closes it only after success", async () => {
    const handlers = callbacks();
    handlers.onRemove.mockRejectedValueOnce(new Error("raw-remove-secret")).mockResolvedValueOnce(undefined);
    render(<Settings profiles={[current]} current={current} connectivity="online" {...handlers} />);
    fireEvent.click(screen.getByRole("button", { name: "移除 Pilot" }));
    fireEvent.click(screen.getByRole("button", { name: "确认移除" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("无法移除服务器配置");
    expect(screen.getByRole("dialog", { name: "确认移除配置" })).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("raw-remove-secret");
    fireEvent.click(screen.getByRole("button", { name: "确认移除" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("keeps focus trapped while profile removal is pending", async () => {
    const handlers = callbacks();
    const removal = deferred<void>();
    handlers.onRemove.mockReturnValue(removal.promise);
    render(<Settings profiles={[current]} current={current} connectivity="online" {...handlers} />);
    fireEvent.click(screen.getByRole("button", { name: "移除 Pilot" }));
    const confirm = screen.getByRole("button", { name: "确认移除" });
    fireEvent.click(confirm);

    const dialog = screen.getByRole("dialog", { name: "确认移除配置" });
    expect(dialog).toHaveFocus();
    expect(confirm).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "取消" })).toBeDisabled();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(dialog).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(dialog).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(dialog).toBeInTheDocument();
    fireEvent.click(confirm);
    expect(handlers.onRemove).toHaveBeenCalledOnce();

    removal.reject(new Error("remove failed"));
    await waitFor(() => expect(confirm).toBeEnabled());
    expect(confirm).toHaveFocus();
  });

  it("manages modal focus, traps Tab, restores the trigger, and makes background inert", async () => {
    const handlers = callbacks();
    render(<Settings profiles={[current]} current={current} connectivity="online" {...handlers} />);
    const trigger = screen.getByRole("button", { name: "移除 Pilot" });
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "确认移除配置" });
    const confirm = within(dialog).getByRole("button", { name: "确认移除" });
    const cancel = within(dialog).getByRole("button", { name: "取消" });
    await waitFor(() => expect(confirm).toHaveFocus());
    expect(screen.getByTestId("settings-background")).toHaveAttribute("inert");
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(confirm).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("waits for shell isolation to clear before restoring modal trigger focus", async () => {
    const handlers = callbacks();
    const onModalOpenChange = vi.fn();
    const { rerender } = render(
      <Settings profiles={[current]} current={current} connectivity="online" modalIsolationActive={false} onModalOpenChange={onModalOpenChange} {...handlers} />,
    );
    const trigger = screen.getByRole("button", { name: "移除 Pilot" });
    fireEvent.click(trigger);
    rerender(<Settings profiles={[current]} current={current} connectivity="online" modalIsolationActive onModalOpenChange={onModalOpenChange} {...handlers} />);
    const dialog = screen.getByRole("dialog", { name: "确认移除配置" });
    expect(within(dialog).getByRole("button", { name: "确认移除" })).toHaveFocus();

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onModalOpenChange).toHaveBeenLastCalledWith(false);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(trigger).not.toHaveFocus();

    rerender(<Settings profiles={[current]} current={current} connectivity="online" modalIsolationActive={false} onModalOpenChange={onModalOpenChange} {...handlers} />);
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("supports wrapping Arrow keys plus Home and End in settings tabs", () => {
    const handlers = callbacks();
    render(<Settings profiles={[current]} current={current} connectivity="online" {...handlers} />);
    const profile = screen.getByRole("tab", { name: "服务器配置" });
    profile.focus();
    fireEvent.keyDown(profile, { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: "会话" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("tab", { name: "会话" }), { key: "Home" });
    expect(profile).toHaveFocus();
    fireEvent.keyDown(profile, { key: "End" });
    expect(screen.getByRole("tabpanel")).toHaveAccessibleName("会话");
    fireEvent.keyDown(screen.getByRole("tab", { name: "会话" }), { key: "ArrowRight" });
    expect(profile).toHaveFocus();
  });
});
