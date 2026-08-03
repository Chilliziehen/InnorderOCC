import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { z } from "zod";

import type { CommandReceipt, WorkspaceCommand, WorkspaceResult } from "../../desktop-contract";
import { CommandPanel } from "../components/CommandPanel";
import { QueryToolbar, type WorkspaceQueryValue } from "../components/QueryToolbar";
import { WorkspaceState } from "../components/WorkspaceState";
import { WORKSPACE_DEFINITIONS, commandFor } from "./workspace-definitions";

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
  readonly onTabChange?: (tabId: string) => void;
  readonly activeTab?: string;
}

const definition = WORKSPACE_DEFINITIONS.administration;
const tabs = [
  ...definition.tabs.slice(0, 6),
  { id: "retention", label: "保留策略" },
  ...definition.tabs.slice(6),
] as const;
const initialTab = tabs[0]!;
const administrationItemSchema = z.object({
  subject: z.string(),
  type: z.string(),
  status: z.string(),
  updatedAt: z.string(),
}).strict();
const requiredText = z.string().trim().min(1);
const expectedVersion = z.preprocess(
  (value) => value === "" ? undefined : value,
  z.coerce.number().int().nonnegative(),
);
const httpsUrl = z.string().trim().url().refine((value) => value.toLowerCase().startsWith("https://"));

function canonicalCommand(operation: string) {
  const command = commandFor("administration", operation);
  if (!command) throw new Error(`Missing canonical Administration command: ${operation}`);
  return command;
}

