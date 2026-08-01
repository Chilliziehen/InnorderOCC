import { useState } from "react";
import { z } from "zod";

import type { CommandReceipt, WorkspaceCommand, WorkspaceResult } from "../../desktop-contract";
import { CommandPanel } from "../components/CommandPanel";
import { QueryToolbar, type WorkspaceQueryValue } from "../components/QueryToolbar";
import { WorkspaceState } from "../components/WorkspaceState";
import { WORKSPACE_DEFINITIONS, type WorkspaceOperation } from "./workspace-definitions";

const reservationSchema = z.object({
  id: z.string(),
  start: z.string(),
  end: z.string(),
  capacity: z.number().nonnegative(),
  state: z.string(),
});

const conflictSchema = z.object({
  kind: z.enum(["exclusive", "capacity"]),
  start: z.string(),
  end: z.string(),
  capacity: z.number().nonnegative().optional(),
});

const resourceSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  state: z.string(),
  capacity: z.number().nonnegative(),
  availableCapacity: z.number().nonnegative(),
  reservation: reservationSchema.optional(),
  conflicts: z.array(conflictSchema),
});

type Resource = z.infer<typeof resourceSchema>;

export interface ResourcesProps {
  readonly result: WorkspaceResult;
  readonly query: WorkspaceQueryValue;
  readonly capabilities: readonly string[];
  readonly online: boolean;
  readonly authenticated: boolean;
  readonly onQueryChange: (value: WorkspaceQueryValue) => void;
  readonly onRefresh: () => void;
  readonly onExecute: (intent: WorkspaceCommand) => Promise<CommandReceipt>;
  readonly onConflictRefresh: () => void;
}

const definition = WORKSPACE_DEFINITIONS.resources;

function operation(name: string): WorkspaceOperation {
  const command = definition.commands.find(({ operation: candidate }) => candidate === name);
  if (!command) throw new Error(`Missing resources operation: ${name}`);
  return command;
}

function ResourceDetails({ resource, view }: { resource: Resource; view: string }) {
  if (view === "reservations") {
    return (
      <section role="region" aria-label="资源预留详情">
        <h3>{resource.name}</h3>
        {resource.reservation ? (
          <dl>
            <dt>预留编号</dt><dd>{resource.reservation.id}</dd>
            <dt>时间区间</dt><dd>{resource.reservation.start} 至 {resource.reservation.end}</dd>
            <dt>预留容量</dt><dd>{resource.reservation.capacity}</dd>
            <dt>状态</dt><dd>{resource.reservation.state}</dd>
          </dl>
        ) : <p>无可见预留</p>}
      </section>
    );
  }
  if (view === "conflicts") {
    return (
      <section role="region" aria-label="资源冲突详情">
        <h3>{resource.name}</h3>
        {resource.conflicts.length === 0 ? <p>无可见冲突</p> : resource.conflicts.map((conflict, index) => (
          <article key={`${conflict.start}-${conflict.end}-${index}`}>
            <strong>{conflict.kind === "exclusive" ? "独占冲突" : "容量冲突"}</strong>
            <p>{conflict.start} 至 {conflict.end}</p>
            {conflict.capacity === undefined ? null : <p>冲突容量 {conflict.capacity}</p>}
            <p>参与者信息已按权限隐藏</p>
          </article>
        ))}
      </section>
    );
  }
  return (
    <section role="region" aria-label="资源库存详情">
      <h3>{resource.name}</h3>
      <dl>
        <dt>类型</dt><dd>{resource.type}</dd>
        <dt>状态</dt><dd>{resource.state}</dd>
        <dt>容量</dt><dd>可用容量 {resource.availableCapacity} / {resource.capacity}</dd>
      </dl>
    </section>
  );
}

