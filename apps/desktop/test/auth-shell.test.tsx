import type { CurrentUser } from "@innorder/contracts";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OccApi, ServerProfile } from "../src/desktop-contract";
import { App } from "../src/renderer/App";
import { AppShell } from "../src/renderer/components/AppShell";
import { Login } from "../src/renderer/components/Login";
import { ProfileBootstrap } from "../src/renderer/components/ProfileBootstrap";
import { StatusBanner } from "../src/renderer/components/StatusBanner";
import { RendererErrorBoundary } from "../src/renderer/components/RendererErrorBoundary";
import type { RouteLocation } from "../src/renderer/routes";

const profileA: ServerProfile = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Pilot A",
  origin: "https://pilot-a.example.test",
  environment: "pilot",
};
const profileB: ServerProfile = {
  id: "00000000-0000-4000-8000-000000000002",
  name: "Production B",
  origin: "https://prod-b.example.test",
  environment: "production",
};
const identity: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000003",
  username: "operator",
  displayName: "值班操作员",
  status: "ACTIVE",
  capabilities: ["occ.read"],
};
const expiresAt = "2099-08-01T13:00:00.000Z";

function createOcc(overrides: Partial<{
  profiles: Partial<OccApi["profiles"]>;
  session: Partial<OccApi["session"]>;
  runtime: Partial<OccApi["runtime"]>;
  workspaces: Partial<OccApi["workspaces"]>;
}> = {}): OccApi {
  return {
    profiles: {
      list: vi.fn().mockResolvedValue([profileA]),
      current: vi.fn().mockResolvedValue(profileA),
      save: vi.fn().mockResolvedValue(profileA),
      select: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
      ...overrides.profiles,
    },
    session: {
      restore: vi.fn().mockResolvedValue({ state: "anonymous" }),
      login: vi.fn().mockResolvedValue({
        state: "authenticated",
        user: identity,
        expiresAt,
      }),
      logout: vi.fn().mockResolvedValue(undefined),
      ...overrides.session,
    },
    runtime: {
      statuses: vi.fn().mockResolvedValue([{
        service: "occ-core",
        version: "0.1.0",
        state: "READY",
        checkedAt: "2026-08-01T12:00:00.000Z",
        components: [{
          id: "core-runtime",
          label: "Core Runtime",
          state: "READY",
          checkedAt: "2026-08-01T12:00:00.000Z",
        }],
      }]),
      ...overrides.runtime,
    },
    workspaces: {
      query: vi.fn().mockResolvedValue({
        state: "unavailable",
        reason: "UNAVAILABLE_CONTRACT",
        resourceGroups: ["/unknown"],
      }),
      ...overrides.workspaces,
    },
    commands: { execute: vi.fn() },
    uploads: { start: vi.fn(), cancel: vi.fn() },
    notifications: {
      list: vi.fn().mockResolvedValue({ items: [] }),
      subscribe: vi.fn(() => vi.fn()),
    },
  };
}

function installOcc(api: OccApi): void {
  Object.defineProperty(window, "occ", { configurable: true, value: api });
}

function authenticatedState(
  capabilities = identity.capabilities,
  route: RouteLocation = { path: "/overview", focusToken: 0 },
) {
  return {
    mode: "authenticated" as const,
    profiles: [profileA, profileB],
    profile: profileA,
    identity: { ...identity, capabilities },
    expiresAt,
    lastFreshAt: Date.now() - 4_000,
    sessionGeneration: 2,
    sessionOperation: null,
    route,
  };
}

function offlineState(route: RouteLocation = { path: "/settings", focusToken: 1 }) {
  const online = authenticatedState(identity.capabilities, route);
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
    route,
  };
}

beforeEach(() => {
  window.location.hash = "#/overview";
});

afterEach(() => {
  vi.useRealTimers();
});

