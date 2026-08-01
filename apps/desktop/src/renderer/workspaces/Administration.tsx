import { useState, type KeyboardEvent } from "react";
import { z } from "zod";

import type { CommandReceipt, WorkspaceCommand, WorkspaceResult } from "../../desktop-contract";
import { CommandPanel } from "../components/CommandPanel";
import { QueryToolbar, type WorkspaceQueryValue } from "../components/QueryToolbar";
import { WorkspaceState } from "../components/WorkspaceState";
import { WORKSPACE_DEFINITIONS } from "./workspace-definitions";

export type WorkspaceConnectivity = "online" | "offline" | "reconnecting";

export interface AdministrationProps {
  readonly result: WorkspaceResult;
  readonly query: WorkspaceQueryValue;
  readonly capabilities: readonly string[];
  readonly connectivity: WorkspaceConnectivity;
  readonly authenticated: boolean;
  readonly onQueryChange: (query: WorkspaceQueryValue) => void;
  readonly onRefresh: () => void;
  readonly onExecute: (command: WorkspaceCommand) => Promise<CommandReceipt>;
}

const definition = WORKSPACE_DEFINITIONS.administration;
const tabs = [
  ...definition.tabs.slice(0, 6),
  { id: "retention", label: "保留策略" },
  ...definition.tabs.slice(6),
] as const;
const initialTab = tabs[0]!;
const operationsByTab: Readonly<Record<string, readonly string[]>> = {
  people: ["create", "disable"],
  relationships: ["assign"],
  roles: ["assign"],
  policies: ["release"],
  providers: ["test"],
  knowledge: ["ingest"],
  retention: [],
  audit: ["inspect"],
};
const administrationItemSchema = z.object({
  subject: z.string(),
  type: z.string(),
  status: z.string(),
  updatedAt: z.string(),
}).strict();

function moveTab(event: KeyboardEvent<HTMLButtonElement>, index: number, select: (id: string) => void) {
  let next: number | undefined;
  if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
  if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
  if (event.key === "Home") next = 0;
  if (event.key === "End") next = tabs.length - 1;
  if (next === undefined) return;
  event.preventDefault();
  select(tabs[next]!.id);
  event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role=tab]")[next]?.focus();
}

export function Administration({
  result,
  query,
  capabilities,
  connectivity,
  authenticated,
  onQueryChange,
  onRefresh,
  onExecute,
}: AdministrationProps) {
  const [activeTab, setActiveTab] = useState(initialTab.id);
  const active = tabs.find(({ id }) => id === activeTab) ?? initialTab;
  const commands = (operationsByTab[active.id] ?? [])
    .map((operation) => definition.commands.find((command) => command.operation === operation))
    .filter((command) => command !== undefined);
  const mutable = connectivity === "online";

  return (
    <section aria-labelledby="administration-title">
      <h1 id="administration-title">管理</h1>
      {connectivity === "reconnecting" ? <p>重新连接时更改操作已锁定</p> : null}
      <div role="tablist" aria-label="管理分类">
        {tabs.map((tab, index) => (
          <button
            type="button"
            role="tab"
            id={`administration-tab-${tab.id}`}
            aria-controls={`administration-panel-${tab.id}`}
            aria-selected={active.id === tab.id}
            tabIndex={active.id === tab.id ? 0 : -1}
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            onKeyDown={(event) => moveTab(event, index, setActiveTab)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <QueryToolbar definition={definition} value={query} disabled={!mutable} onChange={onQueryChange} onRefresh={onRefresh} />
      <div
        role="tabpanel"
        id={`administration-panel-${active.id}`}
        aria-labelledby={`administration-tab-${active.id}`}
      >
        {active.id === "retention" ? <p>保留策略 API 合同尚未定义，当前仅可查看。</p> : null}
        {commands.map((command) => (
          <section key={command.operation} aria-label={`${command.label}操作`}>
            <CommandPanel
              workspace="administration"
              command={command}
              capabilities={capabilities}
              online={mutable}
              authenticated={authenticated}
              payload={{}}
              onExecute={onExecute}
              onConflictRefresh={onRefresh}
            />
            {command.availability.state === "unavailable" ? <p>{command.availability.message}</p> : null}
          </section>
        ))}
      </div>
      <WorkspaceState
        result={result}
        itemSchema={administrationItemSchema}
        columns={definition.columns}
        unavailableControls={definition.commands.map(({ label }) => label)}
        onRetry={onRefresh}
        onRefresh={onRefresh}
      />
    </section>
  );
}
