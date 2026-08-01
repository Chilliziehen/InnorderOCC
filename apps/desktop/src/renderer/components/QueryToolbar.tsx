import { startTransition } from "react";

import type { WorkspaceDefinition } from "../workspaces/workspace-definitions";

export interface WorkspaceQueryValue {
  readonly search: string;
  readonly filters: Readonly<Record<string, string>>;
  readonly sort: string;
  readonly cursor?: string;
  readonly previousCursor?: string;
  readonly nextCursor?: string;
}

interface QueryToolbarProps {
  readonly definition: WorkspaceDefinition;
  readonly value: WorkspaceQueryValue;
  readonly disabled?: boolean;
  readonly onChange: (value: WorkspaceQueryValue) => void;
  readonly onRefresh: () => void;
}

export function QueryToolbar({ definition, value, disabled = false, onChange, onRefresh }: QueryToolbarProps) {
  const update = (patch: Partial<WorkspaceQueryValue>, resetCursor = false) => {
    const { cursor: _cursor, ...withoutCursor } = value;
    startTransition(() => onChange(resetCursor ? { ...withoutCursor, ...patch } : { ...value, ...patch }));
  };
  const clear = () => onChange({ search: "", filters: {}, sort: definition.sortOptions[0]?.value ?? "" });

  return (
    <form className="query-toolbar" aria-label="查询工具" onSubmit={(event) => event.preventDefault()}>
      <label>搜索<input type="search" value={value.search} disabled={disabled} onChange={(event) => update({ search: event.currentTarget.value }, true)} /></label>
      {definition.filters.map((descriptor) => (
        <label key={descriptor.key}>{descriptor.label}
          <select value={value.filters[descriptor.key] ?? ""} disabled={disabled} onChange={(event) => update({ filters: { ...value.filters, [descriptor.key]: event.currentTarget.value } }, true)}>
            <option value="">全部</option>
            {descriptor.options.map((entry) => <option value={entry.value} key={entry.value}>{entry.label}</option>)}
          </select>
        </label>
      ))}
      <label>排序<select value={value.sort} disabled={disabled} onChange={(event) => update({ sort: event.currentTarget.value }, true)}>{definition.sortOptions.map((entry) => <option value={entry.value} key={entry.value}>{entry.label}</option>)}</select></label>
      <button type="button" disabled={disabled} aria-label="清除查询条件" onClick={clear}>清除</button>
      <button type="button" disabled={disabled} onClick={onRefresh}>刷新</button>
      <button type="button" aria-label="上一页" disabled={disabled || !value.previousCursor} onClick={() => value.previousCursor && update({ cursor: value.previousCursor })}>上一页</button>
      <button type="button" aria-label="下一页" disabled={disabled || !value.nextCursor} onClick={() => value.nextCursor && update({ cursor: value.nextCursor })}>下一页</button>
    </form>
  );
}
