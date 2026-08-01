import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

import type { ProfileInput, ServerProfile } from "../../desktop-contract";
import { WORKSPACE_DEFINITIONS } from "./workspace-definitions";
import type { WorkspaceConnectivity } from "./Administration";

export interface SettingsPreferences {
  readonly theme: string;
  readonly reducedMotion: boolean;
}

export interface SettingsProps {
  readonly profiles: readonly ServerProfile[];
  readonly current: ServerProfile | null;
  readonly connectivity: WorkspaceConnectivity;
  readonly onSelect: (profileId: string) => void | Promise<void>;
  readonly onSave: (profile: ProfileInput) => void | Promise<void>;
  readonly onRemove: (profileId: string) => void | Promise<void>;
  readonly onPreferencesChange: (preferences: SettingsPreferences) => void | Promise<void>;
  readonly onLogout: () => void | Promise<void>;
  readonly onTabChange?: (tabId: string) => void;
  readonly activeTab?: string;
}

const definition = WORKSPACE_DEFINITIONS.settings;
const preferencesOperation = definition.commands.find(({ operation }) => operation === "preferences.update")!;
type PendingAction = `select:${string}` | "save" | "remove" | "logout";
type ActionError = { readonly action: PendingAction; readonly message: string };

function moveTab(event: KeyboardEvent<HTMLButtonElement>, index: number, select: (id: string) => void) {
  let next: number | undefined;
  if (event.key === "ArrowRight") next = (index + 1) % definition.tabs.length;
  if (event.key === "ArrowLeft") next = (index - 1 + definition.tabs.length) % definition.tabs.length;
  if (event.key === "Home") next = 0;
  if (event.key === "End") next = definition.tabs.length - 1;
  if (next === undefined) return;
  event.preventDefault();
  select(definition.tabs[next]!.id);
  event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role=tab]")[next]?.focus();
}

