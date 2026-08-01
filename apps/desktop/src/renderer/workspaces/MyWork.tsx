import { useState, type KeyboardEvent } from "react";
import { z } from "zod";

import type { CommandReceipt, WorkspaceCommand, WorkspaceResult } from "../../desktop-contract";
import { CommandPanel } from "../components/CommandPanel";
import { QueryToolbar, type WorkspaceQueryValue } from "../components/QueryToolbar";
import { WorkspaceState } from "../components/WorkspaceState";
import { WORKSPACE_DEFINITIONS, commandFor, type WorkspaceOperation } from "./workspace-definitions";

const definition = WORKSPACE_DEFINITIONS["my-work"];
const MAX_EVIDENCE_BYTES = 100 * 1024 * 1024;

const workItemSchema = z.object({
  id: z.string().min(1),
  task: z.string().min(1),
  process: z.string().min(1),
  state: z.enum(["AVAILABLE", "CLAIMED", "BLOCKED", "PENDING_REVIEW", "RETURNED", "COMPLETED"]),
  dueAt: z.string().min(1),
}).strict();

export type MyWorkTab = "available" | "claimed" | "blocked" | "pending-review" | "returned" | "completed";

export interface MyWorkTaskDetails {
  readonly id: string;
  readonly evidenceRequirements: readonly string[];
  readonly acceptedMediaTypes: readonly string[];
  readonly reservation?: string;
  readonly reviewHistory: readonly {
    readonly id: string;
    readonly outcome: string;
    readonly occurredAt: string;
    readonly note?: string;
  }[];
}

export type EvidenceUploadState =
  | { readonly state: "idle" }
  | { readonly state: "uploading"; readonly fileName: string; readonly progress: number; readonly uploadId: string }
  | { readonly state: "failed"; readonly fileName: string; readonly message: string; readonly retryable: boolean }
  | { readonly state: "quarantined"; readonly fileName: string; readonly message: string }
  | { readonly state: "accepted"; readonly fileName: string; readonly evidenceId: string };

export interface GuidanceState {
  readonly state: "disabled" | "stale" | "unavailable" | "ready";
  readonly message: string;
  readonly citations?: readonly string[];
}

export interface MyWorkProps {
  readonly result: WorkspaceResult;
  readonly activeTab: MyWorkTab;
  readonly query: WorkspaceQueryValue;
  readonly capabilities: readonly string[];
  readonly online: boolean;
  readonly authenticated: boolean;
  readonly selectedTask?: MyWorkTaskDetails;
  readonly upload?: EvidenceUploadState;
  readonly guidance?: GuidanceState;
  readonly uploadReference?: string;
  readonly onTabChange: (tab: MyWorkTab) => void;
  readonly onQueryChange: (query: WorkspaceQueryValue) => void;
  readonly onRefresh: () => void;
  readonly onExecute: (command: WorkspaceCommand) => Promise<CommandReceipt>;
  readonly onStartUpload: (file: File, taskId: string) => void;
  readonly onRetryUpload: () => void;
  readonly onCancelUpload: (uploadId: string) => void;
}

function command(name: string) {
  const operation = commandFor("my-work", name);
  if (!operation) throw new Error(`Missing canonical My Work command: ${name}`);
  return operation;
}

function mutationReason(operationName: string, capabilities: readonly string[], online: boolean, authenticated: boolean): string | undefined {
  const operation = command(operationName);
  if (!authenticated) return "需要有效登录会话";
  if (!online) return "离线时更改操作已锁定";
  if (!capabilities.includes(operation.capability)) return `缺少能力：${operation.capability}`;
  if (operation.availability.state === "unavailable") return operation.availability.message;
  return undefined;
}

interface ClientGuard {
  readonly valid: boolean;
  readonly message: string;
}

function guard(message?: string): ClientGuard {
  return { valid: message === undefined, message: message ?? "" };
}

