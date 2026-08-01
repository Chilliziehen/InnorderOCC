import { useState, type KeyboardEvent } from "react";
import { z } from "zod";

import type { CommandReceipt, WorkspaceCommand, WorkspaceResult } from "../../desktop-contract";
import { CommandPanel } from "../components/CommandPanel";
import { QueryToolbar, type WorkspaceQueryValue } from "../components/QueryToolbar";
import { WorkspaceState } from "../components/WorkspaceState";
import { WORKSPACE_DEFINITIONS, type WorkspaceOperation } from "./workspace-definitions";

const identifierSchema = z.string().trim().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const positiveCapacitySchema = z.number().finite().positive();
const availableCapacitySchema = z.number().finite().nonnegative();
const integerInputSchema = z.string().regex(/^(?:0|[1-9]\d*)$/).transform(Number);
const positiveCapacityInputSchema = z.string().trim().min(1).transform(Number).pipe(positiveCapacitySchema);
const reservationSchema = z.object({
  id: identifierSchema,
  start: z.string().datetime({ offset: true }),
  end: z.string().datetime({ offset: true }),
  capacity: positiveCapacitySchema,
  state: z.string().trim().min(1).max(64),
}).refine(({ start, end }) => Date.parse(start) < Date.parse(end));

const conflictSchema = z.object({
  kind: z.enum(["exclusive", "capacity"]),
  start: z.string().datetime({ offset: true }),
  end: z.string().datetime({ offset: true }),
  capacity: positiveCapacitySchema.optional(),
}).refine(({ start, end }) => Date.parse(start) < Date.parse(end));

const resourceSchema = z.object({
  id: identifierSchema,
  name: z.string().trim().min(1).max(128),
  type: identifierSchema,
  state: z.string().trim().min(1).max(64),
  capacity: positiveCapacitySchema,
  availableCapacity: availableCapacitySchema,
  reservations: z.array(reservationSchema),
  conflicts: z.array(conflictSchema),
}).refine(({ capacity, availableCapacity }) => availableCapacity <= capacity);

