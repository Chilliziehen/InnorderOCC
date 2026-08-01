import { useState, type ChangeEvent, type KeyboardEvent } from "react";
import { z } from "zod";

import type { CommandReceipt, WorkspaceCommand, WorkspaceResult } from "../../desktop-contract";
import { CommandPanel } from "../components/CommandPanel";
import { QueryToolbar, type WorkspaceQueryValue } from "../components/QueryToolbar";
import { WorkspaceState } from "../components/WorkspaceState";
import { WORKSPACE_DEFINITIONS, type WorkspaceOperation } from "./workspace-definitions";

const identifierSchema = z.string().trim().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const packageNameSchema = z.string().trim().min(2).max(128).regex(/^[a-z][a-z0-9-]*$/);
const packageVersionSchema = z.string().trim().max(64).regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
const packageTypeSchema = z.string().trim().min(1).max(64).regex(/^[a-z][a-z0-9-]*$/);
const integerInputSchema = z.string().regex(/^(?:0|[1-9]\d*)$/).transform(Number);
const archiveReferenceSchema = z.object({ uploadId: z.string().uuid(), sha256: z.string().regex(/^[0-9a-f]{64}$/i) }).strict();
const packageMetadataSchema = z.object({ packageName: packageNameSchema, packageVersion: packageVersionSchema, packageType: packageTypeSchema });
const packageTargetSchema = z.object({ packageId: identifierSchema, versionId: identifierSchema });
const diffTargetSchema = packageTargetSchema.extend({ baseVersion: packageVersionSchema });
const versionActionSchema = z.object({ versionId: identifierSchema, expectedVersion: integerInputSchema });

export interface ArchiveUploadReference {
  readonly uploadId: string;
  readonly sha256: string;
}

const packageSchema = z.object({
  id: identifierSchema,
  name: packageNameSchema,
  version: packageVersionSchema,
  status: z.string().trim().min(1).max(64),
  assets: z.array(z.object({ name: z.string().trim().min(1).max(255), kind: z.string().trim().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9-]*$/), digest: z.string().trim().min(1).max(256) })),
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
  readonly maxArchiveBytes: number;
  readonly onArchiveUpload: (file: File, reportProgress: (percent: number) => void) => Promise<ArchiveUploadReference>;
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

function archiveLimitLabel(bytes: number): string {
  return bytes % (1024 * 1024) === 0 ? `${bytes / (1024 * 1024)} MiB` : `${bytes} 字节`;
}

function readSignature(file: File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("archive-read-failed"));
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.readAsArrayBuffer(file.slice(0, 4));
  });
}

