import type { CurrentUser } from "@innorder/contracts";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { OccApi, ServerProfile, WorkspaceResult } from "../src/desktop-contract";
import type { AuthenticatedState } from "../src/renderer/app-controller";
import { AppShell } from "../src/renderer/components/AppShell";
import { WORKSPACE_MANIFEST } from "../src/renderer/workspace-manifest";

const profile: ServerProfile = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Pilot",
  origin: "https://pilot.example.test",
  environment: "pilot",
};

const capabilities = Array.from(new Set([
  "occ.read",
  "occ.admin",
  ...WORKSPACE_MANIFEST.flatMap((workspace) => [
    workspace.query.capability,
    ...workspace.commands.map((command) => command.capability),
  ]),
]));

const identity: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000002",
  username: "operator",
  displayName: "值班操作员",
  status: "ACTIVE",
  capabilities,
};

function state(path: AuthenticatedState["route"] extends infer _Route ? string : never): AuthenticatedState {
  return {
    mode: "authenticated",
    profiles: [profile],
    profile,
    identity,
    expiresAt: "2099-08-01T13:00:00.000Z",
    lastFreshAt: Date.now(),
    sessionGeneration: 4,
    sessionOperation: null,
    route: { path: path as NonNullable<AuthenticatedState["route"]>["path"], focusToken: 1 },
  };
}

function offlineState(path = "/settings") {
  const online = state(path);
  return {
    mode: "offline" as const,
    profiles: online.profiles,
    profile: online.profile,
    cachedIdentity: online.identity,
    expiresAt: online.expiresAt,
    lastFreshAt: online.lastFreshAt,
    staleSince: Date.now(),
    sessionGeneration: online.sessionGeneration,
    sessionOperation: null,
    route: online.route!,
  };
}

function unavailable(message = "合同不可用"): WorkspaceResult {
  return {
    state: "unavailable",
    reason: "UNAVAILABLE_CONTRACT",
    resourceGroups: ["/contract"],
    message,
  };
}

function installOcc(query = vi.fn().mockResolvedValue(unavailable())): OccApi {
  const api: OccApi = {
    profiles: {
      list: vi.fn().mockResolvedValue([profile]),
      current: vi.fn().mockResolvedValue(profile),
      save: vi.fn().mockResolvedValue(profile),
      select: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    },
    session: {
      restore: vi.fn(),
      login: vi.fn(),
      logout: vi.fn().mockResolvedValue(undefined),
    },
    runtime: { statuses: vi.fn().mockResolvedValue([]) },
    workspaces: { query },
    commands: { execute: vi.fn() },
    uploads: { start: vi.fn(), cancel: vi.fn() },
    notifications: { list: vi.fn().mockResolvedValue({ items: [] }), subscribe: vi.fn(() => vi.fn()) },
  };
  Object.defineProperty(window, "occ", { configurable: true, value: api });
  return api;
}

const routeCases = [
  ["/overview", "overview.query", "运行总览视图"],
  ["/my-work", "tasks.query", "工作状态"],
  ["/processes", "processes.query", "流程视图"],
  ["/interventions", "interventions.query", "介入队列"],
  ["/risks", "risks.query", "风险视图"],
  ["/resources", "resources.query", "资源视图"],
  ["/domain-design", "packages.query", "领域设计视图"],
  ["/administration", "administration.query", "管理分类"],
  ["/system", "system.status", "系统运行视图"],
  ["/settings", "profiles.current", "设置分类"],
] as const;

beforeEach(() => {
  window.location.hash = "#/overview";
});

