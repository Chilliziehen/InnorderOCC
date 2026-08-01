import type { ReactNode } from "react";
import type { z } from "zod";

interface DataResult {
  readonly items: readonly unknown[];
  readonly count: number;
  readonly fetchedAt: string;
  readonly nextCursor?: string;
}

export type WorkspaceStateResult =
  | { readonly state: "loading"; readonly label: string }
  | ({ readonly state: "ready" } & DataResult)
  | { readonly state: "empty"; readonly fetchedAt: string; readonly nextCommand?: { readonly label: string; readonly permitted: boolean } }
  | { readonly state: "problem"; readonly problem: { readonly title: string; readonly detail?: string; readonly code?: string; readonly status: number; readonly correlationId?: string } }
  | ({ readonly state: "stale" | "offline" } & DataResult)
  | { readonly state: "conflict"; readonly currentVersion: string; readonly correlationId?: string }
  | { readonly state: "unavailable"; readonly reason: "UNAVAILABLE_CONTRACT"; readonly resourceGroups: readonly string[]; readonly message: string };

export interface WorkspaceColumn {
  readonly key: string;
  readonly label: string;
}

interface WorkspaceStateProps<Item> {
  readonly result: WorkspaceStateResult;
  readonly itemSchema: z.ZodType<Item>;
  readonly columns?: readonly WorkspaceColumn[];
  readonly unavailableControls?: readonly string[];
  readonly now?: number;
  readonly onNextCommand?: () => void;
  readonly onRetry?: () => void;
  readonly onRefresh?: () => void;
  readonly renderItem?: (item: Item) => ReactNode;
}

function ageLabel(fetchedAt: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(fetchedAt)) / 1_000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时`;
}

function displayValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return "--";
}

function ValidatedData<Item>({
  result,
  itemSchema,
  columns = [],
  now,
  renderItem,
}: {
  result: DataResult;
  itemSchema: z.ZodType<Item>;
  columns?: readonly WorkspaceColumn[];
  now?: number;
  renderItem?: (item: Item) => ReactNode;
}) {
  const parsed = result.items.map((item) => itemSchema.safeParse(item));
  if (parsed.some(({ success }) => !success)) {
    return <section role="alert"><strong>数据格式无效</strong><p>响应未通过工作区数据校验。</p></section>;
  }
  const items = parsed.map((entry) => entry.data as Item);
  return (
    <section aria-label="工作区结果">
      <header>
        <span>{result.count} 项</span>
        <time dateTime={result.fetchedAt}>更新于 {new Date(result.fetchedAt).toLocaleString("zh-CN")}</time>
        {result.nextCursor ? <span>下一页可用</span> : null}
        {now === undefined ? null : <span>数据年龄 {ageLabel(result.fetchedAt, now)}</span>}
      </header>
      {renderItem ? items.map((item, index) => <div key={index}>{renderItem(item)}</div>) : (
        <div role="table" aria-label="工作区数据">
          {columns.length > 0 ? (
            <div role="row">{columns.map((column) => <span role="columnheader" key={column.key}>{column.label}</span>)}</div>
          ) : null}
          {items.map((item, index) => {
            const record = item as Record<string, unknown>;
            const values = columns.length > 0 ? columns.map(({ key }) => record[key]) : Object.values(record);
            return <div role="row" key={index}>{values.map((value, cell) => <span role="cell" key={cell}>{displayValue(value)}</span>)}</div>;
          })}
        </div>
      )}
    </section>
  );
}

export function WorkspaceState<Item>({ result, itemSchema, columns, unavailableControls = [], now = Date.now(), onNextCommand, onRetry, onRefresh, renderItem }: WorkspaceStateProps<Item>) {
  let announcement: string = result.state;
  let content: ReactNode;

  switch (result.state) {
    case "loading":
      announcement = result.label;
      content = <section role="status" aria-label={result.label} aria-busy="true"><progress aria-label={result.label} /> <span>{result.label}</span></section>;
      break;
    case "ready":
      announcement = "数据已更新";
      content = <ValidatedData result={result} itemSchema={itemSchema} {...(columns ? { columns } : {})} {...(renderItem ? { renderItem } : {})} />;
      break;
    case "empty":
      announcement = "没有结果";
      content = <section><strong>没有结果</strong>{result.nextCommand?.permitted && onNextCommand ? <button type="button" onClick={onNextCommand}>{result.nextCommand.label}</button> : null}</section>;
      break;
    case "problem":
      announcement = "查询失败";
      content = (
        <section role="alert">
          <strong>{result.problem.title}</strong>
          {result.problem.code ? <span>错误代码 {result.problem.code}</span> : null}
          <span>HTTP {result.problem.status}</span>
          {result.problem.correlationId ? <code>{result.problem.correlationId}</code> : null}
          {onRetry ? <button type="button" onClick={onRetry}>重试</button> : null}
        </section>
      );
      break;
    case "stale":
    case "offline":
      announcement = result.state === "offline" ? "离线，只读" : "数据已过期，只读";
      content = (
        <section>
          <strong>{result.state === "offline" ? "离线数据，只读" : "过期数据，只读"}</strong>
          <ValidatedData result={result} itemSchema={itemSchema} {...(columns ? { columns } : {})} now={now} {...(renderItem ? { renderItem } : {})} />
        </section>
      );
      break;
    case "conflict":
      announcement = "版本冲突";
      content = <section role="alert"><strong>版本冲突</strong><span>当前版本 {result.currentVersion}</span>{result.correlationId ? <code>{result.correlationId}</code> : null}{onRefresh ? <button type="button" onClick={onRefresh}>刷新当前版本</button> : null}</section>;
      break;
    case "unavailable":
      announcement = "工作区合同不可用";
      content = (
        <section role="status">
          <strong>{result.reason}</strong>
          <p>{result.message}</p>
          <p>所需 API：{result.resourceGroups.join("、")}</p>
          {unavailableControls.map((label) => <button type="button" disabled key={label}>{label}</button>)}
        </section>
      );
      break;
  }

  return <div className="workspace-state">{content}<span className="sr-only" aria-live="polite" data-testid="workspace-state-announcement">{announcement}</span></div>;
}
