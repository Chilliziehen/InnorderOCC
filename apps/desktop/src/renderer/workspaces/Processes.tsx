import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { z } from "zod";

import type { CommandReceipt, WorkspaceCommand, WorkspaceResult } from "../../desktop-contract";
import { CommandPanel } from "../components/CommandPanel";
import { QueryToolbar, type WorkspaceQueryValue } from "../components/QueryToolbar";
import { WorkspaceState } from "../components/WorkspaceState";
import { WORKSPACE_DEFINITIONS, commandFor, type WorkspaceOperation } from "./workspace-definitions";

const definition = WORKSPACE_DEFINITIONS.processes;

const processItemSchema = z.object({
  id: z.string().min(1),
  process: z.string().min(1),
  cohort: z.string().min(1),
  owner: z.string().min(1),
  status: z.string().min(1),
}).strict();

export type ProcessesTab = "cohorts" | "processes" | "participants" | "tasks" | "timeline";

interface NamedStateItem {
  readonly id: string;
  readonly name: string;
  readonly state: string;
}

export interface SelectedProcess {
  readonly id: string;
  readonly expectedVersion: number;
  readonly progress: number;
  readonly participants: readonly { readonly id: string; readonly name: string; readonly role: string }[];
  readonly tasks: readonly NamedStateItem[];
  readonly evidence: readonly NamedStateItem[];
  readonly risks: readonly { readonly id: string; readonly name: string; readonly severity: string }[];
  readonly timeline: readonly { readonly id: string; readonly occurredAt: string; readonly label: string }[];
}

export interface ProcessesProps {
  readonly result: WorkspaceResult;
  readonly activeTab: ProcessesTab;
  readonly query: WorkspaceQueryValue;
  readonly capabilities: readonly string[];
  readonly online: boolean;
  readonly authenticated: boolean;
  readonly selectedProcess?: SelectedProcess;
  readonly onTabChange: (tab: ProcessesTab) => void;
  readonly onQueryChange: (query: WorkspaceQueryValue) => void;
  readonly onRefresh: () => void;
  readonly onExecute: (command: WorkspaceCommand) => Promise<CommandReceipt>;
}

function command(name: string) {
  const operation = commandFor("processes", name);
  if (!operation) throw new Error(`Missing canonical Processes command: ${name}`);
  return operation;
}

