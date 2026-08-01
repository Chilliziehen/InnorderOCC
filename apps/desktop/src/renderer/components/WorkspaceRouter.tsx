import { useEffect, useRef, useState } from "react";

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
import { Interventions, type InterventionTab } from "../workspaces/Interventions";
import { MyWork, type EvidenceUploadState, type MyWorkTab } from "../workspaces/MyWork";
import { Overview } from "../workspaces/Overview";
import { Processes, type ProcessesTab } from "../workspaces/Processes";
import { Resources } from "../workspaces/Resources";
import { Risks, type RiskTab } from "../workspaces/Risks";
import { Settings } from "../workspaces/Settings";
import { SystemOperations } from "../workspaces/SystemOperations";

interface WorkspaceRouterProps {
  readonly workspaceId: WorkspaceId;
  readonly state: ShellState;
  readonly statuses: readonly unknown[];
  readonly onLogout: () => void | Promise<void>;
  readonly onProfileSelect: (profile: ServerProfile) => void | Promise<void>;
  readonly onProfileSave: (input: ProfileInput) => Promise<unknown>;
  readonly onProfileRemove?: (profileId: string) => void | Promise<void>;
}

const initialQueries = Object.fromEntries(Object.values(WORKSPACE_DEFINITIONS).map((definition) => [
  definition.id,
  { search: "", filters: {}, sort: definition.sortOptions[0]?.value ?? "" },
])) as Record<WorkspaceId, WorkspaceQueryValue>;

const initialTabs = Object.fromEntries(Object.values(WORKSPACE_DEFINITIONS).map((definition) => [
  definition.id,
  definition.tabs[0]?.id ?? "",
])) as Record<WorkspaceId, string>;

function loadingResult(label: string): WorkspaceResult {
  return { state: "loading", label: `正在加载${label}…` };
}

function callable<T extends (...args: never[]) => unknown>(value: T | undefined): value is T {
  return typeof value === "function";
}