describe("profile bootstrap", () => {
  it("submits labelled profile values and displays generic main validation", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("HTTPS is required"));
    render(<ProfileBootstrap profiles={[]} onSave={onSave} onSelect={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/配置名称/), { target: { value: "Pilot" } });
    fireEvent.change(screen.getByLabelText(/服务器源地址/), {
      target: { value: "http://pilot.example.test/path" },
    });
    fireEvent.change(screen.getByLabelText(/^环境/), { target: { value: "pilot" } });
    fireEvent.change(screen.getByLabelText(/CA.*指纹/), { target: { value: "ABCD" } });
    fireEvent.click(screen.getByRole("button", { name: /保存配置/ }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith({
      name: "Pilot",
      origin: "http://pilot.example.test/path",
      environment: "pilot",
      caFingerprint: "ABCD",
    }));
    expect(await screen.findByRole("alert")).toHaveTextContent("无法保存服务器配置");
    expect(screen.getByRole("alert")).not.toHaveTextContent("HTTPS is required");
    expect(screen.queryByText(/允许 HTTP/)).not.toBeInTheDocument();
  });

  it("allows an existing profile to be selected", () => {
    const onSelect = vi.fn();
    render(<ProfileBootstrap profiles={[profileA, profileB]} onSave={vi.fn()} onSelect={onSelect} />);

    fireEvent.click(screen.getByRole("button", { name: /使用 Production B/ }));
    expect(onSelect).toHaveBeenCalledWith(profileB);
  });
});

