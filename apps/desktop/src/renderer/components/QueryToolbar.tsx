import { useEffect, useRef } from "react";

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
  const currentValue = useRef(value);
  useEffect(() => {
    currentValue.current = value;
  }, [value]);

  const withoutCursors = (query: WorkspaceQueryValue) => {
    const { cursor: _cursor, previousCursor: _previous, nextCursor: _next, ...rest } = query;
    return rest;
  };
  const updateQuery = (patch: Partial<WorkspaceQueryValue>) => {
    const next = { ...withoutCursors(currentValue.current), ...patch };
    currentValue.current = next;
    onChange(next);
  };
  const moveCursor = (cursor: string) => {
    const next = { ...withoutCursors(currentValue.current), cursor };
    currentValue.current = next;
    onChange(next);
  };
  const clear = () => {
    const next = { search: "", filters: {}, sort: definition.sortOptions[0]?.value ?? "" };
    currentValue.current = next;
    onChange(next);
  };

  return (
    <form className="query-toolbar" aria-label="查询工具" onSubmit={(event) => event.preventDefault()}>
      <label>搜索<input type="search" value={value.search} disabled={disabled} onChange={(event) => updateQuery({ search: event.currentTarget.value })} /></label>
      {definition.filters.map((descriptor) => (
        <label key={descriptor.key}>{descriptor.label}
          <select value={value.filters[descriptor.key] ?? ""} disabled={disabled} onChange={(event) => updateQuery({ filters: { ...currentValue.current.filters, [descriptor.key]: event.currentTarget.value } })}>
            <option value="">全部</option>
            {descriptor.options.map((entry) => <option value={entry.value} key={entry.value}>{entry.label}</option>)}
          </select>
        </label>
      ))}
      <label>排序<select value={value.sort} disabled={disabled} onChange={(event) => updateQuery({ sort: event.currentTarget.value })}>{definition.sortOptions.map((entry) => <option value={entry.value} key={entry.value}>{entry.label}</option>)}</select></label>
      <button type="button" disabled={disabled} aria-label="清除查询条件" onClick={clear}>清除</button>
      <button type="button" disabled={disabled} onClick={onRefresh}>刷新</button>
      <button type="button" aria-label="上一页" disabled={disabled || !value.previousCursor} onClick={() => value.previousCursor && moveCursor(value.previousCursor)}>上一页</button>
      <button type="button" aria-label="下一页" disabled={disabled || !value.nextCursor} onClick={() => value.nextCursor && moveCursor(value.nextCursor)}>下一页</button>
    </form>
  );
}
