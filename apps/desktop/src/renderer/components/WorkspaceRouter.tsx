import { useEffect, useRef, useState } from "react";
import { z } from "zod";

import type {
  CommandReceipt,
  ProfileInput,
  ServerProfile,
  WorkspaceCommand,
  WorkspaceResult,
} from "../../desktop-contract";
import type { ShellState } from "./AppShell";
import type { WorkspaceQueryValue } from "./QueryToolbar";
import { failedWorkspaceResult, unavailableWorkspaceResult, workspaceQueryInput } from "../workspace-client";
import { WORKSPACE_DEFINITIONS, type WorkspaceId } from "../workspaces/workspace-definitions";
import { Administration } from "../workspaces/Administration";
import { DomainDesign, type ArchiveUploadReference } from "../workspaces/DomainDesign";
import { Interventions, interventionItemSchema, type InterventionTab } from "../workspaces/Interventions";
import { MyWork, type EvidenceUploadState, type MyWorkTab, type MyWorkTaskDetails } from "../workspaces/MyWork";
import { Overview } from "../workspaces/Overview";
import { Processes, type ProcessesTab, type SelectedProcess } from "../workspaces/Processes";
import { Resources } from "../workspaces/Resources";
import { Risks, riskItemSchema, type RiskTab } from "../workspaces/Risks";
import { Settings } from "../workspaces/Settings";
import { SystemOperations } from "../workspaces/SystemOperations";

interface WorkspaceRouterProps {
  readonly workspaceId: WorkspaceId;
  readonly queryAllowed: boolean;
  readonly state: ShellState;
  readonly statuses: readonly unknown[];
  readonly onLogout: () => void | Promise<void>;
  readonly onProfileSelect: (profile: ServerProfile) => void | Promise<void>;
  readonly onProfileSave: (input: ProfileInput) => Promise<unknown>;
  readonly onProfileRemove?: (profileId: string) => void | Promise<void>;
  readonly onModalOpenChange?: (open: boolean) => void;
  readonly modalIsolationActive: boolean;
}

const initialQueries = Object.fromEntries(Object.values(WORKSPACE_DEFINITIONS).map((definition) => [
  definition.id,
  { search: "", filters: {}, sort: definition.sortOptions[0]?.value ?? "" },
])) as Record<WorkspaceId, WorkspaceQueryValue>;

const initialTabs = Object.fromEntries(Object.values(WORKSPACE_DEFINITIONS).map((definition) => [
  definition.id,
  definition.tabs[0]?.id ?? "",
])) as Record<WorkspaceId, string>;
const FIRST_PAGE_CURSOR = "__occ_first_page__";

function loadingResult(label: string): WorkspaceResult {
  return { state: "loading", label: `正在加载${label}…` };
}

function callable<T extends (...args: never[]) => unknown>(value: T | undefined): value is T {
  return typeof value === "function";
}

const taskRowSchema = z.object({
  id: z.string().min(1),
  task: z.string().min(1),
  process: z.string().min(1),
  state: z.enum(["AVAILABLE", "CLAIMED", "BLOCKED", "PENDING_REVIEW", "RETURNED", "COMPLETED"]),
  dueAt: z.string().min(1),
  evidenceRequirements: z.array(z.string().min(1)),
  acceptedMediaTypes: z.array(z.string().min(1)),
  reservation: z.string().min(1).optional(),
  reviewHistory: z.array(z.object({
    id: z.string().min(1),
    outcome: z.string().min(1),
    occurredAt: z.string().min(1),
    note: z.string().optional(),
  }).strict()),
}).strict().transform(({ id, task, process, state, dueAt, evidenceRequirements, acceptedMediaTypes, reservation, reviewHistory }) => ({
  item: { id, task, process, state, dueAt },
  details: {
    id,
    evidenceRequirements,
    acceptedMediaTypes,
    ...(reservation ? { reservation } : {}),
    reviewHistory: reviewHistory.map(({ id: reviewId, outcome, occurredAt, note }) => ({
      id: reviewId,
      outcome,
      occurredAt,
      ...(note !== undefined ? { note } : {}),
    })),
  } satisfies MyWorkTaskDetails,
}));

