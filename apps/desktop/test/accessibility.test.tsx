import type { CurrentUser } from "@innorder/contracts";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { axe, toHaveNoViolations } from "jest-axe";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { OccApi, ServerProfile, WorkspaceResult } from "../src/desktop-contract";
import type { AuthenticatedState } from "../src/renderer/app-controller";
import { AppShell } from "../src/renderer/components/AppShell";
import { Login } from "../src/renderer/components/Login";
import { ProfileBootstrap } from "../src/renderer/components/ProfileBootstrap";
import { WorkspaceState } from "../src/renderer/components/WorkspaceState";
import { ROUTES } from "../src/renderer/routes";
import { WORKSPACE_MANIFEST } from "../src/renderer/workspace-manifest";

expect.extend(toHaveNoViolations);

declare module "vitest" {
  interface Assertion<T = any> {
    toHaveNoViolations(): T;
  }
}

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

function authenticatedState(path: NonNullable<AuthenticatedState["route"]>["path"], focusToken = 1): AuthenticatedState {
  return {
    mode: "authenticated",
    profiles: [profile],
    profile,
    identity,
    expiresAt: "2099-08-01T13:00:00.000Z",
    lastFreshAt: Date.parse("2026-08-01T12:00:00.000Z"),
    sessionGeneration: 1,
    sessionOperation: null,
    route: { path, focusToken },
  };
}

function unavailableResult(): WorkspaceResult {
  return {
    state: "unavailable",
    reason: "UNAVAILABLE_CONTRACT",
    resourceGroups: ["/contract"],
    message: "工作区 API 合同不可用",
  };
}

function installOcc(result: WorkspaceResult = unavailableResult()): OccApi {
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
    workspaces: { query: vi.fn().mockResolvedValue(result) },
    commands: { execute: vi.fn() },
    uploads: { start: vi.fn(), cancel: vi.fn() },
    notifications: {
      list: vi.fn().mockResolvedValue({ items: [] }),
      subscribe: vi.fn(() => vi.fn()),
    },
  };
  Object.defineProperty(window, "occ", { configurable: true, value: api });
  return api;
}

async function expectAccessible(container: HTMLElement): Promise<void> {
  expect(await axe(container)).toHaveNoViolations();
}

function assertAriaControls(container: HTMLElement): void {
  for (const control of container.querySelectorAll<HTMLElement>("[aria-controls]")) {
    const target = control.getAttribute("aria-controls");
    expect(target, `${control.textContent} must name a controlled element`).toBeTruthy();
    expect(container.querySelector(`#${CSS.escape(target!)}`)).not.toBeNull();
  }
}

beforeEach(() => {
  window.location.hash = "#/overview";
});

describe("entry accessibility", () => {
  it("has no axe violations in profile bootstrap", async () => {
    const { container } = render(<ProfileBootstrap profiles={[profile]} onSave={vi.fn()} onSelect={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "连接服务器" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /使用 Pilot/ })).toBeInTheDocument();
    await expectAccessible(container);
  });

  it("has no axe violations in login and keeps every field keyboard reachable", async () => {
    const { container } = render(<Login profile={profile} profiles={[profile]} onProfileSelect={vi.fn()} onSubmit={vi.fn()} />);
    const username = screen.getByLabelText("用户名");
    username.focus();
    expect(username).toHaveFocus();
    expect(screen.getByLabelText("密码")).not.toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("button", { name: "登录" })).not.toHaveAttribute("tabindex", "-1");
    await expectAccessible(container);
  });
});

