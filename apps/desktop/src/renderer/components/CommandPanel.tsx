import { createContext, useContext, useRef, useState, type FormEvent, type ReactNode } from "react";

import { prepareCommandPayload } from "../../command-payload";
import type { CommandReceipt, WorkspaceCommand } from "../../desktop-contract";
import { commandFor, type WorkspaceId, type WorkspaceOperation } from "../workspaces/workspace-definitions";

interface CommandPanelProps {
  readonly workspace: WorkspaceId;
  readonly command: WorkspaceOperation;
  readonly capabilities: readonly string[];
  readonly availableOperations?: readonly string[];
  readonly online: boolean;
  readonly authenticated: boolean;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly targetId?: string;
  readonly onExecute: (intent: WorkspaceCommand) => Promise<CommandReceipt>;
  readonly onConflictRefresh?: () => void;
}

interface IntentState {
  readonly signature: string;
  readonly handle: string;
  status: "retryable" | "accepted";
}

const MainOperationAvailability = createContext<readonly string[] | undefined>(undefined);

export function MainOperationAvailabilityProvider({ operations, children }: { readonly operations: readonly string[]; readonly children: ReactNode }) {
  return <MainOperationAvailability value={operations}>{children}</MainOperationAvailability>;
}

export function useMainOperationAvailability(workspace?: WorkspaceId): (operation: string) => boolean {
  const operations = useContext(MainOperationAvailability);
  return (operation) => operations ? operations.includes(operation) : workspace === "resources" || commandFor(workspace!, operation)?.availability.state === "available";
}

function disabledReason({ registered, online, authenticated, capable }: { registered: boolean; online: boolean; authenticated: boolean; capable: boolean }): string | undefined {
  if (!registered) return "未注册的操作";
  if (!authenticated) return "需要有效登录会话";
  if (!online) return "离线时更改操作已锁定";
  if (!capable) return "missing-capability";
  return undefined;
}

export function CommandPanel({ workspace, command, capabilities, availableOperations, online, authenticated, payload, targetId, onExecute, onConflictRefresh }: CommandPanelProps) {
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const intentRef = useRef<IntentState | undefined>(undefined);
  const [receipt, setReceipt] = useState<CommandReceipt>();
  const canonical = commandFor(workspace, command.operation);
  const reportedOperations = useContext(MainOperationAvailability);
  const effectiveOperations = availableOperations ?? reportedOperations;
  const registered = canonical !== undefined;
  const operationAvailable = registered && (effectiveOperations
    ? effectiveOperations.includes(canonical.operation)
    : canonical.availability.state === "available");
  const capable = registered && capabilities.includes(canonical.capability);
  const baseReason = disabledReason({ registered, online, authenticated, capable });
  const reason = baseReason === "missing-capability" ? `缺少能力：${canonical?.capability ?? command.capability}` : baseReason;
  const unavailableReason = registered && !operationAvailable && canonical.availability.state === "unavailable" ? canonical.availability.message : undefined;
  const preparedPayload = prepareCommandPayload(payload);
  const payloadReason = preparedPayload.success ? undefined : "命令数据必须是严格 JSON";
  const blockedReason = reason ?? unavailableReason ?? payloadReason;
  const reasonId = `command-${workspace}-${command.operation}-reason`.replaceAll(/[^a-zA-Z0-9_-]/g, "-");
  const signature = preparedPayload.success
    ? `${workspace}\u0000${command.operation}\u0000${targetId ?? ""}\u0000${preparedPayload.canonical}`
    : "invalid-payload";
  const acceptedLocked = receipt?.state === "accepted" && intentRef.current?.signature === signature;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pendingRef.current || acceptedLocked || !registered || !operationAvailable || !online || !authenticated || !capable || !preparedPayload.success) return;
    let intent = intentRef.current;
    if (!intent || intent.signature !== signature || intent.status === "accepted") {
      intent = { signature, handle: crypto.randomUUID(), status: "retryable" };
      intentRef.current = intent;
    }
    pendingRef.current = true;
    setPending(true);
    setReceipt(undefined);
    try {
      const nextReceipt = await onExecute({ workspace, operation: command.operation, payload: preparedPayload.payload, intentHandle: intent.handle, ...(targetId ? { targetId } : {}) });
      setReceipt(nextReceipt);
      if (nextReceipt.state === "accepted") {
        intent.status = "accepted";
      } else if (nextReceipt.state === "problem" && nextReceipt.problem.retryable === true) {
        intent.status = "retryable";
      } else {
        intentRef.current = undefined;
      }
    } catch {
      setReceipt({
        state: "problem",
        problem: { title: "命令提交失败", code: "COMMAND_IPC_FAILED", status: 503 },
      });
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  return (
    <form className="command-panel" onSubmit={(event) => void submit(event)}>
      <button type="submit" disabled={pending || acceptedLocked || Boolean(blockedReason)} aria-describedby={blockedReason ? reasonId : undefined}>{pending ? "正在提交" : command.label}</button>
      {blockedReason ? <p id={reasonId}>{blockedReason}</p> : null}
      {registered && !operationAvailable && canonical.availability.state === "unavailable" ? <p>所需 API：{canonical.availability.resourceGroups.join("、")}</p> : null}
      {receipt ? (
        <section role="status" aria-label="命令回执" aria-live="polite" aria-atomic="true">
          {receipt.state === "accepted" ? <><strong>命令已接收</strong><code>{receipt.correlationId}</code></> : null}
          {receipt.state === "completed" ? <><strong>命令已完成</strong><code>{receipt.correlationId}</code></> : null}
          {receipt.state === "conflict" ? <><strong>版本冲突</strong><span>当前版本 {receipt.currentVersion}</span><code>{receipt.correlationId}</code>{onConflictRefresh ? <button type="button" onClick={onConflictRefresh}>刷新当前版本</button> : null}</> : null}
          {receipt.state === "problem" ? <><strong>{receipt.problem.title}</strong>{receipt.problem.code ? <span>{receipt.problem.code}</span> : null}<span>HTTP {receipt.problem.status}</span>{receipt.problem.correlationId ? <code>{receipt.problem.correlationId}</code> : null}</> : null}
          {receipt.state === "unavailable" ? <><strong>{receipt.reason}</strong><span>{receipt.resourceGroups.join("、")}</span><p>{receipt.message}</p></> : null}
        </section>
      ) : null}
    </form>
  );
}