export function WorkspaceRouter({ workspaceId, state, statuses, onLogout, onProfileSelect, onProfileSave, onProfileRemove }: WorkspaceRouterProps) {
  const definition = WORKSPACE_DEFINITIONS[workspaceId];
  const identity = state.mode === "authenticated" ? state.identity : state.cachedIdentity;
  const [queries, setQueries] = useState(initialQueries);
  const [tabs, setTabs] = useState(initialTabs);
  const query = queries[workspaceId];
  const activeTab = tabs[workspaceId];
  const requestKey = `${state.profile.id}:${state.sessionGeneration}:${workspaceId}:${JSON.stringify(query)}:${activeTab}`;
  const [resultState, setResultState] = useState<{ key: string; value: WorkspaceResult }>({
    key: "",
    value: loadingResult(definition.query.label),
  });
  const [refreshSequence, setRefreshSequence] = useState(0);
  const requestSequence = useRef(0);
  const [selectedIntervention, setSelectedIntervention] = useState<string>();
  const [selectedRisk, setSelectedRisk] = useState<string>();
  const [upload, setUpload] = useState<EvidenceUploadState>({ state: "idle" });
  const uploadRetry = useRef<{ file: File; targetId: string } | undefined>(undefined);
  const result = resultState.key === requestKey
    ? resultState.value
    : loadingResult(definition.query.label);
  const visibleQuery = {
    ...query,
    ...("nextCursor" in result && result.nextCursor ? { nextCursor: result.nextCursor } : {}),
  };
  const online = state.mode === "authenticated";
  const connectivity = state.mode === "authenticated" ? "online" : state.mode;

  useEffect(() => {
    const sequence = ++requestSequence.current;
    let active = true;
    setResultState({ key: requestKey, value: loadingResult(definition.query.label) });
    const queryApi = window.occ?.workspaces?.query;
    if (!callable(queryApi)) {
      setResultState({ key: requestKey, value: unavailableWorkspaceResult(definition) });
      return () => { active = false; };
    }
    void queryApi(workspaceQueryInput(definition, query, activeTab)).then(
      (value) => {
        if (active && requestSequence.current === sequence) setResultState({ key: requestKey, value });
      },
      () => {
        if (active && requestSequence.current === sequence) setResultState({ key: requestKey, value: failedWorkspaceResult() });
      },
    );
    return () => { active = false; };
  }, [activeTab, definition, query, refreshSequence, requestKey]);

  const changeQuery = (value: WorkspaceQueryValue) => {
    setQueries((current) => ({ ...current, [workspaceId]: value }));
  };
  const changeTab = (tab: string) => {
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
  const startEvidenceUpload = async (file: File, targetId: string) => {
    uploadRetry.current = { file, targetId };
    const start = window.occ?.uploads?.start;
    if (!callable(start)) {
      setUpload({ state: "failed", fileName: file.name, message: "证据上传接口不可用。", retryable: false });
      return;
    }
    try {
      const receipt = await start({ workspace: "my-work", targetId, fileName: file.name, contentType: file.type, size: file.size, data: new Uint8Array(await file.arrayBuffer()) });
      if (receipt.state === "completed") {
        setUpload({ state: "accepted", fileName: file.name, evidenceId: receipt.evidenceId });
      } else if (receipt.state === "started") {
        setUpload({ state: "uploading", fileName: file.name, progress: 0, uploadId: receipt.uploadId });
      } else {
        setUpload({ state: "failed", fileName: file.name, message: "证据上传失败，请重试。", retryable: receipt.problem.retryable === true });
      }
    } catch {
      setUpload({ state: "failed", fileName: file.name, message: "证据上传失败，请重试。", retryable: true });
    }
  };
  const archiveUpload = async (file: File): Promise<ArchiveUploadReference> => {
    const start = window.occ?.uploads?.start;
    if (!callable(start)) throw new Error("archive-upload-unavailable");
    const receipt = await start({ workspace: "domain-design", targetId: "package-import", fileName: file.name, contentType: file.type, size: file.size, data: new Uint8Array(await file.arrayBuffer()) });
    if (receipt.state !== "completed" || !/^[0-9a-f]{64}$/i.test(receipt.evidenceId)) throw new Error("archive-upload-incomplete");
    return { uploadId: receipt.uploadId, sha256: receipt.evidenceId };
  };
  const common = { result, query: visibleQuery, capabilities: identity.capabilities, online, authenticated: online, onQueryChange: changeQuery, onRefresh: refresh, onExecute: execute };

  switch (workspaceId) {
    case "overview":
      return <Overview definition={definition} result={result} statuses={statuses} query={visibleQuery} activeTab={activeTab} environment={state.profile.environment} onTabChange={changeTab} onQueryChange={changeQuery} onRefresh={refresh} />;
    case "my-work":
      return <MyWork {...common} activeTab={activeTab as MyWorkTab} upload={upload} uploadProgressAvailable={false} onTabChange={(tab) => changeTab(tab)} onStartUpload={(file, targetId) => void startEvidenceUpload(file, targetId)} onRetryUpload={() => { const retry = uploadRetry.current; if (retry) void startEvidenceUpload(retry.file, retry.targetId); }} onCancelUpload={(uploadId) => { const cancel = window.occ?.uploads?.cancel; if (callable(cancel)) void cancel(uploadId); }} />;
    case "processes":
      return <Processes {...common} activeTab={activeTab as ProcessesTab} onTabChange={(tab) => changeTab(tab)} />;
    case "interventions":
      return <Interventions {...common} activeTab={activeTab as InterventionTab} {...(selectedIntervention ? { selectedItemId: selectedIntervention } : {})} onTabChange={(tab) => changeTab(tab)} onSelectItem={setSelectedIntervention} />;
    case "risks":
      return <Risks {...common} activeTab={activeTab as RiskTab} {...(selectedRisk ? { selectedRiskId: selectedRisk } : {})} onTabChange={(tab) => changeTab(tab)} onSelectRisk={setSelectedRisk} />;
    case "resources":
      return <Resources {...common} activeTab={activeTab} onConflictRefresh={refresh} onTabChange={changeTab} />;
    case "domain-design":
      return <DomainDesign {...common} activeTab={activeTab} onConflictRefresh={refresh} maxArchiveBytes={100 * 1024 * 1024} onArchiveUpload={(file) => archiveUpload(file)} onTabChange={changeTab} />;
    case "administration":
      return <Administration result={result} query={visibleQuery} activeTab={activeTab} capabilities={identity.capabilities} connectivity={connectivity} authenticated={online} onQueryChange={changeQuery} onRefresh={refresh} onExecute={execute} onTabChange={changeTab} />;
    case "system":
      return <SystemOperations definition={definition} result={result} statuses={statuses} query={visibleQuery} activeTab={activeTab} environment={state.profile.environment} configurationFreshness={new Date(state.lastFreshAt).toISOString()} onTabChange={changeTab} onQueryChange={changeQuery} onRefresh={refresh} />;
    case "settings":
      return <Settings profiles={state.profiles} current={state.profile} activeTab={activeTab} connectivity={connectivity} onSelect={(profileId) => { const profile = state.profiles.find(({ id }) => id === profileId); if (profile) return onProfileSelect(profile); }} onSave={async (input) => { await onProfileSave(input); }} onRemove={(profileId) => onProfileRemove?.(profileId)} onPreferencesChange={() => undefined} onLogout={onLogout} onTabChange={changeTab} />;
  }
}