export function Settings({ profiles, current, connectivity, onSelect, onSave, onRemove, onPreferencesChange, onLogout, onTabChange, activeTab: controlledActiveTab }: SettingsProps) {
  const [localActiveTab, setActiveTab] = useState(definition.tabs[0]!.id);
  const activeTab = definition.tabs.some(({ id }) => id === controlledActiveTab) ? controlledActiveTab! : localActiveTab;
  const [name, setName] = useState(current?.name ?? "");
  const [origin, setOrigin] = useState(current?.origin ?? "");
  const [environment, setEnvironment] = useState<ServerProfile["environment"]>(current?.environment ?? "pilot");
  const [fingerprint, setFingerprint] = useState(current?.caFingerprint ?? "");
  const [pendingRemoval, setPendingRemoval] = useState<ServerProfile>();
  const [theme, setTheme] = useState("system");
  const [reducedMotion, setReducedMotion] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction>();
  const [actionError, setActionError] = useState<ActionError>();
  const pendingActionRef = useRef<PendingAction | undefined>(undefined);
  const removalTriggerRef = useRef<HTMLButtonElement | undefined>(undefined);
  const confirmRemovalRef = useRef<HTMLButtonElement>(null);
  const cancelRemovalRef = useRef<HTMLButtonElement>(null);
  const mutable = connectivity === "online";
  const preferencesAvailable = preferencesOperation.availability.state === "available";

  useEffect(() => {
    setName(current?.name ?? "");
    setOrigin(current?.origin ?? "");
    setEnvironment(current?.environment ?? "pilot");
    setFingerprint(current?.caFingerprint ?? "");
  }, [current]);

  useEffect(() => {
    if (pendingRemoval) {
      confirmRemovalRef.current?.focus();
      return;
    }
    removalTriggerRef.current?.focus();
    removalTriggerRef.current = undefined;
  }, [pendingRemoval]);

  const runAction = async (action: PendingAction, message: string, callback: () => void | Promise<void>, onSuccess?: () => void) => {
    if (pendingActionRef.current) return;
    pendingActionRef.current = action;
    setPendingAction(action);
    setActionError(undefined);
    try {
      await callback();
      onSuccess?.();
    } catch {
      setActionError({ action, message });
    } finally {
      pendingActionRef.current = undefined;
      setPendingAction(undefined);
    }
  };

  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!mutable || pendingActionRef.current) return;
    const input: ProfileInput = {
      ...(current ? { id: current.id } : {}),
      name,
      origin,
      environment,
      ...(fingerprint.trim() ? { caFingerprint: fingerprint } : {}),
    };
    void runAction("save", "无法保存服务器配置，请重试。", () => onSave(input));
  };
  const changePreferences = (next: SettingsPreferences) => {
    if (!mutable || !preferencesAvailable) return;
    setTheme(next.theme);
    setReducedMotion(next.reducedMotion);
    void onPreferencesChange(next);
  };
  const closeRemoval = () => {
    if (pendingActionRef.current === "remove") return;
    setPendingRemoval(undefined);
  };
  const handleDialogKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeRemoval();
      return;
    }
    if (event.key !== "Tab") return;
    if (event.shiftKey && document.activeElement === cancelRemovalRef.current) {
      event.preventDefault();
      confirmRemovalRef.current?.focus();
    } else if (!event.shiftKey && document.activeElement === confirmRemovalRef.current) {
      event.preventDefault();
      cancelRemovalRef.current?.focus();
    }
  };

  const active = definition.tabs.find(({ id }) => id === activeTab) ?? definition.tabs[0]!;
  return (
    <section aria-labelledby="settings-title">
      <div data-testid="settings-background" inert={pendingRemoval ? true : undefined} aria-hidden={pendingRemoval ? true : undefined}>
        <h1 id="settings-title">设置</h1>
        <p role="status" aria-live="polite">
          {connectivity === "online" ? "在线，可以更改设置" : connectivity === "offline" ? "离线，服务器配置更改已锁定" : "正在重新连接，服务器配置更改已锁定"}
        </p>
        <div role="tablist" aria-label="设置分类">
        {definition.tabs.map((tab, index) => (
          <button
            type="button"
            role="tab"
            id={`settings-tab-${tab.id}`}
            aria-controls={`settings-panel-${tab.id}`}
            aria-selected={active.id === tab.id}
            tabIndex={active.id === tab.id ? 0 : -1}
            key={tab.id}
            onClick={() => { setActiveTab(tab.id); onTabChange?.(tab.id); }}
            onKeyDown={(event) => moveTab(event, index, (tabId) => { setActiveTab(tabId); onTabChange?.(tabId); })}
          >
            {tab.label}
          </button>
        ))}
        </div>
        <div role="tabpanel" id={`settings-panel-${active.id}`} aria-labelledby={`settings-tab-${active.id}`}>
        {active.id === "profile" ? (
          <>
            <div aria-label="已保存的服务器配置">
              {profiles.map((profile) => (
                <article key={profile.id}>
                  <strong>{profile.name}</strong>
                  <span>{profile.origin}</span>
                  <button type="button" disabled={!mutable || Boolean(pendingAction) || profile.id === current?.id} onClick={() => { if (!mutable || pendingActionRef.current) return; void runAction(`select:${profile.id}`, "无法选择服务器配置，请重试。", () => onSelect(profile.id)); }}>{pendingAction === `select:${profile.id}` ? `正在选择 ${profile.name}` : `使用 ${profile.name}`}</button>
                  <button type="button" disabled={!mutable || Boolean(pendingAction)} onClick={(event) => { if (!mutable || pendingActionRef.current) return; removalTriggerRef.current = event.currentTarget; setActionError(undefined); setPendingRemoval(profile); }}>移除 {profile.name}</button>
                </article>
              ))}
            </div>
            <form aria-label="编辑服务器配置" onSubmit={save}>
              <label>配置名称<input required maxLength={128} disabled={!mutable} value={name} onChange={({ currentTarget }) => setName(currentTarget.value)} /></label>
              <label>服务器源地址<input required type="url" disabled={!mutable} value={origin} onChange={({ currentTarget }) => setOrigin(currentTarget.value)} /></label>
              <label>环境<select disabled={!mutable} value={environment} onChange={({ currentTarget }) => setEnvironment(currentTarget.value as ServerProfile["environment"])}><option value="production">生产环境</option><option value="pilot">试点环境</option><option value="development">开发环境</option></select></label>
              <label>CA SHA-256 指纹<input disabled={!mutable} spellCheck={false} value={fingerprint} onChange={({ currentTarget }) => setFingerprint(currentTarget.value)} /></label>
              <button type="submit" disabled={!mutable || Boolean(pendingAction)}>{pendingAction === "save" ? "正在保存" : "保存配置"}</button>
            </form>
            {actionError && actionError.action !== "remove" ? <p role="alert">{actionError.message}</p> : null}
          </>
        ) : null}
        {active.id === "trust" ? (
          <section aria-label="TLS 信任状态">
            <h2>TLS 信任</h2>
            <strong>{current?.caFingerprint ? "已固定 SHA-256 指纹" : "使用系统 TLS 信任"}</strong>
            {current?.caFingerprint ? <code>{current.caFingerprint}</code> : null}
          </section>
        ) : null}
        {active.id === "preferences" ? (
          <form aria-label="偏好设置" onSubmit={(event) => event.preventDefault()}>
            <label>主题<select disabled={!mutable || !preferencesAvailable} value={theme} onChange={({ currentTarget }) => changePreferences({ theme: currentTarget.value, reducedMotion })}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label>
            <label><input type="checkbox" disabled={!mutable || !preferencesAvailable} checked={reducedMotion} onChange={({ currentTarget }) => changePreferences({ theme, reducedMotion: currentTarget.checked })} />减少动态效果</label>
            {preferencesOperation.availability.state === "unavailable" ? <><p>{preferencesOperation.availability.message}</p><p>所需 API：{preferencesOperation.availability.resourceGroups.join("、")}</p></> : null}
          </form>
        ) : null}
        {active.id === "session" ? <><button type="button" disabled={Boolean(pendingAction)} onClick={() => { if (pendingActionRef.current) return; void runAction("logout", "无法退出登录，请重试。", onLogout); }}>{pendingAction === "logout" ? "正在退出" : "退出登录"}</button>{actionError?.action === "logout" ? <p role="alert">{actionError.message}</p> : null}</> : null}
        </div>
      </div>
      {pendingRemoval ? (
        <div role="dialog" aria-modal="true" aria-labelledby="remove-profile-title" onKeyDown={handleDialogKey}>
          <h2 id="remove-profile-title">确认移除配置</h2>
          <p>{pendingRemoval.id === current?.id ? "这是当前选中的配置。移除后需要选择其他服务器。" : `将移除 ${pendingRemoval.name}。`}</p>
          {actionError?.action === "remove" ? <p role="alert">{actionError.message}</p> : null}
          <button ref={cancelRemovalRef} type="button" disabled={pendingAction === "remove"} onClick={closeRemoval}>取消</button>
          <button ref={confirmRemovalRef} type="button" disabled={!mutable || pendingAction === "remove"} onClick={() => { if (!mutable || pendingActionRef.current) return; void runAction("remove", "无法移除服务器配置，请重试。", () => onRemove(pendingRemoval.id), () => setPendingRemoval(undefined)); }}>{pendingAction === "remove" ? "正在移除" : "确认移除"}</button>
        </div>
      ) : null}
    </section>
  );
}