function isZipSignature(bytes: Uint8Array): boolean {
  if (bytes.length !== 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return false;
  return (bytes[2] === 0x03 && bytes[3] === 0x04) ||
    (bytes[2] === 0x05 && bytes[3] === 0x06) ||
    (bytes[2] === 0x07 && bytes[3] === 0x08);
}

export function DomainDesign({ result, query, capabilities, online, authenticated, onQueryChange, onRefresh, onExecute, onConflictRefresh, maxArchiveBytes, onArchiveUpload }: DomainDesignProps) {
  const [activeTab, setActiveTab] = useState(definition.tabs[0]!.id);
  const [archive, setArchive] = useState<File>();
  const [archiveReference, setArchiveReference] = useState<ArchiveUploadReference>();
  const [archiveError, setArchiveError] = useState<string>();
  const [uploadPending, setUploadPending] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [packageMetadata, setPackageMetadata] = useState({ packageName: "", packageVersion: "", packageType: "" });
  const [packageId, setPackageId] = useState("");
  const [versionId, setVersionId] = useState("");
  const [baseVersion, setBaseVersion] = useState("");
  const [expectedVersion, setExpectedVersion] = useState("");
  const commands = {
    import: operation("import"),
    validate: operation("validate"),
    diff: operation("diff"),
    approve: operation("approve"),
    publish: operation("publish"),
  };
  const commandProps = { capabilities, online, authenticated, onExecute, onConflictRefresh };
  const controlDisabled = (command: WorkspaceOperation) => !online || !authenticated || !capabilities.includes(command.capability);
  const archiveBoundValid = Number.isSafeInteger(maxArchiveBytes) && maxArchiveBytes > 0;
  const selectArchive = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    setArchive(undefined);
    setArchiveReference(undefined);
    setUploadProgress(0);
    if (!file) {
      setArchiveError(undefined);
      return;
    }
    if (!archiveBoundValid || file.size < 1 || file.size > maxArchiveBytes) {
      setArchiveError(`归档大小必须在 1 到 ${archiveLimitLabel(maxArchiveBytes)} 之间`);
      return;
    }
    if (!file.name.toLowerCase().endsWith(".zip")) {
      setArchiveError("归档名称必须使用 .zip 扩展名");
      return;
    }
    if (file.type !== "application/zip") {
      setArchiveError("归档媒体类型必须为 application/zip");
      return;
    }
    try {
      if (!isZipSignature(await readSignature(file))) {
        setArchiveError("归档 ZIP 签名无效");
        return;
      }
      setArchive(file);
      setArchiveError(undefined);
    } catch {
      setArchiveError("无法读取归档签名");
    }
  };
  const uploadArchive = async () => {
    if (!archive || !archiveBoundValid || uploadPending || !online || !authenticated || !capabilities.includes(commands.import.capability)) return;
    setUploadPending(true);
    setArchiveError(undefined);
    setUploadProgress(0);
    try {
      const reference = archiveReferenceSchema.parse(await onArchiveUpload(archive, (percent) => {
        if (Number.isFinite(percent)) setUploadProgress(Math.max(0, Math.min(100, Math.round(percent))));
      }));
      setArchiveReference(reference);
      setUploadProgress(100);
    } catch {
      setArchiveReference(undefined);
      setArchiveError("归档上传失败");
    } finally {
      setUploadPending(false);
    }
  };
  const selectTab = (index: number, target: HTMLButtonElement) => {
    setActiveTab(definition.tabs[index]!.id);
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
  const importResult = packageMetadataSchema.safeParse(packageMetadata);
  const validateResult = packageTargetSchema.safeParse({ packageId, versionId });
  const diffResult = diffTargetSchema.safeParse({ packageId, versionId, baseVersion });
  const versionResult = versionActionSchema.safeParse({ versionId, expectedVersion });
  const guardedCommand = (command: WorkspaceOperation, valid: boolean, invalidMessage: string, payload: Readonly<Record<string, unknown>>, targetId?: string) => valid ? (
    <CommandPanel workspace="domain-design" command={command} payload={payload} {...(targetId ? { targetId } : {})} {...commandProps} />
  ) : (
    <form className="command-panel" onSubmit={(event) => event.preventDefault()}><button type="submit" disabled>{command.label}</button><p>{capabilities.includes(command.capability) ? invalidMessage : `缺少能力：${command.capability}`}</p></form>
  );

  return (
    <section aria-labelledby="domain-design-title">
      <header><h2 id="domain-design-title">领域设计</h2><p>领域包、版本、资产、校验、审批与发布</p></header>
      <div role="tablist" aria-label="领域设计视图">
        {definition.tabs.map((tab, index) => <button key={tab.id} id={`domain-tab-${tab.id}`} type="button" role="tab" tabIndex={activeTab === tab.id ? 0 : -1} aria-selected={activeTab === tab.id} aria-controls="domain-design-panel" onKeyDown={(event) => handleTabKey(event, index)} onClick={(event) => selectTab(index, event.currentTarget)}>{tab.label}</button>)}
      </div>
      <section id="domain-design-panel" role="tabpanel" aria-labelledby={`domain-tab-${activeTab}`}>
        <QueryToolbar definition={definition} value={query} disabled={!online || !authenticated || result.state === "unavailable"} onChange={onQueryChange} onRefresh={onRefresh} />
        <WorkspaceState result={result} itemSchema={packageSchema} onRetry={onRefresh} onRefresh={onConflictRefresh} renderItem={(item) => <PackageDetails item={item} />} />
      </section>

      <section aria-labelledby="package-assets-heading">
        <h2 id="package-assets-heading">包与版本资产</h2>
        <p>仅接受签名 ZIP 归档，最大 {archiveLimitLabel(maxArchiveBytes)}。归档内容由服务端执行路径、类型、签名与大小校验。</p>
        <label>包名称<input value={packageMetadata.packageName} disabled={controlDisabled(commands.import)} onChange={(event) => setPackageMetadata({ ...packageMetadata, packageName: event.currentTarget.value })} /></label>
        <label>包版本<input value={packageMetadata.packageVersion} disabled={controlDisabled(commands.import)} onChange={(event) => setPackageMetadata({ ...packageMetadata, packageVersion: event.currentTarget.value })} /></label>
        <label>包类型<input value={packageMetadata.packageType} disabled={controlDisabled(commands.import)} onChange={(event) => setPackageMetadata({ ...packageMetadata, packageType: event.currentTarget.value })} /></label>
        <label>签名领域包归档<input type="file" accept=".zip,application/zip" disabled={!archiveBoundValid || !online || !authenticated || !capabilities.includes(commands.import.capability) || uploadPending} onChange={(event) => void selectArchive(event)} /></label>
        {archiveError ? <p role="status" aria-label="归档校验错误">{archiveError}</p> : null}
        <button type="button" disabled={!archive || !archiveBoundValid || !online || !authenticated || !capabilities.includes(commands.import.capability) || uploadPending || Boolean(archiveError)} onClick={() => void uploadArchive()}>{uploadPending ? "正在上传" : "上传归档"}</button>
        <progress aria-label="归档上传进度" max="100" value={uploadProgress} />
        {archiveReference ? <section aria-label="归档上传引用"><strong>归档上传完成</strong><code>{archiveReference.uploadId}</code><code>{archiveReference.sha256}</code></section> : null}
        {guardedCommand(commands.import, importResult.success && archiveReference !== undefined, "包名称、版本、类型或上传引用无效", importResult.success && archiveReference ? { ...importResult.data, uploadId: archiveReference.uploadId, sha256: archiveReference.sha256 } : {})}
      </section>

      <section aria-labelledby="validation-diff-heading">
        <h2 id="validation-diff-heading">校验与版本比较</h2>
        <label>领域包编号<input value={packageId} disabled={controlDisabled(commands.validate) && controlDisabled(commands.diff)} onChange={(event) => setPackageId(event.currentTarget.value)} /></label>
        <label>版本编号<input value={versionId} disabled={controlDisabled(commands.validate) && controlDisabled(commands.diff)} onChange={(event) => setVersionId(event.currentTarget.value)} /></label>
        {guardedCommand(commands.validate, validateResult.success, "领域包或版本目标无效", validateResult.success ? { packageId: validateResult.data.packageId } : {}, validateResult.success ? validateResult.data.versionId : undefined)}
        <label>比较基准版本<input value={baseVersion} disabled={controlDisabled(commands.diff)} onChange={(event) => setBaseVersion(event.currentTarget.value)} /></label>
        {guardedCommand(commands.diff, diffResult.success, "比较目标或基准版本无效", diffResult.success ? { packageId: diffResult.data.packageId, baseVersion: diffResult.data.baseVersion } : {}, diffResult.success ? diffResult.data.versionId : undefined)}
      </section>

      <section aria-labelledby="approval-publication-heading">
        <h2 id="approval-publication-heading">审批与发布职责分离</h2>
        <p>批准人与导入或修改该版本的人员必须不同；服务端重新校验身份、能力、校验结果和版本。</p>
        <label>预期版本<input type="number" min="0" step="1" value={expectedVersion} disabled={controlDisabled(commands.approve) && controlDisabled(commands.publish)} onChange={(event) => setExpectedVersion(event.currentTarget.value)} /></label>
        {guardedCommand(commands.approve, versionResult.success, "版本目标或预期版本无效", versionResult.success ? { expectedVersion: versionResult.data.expectedVersion } : {}, versionResult.success ? versionResult.data.versionId : undefined)}
        {guardedCommand(commands.publish, versionResult.success, "版本目标或预期版本无效", versionResult.success ? { expectedVersion: versionResult.data.expectedVersion } : {}, versionResult.success ? versionResult.data.versionId : undefined)}
      </section>
      <p>图形化 BPMN/DMN 编辑、任意源码、脚本、DDL、Rego 与运行实例迁移不在此工作区提供。</p>
    </section>
  );
}