const namedStateItemSchema = z.object({ id: z.string().min(1), name: z.string().min(1), state: z.string().min(1) }).strict();
const processRowSchema = z.object({
  id: z.string().min(1),
  process: z.string().min(1),
  cohort: z.string().min(1),
  owner: z.string().min(1),
  status: z.string().min(1),
  expectedVersion: z.number().int().min(0),
  progress: z.number().min(0).max(100),
  participants: z.array(z.object({ id: z.string().min(1), name: z.string().min(1), role: z.string().min(1) }).strict()),
  tasks: z.array(namedStateItemSchema),
  evidence: z.array(namedStateItemSchema),
  risks: z.array(z.object({ id: z.string().min(1), name: z.string().min(1), severity: z.string().min(1) }).strict()),
  timeline: z.array(z.object({ id: z.string().min(1), occurredAt: z.string().min(1), label: z.string().min(1) }).strict()),
}).strict().transform(({ id, process, cohort, owner, status, ...details }) => ({
  item: { id, process, cohort, owner, status },
  details: { id, ...details } satisfies SelectedProcess,
}));

function hasWorkspaceItems(result: WorkspaceResult): result is Extract<WorkspaceResult, { state: "ready" | "stale" | "offline" }> {
  return result.state === "ready" || result.state === "stale" || result.state === "offline";
}

