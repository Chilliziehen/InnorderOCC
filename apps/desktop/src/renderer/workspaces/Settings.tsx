import { useEffect, useState, type FormEvent } from "react";

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
}

const definition = WORKSPACE_DEFINITIONS.settings;

export function Settings({ profiles, current, connectivity, onSelect, onSave, onRemove, onPreferencesChange, onLogout }: SettingsProps) {
  const [activeTab, setActiveTab] = useState(definition.tabs[0]!.id);
  const [name, setName] = useState(current?.name ?? "");
  const [origin, setOrigin] = useState(current?.origin ?? "");
  const [environment, setEnvironment] = useState<ServerProfile["environment"]>(current?.environment ?? "pilot");
  const [fingerprint, setFingerprint] = useState(current?.caFingerprint ?? "");
  const [pendingRemoval, setPendingRemoval] = useState<ServerProfile>();
  const [theme, setTheme] = useState("system");
  const [reducedMotion, setReducedMotion] = useState(false);
  const mutable = connectivity === "online";

  useEffect(() => {
    setName(current?.name ?? "");
    setOrigin(current?.origin ?? "");
    setEnvironment(current?.environment ?? "pilot");
    setFingerprint(current?.caFingerprint ?? "");
  }, [current]);

  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!mutable) return;
    void onSave({
      ...(current ? { id: current.id } : {}),
      name,
      origin,
      environment,
      ...(fingerprint.trim() ? { caFingerprint: fingerprint } : {}),
    });
  };
  const changePreferences = (next: SettingsPreferences) => {
    if (!mutable) return;
    setTheme(next.theme);
    setReducedMotion(next.reducedMotion);
    void onPreferencesChange(next);
  };

  const active = definition.tabs.find(({ id }) => id === activeTab) ?? definition.tabs[0]!;
  return (
    <section aria-labelledby="settings-title">
      <h1 id="settings-title">设置</h1>
      <p role="status" aria-live="polite">
        {connectivity === "online" ? "在线，可以更改设置" : connectivity === "offline" ? "离线，更改操作已锁定" : "正在重新连接，更改操作已锁定"}
      </p>
      <div role="tablist" aria-label="设置分类">
        {definition.tabs.map((tab) => (
          <button
            type="button"
            role="tab"
            id={`settings-tab-${tab.id}`}
            aria-controls={`settings-panel-${tab.id}`}
            aria-selected={active.id === tab.id}
            tabIndex={active.id === tab.id ? 0 : -1}
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
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
                  <button type="button" disabled={!mutable || profile.id === current?.id} onClick={() => { if (mutable) void onSelect(profile.id); }}>使用 {profile.name}</button>
                  <button type="button" disabled={!mutable} onClick={() => { if (mutable) setPendingRemoval(profile); }}>移除 {profile.name}</button>
                </article>
              ))}
            </div>
            <form aria-label="编辑服务器配置" onSubmit={save}>
              <label>配置名称<input required maxLength={128} disabled={!mutable} value={name} onChange={({ currentTarget }) => setName(currentTarget.value)} /></label>
              <label>服务器源地址<input required type="url" disabled={!mutable} value={origin} onChange={({ currentTarget }) => setOrigin(currentTarget.value)} /></label>
              <label>环境<select disabled={!mutable} value={environment} onChange={({ currentTarget }) => setEnvironment(currentTarget.value as ServerProfile["environment"])}><option value="production">生产环境</option><option value="pilot">试点环境</option><option value="development">开发环境</option></select></label>
              <label>CA SHA-256 指纹<input disabled={!mutable} spellCheck={false} value={fingerprint} onChange={({ currentTarget }) => setFingerprint(currentTarget.value)} /></label>
              <button type="submit" disabled={!mutable}>保存配置</button>
            </form>
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
            <label>主题<select disabled={!mutable} value={theme} onChange={({ currentTarget }) => changePreferences({ theme: currentTarget.value, reducedMotion })}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label>
            <label><input type="checkbox" disabled={!mutable} checked={reducedMotion} onChange={({ currentTarget }) => changePreferences({ theme, reducedMotion: currentTarget.checked })} />减少动态效果</label>
          </form>
        ) : null}
        {active.id === "session" ? <button type="button" disabled={!mutable} onClick={() => { if (mutable) void onLogout(); }}>退出登录</button> : null}
      </div>
      {pendingRemoval ? (
        <div role="dialog" aria-modal="true" aria-labelledby="remove-profile-title">
          <h2 id="remove-profile-title">确认移除配置</h2>
          <p>{pendingRemoval.id === current?.id ? "这是当前选中的配置。移除后需要选择其他服务器。" : `将移除 ${pendingRemoval.name}。`}</p>
          <button type="button" onClick={() => setPendingRemoval(undefined)}>取消</button>
          <button type="button" disabled={!mutable} onClick={() => { if (!mutable) return; void onRemove(pendingRemoval.id); setPendingRemoval(undefined); }}>确认移除</button>
        </div>
      ) : null}
    </section>
  );
}
