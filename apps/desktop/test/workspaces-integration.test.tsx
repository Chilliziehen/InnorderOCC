import type { CurrentUser } from "@innorder/contracts";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const metadataMode = vi.hoisted(() => ({ available: false }));

vi.mock("../src/renderer/workspaces/workspace-definitions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/renderer/workspaces/workspace-definitions")>();
  const domain = actual.WORKSPACE_DEFINITIONS["domain-design"];
  return {
    ...actual,
    WORKSPACE_DEFINITIONS: {
      ...actual.WORKSPACE_DEFINITIONS,
      "domain-design": {
        ...domain,
        commands: domain.commands.map((command) => command.operation === "import"
          ? { ...command, availability: { state: "available" as const } }
          : command),
      },
    },
    commandFor: (workspace: Parameters<typeof actual.commandFor>[0], operationName: string) => {
      const operation = actual.commandFor(typeof workspace === "string" ? workspace : workspace.id, operationName);
      return operation && metadataMode.available
        ? { ...operation, availability: { state: "available" as const } }
        : operation;
    },
  };
});

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
    uploads: { preflight: vi.fn().mockResolvedValue({ state: "available", maxBytes: 100 * 1024 * 1024 }), begin: vi.fn(), append: vi.fn().mockResolvedValue({ acceptedBytes: 3, receivedBytes: 3 }), finish: vi.fn(), cancel: vi.fn(), subscribeProgress: vi.fn(() => () => undefined) },
    notifications: { list: vi.fn().mockResolvedValue({ items: [] }), subscribe: vi.fn(() => vi.fn()), subscribeState: vi.fn(() => vi.fn()) },
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
] as const;

