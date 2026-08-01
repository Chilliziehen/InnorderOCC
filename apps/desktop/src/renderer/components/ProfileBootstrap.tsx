import { useEffect, useState, type FormEvent } from "react";

import type { ProfileInput, ServerProfile } from "../../desktop-contract";

interface ProfileBootstrapProps {
  profiles: ServerProfile[];
  profile?: ServerProfile;
  onSave(input: ProfileInput): Promise<unknown>;
  onSelect(profile: ServerProfile): void | Promise<void>;
}

export function ProfileBootstrap({
  profiles,
  profile,
  onSave,
  onSelect,
}: ProfileBootstrapProps) {
  const [name, setName] = useState(profile?.name ?? "");
  const [origin, setOrigin] = useState(profile?.origin ?? "");
  const [environment, setEnvironment] = useState<ServerProfile["environment"]>(
    profile?.environment ?? "pilot",
  );
  const [caFingerprint, setCaFingerprint] = useState(profile?.caFingerprint ?? "");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setName(profile?.name ?? "");
    setOrigin(profile?.origin ?? "");
    setEnvironment(profile?.environment ?? "pilot");
    setCaFingerprint(profile?.caFingerprint ?? "");
  }, [profile]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setFailed(false);
    try {
      await onSave({
        ...(profile ? { id: profile.id } : {}),
        name,
        origin,
        environment,
        ...(caFingerprint.trim() ? { caFingerprint } : {}),
      });
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="entry-panel" aria-labelledby="profile-title">
      <div className="entry-heading">
        <span className="brand-mark" aria-hidden="true">序</span>
        <div>
          <p className="section-kicker">创序 OCC</p>
          {profile
            ? <h2 id="profile-title">服务器配置</h2>
            : <h1 id="profile-title">连接服务器</h1>}
        </div>
      </div>

      {profiles.length > 0 && !profile ? (
        <div className="profile-list" aria-label="已保存的服务器配置">
          {profiles.map((item) => (
            <button key={item.id} type="button" onClick={() => void onSelect(item)}>
              使用 {item.name}
              <small>{new URL(item.origin).hostname}</small>
            </button>
          ))}
        </div>
      ) : null}

      <form className="entry-form" onSubmit={(event) => void submit(event)}>
        <label htmlFor="profile-name">配置名称</label>
        <input
          id="profile-name"
          required
          maxLength={128}
          value={name}
          onChange={({ target }) => setName(target.value)}
        />

        <label htmlFor="profile-origin">服务器源地址（精确 origin）</label>
        <input
          id="profile-origin"
          required
          type="url"
          placeholder="https://occ.example.com"
          value={origin}
          onChange={({ target }) => setOrigin(target.value)}
        />

        <label htmlFor="profile-environment">环境</label>
        <select
          id="profile-environment"
          value={environment}
          onChange={({ target }) => setEnvironment(target.value as ServerProfile["environment"])}
        >
          <option value="production">生产环境</option>
          <option value="pilot">试点环境</option>
          <option value="development">开发环境</option>
        </select>

        <label htmlFor="profile-ca">CA SHA-256 指纹（可选）</label>
        <input
          id="profile-ca"
          spellCheck={false}
          value={caFingerprint}
          onChange={({ target }) => setCaFingerprint(target.value)}
        />

        {failed ? <p className="form-error" role="alert">无法保存服务器配置，请检查输入后重试。</p> : null}
        <button className="primary-action" type="submit" disabled={busy}>
          {busy ? "正在保存…" : "保存配置"}
        </button>
      </form>
    </section>
  );
}