function GuardedCommand({ operation, payload, valid, message, targetId, capabilities, online, authenticated, onExecute, onRefresh, onAccepted }: {
  readonly operation: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly valid: boolean;
  readonly message: string;
  readonly targetId?: string | undefined;
  readonly capabilities: readonly string[];
  readonly online: boolean;
  readonly authenticated: boolean;
  readonly onExecute: (command: WorkspaceCommand) => Promise<CommandReceipt>;
  readonly onRefresh: () => void;
  readonly onAccepted?: () => void;
}) {
  const command = canonicalCommand(operation);
  const reasonId = `administration-${operation}-shape-error`;
  const executeIfValid = (intent: WorkspaceCommand) => {
    if (!valid) {
      return Promise.resolve<CommandReceipt>({ state: "problem", problem: { title: message, code: "CLIENT_SHAPE_INVALID", status: 400 } });
    }
    onAccepted?.();
    return onExecute(intent);
  };
  return (
    <div>
      <fieldset disabled={!valid} aria-describedby={!valid ? reasonId : undefined}>
        <CommandPanel
          workspace="administration"
          command={command}
          capabilities={capabilities}
          online={online}
          authenticated={authenticated}
          payload={payload}
          {...(targetId ? { targetId } : {})}
          onExecute={executeIfValid}
          onConflictRefresh={onRefresh}
        />
      </fieldset>
      {!valid ? <p role="alert" id={reasonId}>{message}</p> : null}
      {command.availability.state === "unavailable" ? <p>{command.availability.message}</p> : null}
    </div>
  );
}

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
  onTabChange,
  activeTab: controlledActiveTab,
}: AdministrationProps) {
  const [localActiveTab, setActiveTab] = useState(initialTab.id);
  const [personName, setPersonName] = useState("");
  const [personEmail, setPersonEmail] = useState("");
  const [disabledPersonId, setDisabledPersonId] = useState("");
  const [disabledPersonVersion, setDisabledPersonVersion] = useState("");
  const [relationshipSubjectId, setRelationshipSubjectId] = useState("");
  const [relationshipObjectId, setRelationshipObjectId] = useState("");
  const [relationshipType, setRelationshipType] = useState("");
  const [rolePersonId, setRolePersonId] = useState("");
  const [roleId, setRoleId] = useState("");
  const [policyReleaseId, setPolicyReleaseId] = useState("");
  const [policyVersion, setPolicyVersion] = useState("");
  const [policyApproved, setPolicyApproved] = useState(false);
  const [providerId, setProviderId] = useState("");
  const [providerUrl, setProviderUrl] = useState("");
  const [providerModel, setProviderModel] = useState("");
  const [providerSecret, setProviderSecret] = useState("");
  const [uploadRef, setUploadRef] = useState("");
  const [knowledgeTarget, setKnowledgeTarget] = useState("");
  const [auditTarget, setAuditTarget] = useState("");
  const activeTab = tabs.some(({ id }) => id === controlledActiveTab) ? controlledActiveTab! : localActiveTab;
  const active = tabs.find(({ id }) => id === activeTab) ?? initialTab;
  const previousActiveTab = useRef(active.id);
  const mutable = connectivity === "online";
  const commandProps = { capabilities, online: mutable, authenticated, onExecute, onRefresh };
  const createPerson = z.object({ name: requiredText, email: z.string().trim().email() }).strict().safeParse({ name: personName, email: personEmail });
  const disablePerson = z.object({ expectedVersion }).strict().safeParse({ expectedVersion: disabledPersonVersion });
  const relationship = z.object({ relatedPersonId: requiredText, relationshipType: requiredText }).strict().safeParse({ relatedPersonId: relationshipObjectId, relationshipType });
  const role = z.object({ roleId: requiredText }).strict().safeParse({ roleId });
  const policy = z.object({ expectedVersion, approved: z.literal(true) }).strict().safeParse({ expectedVersion: policyVersion, approved: policyApproved });
  const provider = z.object({ endpoint: httpsUrl, model: requiredText, secret: z.string().min(1) }).strict().safeParse({ endpoint: providerUrl, model: providerModel, secret: providerSecret });
  const knowledge = z.object({ uploadRef: requiredText, target: requiredText }).strict().safeParse({ uploadRef, target: knowledgeTarget });
  const audit = z.object({ target: requiredText }).strict().safeParse({ target: auditTarget });

  useEffect(() => {
    const previous = previousActiveTab.current;
    previousActiveTab.current = active.id;
    if (previous === "providers" && active.id !== "providers") setProviderSecret("");
  }, [active.id]);

  const selectTab = (tabId: string) => {
    setActiveTab(tabId);
    onTabChange?.(tabId);
  };

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
            aria-controls="administration-panel"
            aria-selected={active.id === tab.id}
            tabIndex={active.id === tab.id ? 0 : -1}
            key={tab.id}
            onClick={() => selectTab(tab.id)}
            onKeyDown={(event) => moveTab(event, index, selectTab)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <QueryToolbar definition={definition} value={query} disabled={result.state === "loading"} onChange={onQueryChange} onRefresh={onRefresh} />
      <div
        role="tabpanel"
        id="administration-panel"
        aria-labelledby={`administration-tab-${active.id}`}
      >
        {active.id === "people" ? <>
          <section aria-label="创建人员操作">
            <label>人员姓名<input value={personName} onChange={(event) => setPersonName(event.currentTarget.value)} /></label>
            <label>人员邮箱<input type="email" value={personEmail} onChange={(event) => setPersonEmail(event.currentTarget.value)} /></label>
            <GuardedCommand operation="create" payload={createPerson.success ? createPerson.data : { name: personName, email: personEmail }} valid={createPerson.success} message="人员姓名和有效邮箱不能为空" {...commandProps} />
          </section>
          <section aria-label="停用人员操作">
            <label>停用人员 ID<input value={disabledPersonId} onChange={(event) => setDisabledPersonId(event.currentTarget.value)} /></label>
            <label>人员版本<input type="number" min={0} value={disabledPersonVersion} onChange={(event) => setDisabledPersonVersion(event.currentTarget.value)} /></label>
            <GuardedCommand operation="disable" targetId={disabledPersonId.trim() || undefined} payload={disablePerson.success ? disablePerson.data : { expectedVersion: disabledPersonVersion }} valid={Boolean(disabledPersonId.trim()) && disablePerson.success} message="停用人员及有效版本不能为空" {...commandProps} />
          </section>
        </> : null}
        {active.id === "relationships" ? <section aria-label="分配关系操作">
          <label>关系主体 ID<input value={relationshipSubjectId} onChange={(event) => setRelationshipSubjectId(event.currentTarget.value)} /></label>
          <label>关系对象 ID<input value={relationshipObjectId} onChange={(event) => setRelationshipObjectId(event.currentTarget.value)} /></label>
          <label>关系类型<input value={relationshipType} onChange={(event) => setRelationshipType(event.currentTarget.value)} /></label>
          <GuardedCommand operation="assignRelationship" targetId={relationshipSubjectId.trim() || undefined} payload={relationship.success ? relationship.data : { relatedPersonId: relationshipObjectId, relationshipType }} valid={Boolean(relationshipSubjectId.trim()) && relationship.success} message="关系主体、对象和类型不能为空" {...commandProps} />
        </section> : null}
        {active.id === "roles" ? <section aria-label="分配角色操作">
          <label>人员 ID<input value={rolePersonId} onChange={(event) => setRolePersonId(event.currentTarget.value)} /></label>
          <label>角色 ID<input value={roleId} onChange={(event) => setRoleId(event.currentTarget.value)} /></label>
          <GuardedCommand operation="assign" targetId={rolePersonId.trim() || undefined} payload={role.success ? role.data : { roleId }} valid={Boolean(rolePersonId.trim()) && role.success} message="人员和角色不能为空" {...commandProps} />
        </section> : null}
        {active.id === "policies" ? <section aria-label="发布策略操作">
          <label>策略发布 ID<input value={policyReleaseId} onChange={(event) => setPolicyReleaseId(event.currentTarget.value)} /></label>
          <label>策略版本<input type="number" min={0} value={policyVersion} onChange={(event) => setPolicyVersion(event.currentTarget.value)} /></label>
          <label><input type="checkbox" checked={policyApproved} onChange={(event) => setPolicyApproved(event.currentTarget.checked)} />已批准发布</label>
          <GuardedCommand operation="release" targetId={policyReleaseId.trim() || undefined} payload={policy.success ? policy.data : { expectedVersion: policyVersion, approved: policyApproved }} valid={Boolean(policyReleaseId.trim()) && policy.success} message="策略发布目标、有效版本和批准确认不能为空" {...commandProps} />
        </section> : null}
        {active.id === "providers" ? <section aria-label="测试智能服务操作">
          <label>服务配置 ID<input value={providerId} onChange={(event) => setProviderId(event.currentTarget.value)} /></label>
          <label>服务地址<input type="url" value={providerUrl} onChange={(event) => setProviderUrl(event.currentTarget.value)} /></label>
          <label>服务模型<input value={providerModel} onChange={(event) => setProviderModel(event.currentTarget.value)} /></label>
          <label>服务密钥<input type="password" autoComplete="new-password" value={providerSecret} onChange={(event) => setProviderSecret(event.currentTarget.value)} /></label>
          <GuardedCommand operation="test" targetId={providerId.trim() || undefined} payload={provider.success ? provider.data : { endpoint: providerUrl, model: providerModel, secret: providerSecret }} valid={Boolean(providerId.trim()) && provider.success} message="服务配置、HTTPS 地址、模型和密钥不能为空" onAccepted={() => setProviderSecret("")} {...commandProps} />
        </section> : null}
        {active.id === "knowledge" ? <section aria-label="导入知识操作">
          <label>上传引用<input value={uploadRef} onChange={(event) => setUploadRef(event.currentTarget.value)} /></label>
          <label>知识目标<input value={knowledgeTarget} onChange={(event) => setKnowledgeTarget(event.currentTarget.value)} /></label>
          <GuardedCommand operation="ingest" targetId={knowledgeTarget.trim() || undefined} payload={knowledge.success ? knowledge.data : { uploadRef, target: knowledgeTarget }} valid={knowledge.success} message="上传引用和知识目标不能为空" {...commandProps} />
        </section> : null}
        {active.id === "retention" ? <section aria-label="保留设置">
          <label>保留天数<input type="number" min={1} value="365" disabled /></label>
          <label><input type="checkbox" disabled />法律保留</label>
          <p>保留策略 API 合同尚未定义，当前仅可查看。</p>
        </section> : null}
        {active.id === "audit" ? <section aria-label="检查审计操作">
          <label>审计目标<input value={auditTarget} onChange={(event) => setAuditTarget(event.currentTarget.value)} /></label>
          <GuardedCommand operation="inspect" targetId={auditTarget.trim() || undefined} payload={audit.success ? audit.data : { target: auditTarget }} valid={audit.success} message="审计目标不能为空" {...commandProps} />
        </section> : null}
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