const createSchema = z.object({
  name: z.string().trim().min(1).max(128),
  type: identifierSchema,
  capacity: positiveCapacityInputSchema,
});
const changeSchema = z.object({
  resourceId: identifierSchema,
  expectedVersion: integerInputSchema,
  capacity: positiveCapacityInputSchema,
});
const reserveSchema = z.object({
  resourceId: identifierSchema,
  start: z.string().min(1),
  end: z.string().min(1),
  capacity: positiveCapacityInputSchema,
  expectedVersion: integerInputSchema,
  exclusive: z.boolean(),
}).refine(({ start, end }) => Number.isFinite(Date.parse(start)) && Date.parse(start) < Date.parse(end));
const cancelSchema = z.object({ reservationId: identifierSchema, expectedVersion: integerInputSchema });

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
        {resource.reservations.length === 0 ? <p>无可见预留</p> : resource.reservations.map((reservation) => (
          <dl key={reservation.id}>
            <dt>预留编号</dt><dd>{reservation.id}</dd>
            <dt>时间区间</dt><dd>{reservation.start} 至 {reservation.end}</dd>
            <dt>预留容量</dt><dd>{reservation.capacity}</dd>
            <dt>状态</dt><dd>{reservation.state}</dd>
          </dl>
        ))}
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
  const [createPayload, setCreatePayload] = useState({ name: "", type: "", capacity: "" });
  const [changePayload, setChangePayload] = useState({ resourceId: "", expectedVersion: "", capacity: "" });
  const [reservePayload, setReservePayload] = useState({ resourceId: "", start: "", end: "", capacity: "", expectedVersion: "", exclusive: false });
  const [cancelPayload, setCancelPayload] = useState({ reservationId: "", expectedVersion: "" });
  const commandProps = { capabilities, online, authenticated, onExecute, onConflictRefresh };
  const controlDisabled = (command: WorkspaceOperation) => !online || !authenticated || !capabilities.includes(command.capability);
  const create = operation("create");
  const change = operation("change");
  const reserve = operation("reserve");
  const cancel = operation("cancel");
  const createResult = createSchema.safeParse(createPayload);
  const changeResult = changeSchema.safeParse(changePayload);
  const reserveResult = reserveSchema.safeParse(reservePayload);
  const cancelResult = cancelSchema.safeParse(cancelPayload);
  const selectTab = (index: number, target: HTMLButtonElement) => {
    const tab = definition.tabs[index]!;
    setActiveTab(tab.id);
    const buttons = target.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    buttons?.[index]?.focus();
  };
  const handleTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number | undefined;
    if (event.key === "ArrowRight") next = (index + 1) % definition.tabs.length;
    if (event.key === "ArrowLeft") next = (index - 1 + definition.tabs.length) % definition.tabs.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = definition.tabs.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    selectTab(next, event.currentTarget);
  };
  const guardedCommand = (command: WorkspaceOperation, parsed: { success: boolean; data?: Readonly<Record<string, unknown>> }, invalidMessage: string, payload: Readonly<Record<string, unknown>>, targetId?: string) => parsed.success ? (
    <CommandPanel workspace="resources" command={command} payload={payload} {...(targetId ? { targetId } : {})} {...commandProps} />
  ) : (
    <form className="command-panel" onSubmit={(event) => event.preventDefault()}><button type="submit" disabled>{command.label}</button><p>{invalidMessage}</p></form>
  );

  return (
    <section aria-labelledby="resources-title">
      <header><h2 id="resources-title">资源</h2><p>库存、可用容量、预留与冲突</p></header>
      <div role="tablist" aria-label="资源视图">
        {definition.tabs.map((tab, index) => <button key={tab.id} id={`resources-tab-${tab.id}`} type="button" role="tab" tabIndex={activeTab === tab.id ? 0 : -1} aria-selected={activeTab === tab.id} aria-controls="resources-panel" onKeyDown={(event) => handleTabKey(event, index)} onClick={(event) => selectTab(index, event.currentTarget)}>{tab.label}</button>)}
      </div>
      <section id="resources-panel" role="tabpanel" aria-labelledby={`resources-tab-${activeTab}`}>
        <QueryToolbar definition={definition} value={query} disabled={!online || !authenticated || result.state === "unavailable"} onChange={onQueryChange} onRefresh={onRefresh} />
        <WorkspaceState result={result} itemSchema={resourceSchema} onRetry={onRefresh} onRefresh={onConflictRefresh} renderItem={(item) => <ResourceDetails resource={item} view={activeTab} />} />
      </section>

      <section aria-label="资源命令">
        <h2>资源与预留操作</h2>
        <section aria-labelledby="resource-create-heading">
          <h3 id="resource-create-heading">创建资源</h3>
          <label>资源名称<input value={createPayload.name} disabled={controlDisabled(create)} onChange={(event) => setCreatePayload({ ...createPayload, name: event.currentTarget.value })} /></label>
          <label>新资源类型<input value={createPayload.type} disabled={controlDisabled(create)} onChange={(event) => setCreatePayload({ ...createPayload, type: event.currentTarget.value })} /></label>
          <label>容量<input type="number" min="0" step="any" value={createPayload.capacity} disabled={controlDisabled(create)} onChange={(event) => setCreatePayload({ ...createPayload, capacity: event.currentTarget.value })} /></label>
          {guardedCommand(create, createResult, "资源名称、类型或总容量无效", createResult.success ? createResult.data : {})}
        </section>
        <section aria-labelledby="resource-change-heading">
          <h3 id="resource-change-heading">变更资源</h3>
          <label>变更资源编号<input value={changePayload.resourceId} disabled={controlDisabled(change)} onChange={(event) => setChangePayload({ ...changePayload, resourceId: event.currentTarget.value })} /></label>
          <label>当前版本<input type="number" min="0" step="1" value={changePayload.expectedVersion} disabled={controlDisabled(change)} onChange={(event) => setChangePayload({ ...changePayload, expectedVersion: event.currentTarget.value })} /></label>
          <label>新容量<input type="number" min="0" step="any" value={changePayload.capacity} disabled={controlDisabled(change)} onChange={(event) => setChangePayload({ ...changePayload, capacity: event.currentTarget.value })} /></label>
          {guardedCommand(change, changeResult, "资源编号、版本或容量无效", changeResult.success ? { expectedVersion: changeResult.data.expectedVersion, capacity: changeResult.data.capacity } : {}, changeResult.success ? changeResult.data.resourceId : undefined)}
        </section>
        <section aria-labelledby="resource-reserve-heading">
          <h3 id="resource-reserve-heading">创建预留</h3>
          <label>预留资源编号<input value={reservePayload.resourceId} disabled={controlDisabled(reserve)} onChange={(event) => setReservePayload({ ...reservePayload, resourceId: event.currentTarget.value })} /></label>
          <label>开始时间<input type="datetime-local" value={reservePayload.start} disabled={controlDisabled(reserve)} onChange={(event) => setReservePayload({ ...reservePayload, start: event.currentTarget.value })} /></label>
          <label>结束时间<input type="datetime-local" value={reservePayload.end} disabled={controlDisabled(reserve)} onChange={(event) => setReservePayload({ ...reservePayload, end: event.currentTarget.value })} /></label>
          <label>预留容量<input type="number" min="0" step="any" value={reservePayload.capacity} disabled={controlDisabled(reserve)} onChange={(event) => setReservePayload({ ...reservePayload, capacity: event.currentTarget.value })} /></label>
          <label>资源预期版本<input type="number" min="0" step="1" value={reservePayload.expectedVersion} disabled={controlDisabled(reserve)} onChange={(event) => setReservePayload({ ...reservePayload, expectedVersion: event.currentTarget.value })} /></label>
          <label><input type="checkbox" checked={reservePayload.exclusive} disabled={controlDisabled(reserve)} onChange={(event) => setReservePayload({ ...reservePayload, exclusive: event.currentTarget.checked })} />独占预留</label>
          {guardedCommand(reserve, reserveResult, "预留资源、时间区间、容量或版本无效", reserveResult.success ? { start: new Date(reserveResult.data.start).toISOString(), end: new Date(reserveResult.data.end).toISOString(), capacity: reserveResult.data.capacity, expectedVersion: reserveResult.data.expectedVersion, exclusive: reserveResult.data.exclusive } : {}, reserveResult.success ? reserveResult.data.resourceId : undefined)}
        </section>
        <section aria-labelledby="resource-cancel-heading">
          <h3 id="resource-cancel-heading">取消预留</h3>
          <label>预留编号<input value={cancelPayload.reservationId} disabled={controlDisabled(cancel)} onChange={(event) => setCancelPayload({ ...cancelPayload, reservationId: event.currentTarget.value })} /></label>
          <label>预留版本<input type="number" min="0" step="1" value={cancelPayload.expectedVersion} disabled={controlDisabled(cancel)} onChange={(event) => setCancelPayload({ ...cancelPayload, expectedVersion: event.currentTarget.value })} /></label>
          {guardedCommand(cancel, cancelResult, "预留编号或版本无效", cancelResult.success ? { expectedVersion: cancelResult.data.expectedVersion } : {}, cancelResult.success ? cancelResult.data.reservationId : undefined)}
        </section>
      </section>
    </section>
  );
}
