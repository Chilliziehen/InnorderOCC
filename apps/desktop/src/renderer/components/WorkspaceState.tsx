import { useEffect, useState, type ReactNode } from "react";
import type { z } from "zod";

import type { WorkspaceResult } from "../../desktop-contract";

type DataResult = Extract<WorkspaceResult, { items: readonly unknown[] }>;

export interface WorkspaceColumn {
  readonly key: string;
  readonly label: string;
}

interface WorkspaceStateProps<Item> {
  readonly result: WorkspaceResult;
  readonly itemSchema: z.ZodType<Item>;
  readonly columns?: readonly WorkspaceColumn[];
  readonly unavailableControls?: readonly string[];
  readonly now?: number;
  readonly onNextCommand?: () => void;
  readonly onRetry?: () => void;
  readonly onRefresh?: () => void;
  readonly renderItem?: (item: Item) => ReactNode;
  readonly renderRowAction?: (item: Item) => ReactNode;
}

function announcementText(result: WorkspaceResult): string {
  switch (result.state) {
    case "loading": return result.label;
    case "ready": return "数据已更新";
    case "empty": return "没有结果";
    case "error": return "查询失败";
    case "stale": return "数据已过期，只读";
    case "offline": return "离线，只读";
    case "conflict": return "版本冲突";
    case "unavailable": return "工作区合同不可用";
  }
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
  renderRowAction,
}: {
  result: DataResult;
  itemSchema: z.ZodType<Item>;
  columns?: readonly WorkspaceColumn[];
  now?: number;
  renderItem?: (item: Item) => ReactNode;
  renderRowAction?: (item: Item) => ReactNode;
}) {
  const parsed = result.items.map((item) => itemSchema.safeParse(item));
  if (parsed.some(({ success }) => !success)) {
    return <section role="region" aria-label="数据校验错误"><strong>数据格式无效</strong><p>响应未通过工作区数据校验。</p></section>;
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
            <div role="row">{renderRowAction ? <span role="columnheader">选择</span> : null}{columns.map((column) => <span role="columnheader" key={column.key}>{column.label}</span>)}</div>
          ) : null}
          {items.map((item, index) => {
            const record = item as Record<string, unknown>;
            const dataColumns = columns.length > 0
              ? columns
              : Object.keys(record).map((key) => ({ key, label: key }));
            return <div role="row" key={index}>{renderRowAction ? <span role="cell" data-label="选择">{renderRowAction(item)}</span> : null}{dataColumns.map(({ key, label }) => <span role="cell" data-label={label.trim() || key} key={key}>{displayValue(record[key])}</span>)}</div>;
          })}
        </div>
      )}
    </section>
  );
}

export function WorkspaceState<Item>({ result, itemSchema, columns, unavailableControls = [], now = Date.now(), onNextCommand, onRetry, onRefresh, renderItem, renderRowAction }: WorkspaceStateProps<Item>) {
  const [announcement, setAnnouncement] = useState({ text: "", sequence: 0 });
  let content: ReactNode;

  useEffect(() => {
    setAnnouncement((current) => ({
      text: announcementText(result),
      sequence: current.sequence + 1,
    }));
  }, [result]);

  const announceAction = (text: string) => {
    setAnnouncement((current) => ({ text, sequence: current.sequence + 1 }));
  };

  switch (result.state) {
    case "loading":
      content = <section role="region" aria-label={result.label} aria-busy="true"><progress aria-label={result.label} /> <span>{result.label}</span></section>;
      break;
    case "ready":
      content = <ValidatedData result={result} itemSchema={itemSchema} {...(columns ? { columns } : {})} {...(renderItem ? { renderItem } : {})} {...(renderRowAction ? { renderRowAction } : {})} />;
      break;
    case "empty":
      content = <section><strong>没有结果</strong>{result.nextCommand?.permitted && onNextCommand ? <button type="button" onClick={onNextCommand}>{result.nextCommand.label}</button> : null}</section>;
      break;
    case "error":
      content = (
        <section role="region" aria-label="查询错误">
          <strong>{result.problem.title}</strong>
          {result.problem.code ? <span>错误代码 {result.problem.code}</span> : null}
          <span>HTTP {result.problem.status}</span>
          {result.problem.correlationId ? <code>{result.problem.correlationId}</code> : null}
          {onRetry ? <button type="button" onClick={() => { announceAction("正在重试查询"); onRetry(); }}>重试</button> : null}
        </section>
      );
      break;
    case "stale":
    case "offline":
      content = (
        <section>
          <strong>{result.state === "offline" ? "离线数据，只读" : "过期数据，只读"}</strong>
          <ValidatedData result={result} itemSchema={itemSchema} {...(columns ? { columns } : {})} now={now} {...(renderItem ? { renderItem } : {})} {...(renderRowAction ? { renderRowAction } : {})} />
        </section>
      );
      break;
    case "conflict":
      content = <section role="region" aria-label="版本冲突"><strong>版本冲突</strong><span>当前版本 {result.currentVersion}</span>{result.correlationId ? <code>{result.correlationId}</code> : null}{onRefresh ? <button type="button" onClick={() => { announceAction("正在刷新当前版本"); onRefresh(); }}>刷新当前版本</button> : null}</section>;
      break;
    case "unavailable":
      content = (
        <section aria-label="工作区合同不可用">
          <strong>{result.reason}</strong>
          <p>{result.message}</p>
          <p>所需 API：{result.resourceGroups.join("、")}</p>
          {unavailableControls.map((label) => <button type="button" disabled key={label}>{label}</button>)}
        </section>
      );
      break;
  }

  return <div className="workspace-state">{content}<span className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="workspace-state-announcement">{announcement.text}，更新 {announcement.sequence}</span></div>;
}
