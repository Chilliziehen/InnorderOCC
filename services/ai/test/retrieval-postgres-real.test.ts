import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import pg from "pg";
import { describe, expect, it } from "vitest";
import { GUIDANCE_OUTPUT_JSON_SCHEMA } from "@innorder/contracts";

import { buildGuidancePrompt, PARTICIPANT_GUIDANCE_SYSTEM_TEMPLATE } from "../src/guidance/prompt-builder.js";
import { createPostgresPool, PostgresAiRepository } from "../src/persistence/postgres.js";
import { HybridRetriever } from "../src/retrieval/hybrid-retriever.js";
import { PostgresRetrievalRepository } from "../src/retrieval/postgres-retrieval-repository.js";

const docker = process.env.DOCKER_PATH ?? (process.platform === "win32" ? "docker.exe" : "docker");
const image = process.env.PGVECTOR_TEST_IMAGE ?? "pgvector/pgvector:pg16";
const migrations = ["V001__bootstrap.sql", "V002__catalog.sql", "V003__identity_and_entities.sql", "V004__policy_control_plane.sql",
  "V005__occ_runtime.sql", "V006__audit_and_outbox.sql", "V007__ai_rag.sql", "V008__cross_schema_constraints.sql",
  "V009__runtime_privileges.sql", "V010__platform_security_kernel.sql", "V011__account_failed_attempt_window.sql",
  "V012__outbox_publisher_lifecycle.sql", "V016__governed_ai_runtime.sql"];
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const dockerSync = (args: string[], input?: string) => spawnSync(docker, args, { encoding: "utf8", windowsHide: true, ...(input === undefined ? {} : { input }) });

