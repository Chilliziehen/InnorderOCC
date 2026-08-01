import { useState, type FormEvent } from "react";

import type { LoginInput, ServerProfile } from "../../desktop-contract";

const ENVIRONMENT_LABELS: Record<ServerProfile["environment"], string> = {
  production: "生产环境",
  pilot: "试点环境",
  development: "开发环境",
};

interface LoginProps {
  profile: ServerProfile;
  profiles: ServerProfile[];
  notice?: "expired";
  onProfileSelect(profile: ServerProfile): void | Promise<void>;
  onSubmit(input: LoginInput): Promise<unknown>;
}

function correlationIdOf(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("correlationId" in error)) return null;
  const value = error.correlationId;
  return typeof value === "string" ? value : null;
}

export function Login({ profile, profiles, notice, onProfileSelect, onSubmit }: LoginProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ correlationId: string | null } | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setFailure(null);
    try {
      await onSubmit({ username, password });
    } catch (error) {
      setFailure({ correlationId: correlationIdOf(error) });
    } finally {
      setPassword("");
      setBusy(false);
    }
  };

  return (
    <section className="entry-panel login-panel" aria-labelledby="login-title">
      <div className="entry-heading">
        <span className="brand-mark" aria-hidden="true">序</span>
        <div>
          <p className="section-kicker">{profile.name}</p>
          <h1 id="login-title">登录创序 OCC</h1>
        </div>
      </div>

      <div className="environment-identity">
        <strong>{new URL(profile.origin).hostname}</strong>
        <span>{ENVIRONMENT_LABELS[profile.environment]}</span>
      </div>

      {profiles.length > 1 ? (
        <label className="profile-select">
          服务器配置
          <select
            value={profile.id}
            disabled={busy}
            onChange={({ target }) => {
              const selected = profiles.find(({ id }) => id === target.value);
              if (selected) void onProfileSelect(selected);
            }}
          >
            {profiles.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
      ) : null}

      {notice === "expired" ? (
        <p className="session-notice" role="status" aria-live="polite">会话已过期，请重新登录。</p>
      ) : null}

      <form className="entry-form" onSubmit={(event) => void submit(event)}>
        <label htmlFor="login-username">用户名</label>
        <input
          id="login-username"
          autoComplete="username"
          required
          value={username}
          onChange={({ target }) => setUsername(target.value)}
        />
        <label htmlFor="login-password">密码</label>
        <input
          id="login-password"
          autoComplete="current-password"
          required
          type="password"
          value={password}
          onChange={({ target }) => setPassword(target.value)}
        />
        {failure !== null ? (
          <p className="form-error" role="alert">
            登录失败，请检查凭据后重试。
            {failure.correlationId ? <span>关联编号：{failure.correlationId}</span> : null}
          </p>
        ) : null}
        <button className="primary-action" type="submit" disabled={busy}>
          {busy ? "正在登录…" : "登录"}
        </button>
      </form>
    </section>
  );
}

export { ENVIRONMENT_LABELS };
