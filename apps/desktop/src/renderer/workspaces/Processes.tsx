import { useEffect, useRef, useState } from "react";
import { z } from "zod";

import type { CommandReceipt, WorkspaceCommand, WorkspaceResult } from "../../desktop-contract";
import { CommandPanel } from "../components/CommandPanel";
import { QueryToolbar, type WorkspaceQueryValue } from "../components/QueryToolbar";
import { WorkspaceState } from "../components/WorkspaceState";
import { WORKSPACE_DEFINITIONS, commandFor } from "./workspace-definitions";

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

function DetailList({ label, children, empty }: { readonly label: string; readonly children: React.ReactNode; readonly empty: boolean }) {
  return <section aria-labelledby={`process-${label}`}><h2 id={`process-${label}`}>{label}</h2>{empty ? <p>没有{label}</p> : <ul aria-label={label}>{children}</ul>}</section>;
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

  return (
    <main aria-labelledby="processes-title">
      <header>
        <h1 id="processes-title">流程</h1>
        <div role="tablist" aria-label="流程视图">
          {definition.tabs.map((tab) => (
            <button type="button" role="tab" aria-selected={activeTab === tab.id} key={tab.id} onClick={() => onTabChange(tab.id as ProcessesTab)}>{tab.label}</button>
          ))}
        </div>
      </header>

      <section aria-label="群组与流程搜索">
        <label>搜索群组<input type="search" value={query.filters.cohort ?? ""} onChange={(event) => updateSearch("cohort", event.currentTarget.value)} /></label>
        <label>搜索流程<input type="search" value={query.filters.process ?? ""} onChange={(event) => updateSearch("process", event.currentTarget.value)} /></label>
      </section>
      <QueryToolbar definition={definition} value={query} onChange={onQueryChange} onRefresh={onRefresh} />
      <WorkspaceState result={result} itemSchema={processItemSchema} columns={definition.columns} onRetry={onRefresh} onRefresh={onRefresh} />

      <section aria-label="流程命令">
        <h2>流程命令</h2>
        <label>群组名称<input value={cohortName} disabled={controlDisabled("create", capabilities, online, authenticated)} onChange={(event) => setCohortName(event.currentTarget.value)} /></label>
        <CommandPanel
          workspace="processes"
          command={command("create")}
          capabilities={capabilities}
          online={online}
          authenticated={authenticated}
          payload={{ name: cohortName }}
          onExecute={onExecute}
          onConflictRefresh={onRefresh}
        />
        <label>流程定义<input value={processDefinition} disabled={controlDisabled("start", capabilities, online, authenticated)} onChange={(event) => setProcessDefinition(event.currentTarget.value)} /></label>
        <CommandPanel
          workspace="processes"
          command={command("start")}
          capabilities={capabilities}
          online={online}
          authenticated={authenticated}
          payload={{ processDefinition, ...(target ? { processId: target } : {}) }}
          {...(target ? { targetId: target } : {})}
          onExecute={onExecute}
          onConflictRefresh={onRefresh}
        />
        <label>暂停或取消原因<textarea value={reason} disabled={controlDisabled("suspend", capabilities, online, authenticated) || controlDisabled("cancel", capabilities, online, authenticated)} onChange={(event) => setReason(event.currentTarget.value)} /></label>
        {(["suspend", "cancel"] as const).map((operation) => (
          <CommandPanel
            workspace="processes"
            command={command(operation)}
            capabilities={capabilities}
            online={online}
            authenticated={authenticated}
            payload={{ reason }}
            {...(target ? { targetId: target } : {})}
            onExecute={onExecute}
            onConflictRefresh={onRefresh}
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
    </main>
  );
}