describe("real authorization-first pgvector retrieval", () => {
  it("excludes the unauthorized lexical and semantic winner from hits, trace, and provider prompt", async () => {
    const container = `innorder-ai-retrieval-${randomUUID()}`;
    const adminPassword = `admin-${randomUUID()}`;
    const aiPassword = `ai-${randomUUID()}`;
    let admin: pg.Client | undefined;
    let pool: pg.Pool | undefined;
    try {
      expect(dockerSync(["info", "--format", "{{.ServerVersion}}"]).status, "Docker is required").toBe(0);
      const started = dockerSync(["run", "--detach", "--name", container, "--publish", "127.0.0.1::5432", "-e", `POSTGRES_PASSWORD=${adminPassword}`, "-e", "POSTGRES_DB=innorder_test", image]);
      expect(started.status, started.stderr).toBe(0);
      for (let attempt = 0; attempt < 60; attempt += 1) {
        if (dockerSync(["exec", "-e", `PGPASSWORD=${adminPassword}`, container, "psql", "--username", "postgres", "--dbname", "innorder_test", "--command", "SELECT 1"]).status === 0) break;
        await new Promise((resolveWait) => setTimeout(resolveWait, 500));
        if (attempt === 59) throw new Error("PostgreSQL container did not become ready");
      }
      expect(dockerSync(["exec", "-i", "-e", `PGPASSWORD=${adminPassword}`, container, "psql", "--username", "postgres", "--dbname", "innorder_test", "--set", "ON_ERROR_STOP=1"],
        `CREATE ROLE innorder_runtime NOLOGIN; CREATE ROLE innorder_ai_runtime LOGIN PASSWORD '${aiPassword}';`).status).toBe(0);
      for (const migration of migrations) {
        const applied = dockerSync(["exec", "-i", "-e", `PGPASSWORD=${adminPassword}`, container, "psql", "--username", "postgres", "--dbname", "innorder_test", "--set", "ON_ERROR_STOP=1"],
          readFileSync(join(resolve("../../database/migrations"), migration), "utf8"));
        expect(applied.status, `${migration}: ${applied.stderr}`).toBe(0);
      }
      const port = Number(dockerSync(["port", container, "5432/tcp"]).stdout.trim().split(":").at(-1));
      admin = new pg.Client({ host: "127.0.0.1", port, database: "innorder_test", user: "postgres", password: adminPassword });
      await admin.connect();
      const id = Object.fromEntries(["domain", "package", "principalType", "resourceType", "principalTypeVersion", "resourceTypeVersion", "principal", "target", "provider",
        "source", "authorizedDocumentEntity", "unauthorizedDocumentEntity", "release", "profile", "space", "promptTemplate", "prompt", "agentDefinition", "agent", "grant", "event", "run",
        "authorizedVersion", "unauthorizedVersion", "authorizedChunk", "unauthorizedChunk", "trace"].map((key) => [key, randomUUID()])) as Record<string, string>;
      await admin.query("INSERT INTO catalog.domain_package(id,package_key,name,status) VALUES($1,$2,'Retrieval','ACTIVE')", [id.domain, `retrieval.${id.domain}`]);
      await admin.query("INSERT INTO catalog.package_version(id,package_id,semver,status,manifest) VALUES($1,$2,'1.0.0','DRAFT','{}')", [id.package, id.domain]);
      await admin.query("INSERT INTO catalog.entity_type(id,package_id,type_key,name,entity_kind,authorizable) VALUES($1,$2,$3,'Principal','PRINCIPAL',true),($4,$2,$5,'Resource','RESOURCE',true)", [id.principalType, id.domain, `principal_${id.domain}`, id.resourceType, `resource_${id.domain}`]);
      await admin.query("INSERT INTO catalog.entity_type_version(id,entity_type_id,package_version_id,schema_version,json_schema,ui_schema,auth_schema,index_spec) VALUES($1,$2,$3,1,'{}','{}','{}','{}'),($4,$5,$3,1,'{}','{}','{}','{}')", [id.principalTypeVersion, id.principalType, id.package, id.resourceTypeVersion, id.resourceType]);
      for (const [entityId, key, type, version] of [[id.principal, "principal", id.principalType, id.principalTypeVersion], [id.target, "target", id.resourceType, id.resourceTypeVersion],
        [id.provider, "provider", id.resourceType, id.resourceTypeVersion], [id.source, "source", id.resourceType, id.resourceTypeVersion],
        [id.authorizedDocumentEntity, "authorized", id.resourceType, id.resourceTypeVersion], [id.unauthorizedDocumentEntity, "unauthorized", id.resourceType, id.resourceTypeVersion]]) {
        await admin.query("INSERT INTO authz.entity(id,entity_type_id,entity_type_version_id,entity_key,state,auth_attributes) VALUES($1,$2,$3,$4,'ACTIVE','{}')", [entityId, type, version, `${key}:${id.domain}`]);
      }
      await admin.query("INSERT INTO iam.principal(id,principal_kind,display_name,status,profile) VALUES($1,'SERVICE','Retrieval test','ACTIVE','{}')", [id.principal]);
      await admin.query("INSERT INTO authz.policy_release(id,release_number,status,content_hash) VALUES($1,1,'STAGED',$2)", [id.release, hash("policy")]);
      await admin.query("INSERT INTO ai.model_provider(id,provider_type,base_url,secret_ref,capabilities,data_policy,state) VALUES($1,'TEST','https://provider.test','secret','{}',$2,'ACTIVE')", [id.provider, { maxClassification: "INTERNAL" }]);
      await admin.query("INSERT INTO ai.model_profile(id,provider_id,model_key,purpose,parameters,capability_snapshot,timeout_ms,rate_limit,cost_rule,state) VALUES($1,$2,'model','EMBEDDING','{}',$3,1000,'{}','{}','ACTIVE')", [id.profile, id.provider, { embeddings: true, embeddingDimensions: 3, maxInputTokens: 65536, snapshotHash: hash("capability") }]);
      await admin.query("INSERT INTO ai.embedding_space(id,model_profile_id,dimensions,distance_metric,corpus_version,status,coverage,activated_at) VALUES($1,$2,3,'COSINE',$3,'ACTIVE',1,now())", [id.space, id.profile, hash("manifest")]);
      await admin.query("SELECT ai.create_embedding_partition($1,3,'COSINE')", [id.space]);
      await admin.query("INSERT INTO ai.prompt_template(id,prompt_key,name) VALUES($1,$2,'Guidance')", [id.promptTemplate, `prompt.${id.domain}`]);
      await admin.query("INSERT INTO ai.prompt_template_version(id,prompt_template_id,version,template,variable_schema,content_hash,status,created_by) VALUES($1,$2,1,'test','{}',$3,'DRAFT',$4)", [id.prompt, id.promptTemplate, hash("test"), id.principal]);
      await admin.query("INSERT INTO ai.agent_definition(id,agent_key,name) VALUES($1,$2,'Guidance')", [id.agentDefinition, `agent.${id.domain}`]);
      await admin.query("INSERT INTO ai.agent_definition_version(id,agent_definition_id,package_version_id,input_schema,output_schema,prompt_version_id,content_hash) VALUES($1,$2,$3,'{}','{}',$4,$5)", [id.agent, id.agentDefinition, id.package, id.prompt, hash("agent")]);
      await admin.query("INSERT INTO ai.knowledge_source(id,source_type,sync_config,state,sync_cursor) VALUES($1,'UPLOAD','{}','ACTIVE','{}')", [id.source]);
      await admin.query("INSERT INTO ai.knowledge_document(id,source_id,document_key,state) VALUES($1,$3,'authorized','READY'),($2,$3,'unauthorized','READY')", [id.authorizedDocumentEntity, id.unauthorizedDocumentEntity, id.source]);
      await admin.query("INSERT INTO ai.knowledge_document_version(id,document_id,version,object_key,content_hash,mime_type,parser_version,data_classification) VALUES($1,$2,1,$3,$4,'text/plain','test','INTERNAL'),($5,$6,1,$7,$8,'text/plain','test','PUBLIC')", [id.authorizedVersion, id.authorizedDocumentEntity, `authorized/${id.domain}`, hash("authorized-doc"), id.unauthorizedVersion, id.unauthorizedDocumentEntity, `unauthorized/${id.domain}`, hash("unauthorized-doc")]);
      await admin.query("UPDATE ai.knowledge_document SET current_version=1 WHERE id IN ($1,$2)", [id.authorizedDocumentEntity, id.unauthorizedDocumentEntity]);
      const authorizedContent = "approved procedure";
      const unauthorizedContent = "approved procedure approved procedure approved procedure secret";
      await admin.query("INSERT INTO ai.knowledge_chunk(id,document_version_id,ordinal,content,content_hash,token_count,metadata) VALUES($1,$2,0,$3,$4,2,'{}'),($5,$6,0,$7,$8,6,'{}')", [id.authorizedChunk, id.authorizedVersion, authorizedContent, hash(authorizedContent), id.unauthorizedChunk, id.unauthorizedVersion, unauthorizedContent, hash(unauthorizedContent)]);
      await admin.query("INSERT INTO ai.chunk_embedding(embedding_space_id,chunk_id,embedding) VALUES($1,$2,'[0.9,0.1,0]'),($1,$3,'[1,0,0]')", [id.space, id.authorizedChunk, id.unauthorizedChunk]);
      const revision = Number((await admin.query("SELECT current_revision FROM authz.authorization_state WHERE singleton")).rows[0]!.current_revision);
      await admin.query(`INSERT INTO authz.ai_authorization_grant(id,token_hash,signer_kid,operation,jti,principal_id,target_entity_id,purpose,authorization_revision,
        policy_release_id,policy_release_digest,authorized_set_digest,context_digest,bounded_context,classification_ceiling,agent_version_id,model_profile_id,prompt_version_id,
        package_version_id,embedding_space_id,issued_at,expires_at,event_id,intended_run_id) VALUES($1,$2,'test',$18::text,$3,$4,$5,'PARTICIPANT_GUIDANCE',$6,$7,$8,$9,$10,$11,'INTERNAL',$12,$13,$14,$15,$16,now(),now()+interval '5 minutes',$17,$18::uuid)`,
      [id.grant, hash("token"), `jti-${id.grant}`, id.principal, id.target, revision, id.release, hash("policy"), hash("authorized"), hash("context"), { query: "approved procedure", expectedTargetVersion: 1 }, id.agent, id.profile, id.prompt, id.package, id.space, id.event, id.run]);
      await admin.query("INSERT INTO authz.ai_authorized_document(grant_id,document_version_id) VALUES($1,$2)", [id.grant, id.authorizedVersion]);
      pool = createPostgresPool({ host: "127.0.0.1", port, database: "innorder_test", user: "innorder_ai_runtime", password: aiPassword, max: 2 });
      await new PostgresAiRepository(pool).consumeGrant({ tokenHash: hash("token"), claims: { iss: "innorder-core", aud: "innorder-ai", typ: "ai_authorization_grant", jti: id.grant,
        eventId: id.event, operationId: id.run, principalId: id.principal, targetId: id.target, purpose: "PARTICIPANT_GUIDANCE", authorizationRevision: revision,
        policyReleaseDigest: hash("policy"), authorizedSetDigest: hash("authorized"), contextDigest: hash("context"), classificationCeiling: "INTERNAL",
        agentVersionId: id.agent, modelProfileId: id.profile, promptVersionId: id.prompt, packageVersionId: id.package, embeddingSpaceId: id.space,
        iat: 1, nbf: 1, exp: 2 } });
      const retriever = new HybridRetriever({ provider: { embed: async () => ({ embeddings: [[1, 0, 0]] }) } as never,
        repository: new PostgresRetrievalRepository(pool), traceId: () => id.trace });
      const result = await retriever.retrieve({ runId: id.run, query: "approved procedure", authorizedSetDigest: hash("authorized"), authorizedDocumentCount: 1,
        classificationCeiling: "INTERNAL", providerMaxClassification: "INTERNAL", space: { id: id.space, dimensions: 3, manifestDigest: hash("manifest"), embeddingProfileId: id.profile } }, new AbortController().signal);
      expect(result.hits.map(({ chunkId }) => chunkId)).toEqual([id.authorizedChunk]);
      const persisted = await admin.query("SELECT hit.chunk_id, trace.authorized_document_count FROM ai.retrieval_hit hit JOIN ai.retrieval_trace trace ON trace.id=hit.trace_id WHERE trace.id=$1", [id.trace]);
      expect(persisted.rows).toEqual([{ chunk_id: id.authorizedChunk, authorized_document_count: 1 }]);
      const prompt = buildGuidancePrompt({ template: PARTICIPANT_GUIDANCE_SYSTEM_TEMPLATE, templateHash: hash(PARTICIPANT_GUIDANCE_SYSTEM_TEMPLATE),
        taskContext: { query: "approved procedure", expectedTargetVersion: 1 }, hits: result.hits, outputSchema: GUIDANCE_OUTPUT_JSON_SCHEMA, maxInputBytes: 65536 });
      expect(prompt.messages[1]!.content).toContain(authorizedContent);
      expect(prompt.messages[1]!.content).not.toContain(unauthorizedContent);
    } finally {
      await pool?.end().catch(() => undefined);
      await admin?.end().catch(() => undefined);
      dockerSync(["rm", "-f", container]);
    }
  }, 180_000);
});