describe("authenticated console accessibility", () => {
  it.each(ROUTES)("has no axe violations on $path", async ({ path, title }) => {
    const api = installOcc();
    const { container } = render(
      <AppShell
        state={authenticatedState(path)}
        statuses={[]}
        onLogout={vi.fn()}
        onProfileSelect={vi.fn()}
        onProfileSave={vi.fn()}
        onProfileRemove={vi.fn()}
      />,
    );

    expect(await screen.findByRole("heading", { name: title })).toBeInTheDocument();
    if (path !== "/system" && path !== "/settings") {
      await waitFor(() => expect(api.workspaces.query).toHaveBeenCalled());
      await screen.findByText("工作区 API 合同不可用");
    }
    assertAriaControls(container);
    expect(container.querySelectorAll("main")).toHaveLength(1);
    for (const button of screen.getAllByRole("button")) {
      expect(button).toHaveAccessibleName();
    }
    await expectAccessible(container);
  });

  it("uses native route links and focuses the destination heading", async () => {
    installOcc();
    const props = { statuses: [], onLogout: vi.fn(), onProfileSelect: vi.fn(), onProfileSave: vi.fn() };
    const { rerender } = render(<AppShell state={authenticatedState("/overview", 0)} {...props} />);
    const navigation = screen.getByRole("navigation", { name: "主导航" });
    const risksLink = within(navigation).getByRole("link", { name: "风险" });
    expect(risksLink).toHaveAttribute("href", "#/risks");
    risksLink.focus();
    expect(risksLink).toHaveFocus();

    rerender(<AppShell state={authenticatedState("/risks", 2)} {...props} />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "风险" })).toHaveFocus());
  });

  it("supports keyboard tabs and a trapped, labelled removal modal", async () => {
    installOcc();
    const { container } = render(
      <AppShell
        state={authenticatedState("/settings")}
        statuses={[]}
        onLogout={vi.fn()}
        onProfileSelect={vi.fn()}
        onProfileSave={vi.fn()}
        onProfileRemove={vi.fn()}
      />,
    );
    const firstTab = screen.getByRole("tab", { name: "服务器配置" });
    firstTab.focus();
    fireEvent.keyDown(firstTab, { key: "ArrowRight" });
    const trustTab = screen.getByRole("tab", { name: "TLS 信任" });
    expect(trustTab).toHaveFocus();
    fireEvent.keyDown(trustTab, { key: "ArrowLeft" });
    expect(firstTab).toHaveFocus();

    const remove = screen.getByRole("button", { name: "移除 Pilot" });
    fireEvent.click(remove);
    const dialog = screen.getByRole("dialog", { name: "确认移除配置" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    const confirm = within(dialog).getByRole("button", { name: "确认移除" });
    expect(confirm).toHaveFocus();
    fireEvent.keyDown(confirm, { key: "Tab" });
    expect(within(dialog).getByRole("button", { name: "取消" })).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(remove).toHaveFocus();
    await expectAccessible(container);
  });
});

describe("workspace state accessibility", () => {
  const schema = z.object({ name: z.string() }).strict();
  const fetchedAt = "2026-08-01T12:00:00.000Z";
  const cases: Array<[string, WorkspaceResult]> = [
    ["offline", { state: "offline", items: [{ name: "离线记录" }], count: 1, fetchedAt }],
    ["stale", { state: "stale", items: [{ name: "过期记录" }], count: 1, fetchedAt }],
    ["error", { state: "error", problem: { title: "查询失败", code: "FAILED", status: 503 } }],
    ["conflict", { state: "conflict", currentVersion: 4, correlationId: "correlation-4" }],
    ["unavailable", unavailableResult()],
  ];

  it.each(cases)("has no axe violations for %s", async (_name, result) => {
    const { container } = render(
      <WorkspaceState
        result={result}
        itemSchema={schema}
        columns={[{ key: "name", label: "名称" }]}
        unavailableControls={["不可用操作"]}
        onRetry={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );
    await expectAccessible(container);
  });
});

describe("static accessibility and reflow policy", () => {
  const styles = readFileSync("src/renderer/styles.css", "utf8");
  const html = readFileSync("src/renderer/index.html", "utf8");

  it("defines console tokens, stable controls, focus, compact reflow, and system accessibility modes", () => {
    expect(styles).toMatch(/--sidebar:\s*#172126/i);
    expect(styles).toMatch(/--surface:\s*#fff(?:fff)?/i);
    expect(styles).toMatch(/--status-(?:success|warning|danger):/g);
    expect(styles).toMatch(/:focus-visible[^}]*outline:\s*(?:[2-9]|\d{2,})px/is);
    expect(styles).toMatch(/min-height:\s*32px/i);
    expect(styles).toMatch(/@media\s*\(max-width:\s*980px\)/i);
    expect(styles).toMatch(/@media\s*\(max-width:\s*700px\)/i);
    expect(styles).toMatch(/@media\s*\(forced-colors:\s*active\)/i);
    expect(styles).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/i);
    expect(styles).not.toMatch(/gradient\s*\(/i);
    expect(styles).not.toMatch(/\.status-(?:table-head|row)\s*>\s*:last-child[^}]*display:\s*none/is);
  });

  it("declares the Chinese document language and desktop metadata", () => {
    expect(html).toMatch(/<html\s+lang="zh-CN">/);
    expect(html).toMatch(/<meta\s+name="description"/);
    expect(html).toMatch(/<title>创序 OCC 运营控制中心<\/title>/);
  });
});
