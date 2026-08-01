import { useState, type ChangeEvent } from "react";
import { z } from "zod";

import type { CommandReceipt, WorkspaceCommand, WorkspaceResult } from "../../desktop-contract";
import { CommandPanel } from "../components/CommandPanel";
import { QueryToolbar, type WorkspaceQueryValue } from "../components/QueryToolbar";
import { WorkspaceState } from "../components/WorkspaceState";
import { WORKSPACE_DEFINITIONS, type WorkspaceOperation } from "./workspace-definitions";

const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024;

const packageSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  status: z.string(),
  assets: z.array(z.object({ name: z.string(), kind: z.string(), digest: z.string() })),
  validation: z.object({ state: z.string(), summary: z.string() }).optional(),
  diff: z.object({ baseVersion: z.string(), summary: z.string() }).optional(),
  approval: z.object({ state: z.string() }).optional(),
});

type DomainPackage = z.infer<typeof packageSchema>;

export interface DomainDesignProps {
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

const definition = WORKSPACE_DEFINITIONS["domain-design"];

function operation(name: string): WorkspaceOperation {
  const command = definition.commands.find(({ operation: candidate }) => candidate === name);
  if (!command) throw new Error(`Missing domain design operation: ${name}`);
  return command;
}

function PackageDetails({ item }: { item: DomainPackage }) {
  return (
    <article aria-label={`${item.name} ${item.version}`}>
      <header><h3>{item.name}</h3><p>版本 {item.version} · {item.status}</p></header>
      <section aria-label="包资产">
        <h4>资产</h4>
        <ul>{item.assets.map((asset) => <li key={`${asset.kind}-${asset.name}`}><strong>{asset.kind}</strong> {asset.name} <code>{asset.digest}</code></li>)}</ul>
      </section>
      <section aria-label="校验结果"><h4>校验</h4>{item.validation ? <p><span>{item.validation.state}</span>：<span>{item.validation.summary}</span></p> : <p>尚无校验结果</p>}</section>
      <section aria-label="版本比较"><h4>比较</h4>{item.diff ? <p>相对 <span>{item.diff.baseVersion}</span>：<span>{item.diff.summary}</span></p> : <p>尚无版本比较</p>}</section>
      <section aria-label="审批状态"><h4>审批</h4><p>{item.approval?.state ?? "尚未提交审批"}</p></section>
    </article>
  );
}

export function DomainDesign({ result, query, capabilities, online, authenticated, onQueryChange, onRefresh, onExecute, onConflictRefresh }: DomainDesignProps) {
  const [activeTab, setActiveTab] = useState(definition.tabs[0]!.id);
  const [archive, setArchive] = useState<{ name: string; size: number; type: string }>();
  const [archiveError, setArchiveError] = useState<string>();
  const [packageId, setPackageId] = useState("");
  const [versionId, setVersionId] = useState("");
  const [baseVersion, setBaseVersion] = useState("");
  const [expectedVersion, setExpectedVersion] = useState(0);
  const commands = {
    import: operation("import"),
    validate: operation("validate"),
    diff: operation("diff"),
    approve: operation("approve"),
    publish: operation("publish"),
  };
  const commandProps = { capabilities, online, authenticated, onExecute, onConflictRefresh };
  const controlDisabled = (command: WorkspaceOperation) => !online || !authenticated || command.availability.state !== "available" || !capabilities.includes(command.capability);
  const selectArchive = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    if (!file) {
      setArchive(undefined);
      setArchiveError(undefined);
      return;
    }
    if (file.size > MAX_ARCHIVE_BYTES) {
      setArchive(undefined);
      setArchiveError("归档超过 10 MiB 限制");
      return;
    }
    setArchive({ name: file.name, size: file.size, type: file.type });
    setArchiveError(undefined);
  };

  return (
    <section aria-labelledby="domain-design-title">
      <header><h2 id="domain-design-title">领域设计</h2><p>领域包、版本、资产、校验、审批与发布</p></header>
      <div role="tablist" aria-label="领域设计视图">
        {definition.tabs.map((tab) => <button key={tab.id} id={`domain-tab-${tab.id}`} type="button" role="tab" aria-selected={activeTab === tab.id} aria-controls="domain-design-panel" onClick={() => setActiveTab(tab.id)}>{tab.label}</button>)}
      </div>
      <section id="domain-design-panel" role="tabpanel" aria-label={definition.tabs.find(({ id }) => id === activeTab)?.label}>
        <QueryToolbar definition={definition} value={query} disabled={!online || !authenticated || result.state === "unavailable"} onChange={onQueryChange} onRefresh={onRefresh} />
        <WorkspaceState result={result} itemSchema={packageSchema} onRetry={onRefresh} onRefresh={onConflictRefresh} renderItem={(item) => <PackageDetails item={item} />} />
      </section>

      <section aria-labelledby="package-assets-heading">
        <h2 id="package-assets-heading">包与版本资产</h2>
        <p>仅接受签名 ZIP 归档，最大 10 MiB。归档内容由服务端执行路径、类型、签名与大小校验。</p>
        <label>签名领域包归档<input type="file" accept=".zip,application/zip" disabled={controlDisabled(commands.import)} onChange={selectArchive} /></label>
        {archiveError ? <p role="status">{archiveError}</p> : null}
        <CommandPanel workspace="domain-design" command={commands.import} payload={archive ?? {}} {...commandProps} />
      </section>

      <section aria-labelledby="validation-diff-heading">
        <h2 id="validation-diff-heading">校验与版本比较</h2>
        <label>领域包编号<input value={packageId} disabled={controlDisabled(commands.validate) && controlDisabled(commands.diff)} onChange={(event) => setPackageId(event.currentTarget.value)} /></label>
        <label>版本编号<input value={versionId} disabled={controlDisabled(commands.validate) && controlDisabled(commands.diff)} onChange={(event) => setVersionId(event.currentTarget.value)} /></label>
        <CommandPanel workspace="domain-design" command={commands.validate} {...(versionId ? { targetId: versionId } : {})} payload={{ packageId }} {...commandProps} />
        <label>比较基准版本<input value={baseVersion} disabled={controlDisabled(commands.diff)} onChange={(event) => setBaseVersion(event.currentTarget.value)} /></label>
        <CommandPanel workspace="domain-design" command={commands.diff} {...(versionId ? { targetId: versionId } : {})} payload={{ packageId, baseVersion }} {...commandProps} />
      </section>

      <section aria-labelledby="approval-publication-heading">
        <h2 id="approval-publication-heading">审批与发布职责分离</h2>
        <p>批准人与导入或修改该版本的人员必须不同；服务端重新校验身份、能力、校验结果和版本。</p>
        <label>预期版本<input type="number" min="0" value={expectedVersion} disabled={controlDisabled(commands.approve) && controlDisabled(commands.publish)} onChange={(event) => setExpectedVersion(event.currentTarget.valueAsNumber)} /></label>
        <CommandPanel workspace="domain-design" command={commands.approve} {...(versionId ? { targetId: versionId } : {})} payload={{ expectedVersion }} {...commandProps} />
        <CommandPanel workspace="domain-design" command={commands.publish} {...(versionId ? { targetId: versionId } : {})} payload={{ expectedVersion }} {...commandProps} />
      </section>
      <p>图形化 BPMN/DMN 编辑、任意源码、脚本、DDL、Rego 与运行实例迁移不在此工作区提供。</p>
    </section>
  );
}