function controlDisabled(operationName: string, capabilities: readonly string[], online: boolean, authenticated: boolean): boolean {
  const operation = command(operationName);
  return !authenticated || !online || !capabilities.includes(operation.capability) || operation.availability.state !== "available";
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
  const errorId = `processes-${operation.operation}-shape-error`;
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
          workspace="processes"
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

function DetailList({ label, children, empty }: { readonly label: string; readonly children: React.ReactNode; readonly empty: boolean }) {
  return <section aria-labelledby={`process-${label}`}><h2 id={`process-${label}`}>{label}</h2>{empty ? <p>没有{label}</p> : <ul aria-label={label}>{children}</ul>}</section>;
}

function moveTabFocus(event: KeyboardEvent<HTMLButtonElement>, index: number, onTabChange: (tab: ProcessesTab) => void) {
  let nextIndex: number | undefined;
  if (event.key === "ArrowRight") nextIndex = (index + 1) % definition.tabs.length;
  if (event.key === "ArrowLeft") nextIndex = (index - 1 + definition.tabs.length) % definition.tabs.length;
  if (event.key === "Home") nextIndex = 0;
  if (event.key === "End") nextIndex = definition.tabs.length - 1;
  if (nextIndex === undefined) return;
  event.preventDefault();
  const next = definition.tabs[nextIndex]!;
  document.getElementById(`processes-tab-${next.id}`)?.focus();
  onTabChange(next.id as ProcessesTab);
}

export function Processes({
  result,
  activeTab,
  query,
  capabilities,
  online,
  authenticated,
  selectedProcess,
  onTabChange,
  onQueryChange,
  onRefresh,
  onExecute,
}: ProcessesProps) {
  const queryRef = useRef(query);
  const [cohortName, setCohortName] = useState("");
  const [processDefinition, setProcessDefinition] = useState("");
  const [reason, setReason] = useState("");

  useEffect(() => {
    queryRef.current = query;
  }, [query]);

  const updateSearch = (key: "cohort" | "process", value: string) => {
    const current = queryRef.current;
    const next = { ...current, filters: { ...current.filters, [key]: value } };
    queryRef.current = next;
    onQueryChange(next);
  };
  const target = selectedProcess?.id;
  const expectedVersion = selectedProcess?.expectedVersion;
  const createShape = guard(cohortName.trim() ? undefined : "群组名称不能为空");
  const startShape = guard(
    !processDefinition.trim() ? "流程定义不能为空"
      : !target?.trim() ? "请选择要启动的流程"
        : undefined,
  );
  const versionValid = Number.isInteger(expectedVersion) && (expectedVersion ?? -1) >= 0;
  const suspendShape = guard(
    !target?.trim() ? "请选择要暂停的流程"
      : !reason.trim() ? "暂停原因不能为空"
        : !versionValid ? "缺少有效的流程版本"
          : undefined,
  );
  const cancelShape = guard(
    !target?.trim() ? "请选择要取消的流程"
      : !reason.trim() ? "取消原因不能为空"
        : !versionValid ? "缺少有效的流程版本"
          : undefined,
  );

  return (
    <main aria-labelledby="processes-title">
      <header>
        <h1 id="processes-title">流程</h1>
        <div role="tablist" aria-label="流程视图">
          {definition.tabs.map((tab, index) => (
            <button
              type="button"
              role="tab"
              id={`processes-tab-${tab.id}`}
              aria-controls={`processes-panel-${tab.id}`}
              aria-selected={activeTab === tab.id}
              tabIndex={activeTab === tab.id ? 0 : -1}
              key={tab.id}
              onClick={() => onTabChange(tab.id as ProcessesTab)}
              onKeyDown={(event) => moveTabFocus(event, index, onTabChange)}
            >{tab.label}</button>
          ))}
        </div>
      </header>

      <section aria-label="群组与流程搜索">
        <label>搜索群组<input type="search" value={query.filters.cohort ?? ""} onChange={(event) => updateSearch("cohort", event.currentTarget.value)} /></label>
        <label>搜索流程<input type="search" value={query.filters.process ?? ""} onChange={(event) => updateSearch("process", event.currentTarget.value)} /></label>
      </section>
      <QueryToolbar definition={definition} value={query} onChange={onQueryChange} onRefresh={onRefresh} />
      <section role="tabpanel" id={`processes-panel-${activeTab}`} aria-labelledby={`processes-tab-${activeTab}`} tabIndex={0}>
      <WorkspaceState result={result} itemSchema={processItemSchema} columns={definition.columns} onRetry={onRefresh} onRefresh={onRefresh} />

      <section aria-label="流程命令">
        <h2>流程命令</h2>
        <label>群组名称<input value={cohortName} disabled={controlDisabled("create", capabilities, online, authenticated)} onChange={(event) => setCohortName(event.currentTarget.value)} /></label>
        <GuardedCommand
          operation={command("create")}
          shape={createShape}
          capabilities={capabilities}
          online={online}
          authenticated={authenticated}
          payload={{ name: cohortName.trim() }}
          onExecute={onExecute}
          onRefresh={onRefresh}
        />
        <label>流程定义<input value={processDefinition} disabled={controlDisabled("start", capabilities, online, authenticated)} onChange={(event) => setProcessDefinition(event.currentTarget.value)} /></label>
        <GuardedCommand
          operation={command("start")}
          shape={startShape}
          capabilities={capabilities}
          online={online}
          authenticated={authenticated}
          payload={{ processDefinition: processDefinition.trim(), ...(target ? { processId: target } : {}) }}
          {...(target ? { targetId: target } : {})}
          onExecute={onExecute}
          onRefresh={onRefresh}
        />
        <label>暂停或取消原因<textarea value={reason} disabled={controlDisabled("suspend", capabilities, online, authenticated) && controlDisabled("cancel", capabilities, online, authenticated)} onChange={(event) => setReason(event.currentTarget.value)} /></label>
        {(["suspend", "cancel"] as const).map((operation) => (
          <GuardedCommand
            operation={command(operation)}
            shape={operation === "suspend" ? suspendShape : cancelShape}
            capabilities={capabilities}
            online={online}
            authenticated={authenticated}
            payload={{ reason: reason.trim(), expectedVersion: expectedVersion ?? -1 }}
            {...(target ? { targetId: target } : {})}
            onExecute={onExecute}
            onRefresh={onRefresh}
            key={operation}
          />
        ))}
      </section>

      <section aria-label="流程进度">
        <h2>流程进度</h2>
        {selectedProcess ? <><progress aria-label="流程进度" max={100} value={Math.min(100, Math.max(0, selectedProcess.progress))} /><span>{selectedProcess.progress}%</span></> : <p>没有流程进度</p>}
      </section>
      <DetailList label="参与者" empty={!selectedProcess?.participants.length}>{selectedProcess?.participants.map((item) => <li key={item.id}><strong>{item.name}</strong> {item.role}</li>)}</DetailList>
      <DetailList label="任务" empty={!selectedProcess?.tasks.length}>{selectedProcess?.tasks.map((item) => <li key={item.id}><strong>{item.name}</strong> {item.state}</li>)}</DetailList>
      <DetailList label="证据" empty={!selectedProcess?.evidence.length}>{selectedProcess?.evidence.map((item) => <li key={item.id}><strong>{item.name}</strong> {item.state}</li>)}</DetailList>
      <DetailList label="风险" empty={!selectedProcess?.risks.length}>{selectedProcess?.risks.map((item) => <li key={item.id}><strong>{item.name}</strong> {item.severity}</li>)}</DetailList>
      <DetailList label="时间线" empty={!selectedProcess?.timeline.length}>{selectedProcess?.timeline.map((item) => <li key={item.id}><time dateTime={item.occurredAt}>{item.occurredAt}</time> {item.label}</li>)}</DetailList>
      </section>
      {definition.tabs.filter(({ id }) => id !== activeTab).map(({ id }) => (
        <section role="tabpanel" id={`processes-panel-${id}`} aria-labelledby={`processes-tab-${id}`} hidden key={id} />
      ))}
    </main>
  );
}