describe("authenticated workspace integration", () => {
  it.each(routeCases)("renders %s and queries %s through the canonical operation", async (path, operation, controlName) => {
    const api = installOcc();
    render(
      <AppShell
        state={state(path)}
        statuses={[]}
        onLogout={vi.fn()}
        onProfileSelect={vi.fn()}
        onProfileSave={vi.fn()}
      />,
    );

    expect(await screen.findByRole("tablist", { name: controlName })).toBeInTheDocument();
    await waitFor(() => expect(api.workspaces.query).toHaveBeenCalledWith(expect.objectContaining({
      workspace: path.slice(1),
      operation,
    })));
  });

  it("updates tab query state and performs a fresh query", async () => {
    const api = installOcc();
    render(<AppShell state={state("/resources")} statuses={[]} onLogout={vi.fn()} onProfileSelect={vi.fn()} onProfileSave={vi.fn()} />);
    await waitFor(() => expect(api.workspaces.query).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("tab", { name: "预留" }));

    await waitFor(() => expect(api.workspaces.query).toHaveBeenCalledTimes(2));
    expect(api.workspaces.query).toHaveBeenLastCalledWith(expect.objectContaining({
      operation: "resources.query",
      filters: expect.objectContaining({ tab: "reservations" }),
    }));
  });

  it("keeps a route tab stable after navigating away and back", async () => {
    installOcc();
    const props = { statuses: [], onLogout: vi.fn(), onProfileSelect: vi.fn(), onProfileSave: vi.fn() };
    const { rerender } = render(<AppShell state={state("/resources")} {...props} />);
    fireEvent.click(await screen.findByRole("tab", { name: "预留" }));
    expect(screen.getByRole("tab", { name: "预留" })).toHaveAttribute("aria-selected", "true");

    rerender(<AppShell state={state("/risks")} {...props} />);
    await screen.findByRole("tablist", { name: "风险视图" });
    rerender(<AppShell state={state("/resources")} {...props} />);

    expect(await screen.findByRole("tab", { name: "预留" })).toHaveAttribute("aria-selected", "true");
  });

  it("sends filter changes with canonical sort metadata", async () => {
    const api = installOcc();
    render(<AppShell state={state("/overview")} statuses={[]} onLogout={vi.fn()} onProfileSelect={vi.fn()} onProfileSave={vi.fn()} />);
    await waitFor(() => expect(api.workspaces.query).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText("严重性"), { target: { value: "high" } });

    await waitFor(() => expect(api.workspaces.query).toHaveBeenCalledTimes(2));
    expect(api.workspaces.query).toHaveBeenLastCalledWith(expect.objectContaining({
      filters: { severity: "high", search: "", tab: "attention" },
      sort: { field: "priority", direction: "desc" },
    }));
  });

  it("ignores a stale response after the route changes", async () => {
    let resolveOld!: (value: WorkspaceResult) => void;
    const query = vi.fn()
      .mockImplementationOnce(() => new Promise<WorkspaceResult>((resolve) => { resolveOld = resolve; }))
      .mockResolvedValueOnce(unavailable("current route"));
    installOcc(query);
    const { rerender } = render(<AppShell state={state("/overview")} statuses={[]} onLogout={vi.fn()} onProfileSelect={vi.fn()} onProfileSave={vi.fn()} />);
    await waitFor(() => expect(query).toHaveBeenCalledOnce());

    rerender(<AppShell state={state("/risks")} statuses={[]} onLogout={vi.fn()} onProfileSelect={vi.fn()} onProfileSave={vi.fn()} />);
    expect(await screen.findByText("current route")).toBeInTheDocument();
    resolveOld(unavailable("old route secret"));
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(document.body).not.toHaveTextContent("old route secret");
  });

  it("sanitizes workspace query rejection details", async () => {
    installOcc(vi.fn().mockRejectedValue(new Error("token secret at C:\\private")));
    render(<AppShell state={state("/overview")} statuses={[]} onLogout={vi.fn()} onProfileSelect={vi.fn()} onProfileSave={vi.fn()} />);

    expect(await screen.findByText("无法加载工作区数据，请重试。")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/token secret|private/i);
  });

  it("renders canonical unavailable metadata when the workspace group is missing", async () => {
    const api = installOcc();
    Object.defineProperty(window, "occ", { configurable: true, value: { ...api, workspaces: undefined } });
    render(<AppShell state={state("/overview")} statuses={[]} onLogout={vi.fn()} onProfileSelect={vi.fn()} onProfileSave={vi.fn()} />);

    expect(await screen.findByText("总览业务 API 合同尚未集成")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/sample|fixture/i);
  });

  it("resolves access denial before query or command IPC", () => {
    const api = installOcc();
    render(<AppShell state={state("/administration").identity.capabilities.includes("occ.admin")
      ? { ...state("/administration"), identity: { ...identity, capabilities: ["occ.read"] } }
      : state("/administration")} statuses={[]} onLogout={vi.fn()} onProfileSelect={vi.fn()} onProfileSave={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "访问被拒绝" })).toBeInTheDocument();
    expect(api.workspaces.query).not.toHaveBeenCalled();
    expect(api.commands.execute).not.toHaveBeenCalled();
  });

  it("keeps offline settings mutations locked while logout remains local", async () => {
    const api = installOcc();
    const onLogout = vi.fn().mockResolvedValue(undefined);
    render(<AppShell state={offlineState()} statuses={[]} onLogout={onLogout} onProfileSelect={vi.fn()} onProfileSave={vi.fn()} />);

    expect(await screen.findByRole("button", { name: "保存配置" })).toBeDisabled();
    fireEvent.click(screen.getByRole("tab", { name: "会话" }));
    fireEvent.click(screen.getByText("退出登录", { selector: "button" }));
    await waitFor(() => expect(onLogout).toHaveBeenCalledOnce());
    expect(api.commands.execute).not.toHaveBeenCalled();
  });

  it("allows an offline workspace query to refresh while mutations remain locked", async () => {
    const offlineResult: WorkspaceResult = {
      state: "offline",
      items: [{
        id: "resource-1",
        name: "GPU pool",
        type: "compute",
        state: "available",
        capacity: 8,
        availableCapacity: 4,
        reservations: [],
        conflicts: [],
      }],
      count: 1,
      fetchedAt: "2026-08-01T12:00:00.000Z",
    };
    const api = installOcc(vi.fn().mockResolvedValue(offlineResult));
    render(<AppShell state={offlineState("/resources")} statuses={[]} onLogout={vi.fn()} onProfileSelect={vi.fn()} onProfileSave={vi.fn()} />);
    await waitFor(() => expect(api.workspaces.query).toHaveBeenCalledOnce());

    const refresh = screen.getByRole("button", { name: "刷新" });
    expect(refresh).toBeEnabled();
    fireEvent.click(refresh);

    await waitFor(() => expect(api.workspaces.query).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText("资源名称")).toBeDisabled();
    expect(api.commands.execute).not.toHaveBeenCalled();
  });
});