export function Resources({ result, query, capabilities, online, authenticated, onQueryChange, onRefresh, onExecute, onConflictRefresh }: ResourcesProps) {
  const [activeTab, setActiveTab] = useState(definition.tabs[0]!.id);
  const [createPayload, setCreatePayload] = useState({ name: "", type: "", capacity: 1 });
  const [changePayload, setChangePayload] = useState({ resourceId: "", expectedVersion: 0, capacity: 1 });
  const [reservePayload, setReservePayload] = useState({ resourceId: "", start: "", end: "", capacity: 1, exclusive: false });
  const [cancelPayload, setCancelPayload] = useState({ reservationId: "", expectedVersion: 0 });
  const commandProps = { capabilities, online, authenticated, onExecute, onConflictRefresh };
  const controlDisabled = (command: WorkspaceOperation) => !online || !authenticated || command.availability.state !== "available" || !capabilities.includes(command.capability);
  const create = operation("create");
  const change = operation("change");
  const reserve = operation("reserve");
  const cancel = operation("cancel");

  return (
    <section aria-labelledby="resources-title">
      <header><h2 id="resources-title">资源</h2><p>库存、可用容量、预留与冲突</p></header>
      <div role="tablist" aria-label="资源视图">
        {definition.tabs.map((tab) => <button key={tab.id} id={`resources-tab-${tab.id}`} type="button" role="tab" aria-selected={activeTab === tab.id} aria-controls="resources-panel" onClick={() => setActiveTab(tab.id)}>{tab.label}</button>)}
      </div>
      <section id="resources-panel" role="tabpanel" aria-label={definition.tabs.find(({ id }) => id === activeTab)?.label}>
        <QueryToolbar definition={definition} value={query} disabled={!online || !authenticated || result.state === "unavailable"} onChange={onQueryChange} onRefresh={onRefresh} />
        <WorkspaceState result={result} itemSchema={resourceSchema} onRetry={onRefresh} onRefresh={onConflictRefresh} renderItem={(item) => <ResourceDetails resource={item} view={activeTab} />} />
      </section>

      <section aria-label="资源命令">
        <h2>资源与预留操作</h2>
        <section aria-labelledby="resource-create-heading">
          <h3 id="resource-create-heading">创建资源</h3>
          <label>资源名称<input value={createPayload.name} disabled={controlDisabled(create)} onChange={(event) => setCreatePayload({ ...createPayload, name: event.currentTarget.value })} /></label>
          <label>新资源类型<input value={createPayload.type} disabled={controlDisabled(create)} onChange={(event) => setCreatePayload({ ...createPayload, type: event.currentTarget.value })} /></label>
          <label>容量<input type="number" min="1" value={createPayload.capacity} disabled={controlDisabled(create)} onChange={(event) => setCreatePayload({ ...createPayload, capacity: event.currentTarget.valueAsNumber })} /></label>
          <CommandPanel workspace="resources" command={create} payload={createPayload} {...commandProps} />
        </section>
        <section aria-labelledby="resource-change-heading">
          <h3 id="resource-change-heading">变更资源</h3>
          <label>变更资源编号<input value={changePayload.resourceId} disabled={controlDisabled(change)} onChange={(event) => setChangePayload({ ...changePayload, resourceId: event.currentTarget.value })} /></label>
          <label>当前版本<input type="number" min="0" value={changePayload.expectedVersion} disabled={controlDisabled(change)} onChange={(event) => setChangePayload({ ...changePayload, expectedVersion: event.currentTarget.valueAsNumber })} /></label>
          <label>新容量<input type="number" min="1" value={changePayload.capacity} disabled={controlDisabled(change)} onChange={(event) => setChangePayload({ ...changePayload, capacity: event.currentTarget.valueAsNumber })} /></label>
          <CommandPanel workspace="resources" command={change} {...(changePayload.resourceId ? { targetId: changePayload.resourceId } : {})} payload={{ expectedVersion: changePayload.expectedVersion, capacity: changePayload.capacity }} {...commandProps} />
        </section>
        <section aria-labelledby="resource-reserve-heading">
          <h3 id="resource-reserve-heading">创建预留</h3>
          <label>预留资源编号<input value={reservePayload.resourceId} disabled={controlDisabled(reserve)} onChange={(event) => setReservePayload({ ...reservePayload, resourceId: event.currentTarget.value })} /></label>
          <label>开始时间<input type="datetime-local" value={reservePayload.start} disabled={controlDisabled(reserve)} onChange={(event) => setReservePayload({ ...reservePayload, start: event.currentTarget.value })} /></label>
          <label>结束时间<input type="datetime-local" value={reservePayload.end} disabled={controlDisabled(reserve)} onChange={(event) => setReservePayload({ ...reservePayload, end: event.currentTarget.value })} /></label>
          <label>预留容量<input type="number" min="1" value={reservePayload.capacity} disabled={controlDisabled(reserve)} onChange={(event) => setReservePayload({ ...reservePayload, capacity: event.currentTarget.valueAsNumber })} /></label>
          <label><input type="checkbox" checked={reservePayload.exclusive} disabled={controlDisabled(reserve)} onChange={(event) => setReservePayload({ ...reservePayload, exclusive: event.currentTarget.checked })} />独占预留</label>
          <CommandPanel workspace="resources" command={reserve} {...(reservePayload.resourceId ? { targetId: reservePayload.resourceId } : {})} payload={{ start: reservePayload.start, end: reservePayload.end, capacity: reservePayload.capacity, exclusive: reservePayload.exclusive }} {...commandProps} />
        </section>
        <section aria-labelledby="resource-cancel-heading">
          <h3 id="resource-cancel-heading">取消预留</h3>
          <label>预留编号<input value={cancelPayload.reservationId} disabled={controlDisabled(cancel)} onChange={(event) => setCancelPayload({ ...cancelPayload, reservationId: event.currentTarget.value })} /></label>
          <label>预留版本<input type="number" min="0" value={cancelPayload.expectedVersion} disabled={controlDisabled(cancel)} onChange={(event) => setCancelPayload({ ...cancelPayload, expectedVersion: event.currentTarget.valueAsNumber })} /></label>
          <CommandPanel workspace="resources" command={cancel} {...(cancelPayload.reservationId ? { targetId: cancelPayload.reservationId } : {})} payload={{ expectedVersion: cancelPayload.expectedVersion }} {...commandProps} />
        </section>
      </section>
    </section>
  );
}