describe("login", () => {
  it("shows environment identity and clears the password after generic failure", async () => {
    const onSubmit = vi.fn().mockRejectedValue({
      message: "token abc.def.ghi rejected",
      correlationId: "00000000-0000-4000-8000-000000000099",
    });
    render(
      <Login
        profile={profileB}
        profiles={[profileA, profileB]}
        onProfileSelect={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    expect(screen.getByText("prod-b.example.test")).toBeInTheDocument();
    expect(screen.getByText(/生产环境/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/用户名/), { target: { value: "operator" } });
    const password = screen.getByLabelText(/密码/);
    expect(password).toHaveAttribute("autocomplete", "current-password");
    fireEvent.change(password, { target: { value: "NeverEchoThis123!" } });
    fireEvent.click(screen.getByRole("button", { name: /登录/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent("登录失败");
    expect(screen.getByRole("alert")).toHaveTextContent("00000000-0000-4000-8000-000000000099");
    expect(screen.getByRole("alert")).not.toHaveTextContent(/token|NeverEchoThis/i);
    expect(password).toHaveValue("");
  });

  it("announces session expiry without restoring secret data", () => {
    render(
      <Login
        profile={profileA}
        profiles={[profileA]}
        notice="expired"
        onProfileSelect={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("会话已过期");
  });
});

describe("authenticated shell", () => {
  it("filters navigation and denies a direct admin route without querying content", () => {
    const query = vi.fn();
    installOcc(createOcc({ workspaces: { query } }));
    render(
      <AppShell
        state={authenticatedState(["occ.read"], { path: "/administration", focusToken: 1 })}
        statuses={[]}
        onLogout={vi.fn()}
        onProfileSelect={vi.fn()}
        onProfileSave={vi.fn()}
      />,
    );

    expect(screen.getByRole("navigation", { name: /主导航/ })).not.toHaveTextContent("管理");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("访问被拒绝");
    expect(query).not.toHaveBeenCalled();
  });

  it("focuses and announces the route heading after a hash change", async () => {
    installOcc(createOcc());
    const { rerender } = render(
      <AppShell
        state={authenticatedState()}
        statuses={[]}
        onLogout={vi.fn()}
        onProfileSelect={vi.fn()}
        onProfileSave={vi.fn()}
      />,
    );
    rerender(
      <AppShell
        state={authenticatedState(identity.capabilities, { path: "/risks", focusToken: 1 })}
        statuses={[]}
        onLogout={vi.fn()}
        onProfileSelect={vi.fn()}
        onProfileSave={vi.fn()}
      />,
    );

    const heading = screen.getByRole("heading", { level: 1, name: "风险" });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(heading).toHaveAttribute("tabindex", "-1");
    expect(screen.getByTestId("page-announcement")).toHaveTextContent("风险");
  });

  it("keeps the route heading as the only level-one heading in settings", () => {
    installOcc(createOcc());
    render(
      <AppShell
        state={authenticatedState(identity.capabilities, { path: "/settings", focusToken: 1 })}
        statuses={[]}
        onLogout={vi.fn()}
        onProfileSelect={vi.fn()}
        onProfileSave={vi.fn()}
      />,
    );
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("设置");
  });

  it.each(["offline", "reconnecting"] as const)(
    "fully disables settings and rejects forced save while %s",
    (mode) => {
      const onProfileSave = vi.fn();
      const state = mode === "offline"
        ? offlineState()
        : { ...offlineState(), mode: "reconnecting" as const, retryAvailable: false };
      installOcc(createOcc());
      const { container } = render(
        <AppShell
          state={state}
          statuses={[]}
          onLogout={vi.fn()}
          onProfileSelect={vi.fn()}
          onProfileSave={onProfileSave}
        />,
      );

      for (const label of [/配置名称/, /服务器源地址/, /^环境/, /CA.*指纹/]) {
        expect(screen.getByLabelText(label)).toBeDisabled();
      }
      expect(screen.getByRole("button", { name: /保存配置/ })).toBeDisabled();
      const form = container.querySelector("form");
      expect(form).not.toBeNull();
      fireEvent.submit(form as HTMLFormElement);
      expect(onProfileSave).not.toHaveBeenCalled();
    },
  );

  it("shows exact stale connectivity states and mutation lockout", () => {
    const { rerender } = render(<StatusBanner mode="authenticated" lastFreshAt={Date.now() - 4_000} />);
    expect(screen.getByLabelText("连接状态", { exact: true })).toHaveTextContent(/在线.*4 秒/);

    rerender(<StatusBanner mode="reconnecting" lastFreshAt={Date.now() - 65_000} />);
    expect(screen.getByLabelText("连接状态", { exact: true })).toHaveTextContent(/正在重新连接.*1 分钟/);
    expect(screen.getByLabelText("连接状态", { exact: true })).toHaveTextContent("更改操作已锁定");

    rerender(<StatusBanner mode="offline" lastFreshAt={Date.now() - 125_000} />);
    expect(screen.getByLabelText("连接状态", { exact: true })).toHaveTextContent(/离线.*2 分钟/);
    expect(screen.getByLabelText("连接状态", { exact: true })).toHaveTextContent("只读");
  });

  it("keeps changing freshness age outside the connectivity live region", () => {
    const { rerender } = render(<StatusBanner mode="authenticated" lastFreshAt={Date.now() - 4_000} />);
    const announcement = screen.getByRole("status", { name: "连接状态更新" });
    expect(announcement).toHaveTextContent("在线");
    expect(announcement).not.toHaveTextContent(/数据距上次更新|秒/);
    expect(screen.getByText(/数据距上次更新/)).not.toHaveAttribute("aria-live");

    rerender(<StatusBanner mode="authenticated" lastFreshAt={Date.now() - 8_000} />);
    expect(screen.getByRole("status", { name: "连接状态更新" })).toHaveTextContent(/^在线$/);
  });
});

describe("application controller", () => {
  it("restores the durable selected profile without selecting the first profile", async () => {
    const api = createOcc({
      profiles: {
        list: vi.fn().mockResolvedValue([profileA, profileB]),
        current: vi.fn().mockResolvedValue(profileB),
      },
      session: {
        restore: vi.fn().mockResolvedValue({ state: "authenticated", user: identity, expiresAt }),
      },
    });
    installOcc(api);
    render(<App />);

    await screen.findByRole("heading", { name: "运行总览" });
    expect(screen.getByText(/Production B/)).toBeInTheDocument();
    expect(api.profiles.select).not.toHaveBeenCalled();
    expect(api.session.restore).toHaveBeenCalledOnce();
  });

  it("does not select or restore when no durable profile is selected", async () => {
    const api = createOcc({
      profiles: {
        list: vi.fn().mockResolvedValue([profileA, profileB]),
        current: vi.fn().mockResolvedValue(null),
      },
    });
    installOcc(api);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "连接服务器" })).toBeInTheDocument();
    expect(api.profiles.select).not.toHaveBeenCalled();
    expect(api.session.restore).not.toHaveBeenCalled();
  });

  it("initializes profiles, restores the selected session, switches profiles, and logs out", async () => {
    const api = createOcc({
      profiles: { list: vi.fn().mockResolvedValue([profileA, profileB]) },
      session: {
        restore: vi.fn()
          .mockResolvedValueOnce({ state: "anonymous" })
          .mockResolvedValueOnce({ state: "authenticated", user: identity, expiresAt }),
      },
    });
    installOcc(api);
    render(<App />);

    expect(await screen.findByRole("heading", { name: /登录/ })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/服务器配置/), { target: { value: profileB.id } });
    await screen.findByRole("heading", { name: "运行总览" });
    expect(api.profiles.select).toHaveBeenCalledWith(profileB.id);
    expect(api.session.restore).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/Production B/)).toBeInTheDocument();
    expect(screen.getByText(/生产环境/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /退出登录/ }));
    await waitFor(() => expect(api.session.logout).toHaveBeenCalledOnce());
    expect(await screen.findByRole("heading", { name: /登录/ })).toBeInTheDocument();
  });

  it("survives profile IPC failure without a blank screen", async () => {
    installOcc(createOcc({ profiles: { list: vi.fn().mockRejectedValue(new Error("secret path")) } }));
    render(<App />);
    expect(await screen.findByRole("alert")).toHaveTextContent("无法加载服务器配置");
    expect(screen.getByRole("button", { name: /重试/ })).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("secret path");
  });

  it("moves an authenticated session offline and locks mutations", async () => {
    installOcc(createOcc({
      session: {
        restore: vi.fn().mockResolvedValue({ state: "authenticated", user: identity, expiresAt }),
      },
    }));
    render(<App />);
    await screen.findByRole("heading", { name: "运行总览" });

    fireEvent(window, new Event("offline"));
    await waitFor(() => expect(screen.getByLabelText("连接状态", { exact: true })).toHaveTextContent(/离线.*只读/));
  });

  it("moves stale when polling reports Core unreachable", async () => {
    const checkedAt = "2026-08-01T12:00:00.000Z";
    installOcc(createOcc({
      session: {
        restore: vi.fn().mockResolvedValue({ state: "authenticated", user: identity, expiresAt }),
      },
      runtime: {
        statuses: vi.fn().mockResolvedValue([{
          service: "occ-core",
          version: "unknown",
          state: "UNREACHABLE",
          checkedAt,
          components: [],
        }]),
      },
    }));
    render(<App />);

    await waitFor(() => {
      expect(screen.getByLabelText("连接状态", { exact: true })).toHaveTextContent(/离线.*只读/);
    });
    expect(screen.getByRole("row", { name: /OCC Core/ })).toHaveTextContent("不可达");
  });

  it("clears statuses on profile switch and rejects the old delayed callback", async () => {
    let resolveA!: (value: []) => void;
    let resolveB!: (value: []) => void;
    const statuses = vi.fn()
      .mockImplementationOnce(() => new Promise<[]>((resolve) => void (resolveA = resolve)))
      .mockImplementationOnce(() => new Promise<[]>((resolve) => void (resolveB = resolve)));
    const api = createOcc({
      profiles: {
        list: vi.fn().mockResolvedValue([profileA, profileB]),
        current: vi.fn().mockResolvedValue(profileA),
      },
      session: {
        restore: vi.fn().mockResolvedValue({ state: "authenticated", user: identity, expiresAt }),
      },
      runtime: { statuses },
    });
    installOcc(api);
    render(<App />);
    await screen.findByRole("heading", { name: "运行总览" });
    expect(statuses).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: /退出登录/ }));
    await screen.findByRole("heading", { name: /登录/ });
    fireEvent.change(screen.getByLabelText(/服务器配置/), { target: { value: profileB.id } });
    await screen.findByRole("heading", { name: "运行总览" });
    expect(statuses).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("row", { name: /OCC Core/ })).toHaveTextContent("检查中");

    resolveA([]);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(screen.getByRole("row", { name: /OCC Core/ })).toHaveTextContent("检查中");
    resolveB([]);
  });

  it("guards profile persistence after the shell becomes read-only", async () => {
    const api = createOcc({
      session: {
        restore: vi.fn().mockResolvedValue({ state: "authenticated", user: identity, expiresAt }),
      },
    });
    installOcc(api);
    const { container } = render(<App />);
    await screen.findByRole("heading", { name: "运行总览" });
    window.location.hash = "#/settings";
    fireEvent(window, new HashChangeEvent("hashchange"));
    await screen.findByRole("heading", { name: "设置" });
    fireEvent(window, new Event("offline"));

    await waitFor(() => expect(screen.getByRole("button", { name: /保存配置/ })).toBeDisabled());
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);
    expect(api.profiles.save).not.toHaveBeenCalled();
  });

  it("bounds failed reconnect validation and unlocks only after manual retry succeeds", async () => {
    const restore = vi.fn()
      .mockResolvedValueOnce({ state: "authenticated", user: identity, expiresAt })
      .mockRejectedValueOnce(new Error("offline secret"))
      .mockResolvedValueOnce({ state: "authenticated", user: identity, expiresAt });
    const api = createOcc({ session: { restore } });
    installOcc(api);
    render(<App />);
    await screen.findByRole("heading", { name: "运行总览" });

    fireEvent(window, new Event("offline"));
    fireEvent(window, new Event("online"));
    const retry = await screen.findByRole("button", { name: /重试连接/ });
    expect(screen.getByLabelText("连接状态", { exact: true })).toHaveTextContent(/重新连接.*锁定/);
    await new Promise((resolve) => window.setTimeout(resolve, 25));
    expect(restore).toHaveBeenCalledTimes(2);

    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByLabelText("连接状态", { exact: true })).toHaveTextContent("在线"));
    expect(restore).toHaveBeenCalledTimes(3);
    expect(document.body).not.toHaveTextContent("offline secret");
  });

  it("keeps a saved settings profile in the selectable profile list", async () => {
    const updated = { ...profileA, name: "Updated Pilot" };
    const api = createOcc({
      profiles: {
        list: vi.fn().mockResolvedValue([profileA, profileB]),
        save: vi.fn().mockResolvedValue(updated),
      },
      session: {
        restore: vi.fn()
          .mockResolvedValueOnce({ state: "authenticated", user: identity, expiresAt })
          .mockResolvedValueOnce({ state: "anonymous" }),
      },
    });
    installOcc(api);
    render(<App />);
    await screen.findByRole("heading", { name: "运行总览" });

    window.location.hash = "#/settings";
    fireEvent(window, new HashChangeEvent("hashchange"));
    await screen.findByRole("heading", { name: "设置" });
    fireEvent.change(screen.getByLabelText(/配置名称/), { target: { value: updated.name } });
    fireEvent.click(screen.getByRole("button", { name: /保存配置/ }));

    const selector = await screen.findByLabelText(/服务器配置/);
    expect(within(selector).getByRole("option", { name: updated.name })).toBeInTheDocument();
  });
});

describe("renderer error boundary", () => {
  it("hides sensitive exception details and remounts content on retry", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let fail = true;
    function UnstableContent() {
      if (fail) throw new Error("token secret-value at C:\\private\\path");
      return <p>恢复完成</p>;
    }
    render(
      <RendererErrorBoundary>
        <UnstableContent />
      </RendererErrorBoundary>,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("应用无法继续显示");
    expect(document.body).not.toHaveTextContent(/secret-value|private|token/i);
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: /重试应用/ }));
    expect(screen.getByText("恢复完成")).toBeInTheDocument();
    consoleError.mockRestore();
  });
});