beforeEach(() => {
  metadataMode.available = false;
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

  it("uses runtime statuses and profile state directly without workspace queries", async () => {
    const api = installOcc();
    const props = { onLogout: vi.fn(), onProfileSelect: vi.fn(), onProfileSave: vi.fn() };
    const statuses = [{
      service: "occ-core",
      version: "1.7.0",
      state: "READY" as const,
      checkedAt: "2026-08-01T12:00:00.000Z",
      components: [],
    }];
    const { rerender } = render(<AppShell state={state("/system")} statuses={statuses} {...props} />);

    expect(await screen.findByRole("cell", { name: "occ-core" })).toBeInTheDocument();
    expect(api.workspaces.query).not.toHaveBeenCalled();

    rerender(<AppShell state={state("/settings")} statuses={statuses} {...props} />);
    expect(await screen.findByDisplayValue(profile.name)).toBeInTheDocument();
    expect(api.workspaces.query).not.toHaveBeenCalled();
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

  it("tracks cursor history within scope and resets it for criteria, tab, and profile", async () => {
    const query = vi.fn(async ({ cursor }: { cursor?: string }): Promise<WorkspaceResult> => ({
      state: "ready",
      items: [{
        id: cursor ?? "first", name: cursor ?? "first page", type: "compute", state: "available",
        capacity: 1, availableCapacity: 1, reservations: [], conflicts: [],
      }],
      count: 1,
      ...(cursor === "page-3" ? {} : { nextCursor: cursor === "page-2" ? "page-3" : "page-2" }),
      fetchedAt: "2026-08-01T12:00:00.000Z",
    }));
    installOcc(query);
    const props = { statuses: [], onLogout: vi.fn(), onProfileSelect: vi.fn(), onProfileSave: vi.fn() };
    const { rerender } = render(<AppShell state={state("/resources")} {...props} />);
    await waitFor(() => expect(query).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() => expect(query).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "page-2" })));
    expect(screen.getByRole("button", { name: "上一页" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() => expect(query).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "page-3" })));

    fireEvent.click(screen.getByRole("button", { name: "上一页" }));
    await waitFor(() => expect(query).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "page-2" })));
    fireEvent.click(screen.getByRole("button", { name: "上一页" }));
    await waitFor(() => expect(query).toHaveBeenLastCalledWith(expect.not.objectContaining({ cursor: expect.anything() })));
    expect(screen.getByRole("button", { name: "上一页" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() => expect(query).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "page-2" })));
    fireEvent.change(screen.getByLabelText("搜索"), { target: { value: "GPU" } });
    await waitFor(() => expect(query).toHaveBeenLastCalledWith(expect.not.objectContaining({ cursor: expect.anything() })));
    expect(screen.getByRole("button", { name: "上一页" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() => expect(query).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "page-2" })));
    fireEvent.click(screen.getByRole("tab", { name: "预留" }));
    await waitFor(() => expect(query).toHaveBeenLastCalledWith(expect.not.objectContaining({ cursor: expect.anything() })));
    expect(screen.getByRole("button", { name: "上一页" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() => expect(query).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "page-2" })));
    const otherProfile = { ...profile, id: "00000000-0000-4000-8000-000000000009", name: "Other" };
    rerender(<AppShell state={{ ...state("/resources"), profile: otherProfile, profiles: [profile, otherProfile] }} {...props} />);
    await waitFor(() => expect(query).toHaveBeenLastCalledWith(expect.not.objectContaining({ cursor: expect.anything() })));
    expect(screen.getByRole("button", { name: "上一页" })).toBeDisabled();
  }, 15_000);

  it("requires explicit selection from multiple validated task and process rows", async () => {
    const query = vi.fn(async ({ workspace }: { workspace: string }): Promise<WorkspaceResult> => workspace === "my-work" ? {
      state: "ready",
      count: 2,
      fetchedAt: "2026-08-01T12:00:00.000Z",
      items: [
        {
          id: "task-16", task: "检查接线", process: "电子模块", state: "CLAIMED", dueAt: "2026-08-02T08:00:00Z",
          evidenceRequirements: ["接线照片"], acceptedMediaTypes: ["image/jpeg"], reviewHistory: [],
        },
        {
          id: "task-17", task: "校准电源", process: "电子模块", state: "CLAIMED", dueAt: "2026-08-03T08:00:00Z",
          evidenceRequirements: ["校准记录 PDF"], acceptedMediaTypes: ["application/pdf"], reviewHistory: [],
        },
      ],
    } : {
      state: "ready",
      count: 2,
      fetchedAt: "2026-08-01T12:00:00.000Z",
      items: [
        {
          id: "process-6", process: "机械模块", cohort: "2026 春季", owner: "课程负责人", status: "ACTIVE",
          expectedVersion: 2, progress: 20, participants: [], tasks: [], evidence: [], risks: [], timeline: [],
        },
        {
          id: "process-7", process: "电子模块", cohort: "2026 春季", owner: "课程负责人", status: "ACTIVE",
          expectedVersion: 3, progress: 65,
          participants: [{ id: "person-1", name: "王工", role: "负责人" }],
          tasks: [], evidence: [], risks: [], timeline: [],
        },
      ],
    });
    installOcc(query);
    const props = { statuses: [], onLogout: vi.fn(), onProfileSelect: vi.fn(), onProfileSave: vi.fn() };
    const { rerender } = render(<AppShell state={state("/my-work")} {...props} />);

    expect(await screen.findByRole("button", { name: "选择任务：检查接线" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "选择任务：校准电源" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("请选择任务后再领取")).toBeInTheDocument();
    expect(screen.queryByText("校准记录 PDF")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "选择任务：校准电源" }));
    expect(await screen.findByText("校准记录 PDF")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "选择任务：校准电源" })).toHaveAttribute("aria-pressed", "true");

    rerender(<AppShell state={state("/processes")} {...props} />);
    expect(await screen.findByRole("button", { name: "选择流程：机械模块" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "选择流程：电子模块" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("progressbar", { name: "流程进度" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "选择流程：电子模块" }));
    expect(await screen.findByRole("progressbar", { name: "流程进度" })).toHaveAttribute("value", "65");
    expect(screen.getByRole("list", { name: "参与者" })).toHaveTextContent("王工");
    expect(screen.getByRole("button", { name: "选择流程：电子模块" })).toHaveAttribute("aria-pressed", "true");
  });

  it("uses the current task ID and completed named upload reference", async () => {
    metadataMode.available = true;
    const result: WorkspaceResult = {
      state: "ready",
      count: 1,
      fetchedAt: "2026-08-01T12:00:00.000Z",
      items: [{
        id: "task-17", task: "校准电源", process: "电子模块", state: "CLAIMED", dueAt: "2026-08-03T08:00:00Z",
        evidenceRequirements: ["校准记录 PDF"], acceptedMediaTypes: ["application/pdf"], reviewHistory: [],
      }],
    };
    const api = installOcc(vi.fn().mockResolvedValue(result));
    const uploadId = "00000000-0000-4000-8000-000000000077";
    vi.mocked(api.uploads.begin).mockResolvedValue({ state: "started", uploadId });
    vi.mocked(api.uploads.finish).mockResolvedValue({ state: "completed", kind: "evidence", uploadId, evidenceId: "evidence-17", uploadReference: uploadId, quarantineStatus: "released", processingStatus: "ready", reviewStatus: "pending" });
    vi.mocked(api.commands.execute).mockResolvedValue({
      state: "completed",
      commandId: "00000000-0000-4000-8000-000000000088",
      correlationId: "00000000-0000-4000-8000-000000000099",
    });
    render(<AppShell state={state("/my-work")} statuses={[]} onLogout={vi.fn()} onProfileSelect={vi.fn()} onProfileSave={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "选择任务：校准电源" }));
    const input = await screen.findByLabelText("选择证据文件");
    const file = new File(["pdf"], "record.pdf", { type: "application/pdf" });
    const wholeRead = vi.fn();
    const slice = vi.fn(() => ({ arrayBuffer: vi.fn().mockResolvedValue(new TextEncoder().encode("pdf").buffer) }));
    Object.defineProperty(file, "arrayBuffer", { value: wholeRead });
    Object.defineProperty(file, "slice", { value: slice });
    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "开始上传" }));

    await screen.findByRole("status", { name: "证据上传完成" });
    expect(api.uploads.begin).toHaveBeenCalledWith(expect.objectContaining({ taskId: "task-17", fileName: "record.pdf", mediaType: "application/pdf", intentHandle: expect.stringMatching(/^[0-9a-f-]{36}$/i) }));
    expect(slice).toHaveBeenCalledWith(0, 1024 * 1024);
    expect(wholeRead).not.toHaveBeenCalled();
    expect(api.uploads.append).toHaveBeenCalledWith({ uploadId, sequence: 0, data: new Uint8Array([112, 100, 102]) });
    fireEvent.click(screen.getByRole("button", { name: "提交证据" }));
    await waitFor(() => expect(api.commands.execute).toHaveBeenCalledWith(expect.objectContaining({
      operation: "submitEvidence",
      targetId: "task-17",
      payload: expect.objectContaining({ taskId: "task-17", uploadReference: uploadId }),
    })));

    fireEvent.change(screen.getByLabelText("搜索"), { target: { value: "next task" } });
    await waitFor(() => expect(api.workspaces.query).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("status", { name: "证据上传完成" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "提交证据" })).toBeDisabled();
    expect(screen.getByText("请选择任务后再领取")).toBeInTheDocument();
  });

  it("does not read file bytes when named upload preflight is unavailable", async () => {
    metadataMode.available = true;
    const result: WorkspaceResult = { state: "ready", count: 1, fetchedAt: "2026-08-01T12:00:00.000Z", items: [{ id: "task-17", task: "校准电源", process: "电子模块", state: "CLAIMED", dueAt: "2026-08-03T08:00:00Z", evidenceRequirements: [], acceptedMediaTypes: ["application/pdf"], reviewHistory: [] }] };
    const api = installOcc(vi.fn().mockResolvedValue(result));
    vi.mocked(api.uploads.preflight).mockResolvedValue({ state: "unavailable", reason: "UNAVAILABLE_CONTRACT", resourceGroups: ["/evidence"], message: "证据提交 API 合同尚未集成" });
    render(<AppShell state={state("/my-work")} statuses={[]} onLogout={vi.fn()} onProfileSelect={vi.fn()} onProfileSave={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "选择任务：校准电源" }));
    const file = new File(["pdf"], "record.pdf", { type: "application/pdf" });
    const read = vi.fn().mockResolvedValue(new TextEncoder().encode("pdf").buffer);
    Object.defineProperty(file, "slice", { value: vi.fn(() => ({ arrayBuffer: read })) });
    fireEvent.change(screen.getByLabelText("选择证据文件"), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "开始上传" }));
    await screen.findByText("证据提交 API 合同尚未集成");
    expect(api.uploads.preflight).toHaveBeenCalledWith(expect.objectContaining({ taskId: "task-17", fileName: "record.pdf" }));
    expect(read).not.toHaveBeenCalled();
    expect(api.uploads.begin).not.toHaveBeenCalled();
  });

  it.each(["read", "append", "finish"] as const)("cancels a begun domain archive session after %s failure", async (failure) => {
    metadataMode.available = true;
    const api = installOcc();
    const uploadId = "00000000-0000-4000-8000-000000000077";
    vi.mocked(api.uploads.begin).mockResolvedValue({ state: "started", uploadId });
    vi.mocked(api.uploads.append).mockResolvedValue({ acceptedBytes: 1024 * 1024, receivedBytes: 1024 * 1024 });
    vi.mocked(api.uploads.finish).mockResolvedValue({ state: "completed", kind: "archive", uploadId, uploadReference: uploadId, sha256: "a".repeat(64) });
    if (failure === "append") vi.mocked(api.uploads.append).mockRejectedValue(new Error("append failed"));
    if (failure === "finish") vi.mocked(api.uploads.finish).mockRejectedValue(new Error("finish failed"));
    const bytes = new Uint8Array(1024 * 1024 + 4);
    bytes.set([0x50, 0x4b, 0x03, 0x04]);
    const file = new File([bytes], "domain.zip", { type: "application/zip" });
    const signature = file.slice(0, 4);
    const chunkRead = vi.fn(() => failure === "read"
      ? Promise.reject(new Error("read failed"))
      : Promise.resolve(new Uint8Array([0x50, 0x4b, 0x03, 0x04]).buffer));
    const slice = vi.fn()
      .mockImplementationOnce(() => signature)
      .mockImplementation(() => ({ arrayBuffer: chunkRead }));
    Object.defineProperty(file, "slice", { value: slice });
    render(<AppShell state={state("/domain-design")} statuses={[]} onLogout={vi.fn()} onProfileSelect={vi.fn()} onProfileSave={vi.fn()} />);

    fireEvent.change(await screen.findByLabelText("签名领域包归档"), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByRole("button", { name: "上传归档" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "上传归档" }));

    await screen.findByRole("status", { name: "归档校验错误" });
    expect(api.uploads.begin).toHaveBeenCalledWith(expect.objectContaining({ workspace: "domain-design", taskId: "package-import", size: 1024 * 1024 + 4 }));
    expect(api.uploads.cancel).toHaveBeenCalledOnce();
    expect(api.uploads.cancel).toHaveBeenCalledWith(uploadId);
    for (const [start, end] of slice.mock.calls.slice(1)) expect((end as number) - (start as number)).toBeLessThanOrEqual(1024 * 1024);
    if (failure === "finish") expect(slice.mock.calls.slice(1)).toEqual([[0, 1024 * 1024], [1024 * 1024, 2 * 1024 * 1024]]);
  });

  it("ignores upload completion after the selected task changes", async () => {
    metadataMode.available = true;
    const result: WorkspaceResult = {
      state: "ready",
      count: 2,
      fetchedAt: "2026-08-01T12:00:00.000Z",
      items: [
        {
          id: "task-a", task: "任务 A", process: "流程", state: "CLAIMED", dueAt: "2026-08-03T08:00:00Z",
          evidenceRequirements: [], acceptedMediaTypes: ["application/pdf"], reviewHistory: [],
        },
        {
          id: "task-b", task: "任务 B", process: "流程", state: "CLAIMED", dueAt: "2026-08-04T08:00:00Z",
          evidenceRequirements: [], acceptedMediaTypes: ["application/pdf"], reviewHistory: [],
        },
      ],
    };
    let completeUpload!: (receipt: Awaited<ReturnType<NonNullable<typeof window.occ>["uploads"]["finish"]>>) => void;
    const api = installOcc(vi.fn().mockResolvedValue(result));
    vi.mocked(api.uploads.begin).mockResolvedValue({ state: "started", uploadId: "00000000-0000-4000-8000-000000000077" });
    vi.mocked(api.uploads.finish).mockImplementation(() => new Promise((resolve) => { completeUpload = resolve; }));
    render(<AppShell state={state("/my-work")} statuses={[]} onLogout={vi.fn()} onProfileSelect={vi.fn()} onProfileSave={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "选择任务：任务 A" }));
    const file = new File(["pdf"], "record.pdf", { type: "application/pdf" });
    Object.defineProperty(file, "slice", { value: vi.fn(() => ({ arrayBuffer: vi.fn().mockResolvedValue(new TextEncoder().encode("pdf").buffer) })) });
    fireEvent.change(screen.getByLabelText("选择证据文件"), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "开始上传" }));
    await waitFor(() => expect(api.uploads.finish).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000077"));
    fireEvent.click(screen.getByRole("button", { name: "选择任务：任务 B" }));

    completeUpload({ state: "completed", kind: "evidence", uploadId: "00000000-0000-4000-8000-000000000077", evidenceId: "evidence-a", uploadReference: "upload-ref-a", quarantineStatus: "released", processingStatus: "ready", reviewStatus: "pending" });
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(screen.queryByRole("status", { name: "证据上传完成" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "提交证据" })).toBeDisabled();
    expect(screen.getByText("缺少证据上传引用")).toBeInTheDocument();
  });

  it("clears row selection when query, tab, generation, or profile changes", async () => {
    const result: WorkspaceResult = {
      state: "ready",
      count: 1,
      fetchedAt: "2026-08-01T12:00:00.000Z",
      items: [{ id: "review-1", item: "检查证据", type: "review", owner: null, status: "open", version: 2, evidenceVersion: 3 }],
    };
    installOcc(vi.fn().mockResolvedValue(result));
    const props = { statuses: [], onLogout: vi.fn(), onProfileSelect: vi.fn(), onProfileSave: vi.fn() };
    const { rerender } = render(<AppShell state={state("/interventions")} {...props} />);
    const select = await screen.findByRole("button", { name: "选择介入事项：检查证据" });
    fireEvent.click(select);
    expect(select).toHaveAttribute("aria-pressed", "true");

    fireEvent.change(screen.getByLabelText("介入类型"), { target: { value: "review" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "选择介入事项：检查证据" })).toHaveAttribute("aria-pressed", "false"));
    fireEvent.click(screen.getByRole("button", { name: "选择介入事项：检查证据" }));
    fireEvent.click(screen.getByRole("tab", { name: "异常" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "选择介入事项：检查证据" })).toHaveAttribute("aria-pressed", "false"));

    fireEvent.click(screen.getByRole("button", { name: "选择介入事项：检查证据" }));
    rerender(<AppShell state={{ ...state("/interventions"), sessionGeneration: 5 }} {...props} />);
    expect(await screen.findByRole("button", { name: "选择介入事项：检查证据" })).toHaveAttribute("aria-pressed", "false");

    const otherProfile = { ...profile, id: "00000000-0000-4000-8000-000000000009", name: "Other" };
    fireEvent.click(screen.getByRole("button", { name: "选择介入事项：检查证据" }));
    rerender(<AppShell state={{ ...state("/interventions"), profile: otherProfile, profiles: [profile, otherProfile] }} {...props} />);
    expect(await screen.findByRole("button", { name: "选择介入事项：检查证据" })).toHaveAttribute("aria-pressed", "false");
  });

  it("clears a risk selection removed by a same-scope refresh", async () => {
    const risk = (id: string, name: string): WorkspaceResult => ({
      state: "ready",
      count: 1,
      fetchedAt: "2026-08-01T12:00:00.000Z",
      items: [{ id, risk: name, severity: "high", owner: null, status: "open", deadline: "2026-08-03T08:00:00Z", sla: "on-track", version: 1 }],
    });
    const query = vi.fn()
      .mockResolvedValueOnce(risk("risk-a", "风险 A"))
      .mockResolvedValueOnce(risk("risk-b", "风险 B"))
      .mockResolvedValueOnce(risk("risk-a", "风险 A"));
    installOcc(query);
    render(<AppShell state={state("/risks")} statuses={[]} onLogout={vi.fn()} onProfileSelect={vi.fn()} onProfileSave={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "选择风险：风险 A" }));
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));

    expect(await screen.findByRole("button", { name: "选择风险：风险 B" })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect(await screen.findByRole("button", { name: "选择风险：风险 A" })).toHaveAttribute("aria-pressed", "false");
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

  it("requires the exact route query capability before workspace IPC", async () => {
    const api = installOcc();
    render(
      <AppShell
        state={{ ...state("/risks"), identity: { ...identity, capabilities: ["occ.read"] } }}
        statuses={[]}
        onLogout={vi.fn()}
        onProfileSelect={vi.fn()}
        onProfileSave={vi.fn()}
      />,
    );

    expect(await screen.findByRole("tablist", { name: "风险视图" })).toBeInTheDocument();
    expect(await screen.findByText("缺少能力：risks.query")).toBeInTheDocument();
    expect(api.workspaces.query).not.toHaveBeenCalled();
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

  it("retains the scoped successful result canonically when connectivity goes offline", async () => {
    const readyResult: WorkspaceResult = {
      state: "ready",
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
    const query = vi.fn().mockResolvedValueOnce(readyResult).mockRejectedValueOnce(new Error("main unavailable"));
    const api = installOcc(query);
    const props = { statuses: [], onLogout: vi.fn(), onProfileSelect: vi.fn(), onProfileSave: vi.fn() };
    const { rerender } = render(<AppShell state={state("/resources")} {...props} />);
    await waitFor(() => expect(api.workspaces.query).toHaveBeenCalledOnce());
    expect(await screen.findByText("GPU pool")).toBeInTheDocument();

    rerender(<AppShell state={offlineState("/resources")} {...props} />);

    expect(await screen.findByText("离线数据，只读")).toBeInTheDocument();
    expect(screen.getByText("GPU pool")).toBeInTheDocument();
    expect(api.workspaces.query).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText("资源名称")).toBeDisabled();
    expect(api.commands.execute).not.toHaveBeenCalled();
  });

  it("retains a valid stale result when connectivity goes offline", async () => {
    const staleResult: WorkspaceResult = {
      state: "stale",
      items: [{
        id: "resource-stale",
        name: "Stale GPU pool",
        type: "compute",
        state: "available",
        capacity: 8,
        availableCapacity: 2,
        reservations: [],
        conflicts: [],
      }],
      count: 1,
      fetchedAt: "2026-08-01T10:00:00.000Z",
    };
    const api = installOcc(vi.fn().mockResolvedValue(staleResult));
    const props = { statuses: [], onLogout: vi.fn(), onProfileSelect: vi.fn(), onProfileSave: vi.fn() };
    const { rerender } = render(<AppShell state={state("/resources")} {...props} />);

    expect(await screen.findByText("过期数据，只读")).toBeInTheDocument();
    expect(screen.getByText("Stale GPU pool")).toBeInTheDocument();
    rerender(<AppShell state={offlineState("/resources")} {...props} />);

    expect(await screen.findByText("过期数据，只读")).toBeInTheDocument();
    expect(screen.getByText("Stale GPU pool")).toBeInTheDocument();
    expect(api.workspaces.query).toHaveBeenCalledTimes(2);
  });

  it("preserves retained success across an online refresh error for later offline display", async () => {
    const readyResult: WorkspaceResult = {
      state: "ready",
      items: [{
        id: "resource-1", name: "GPU pool", type: "compute", state: "available", capacity: 8,
        availableCapacity: 4, reservations: [], conflicts: [],
      }],
      count: 1,
      fetchedAt: "2026-08-01T12:00:00.000Z",
    };
    const refreshError: WorkspaceResult = {
      state: "error",
      problem: { title: "online refresh failed", code: "REFRESH_FAILED", status: 503 },
    };
    const query = vi.fn().mockResolvedValueOnce(readyResult).mockResolvedValueOnce(refreshError).mockRejectedValueOnce(new Error("main unavailable"));
    installOcc(query);
    const props = { statuses: [], onLogout: vi.fn(), onProfileSelect: vi.fn(), onProfileSave: vi.fn() };
    const { rerender } = render(<AppShell state={state("/resources")} {...props} />);
    expect(await screen.findByText("GPU pool")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect(await screen.findByText("online refresh failed")).toBeInTheDocument();
    expect(screen.queryByText("GPU pool")).not.toBeInTheDocument();

    rerender(<AppShell state={offlineState("/resources")} {...props} />);
    expect(await screen.findByText("离线数据，只读")).toBeInTheDocument();
    expect(screen.getByText("GPU pool")).toBeInTheDocument();
    expect(query).toHaveBeenCalledTimes(3);
  });

  it("loads persisted main cache on an offline restart without renderer retention", async () => {
    const cached: WorkspaceResult = {
      state: "stale", items: [{ id: "restart-resource", name: "Restart GPU pool", type: "compute", state: "available", capacity: 4, availableCapacity: 2, reservations: [], conflicts: [] }],
      count: 1, fetchedAt: "2026-08-01T09:00:00.000Z",
    };
    const api = installOcc(vi.fn().mockResolvedValue(cached));
    render(<AppShell state={offlineState("/resources")} statuses={[]} onLogout={vi.fn()} onProfileSelect={vi.fn()} onProfileSave={vi.fn()} />);

    expect(await screen.findByText("Restart GPU pool")).toBeInTheDocument();
    expect(api.workspaces.query).toHaveBeenCalledOnce();
    expect(screen.getByText("过期数据，只读")).toBeInTheDocument();
  });

  it("ignores an in-flight online result after connectivity goes offline", async () => {
    const resolvers: Array<(value: WorkspaceResult) => void> = [];
    const query = vi.fn(() => new Promise<WorkspaceResult>((resolve) => { resolvers.push(resolve); }));
    installOcc(query);
    const props = { statuses: [], onLogout: vi.fn(), onProfileSelect: vi.fn(), onProfileSave: vi.fn() };
    const { rerender } = render(<AppShell state={state("/resources")} {...props} />);
    await waitFor(() => expect(query).toHaveBeenCalledOnce());

    rerender(<AppShell state={offlineState("/resources")} {...props} />);
    resolvers[0]!({
      state: "ready",
      items: [{ id: "late", name: "late online secret", type: "compute", state: "available", capacity: 1, availableCapacity: 1, reservations: [], conflicts: [] }],
      count: 1,
      fetchedAt: "2026-08-01T12:00:00.000Z",
    });
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(query).toHaveBeenCalledTimes(2);
    expect(document.body).not.toHaveTextContent("late online secret");
  });
});
