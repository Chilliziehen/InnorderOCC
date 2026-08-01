import type { CurrentUser } from "@innorder/contracts";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OccApi, ServerProfile } from "../src/desktop-contract";
import { App } from "../src/renderer/App";
import { AppShell } from "../src/renderer/components/AppShell";
import { Login } from "../src/renderer/components/Login";
import { ProfileBootstrap } from "../src/renderer/components/ProfileBootstrap";
import { StatusBanner } from "../src/renderer/components/StatusBanner";
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
      statuses: vi.fn().mockResolvedValue([]),
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

  it("shows exact stale connectivity states and mutation lockout", () => {
    const { rerender } = render(<StatusBanner mode="authenticated" lastFreshAt={Date.now() - 4_000} />);
    expect(screen.getByRole("status")).toHaveTextContent(/在线.*4 秒/);

    rerender(<StatusBanner mode="reconnecting" lastFreshAt={Date.now() - 65_000} />);
    expect(screen.getByRole("status")).toHaveTextContent(/正在重新连接.*1 分钟/);
    expect(screen.getByRole("status")).toHaveTextContent("更改操作已锁定");

    rerender(<StatusBanner mode="offline" lastFreshAt={Date.now() - 125_000} />);
    expect(screen.getByRole("status")).toHaveTextContent(/离线.*2 分钟/);
    expect(screen.getByRole("status")).toHaveTextContent("只读");
  });
});

describe("application controller", () => {
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
    expect(await screen.findByRole("status", { name: /连接状态/ })).toHaveTextContent(/离线.*只读/);
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
