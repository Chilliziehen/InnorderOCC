import { useState } from "react";
import { z } from "zod";

import type { CommandReceipt, WorkspaceCommand, WorkspaceResult } from "../../desktop-contract";
import { CommandPanel } from "../components/CommandPanel";
import { QueryToolbar, type WorkspaceQueryValue } from "../components/QueryToolbar";
import { WorkspaceState } from "../components/WorkspaceState";
import { WORKSPACE_DEFINITIONS, commandFor } from "./workspace-definitions";

const definition = WORKSPACE_DEFINITIONS["my-work"];

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
  readonly onTabChange: (tab: MyWorkTab) => void;
  readonly onQueryChange: (query: WorkspaceQueryValue) => void;
  readonly onRefresh: () => void;
  readonly onExecute: (command: WorkspaceCommand) => Promise<CommandReceipt>;
  readonly onStartUpload: (file: File, taskId?: string) => void;
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

function EmptyList({ label }: { readonly label: string }) {
  return <p>没有{label}</p>;
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
  const [reservationRequest, setReservationRequest] = useState("");
  const [guidanceQuestion, setGuidanceQuestion] = useState("");
  const uploadReason = mutationReason("submitEvidence", capabilities, online, authenticated);
  const uploadBlocked = Boolean(uploadReason);
  const taskPayload = selectedTask ? { taskId: selectedTask.id } : {};
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
          {definition.tabs.map((tab) => (
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              key={tab.id}
              onClick={() => onTabChange(tab.id as MyWorkTab)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </header>

      <QueryToolbar definition={definition} value={query} onChange={onQueryChange} onRefresh={onRefresh} />
      <WorkspaceState result={result} itemSchema={workItemSchema} columns={definition.columns} onRetry={onRefresh} onRefresh={onRefresh} />

      <section aria-label="任务操作">
        <h2>任务操作</h2>
        <CommandPanel
          workspace="my-work"
          command={command("claim")}
          capabilities={capabilities}
          online={online}
          authenticated={authenticated}
          payload={taskPayload}
          {...(selectedTask ? { targetId: selectedTask.id } : {})}
          onExecute={onExecute}
          onConflictRefresh={onRefresh}
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
            disabled={uploadBlocked}
            onChange={(event) => setFile(event.currentTarget.files?.[0])}
          />
        </label>
        <label>提交说明<textarea value={evidenceNote} disabled={uploadBlocked} onChange={(event) => setEvidenceNote(event.currentTarget.value)} /></label>
        <button type="button" disabled={uploadBlocked || !file} onClick={() => file && onStartUpload(file, selectedTask?.id)}>开始上传</button>
        {uploadReason ? <p>{uploadReason}</p> : null}
        {upload.state === "uploading" ? (
          <div>
            <progress aria-label={`${upload.fileName} 上传进度`} max={100} value={Math.min(100, Math.max(0, upload.progress))} />
            <span>{upload.progress}%</span>
            <button type="button" disabled={uploadBlocked} onClick={() => onCancelUpload(upload.uploadId)}>取消上传</button>
          </div>
        ) : null}
        {upload.state === "failed" ? (
          <div role="status" aria-label="证据上传失败"><p>{upload.message}</p><button type="button" disabled={uploadBlocked || !upload.retryable} onClick={onRetryUpload}>重试上传</button></div>
        ) : null}
        {upload.state === "quarantined" ? <div role="status" aria-label="证据隔离状态"><strong>隔离检查中</strong><p>{upload.message}</p></div> : null}
        {upload.state === "accepted" ? <div role="status" aria-label="证据上传完成"><strong>证据已接收</strong><code>{upload.evidenceId}</code></div> : null}
        <CommandPanel
          workspace="my-work"
          command={command("submitEvidence")}
          capabilities={capabilities}
          online={online}
          authenticated={authenticated}
          payload={selectedTask ? { taskId: selectedTask.id, note: evidenceNote } : { note: evidenceNote }}
          {...(selectedTask ? { targetId: selectedTask.id } : {})}
          onExecute={onExecute}
          onConflictRefresh={onRefresh}
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
        <label>预留请求<input value={reservationRequest} disabled={Boolean(mutationReason("reserve", capabilities, online, authenticated))} onChange={(event) => setReservationRequest(event.currentTarget.value)} /></label>
        <CommandPanel
          workspace="my-work"
          command={command("reserve")}
          capabilities={capabilities}
          online={online}
          authenticated={authenticated}
          payload={selectedTask ? { taskId: selectedTask.id, request: reservationRequest } : { request: reservationRequest }}
          {...(selectedTask ? { targetId: selectedTask.id } : {})}
          onExecute={onExecute}
          onConflictRefresh={onRefresh}
        />
      </section>

      <section role="region" aria-label="智能建议">
        <h2>智能建议</h2>
        <strong>{guidanceStatus.message}</strong>
        <p>建议仅供参考，不能替代流程、证据、审核或权限决定。</p>
        {guidanceStatus.state === "stale" ? <p>智能建议已过期，请勿据此执行变更。</p> : null}
        {guidanceStatus.citations?.length ? <ul aria-label="建议引用">{guidanceStatus.citations.map((citation) => <li key={citation}>{citation}</li>)}</ul> : null}
        <label>问题<textarea value={guidanceQuestion} disabled={Boolean(mutationReason("guidance", capabilities, online, authenticated))} onChange={(event) => setGuidanceQuestion(event.currentTarget.value)} /></label>
        <CommandPanel
          workspace="my-work"
          command={command("guidance")}
          capabilities={capabilities}
          online={online}
          authenticated={authenticated}
          payload={selectedTask ? { taskId: selectedTask.id, question: guidanceQuestion } : { question: guidanceQuestion }}
          {...(selectedTask ? { targetId: selectedTask.id } : {})}
          onExecute={onExecute}
          onConflictRefresh={onRefresh}
        />
      </section>
    </main>
  );
}