function GuardedCommand({
  operation,
  shape,
  capabilities,
  online,
  authenticated,
  payload,
  targetId,
  onExecute,
  onRefresh,
}: {
  readonly operation: WorkspaceOperation;
  readonly shape: ClientGuard;
  readonly capabilities: readonly string[];
  readonly online: boolean;
  readonly authenticated: boolean;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly targetId?: string;
  readonly onExecute: (command: WorkspaceCommand) => Promise<CommandReceipt>;
  readonly onRefresh: () => void;
}) {
  const errorId = `my-work-${operation.operation}-shape-error`;
  const executeIfValid = async (intent: WorkspaceCommand): Promise<CommandReceipt> => {
    if (!shape.valid) {
      return { state: "problem", problem: { title: shape.message, code: "CLIENT_SHAPE_INVALID", status: 400 } };
    }
    return onExecute(intent);
  };
  return (
    <div>
      <fieldset disabled={!shape.valid} aria-describedby={!shape.valid ? errorId : undefined}>
        <CommandPanel
          workspace="my-work"
          command={operation}
          capabilities={capabilities}
          online={online}
          authenticated={authenticated}
          payload={payload}
          {...(targetId ? { targetId } : {})}
          onExecute={executeIfValid}
          onConflictRefresh={onRefresh}
        />
      </fieldset>
      {!shape.valid ? <p role="alert" id={errorId}>{shape.message}</p> : null}
    </div>
  );
}

function acceptsMediaType(accepted: readonly string[], mediaType: string): boolean {
  return accepted.some((candidate) => candidate === mediaType || (candidate.endsWith("/*") && mediaType.startsWith(candidate.slice(0, -1))));
}

function EmptyList({ label }: { readonly label: string }) {
  return <p>没有{label}</p>;
}

function moveTabFocus(event: KeyboardEvent<HTMLButtonElement>, index: number, onTabChange: (tab: MyWorkTab) => void) {
  let nextIndex: number | undefined;
  if (event.key === "ArrowRight") nextIndex = (index + 1) % definition.tabs.length;
  if (event.key === "ArrowLeft") nextIndex = (index - 1 + definition.tabs.length) % definition.tabs.length;
  if (event.key === "Home") nextIndex = 0;
  if (event.key === "End") nextIndex = definition.tabs.length - 1;
  if (nextIndex === undefined) return;
  event.preventDefault();
  const next = definition.tabs[nextIndex]!;
  document.getElementById(`my-work-tab-${next.id}`)?.focus();
  onTabChange(next.id as MyWorkTab);
}