export function WorkspaceRouter({ workspaceId, queryAllowed, state, statuses, onLogout, onProfileSelect, onProfileSave, onProfileRemove, onModalOpenChange, modalIsolationActive }: WorkspaceRouterProps) {
  const definition = WORKSPACE_DEFINITIONS[workspaceId];
  const identity = state.mode === "authenticated" ? state.identity : state.cachedIdentity;
  const [queries, setQueries] = useState(initialQueries);
  const [tabs, setTabs] = useState(initialTabs);
  const query = queries[workspaceId];
  const activeTab = tabs[workspaceId];
  const online = state.mode === "authenticated";
  const connectivity = state.mode === "authenticated" ? "online" : state.mode;
  const { cursor: _cursor, previousCursor: _previousCursor, nextCursor: _nextCursor, ...criteria } = query;
  const historyPrefix = `${state.profile.id}:${state.sessionGeneration}:${workspaceId}:${activeTab}:`;
  const historyKey = `${historyPrefix}${JSON.stringify(criteria)}`;
  const scopeKey = `${state.profile.id}:${state.sessionGeneration}:${workspaceId}:${JSON.stringify(query)}:${activeTab}`;
  const requestKey = `${scopeKey}:${connectivity}`;
  const [resultState, setResultState] = useState<{ key: string; value: WorkspaceResult }>({
    key: "",
    value: loadingResult(definition.query.label),
  });
  const [refreshSequence, setRefreshSequence] = useState(0);
  const [, setCursorHistoryVersion] = useState(0);
  const requestSequence = useRef(0);
  const cursorHistory = useRef(new Map<string, Array<string | undefined>>());
  const retainedResult = useRef<{ key: string; value: WorkspaceResult } | undefined>(undefined);
  const [selectedTaskId, setSelectedTaskId] = useState<string>();
  const [selectedProcessId, setSelectedProcessId] = useState<string>();
  const [selectedIntervention, setSelectedIntervention] = useState<string>();
  const [selectedRisk, setSelectedRisk] = useState<string>();
  const [upload, setUpload] = useState<EvidenceUploadState>({ state: "idle" });
  const [uploadReference, setUploadReference] = useState<string>();
  const uploadRetry = useRef<{ file: File; targetId: string; intentHandle: string } | undefined>(undefined);
  const activeUploadId = useRef<string | undefined>(undefined);
  const uploadSequence = useRef(0);
  const uploadScopeKey = `${scopeKey}:${selectedTaskId ?? ""}`;
  const currentUploadScope = useRef(uploadScopeKey);
  currentUploadScope.current = uploadScopeKey;
  const result = resultState.key === requestKey
    ? resultState.value
    : loadingResult(definition.query.label);
  const history = cursorHistory.current.get(historyKey) ?? [];
  const previousPage = history.at(-1);
  const visibleQuery = {
    ...query,
    ...(history.length > 0 ? { previousCursor: previousPage ?? FIRST_PAGE_CURSOR } : {}),
    ...("nextCursor" in result && result.nextCursor ? { nextCursor: result.nextCursor } : {}),
  };
  useEffect(() => {
    const uploadId = activeUploadId.current;
    if (uploadId) void window.occ?.uploads?.cancel?.(uploadId);
    activeUploadId.current = undefined;
    uploadSequence.current += 1;
    setSelectedTaskId(undefined);
    setSelectedProcessId(undefined);
    setSelectedIntervention(undefined);
    setSelectedRisk(undefined);
    setUpload({ state: "idle" });
    setUploadReference(undefined);
    uploadRetry.current = undefined;
  }, [requestKey]);

  useEffect(() => {
    const subscribe = window.occ?.uploads?.subscribeProgress;
    if (!callable(subscribe)) return;
    return subscribe((progress) => {
      const retry = uploadRetry.current;
      if (!retry || progress.intentHandle !== retry.intentHandle) return;
      setUpload({ state: "uploading", fileName: retry.file.name, progress: progress.percent, uploadId: progress.uploadId });
    });
  }, []);

  useEffect(() => {
    const sequence = ++requestSequence.current;
    let active = true;
    setResultState({ key: requestKey, value: loadingResult(definition.query.label) });
    if (workspaceId === "system" || workspaceId === "settings") {
      setResultState({ key: requestKey, value: { state: "empty", fetchedAt: new Date(state.lastFreshAt).toISOString() } });
      return () => { active = false; };
    }
    if (!queryAllowed) {
      setResultState({ key: requestKey, value: {
        state: "error",
        problem: { title: `缺少能力：${definition.query.capability}`, code: "QUERY_CAPABILITY_REQUIRED", status: 403 },
      } });
      return () => { active = false; };
    }
    const retainedFallback = (): WorkspaceResult | undefined => {
      const retained = retainedResult.current;
      const retainedValue = retained?.key === scopeKey ? retained.value : undefined;
      return retainedValue
        ? hasWorkspaceItems(retainedValue) ? { ...retainedValue, state: "offline" as const } : retainedValue
        : undefined;
    };
    const queryApi = window.occ?.workspaces?.query;
    if (!callable(queryApi)) {
      setResultState({ key: requestKey, value: retainedFallback() ?? unavailableWorkspaceResult(definition) });
      return () => { active = false; };
    }
    void queryApi(workspaceQueryInput(definition, query, activeTab)).then(
      (value) => {
        if (active && requestSequence.current === sequence) {
          if (value.state === "ready" || value.state === "empty" || value.state === "stale") retainedResult.current = { key: scopeKey, value };
          setResultState({ key: requestKey, value });
        }
      },
      () => {
        if (active && requestSequence.current === sequence) setResultState({ key: requestKey, value: retainedFallback() ?? failedWorkspaceResult() });
      },
    );
    return () => { active = false; };
  }, [activeTab, definition, online, query, queryAllowed, refreshSequence, requestKey, scopeKey, state.lastFreshAt, workspaceId]);

  const changeQuery = (value: WorkspaceQueryValue) => {
    const { cursor: nextCursor, previousCursor: _nextPrevious, nextCursor: _nextNext, ...nextCriteria } = value;
    if (JSON.stringify(criteria) !== JSON.stringify(nextCriteria)) {
      for (const key of cursorHistory.current.keys()) {
        if (key.startsWith(historyPrefix)) cursorHistory.current.delete(key);
      }
      setCursorHistoryVersion((current) => current + 1);
      setQueries((current) => ({ ...current, [workspaceId]: nextCriteria }));
      return;
    }
    if (nextCursor !== query.cursor) {
      const nextHistory = [...history];
      if (nextCursor === visibleQuery.previousCursor) nextHistory.pop();
      else if (nextCursor === visibleQuery.nextCursor) nextHistory.push(query.cursor);
      cursorHistory.current.set(historyKey, nextHistory);
      setCursorHistoryVersion((current) => current + 1);
    }
    setQueries((current) => ({
      ...current,
      [workspaceId]: nextCursor === FIRST_PAGE_CURSOR ? nextCriteria : value,
    }));
  };
  const changeTab = (tab: string) => {
    for (const key of cursorHistory.current.keys()) {
      if (key.startsWith(`${state.profile.id}:${state.sessionGeneration}:${workspaceId}:`)) cursorHistory.current.delete(key);
    }
    setCursorHistoryVersion((current) => current + 1);
    setTabs((current) => ({ ...current, [workspaceId]: tab }));
    setQueries((current) => {
      const { cursor: _cursor, previousCursor: _previous, nextCursor: _next, ...rest } = current[workspaceId];
      return { ...current, [workspaceId]: rest };
    });
  };
  const refresh = () => setRefreshSequence((current) => current + 1);
  const execute = async (command: WorkspaceCommand): Promise<CommandReceipt> => {
    const executeCommand = window.occ?.commands?.execute;
    if (callable(executeCommand)) return executeCommand(command);
    const operation = definition.commands.find(({ operation }) => operation === command.operation);
    return operation?.availability.state === "unavailable"
      ? { state: "unavailable", reason: operation.availability.reason, resourceGroups: [...operation.availability.resourceGroups], message: operation.availability.message }
      : { state: "problem", problem: { title: "命令接口不可用", code: "COMMAND_API_UNAVAILABLE", status: 503 } };
  };
  const startEvidenceUpload = async (file: File, targetId: string, retainedIntentHandle?: string) => {
    const sequence = ++uploadSequence.current;
    const initiationScope = uploadScopeKey;
    const intentHandle = retainedIntentHandle ?? crypto.randomUUID();
    uploadRetry.current = { file, targetId, intentHandle };
    const metadata = { workspace: "my-work", taskId: targetId, fileName: file.name, mediaType: file.type, size: file.size, intentHandle };
    const preflight = window.occ?.uploads?.preflight;
    const begin = window.occ?.uploads?.begin;
    const append = window.occ?.uploads?.append;
    const finish = window.occ?.uploads?.finish;
    const cancel = window.occ?.uploads?.cancel;
    if (!callable(preflight) || !callable(begin) || !callable(append) || !callable(finish) || !callable(cancel)) {
      setUpload({ state: "failed", fileName: file.name, message: "证据上传接口不可用。", retryable: false });
      return;
    }
    try {
      const availability = await preflight(metadata);
      if (uploadSequence.current !== sequence || currentUploadScope.current !== initiationScope) return;
      if (availability.state === "unavailable") {
        setUpload({ state: "failed", fileName: file.name, message: availability.message, retryable: false });
        return;
      }
      const started = await begin(metadata);
      if (started.state !== "started") {
        if (started.state === "unavailable") setUpload({ state: "failed", fileName: file.name, message: started.message, retryable: false });
        else setUpload({ state: "failed", fileName: file.name, message: "证据上传响应无效。", retryable: false });
        return;
      }
      activeUploadId.current = started.uploadId;
      for (let offset = 0, chunkSequence = 0; offset < file.size; offset += 1024 * 1024, chunkSequence += 1) {
        if (uploadSequence.current !== sequence || currentUploadScope.current !== initiationScope) {
          await cancel(started.uploadId);
          activeUploadId.current = undefined;
          return;
        }
        const data = new Uint8Array(await file.slice(offset, offset + 1024 * 1024).arrayBuffer());
        await append({ uploadId: started.uploadId, sequence: chunkSequence, data });
      }
      const receipt = await finish(started.uploadId);
      activeUploadId.current = undefined;
      if (uploadSequence.current !== sequence || currentUploadScope.current !== initiationScope) return;
      if (receipt.state === "completed" && receipt.kind === "evidence") {
        setUpload({ state: "accepted", fileName: file.name, evidenceId: receipt.evidenceId });
        setUploadReference(receipt.uploadReference);
      } else if (receipt.state === "started") {
        setUpload({ state: "uploading", fileName: file.name, progress: 0, uploadId: receipt.uploadId });
      } else if (receipt.state === "problem") {
        setUpload({ state: "failed", fileName: file.name, message: "证据上传失败，请重试。", retryable: receipt.problem.retryable === true });
      } else if (receipt.state === "unavailable") {
        setUpload({ state: "failed", fileName: file.name, message: receipt.message, retryable: false });
      } else {
        setUpload({ state: "failed", fileName: file.name, message: "证据上传响应无效。", retryable: false });
      }
    } catch {
      const uploadId = activeUploadId.current;
      if (uploadId) await window.occ?.uploads?.cancel?.(uploadId).catch(() => undefined);
      activeUploadId.current = undefined;
      if (uploadSequence.current === sequence && currentUploadScope.current === initiationScope) {
        setUpload({ state: "failed", fileName: file.name, message: "证据上传失败，请重试。", retryable: true });
      }
    }
  };
  const archiveUpload = async (file: File): Promise<ArchiveUploadReference> => {
    const preflight = window.occ?.uploads?.preflight;
    const begin = window.occ?.uploads?.begin;
    const append = window.occ?.uploads?.append;
    const finish = window.occ?.uploads?.finish;
    const cancel = window.occ?.uploads?.cancel;
    if (!callable(preflight) || !callable(begin) || !callable(append) || !callable(finish) || !callable(cancel)) throw new Error("archive-upload-unavailable");
    const metadata = { workspace: "domain-design", taskId: "package-import", fileName: file.name, mediaType: file.type, size: file.size, intentHandle: crypto.randomUUID() };
    const availability = await preflight(metadata);
    if (availability.state === "unavailable") throw new Error("archive-upload-unavailable");
    const started = await begin(metadata);
    if (started.state !== "started") throw new Error("archive-upload-unavailable");
    let completed = false;
    try {
      for (let offset = 0, sequence = 0; offset < file.size; offset += 1024 * 1024, sequence += 1) {
        const data = new Uint8Array(await file.slice(offset, offset + 1024 * 1024).arrayBuffer());
        await append({ uploadId: started.uploadId, sequence, data });
      }
      const receipt = await finish(started.uploadId);
      if (receipt.state !== "completed" || receipt.kind !== "archive") throw new Error("archive-upload-incomplete");
      completed = true;
      return { uploadId: receipt.uploadId, sha256: receipt.sha256 };
    } finally {
      if (!completed) await cancel(started.uploadId).catch(() => undefined);
    }
  };
  const taskRows = hasWorkspaceItems(result) ? result.items.map((item) => taskRowSchema.safeParse(item)) : [];
  const processRows = hasWorkspaceItems(result) ? result.items.map((item) => processRowSchema.safeParse(item)) : [];
  const selectedTaskEntry = taskRows.find((entry) => entry.success && entry.data.details.id === selectedTaskId);
  const selectedProcessEntry = processRows.find((entry) => entry.success && entry.data.details.id === selectedProcessId);
  const selectedTask = selectedTaskEntry?.success ? selectedTaskEntry.data.details : undefined;
  const selectedProcess = selectedProcessEntry?.success ? selectedProcessEntry.data.details : undefined;
  const selectedInterventionIsCurrent = hasWorkspaceItems(result) && result.items.some((item) => {
    const parsed = interventionItemSchema.safeParse(item);
    return parsed.success && parsed.data.id === selectedIntervention;
  });
  const selectedRiskIsCurrent = hasWorkspaceItems(result) && result.items.some((item) => {
    const parsed = riskItemSchema.safeParse(item);
    return parsed.success && parsed.data.id === selectedRisk;
  });
  const selectionResultIsCurrent = hasWorkspaceItems(result) || result.state === "empty";
  useEffect(() => {
    if (!selectionResultIsCurrent) return;
    if (workspaceId === "my-work" && selectedTaskId && !selectedTask) {
      uploadSequence.current += 1;
      setSelectedTaskId(undefined);
      setUpload({ state: "idle" });
      setUploadReference(undefined);
      uploadRetry.current = undefined;
    }
    if (workspaceId === "processes" && selectedProcessId && !selectedProcess) setSelectedProcessId(undefined);
    if (workspaceId === "interventions" && selectedIntervention && !selectedInterventionIsCurrent) setSelectedIntervention(undefined);
    if (workspaceId === "risks" && selectedRisk && !selectedRiskIsCurrent) setSelectedRisk(undefined);
  }, [selectedIntervention, selectedInterventionIsCurrent, selectedProcess, selectedProcessId, selectedRisk, selectedRiskIsCurrent, selectedTask, selectedTaskId, selectionResultIsCurrent, workspaceId]);
  const routedResult = hasWorkspaceItems(result) && (workspaceId === "my-work" || workspaceId === "processes")
    ? {
        ...result,
        items: result.items.map((item, index) => {
          const parsed = workspaceId === "my-work" ? taskRows[index] : processRows[index];
          return parsed?.success ? parsed.data.item : item;
        }),
      }
    : result;
  const common = { result: routedResult, query: visibleQuery, capabilities: identity.capabilities, online, authenticated: online, onQueryChange: changeQuery, onRefresh: refresh, onExecute: execute };

  switch (workspaceId) {
    case "overview":
      return <Overview definition={definition} result={result} statuses={statuses} query={visibleQuery} activeTab={activeTab} environment={state.profile.environment} onTabChange={changeTab} onQueryChange={changeQuery} onRefresh={refresh} />;
    case "my-work":
      return <MyWork {...common} activeTab={activeTab as MyWorkTab} {...(selectedTaskId ? { selectedId: selectedTaskId } : {})} onSelect={(id) => { if (id !== selectedTaskId) { uploadSequence.current += 1; setUpload({ state: "idle" }); setUploadReference(undefined); uploadRetry.current = undefined; } setSelectedTaskId(id); }} {...(selectedTask ? { selectedTask } : {})} upload={upload} {...(uploadReference ? { uploadReference } : {})} uploadProgressAvailable={callable(window.occ?.uploads?.subscribeProgress)} onTabChange={(tab) => changeTab(tab)} onStartUpload={(file, targetId) => void startEvidenceUpload(file, targetId)} onRetryUpload={() => { const retry = uploadRetry.current; if (retry) void startEvidenceUpload(retry.file, retry.targetId, retry.intentHandle); }} onCancelUpload={(uploadId) => { const cancel = window.occ?.uploads?.cancel; if (callable(cancel)) void cancel(uploadId); }} />;
    case "processes":
      return <Processes {...common} activeTab={activeTab as ProcessesTab} {...(selectedProcessId ? { selectedId: selectedProcessId } : {})} onSelect={setSelectedProcessId} {...(selectedProcess ? { selectedProcess } : {})} onTabChange={(tab) => changeTab(tab)} />;
    case "interventions":
      return <Interventions {...common} activeTab={activeTab as InterventionTab} {...(selectedInterventionIsCurrent && selectedIntervention ? { selectedItemId: selectedIntervention } : {})} onTabChange={(tab) => changeTab(tab)} onSelectItem={setSelectedIntervention} />;
    case "risks":
      return <Risks {...common} activeTab={activeTab as RiskTab} {...(selectedRiskIsCurrent && selectedRisk ? { selectedRiskId: selectedRisk } : {})} onTabChange={(tab) => changeTab(tab)} onSelectRisk={setSelectedRisk} />;
    case "resources":
      return <Resources {...common} activeTab={activeTab} onConflictRefresh={refresh} onTabChange={changeTab} />;
    case "domain-design":
      return <DomainDesign {...common} activeTab={activeTab} onConflictRefresh={refresh} maxArchiveBytes={100 * 1024 * 1024} onArchiveUpload={(file) => archiveUpload(file)} onTabChange={changeTab} />;
    case "administration":
      return <Administration result={result} query={visibleQuery} activeTab={activeTab} capabilities={identity.capabilities} connectivity={connectivity} authenticated={online} onQueryChange={changeQuery} onRefresh={refresh} onExecute={execute} onTabChange={changeTab} />;
    case "system":
      return <SystemOperations definition={definition} result={result} statuses={statuses} query={visibleQuery} activeTab={activeTab} environment={state.profile.environment} configurationFreshness={new Date(state.lastFreshAt).toISOString()} onTabChange={changeTab} onQueryChange={changeQuery} onRefresh={refresh} />;
    case "settings":
      return <Settings profiles={state.profiles} current={state.profile} activeTab={activeTab} connectivity={connectivity} onSelect={(profileId) => { const profile = state.profiles.find(({ id }) => id === profileId); if (profile) return onProfileSelect(profile); }} onSave={async (input) => { await onProfileSave(input); }} onRemove={(profileId) => onProfileRemove?.(profileId)} onPreferencesChange={() => undefined} onLogout={onLogout} onTabChange={changeTab} modalIsolationActive={modalIsolationActive} {...(onModalOpenChange ? { onModalOpenChange } : {})} />;
  }
}
