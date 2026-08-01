import { useRef, useState, type FormEvent } from "react";

import type { CommandReceipt, WorkspaceCommand } from "../../desktop-contract";
import { commandFor, type WorkspaceId, type WorkspaceOperation } from "../workspaces/workspace-definitions";

type CommandPanelReceipt = CommandReceipt | {
  readonly state: "conflict";
  readonly currentVersion: string;
  readonly correlationId: string;
  readonly detail?: string;
};

interface CommandPanelProps {
  readonly workspace: WorkspaceId;
  readonly command: WorkspaceOperation;
  readonly capabilities: readonly string[];
  readonly online: boolean;
  readonly authenticated: boolean;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly targetId?: string;
  readonly onExecute: (intent: WorkspaceCommand) => Promise<CommandPanelReceipt>;
  readonly onConflictRefresh?: () => void;
}

function disabledReason({ registered, online, authenticated, capable }: { registered: boolean; online: boolean; authenticated: boolean; capable: boolean }): string | undefined {
  if (!registered) return "未注册的操作";
  if (!authenticated) return "需要有效登录会话";
  if (!online) return "离线时更改操作已锁定";
  if (!capable) return "missing-capability";
  return undefined;
}

export function CommandPanel({ workspace, command, capabilities, online, authenticated, payload, targetId, onExecute, onConflictRefresh }: CommandPanelProps) {
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [receipt, setReceipt] = useState<CommandPanelReceipt>();
  const canonical = commandFor(workspace, command.operation);
  const registered = canonical !== undefined;
  const operationAvailable = registered && canonical.availability.state === "available";
  const capable = registered && capabilities.includes(canonical.capability);
  const baseReason = disabledReason({ registered, online, authenticated, capable });
  const reason = baseReason === "missing-capability" ? `缺少能力：${canonical?.capability ?? command.capability}` : baseReason;
  const unavailableReason = registered && canonical.availability.state === "unavailable" ? canonical.availability.message : undefined;
  const blockedReason = reason ?? unavailableReason;
  const reasonId = `command-${workspace}-${command.operation}-reason`.replaceAll(/[^a-zA-Z0-9_-]/g, "-");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pendingRef.current || !registered || !operationAvailable || !online || !authenticated || !capable) return;
    pendingRef.current = true;
    setPending(true);
    setReceipt(undefined);
    try {
      setReceipt(await onExecute({ workspace, operation: command.operation, payload: { ...payload }, idempotencyKey: crypto.randomUUID(), ...(targetId ? { targetId } : {}) }));
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  return (
    <form className="command-panel" onSubmit={(event) => void submit(event)}>
      <button type="submit" disabled={pending || Boolean(blockedReason)} aria-describedby={blockedReason ? reasonId : undefined}>{pending ? "正在提交" : command.label}</button>
      {blockedReason ? <p id={reasonId}>{blockedReason}</p> : null}
      {registered && canonical.availability.state === "unavailable" ? <p>所需 API：{canonical.availability.resourceGroups.join("、")}</p> : null}
      {receipt ? (
        <section role="status" aria-label="命令回执">
          {receipt.state === "accepted" || receipt.state === "completed" ? <><strong>命令已接收</strong><code>{receipt.correlationId}</code></> : null}
          {receipt.state === "conflict" ? <><strong>版本冲突</strong>{"currentVersion" in receipt ? <span>当前版本 {receipt.currentVersion}</span> : null}<code>{receipt.correlationId}</code>{onConflictRefresh ? <button type="button" onClick={onConflictRefresh}>刷新当前版本</button> : null}</> : null}
          {receipt.state === "problem" ? <><strong>{receipt.problem.title}</strong><span>HTTP {receipt.problem.status}</span>{receipt.problem.correlationId ? <code>{receipt.problem.correlationId}</code> : null}</> : null}
          {receipt.state === "unavailable" ? <><strong>{receipt.reason}</strong><span>{receipt.resourceGroups.join("、")}</span></> : null}
        </section>
      ) : null}
    </form>
  );
}