export function MyWork({
  result,
  activeTab,
  query,
  capabilities,
  online,
  authenticated,
  selectedTask,
  upload = { state: "idle" },
  guidance,
  uploadReference,
  onTabChange,
  onQueryChange,
  onRefresh,
  onExecute,
  onStartUpload,
  onRetryUpload,
  onCancelUpload,
}: MyWorkProps) {
  const [file, setFile] = useState<File>();
  const [evidenceNote, setEvidenceNote] = useState("");
  const [resourceId, setResourceId] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [guidanceQuestion, setGuidanceQuestion] = useState("");
  const uploadReason = mutationReason("submitEvidence", capabilities, online, authenticated);
  const uploadBlocked = Boolean(uploadReason);
  const taskPayload = selectedTask ? { taskId: selectedTask.id } : {};
  const claimShape = guard(selectedTask?.id.trim() ? undefined : "请选择任务后再领取");
  const uploadShape = guard(
    !selectedTask?.id.trim() ? "请选择任务后再上传证据"
      : selectedTask.acceptedMediaTypes.length === 0 ? "缺少可接受媒体类型元数据"
        : !file ? "请选择证据文件"
          : file.size <= 0 || file.size > MAX_EVIDENCE_BYTES ? "证据文件不得超过 100 MiB"
            : !acceptsMediaType(selectedTask.acceptedMediaTypes, file.type) ? "文件媒体类型不在任务允许范围内"
              : undefined,
  );
  const evidenceShape = guard(!uploadShape.valid ? uploadShape.message : uploadReference?.trim() ? undefined : "缺少证据上传引用");
  const parsedStart = Date.parse(startsAt);
  const parsedEnd = Date.parse(endsAt);
  const reservationShape = guard(
    !selectedTask?.id.trim() ? "请选择任务后再预留资源"
      : !resourceId.trim() ? "资源 ID 不能为空"
        : !Number.isFinite(parsedStart) || !Number.isFinite(parsedEnd) || parsedStart >= parsedEnd ? "预留时间范围无效"
          : undefined,
  );
  const guidanceShape = guard(selectedTask?.id.trim() ? undefined : "请选择任务后再请求智能建议");
  const guidanceCommand = command("guidance");
  const defaultGuidance: GuidanceState = {
    state: "unavailable" as const,
    message: guidanceCommand.availability.state === "unavailable"
      ? guidanceCommand.availability.message
      : "智能建议不可用",
  };
  const guidanceStatus: GuidanceState = guidance ?? defaultGuidance;

  return (
    <main aria-labelledby="my-work-title">
      <header>
        <h1 id="my-work-title">我的工作</h1>
        <div role="tablist" aria-label="工作状态">
          {definition.tabs.map((tab, index) => (
            <button
              type="button"
              role="tab"
              id={`my-work-tab-${tab.id}`}
              aria-controls={`my-work-panel-${tab.id}`}
              aria-selected={activeTab === tab.id}
              tabIndex={activeTab === tab.id ? 0 : -1}
              key={tab.id}
              onClick={() => onTabChange(tab.id as MyWorkTab)}
              onKeyDown={(event) => moveTabFocus(event, index, onTabChange)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </header>

      <QueryToolbar definition={definition} value={query} onChange={onQueryChange} onRefresh={onRefresh} />
      <section role="tabpanel" id={`my-work-panel-${activeTab}`} aria-labelledby={`my-work-tab-${activeTab}`} tabIndex={0}>
      <WorkspaceState result={result} itemSchema={workItemSchema} columns={definition.columns} onRetry={onRefresh} onRefresh={onRefresh} />

      <section aria-label="任务操作">
        <h2>任务操作</h2>
        <GuardedCommand
          operation={command("claim")}
          shape={claimShape}
          capabilities={capabilities}
          online={online}
          authenticated={authenticated}
          payload={taskPayload}
          {...(selectedTask ? { targetId: selectedTask.id } : {})}
          onExecute={onExecute}
          onRefresh={onRefresh}
        />
      </section>

      <section role="region" aria-label="证据提交">
        <h2>证据提交</h2>
        {selectedTask?.evidenceRequirements.length
          ? <ul aria-label="证据要求">{selectedTask.evidenceRequirements.map((requirement) => <li key={requirement}>{requirement}</li>)}</ul>
          : <EmptyList label="证据要求" />}
        <p>单个文件最大 100 MiB；允许的媒体类型由任务证据要求确定。</p>
        <label>选择证据文件
          <input
            aria-label="选择证据文件"
            type="file"
            accept={selectedTask?.acceptedMediaTypes.join(",")}
            disabled={uploadBlocked || !selectedTask?.id.trim() || !selectedTask.acceptedMediaTypes.length}
            onChange={(event) => setFile(event.currentTarget.files?.[0])}
          />
        </label>
        <label>提交说明<textarea value={evidenceNote} disabled={uploadBlocked} onChange={(event) => setEvidenceNote(event.currentTarget.value)} /></label>
        <form aria-label="开始证据上传" onSubmit={(event) => {
          event.preventDefault();
          if (!uploadBlocked && uploadShape.valid && file && selectedTask?.id.trim()) onStartUpload(file, selectedTask.id);
        }}>
          <button type="submit" disabled={uploadBlocked || !uploadShape.valid}>开始上传</button>
        </form>
        {uploadReason ? <p>{uploadReason}</p> : null}
        {!uploadShape.valid ? <p role="alert">{uploadShape.message}</p> : null}
        {upload.state === "uploading" ? (
          <div>
            <progress aria-label={`${upload.fileName} 上传进度`} max={100} value={Math.min(100, Math.max(0, upload.progress))} />
            <span>{upload.progress}%</span>
            <form aria-label="取消证据上传" onSubmit={(event) => {
              event.preventDefault();
              if (!uploadBlocked && upload.uploadId.trim()) onCancelUpload(upload.uploadId);
            }}><button type="submit" disabled={uploadBlocked}>取消上传</button></form>
          </div>
        ) : null}
        {upload.state === "failed" ? (
          <div role="status" aria-label="证据上传失败"><p>{upload.message}</p><form aria-label="重试证据上传" onSubmit={(event) => {
            event.preventDefault();
            if (!uploadBlocked && upload.retryable) onRetryUpload();
          }}><button type="submit" disabled={uploadBlocked || !upload.retryable}>重试上传</button></form></div>
        ) : null}
        {upload.state === "quarantined" ? <div role="status" aria-label="证据隔离状态"><strong>隔离检查中</strong><p>{upload.message}</p></div> : null}
        {upload.state === "accepted" ? <div role="status" aria-label="证据上传完成"><strong>证据已接收</strong><code>{upload.evidenceId}</code></div> : null}
        <GuardedCommand
          operation={command("submitEvidence")}
          shape={evidenceShape}
          capabilities={capabilities}
          online={online}
          authenticated={authenticated}
          payload={selectedTask ? { taskId: selectedTask.id, note: evidenceNote, uploadReference: uploadReference ?? "" } : { note: evidenceNote, uploadReference: uploadReference ?? "" }}
          {...(selectedTask ? { targetId: selectedTask.id } : {})}
          onExecute={onExecute}
          onRefresh={onRefresh}
        />
      </section>

      <section role="region" aria-label="审核历史">
        <h2>审核历史</h2>
        {selectedTask?.reviewHistory.length ? (
          <ol>{selectedTask.reviewHistory.map((review) => (
            <li key={review.id}><strong>{review.outcome}</strong> <time dateTime={review.occurredAt}>{review.occurredAt}</time>{review.note ? <p>{review.note}</p> : null}</li>
          ))}</ol>
        ) : <EmptyList label="审核记录" />}
      </section>

      <section role="region" aria-label="资源预留">
        <h2>资源预留</h2>
        <p>{selectedTask?.reservation ?? "没有预留信息"}</p>
        <label>资源 ID<input value={resourceId} disabled={Boolean(mutationReason("reserve", capabilities, online, authenticated))} onChange={(event) => setResourceId(event.currentTarget.value)} /></label>
        <label>开始时间<input type="datetime-local" value={startsAt} disabled={Boolean(mutationReason("reserve", capabilities, online, authenticated))} onChange={(event) => setStartsAt(event.currentTarget.value)} /></label>
        <label>结束时间<input type="datetime-local" value={endsAt} disabled={Boolean(mutationReason("reserve", capabilities, online, authenticated))} onChange={(event) => setEndsAt(event.currentTarget.value)} /></label>
        <GuardedCommand
          operation={command("reserve")}
          shape={reservationShape}
          capabilities={capabilities}
          online={online}
          authenticated={authenticated}
          payload={selectedTask ? { taskId: selectedTask.id, resourceId: resourceId.trim(), startsAt, endsAt } : { resourceId: resourceId.trim(), startsAt, endsAt }}
          {...(selectedTask ? { targetId: selectedTask.id } : {})}
          onExecute={onExecute}
          onRefresh={onRefresh}
        />
      </section>

      <section role="region" aria-label="智能建议">
        <h2>智能建议</h2>
        <strong>{guidanceStatus.message}</strong>
        <p>建议仅供参考，不能替代流程、证据、审核或权限决定。</p>
        {guidanceStatus.state === "stale" ? <p>智能建议已过期，请勿据此执行变更。</p> : null}
        {guidanceStatus.citations?.length ? <ul aria-label="建议引用">{guidanceStatus.citations.map((citation) => <li key={citation}>{citation}</li>)}</ul> : null}
        <label>问题<textarea value={guidanceQuestion} disabled={Boolean(mutationReason("guidance", capabilities, online, authenticated))} onChange={(event) => setGuidanceQuestion(event.currentTarget.value)} /></label>
        <GuardedCommand
          operation={command("guidance")}
          shape={guidanceShape}
          capabilities={capabilities}
          online={online}
          authenticated={authenticated}
          payload={selectedTask ? { taskId: selectedTask.id, question: guidanceQuestion } : { question: guidanceQuestion }}
          {...(selectedTask ? { targetId: selectedTask.id } : {})}
          onExecute={onExecute}
          onRefresh={onRefresh}
        />
      </section>
      </section>
      {definition.tabs.filter(({ id }) => id !== activeTab).map(({ id }) => (
        <section role="tabpanel" id={`my-work-panel-${id}`} aria-labelledby={`my-work-tab-${id}`} hidden key={id} />
      ))}
    </main>
  );
}
