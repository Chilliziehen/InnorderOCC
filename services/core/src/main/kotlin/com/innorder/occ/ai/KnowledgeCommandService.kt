package com.innorder.occ.ai

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.node.ObjectNode
import com.innorder.occ.command.AuthorizedCommand
import com.innorder.occ.command.CanonicalJsonObject
import com.innorder.occ.command.CommandContext
import com.innorder.occ.command.CommandExecutor
import com.innorder.occ.command.CommandMetadata
import com.innorder.occ.command.CommandMutation
import com.innorder.occ.command.CommandResult
import com.innorder.occ.command.InvalidCommandRequestException
import com.innorder.occ.command.PendingEventSpec
import org.springframework.stereotype.Service
import java.util.UUID

data class KnowledgeActivationRequest(
    val documentId: UUID,
    val candidateVersion: Int,
    val candidateSpaceId: UUID,
    val gateEvaluationId: UUID,
    val expectedActiveSpaceId: UUID,
) {
    init {
        requireValid(documentId, candidateSpaceId, gateEvaluationId, expectedActiveSpaceId)
        if (candidateVersion < 1) throw InvalidCommandRequestException()
    }
}

data class KnowledgeRollbackRequest(val documentId: UUID, val gateEvaluationId: UUID) {
    init { requireValid(documentId, gateEvaluationId) }
}

private fun requireValid(vararg ids: UUID) {
    if (ids.any { it == UUID(0, 0) || it.version() !in 1..8 || it.variant() != 2 }) throw InvalidCommandRequestException()
}

@Service
class KnowledgeCommandService(private val executor: CommandExecutor) {
    private val mapper = ObjectMapper().findAndRegisterModules()

    fun activate(metadata: CommandMetadata, request: KnowledgeActivationRequest): CommandResult = executor.execute(
        metadata, mapper.writeValueAsBytes(request), ActivationCommand(request, mapper),
    )

    fun rollback(metadata: CommandMetadata, request: KnowledgeRollbackRequest): CommandResult = executor.execute(
        metadata, mapper.writeValueAsBytes(request), RollbackCommand(request, mapper),
    )
}

private data class Space(val id: UUID, val status: String, val corpusVersion: String)
private data class CorpusMember(
    val documentId: UUID,
    val previousVersion: Int,
    val previousVersionId: UUID,
    val previousHash: String,
    val candidateVersion: Int,
    val candidateVersionId: UUID,
    val candidateHash: String,
    var rowVersion: Long,
)

private abstract class KnowledgeCommand(protected val documentId: UUID, protected val mapper: ObjectMapper) : AuthorizedCommand {
    override val entityId = documentId
    override val resourceId = documentId
    override val aggregateType = "knowledge-document"
    override val aggregateId = documentId
    override val expectedVersionRequired = true
    override val changesAuthorizationFacts = false
    protected var rowVersion = -1L
    protected var currentVersion = -1

    protected fun setPrimary(members: List<CorpusMember>) {
        val primary = members.singleOrNull { it.documentId == documentId } ?: throw KnowledgeGateException()
        rowVersion = primary.rowVersion
        currentVersion = primary.previousVersion
    }

    protected fun json(block: ObjectNode.() -> Unit): CanonicalJsonObject =
        CanonicalJsonObject.from(mapper.createObjectNode().apply(block))

    protected fun lockSpaces(context: CommandContext, first: UUID, second: UUID): Map<UUID, Space> {
        val rows = context.jdbc.query(
            "SELECT id, status, corpus_version FROM ai.embedding_space WHERE id IN (?, ?) ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, id FOR UPDATE",
            { result, _ -> Space(result.getObject("id", UUID::class.java), result.getString("status"), result.getString("corpus_version")) },
            first, second, first,
        )
        if (rows.size != 2) throw KnowledgeGateException()
        return rows.associateBy { it.id }
    }

    protected fun lockMembers(context: CommandContext, candidateSpaceId: UUID, manifest: String): List<CorpusMember> {
        val ids = context.jdbc.queryForList(
            """SELECT DISTINCT document_id FROM ai.ingestion_job
               WHERE candidate_embedding_space_id = ? AND corpus_manifest_digest = ? AND status = 'COMPLETED'
               ORDER BY document_id""", UUID::class.java, candidateSpaceId, manifest,
        )
        if (ids.isEmpty()) throw KnowledgeGateException()
        ids.forEach { id ->
            context.jdbc.queryForObject(
                "SELECT id FROM ai.knowledge_document WHERE id = ? AND state IN ('READY','FAILED') FOR UPDATE",
                UUID::class.java, id,
            ) ?: throw KnowledgeGateException()
        }
        val members = context.jdbc.query(
            """SELECT document.id AS document_id, document.current_version, document.row_version,
                      previous.id AS previous_version_id, previous.content_hash AS previous_hash,
                      candidate.version AS candidate_version, candidate.id AS candidate_version_id,
                      candidate.content_hash AS candidate_hash
               FROM ai.ingestion_job job
               JOIN ai.knowledge_document document ON document.id = job.document_id
               JOIN ai.knowledge_document_version candidate ON candidate.id = job.produced_document_version_id
               JOIN ai.knowledge_document_version previous
                 ON previous.document_id = document.id AND previous.version = document.current_version
               WHERE job.candidate_embedding_space_id = ? AND job.corpus_manifest_digest = ? AND job.status = 'COMPLETED'
               ORDER BY document.id""",
            { result, _ -> CorpusMember(
                result.getObject("document_id", UUID::class.java), result.getInt("current_version"),
                result.getObject("previous_version_id", UUID::class.java), result.getString("previous_hash"),
                result.getInt("candidate_version"), result.getObject("candidate_version_id", UUID::class.java),
                result.getString("candidate_hash"), result.getLong("row_version"),
            ) }, candidateSpaceId, manifest,
        )
        if (members.size != ids.size || members.map { it.documentId }.distinct().size != members.size) throw KnowledgeGateException()
        return members
    }

    protected fun canonicalManifest(context: CommandContext, members: List<CorpusMember>, candidate: Boolean): String =
        members.sortedBy { it.documentId }.joinToString(",") { member ->
            val versionId = if (candidate) member.candidateVersionId else member.previousVersionId
            val version = if (candidate) member.candidateVersion else member.previousVersion
            val contentHash = if (candidate) member.candidateHash else member.previousHash
            val chunks = context.jdbc.query(
                "SELECT id, ordinal, content_hash FROM ai.knowledge_chunk WHERE document_version_id = ? ORDER BY ordinal, id FOR SHARE",
                { result, _ -> "${result.getObject("id", UUID::class.java)}:${result.getInt("ordinal")}:${result.getString("content_hash")}" }, versionId,
            )
            "${member.documentId}:${member.previousVersion}>$versionId:$version:$contentHash[${chunks.joinToString(";")}]"
        }

    protected fun updateHeads(context: CommandContext, members: List<CorpusMember>, rollback: Boolean) {
        members.forEach { member ->
            val expected = if (rollback) member.candidateVersion else member.previousVersion
            val target = if (rollback) member.previousVersion else member.candidateVersion
            context.jdbc.update(
                "UPDATE ai.knowledge_document SET current_version = ?, state = 'READY' WHERE id = ? AND current_version = ? AND row_version = ?",
                target, member.documentId, expected, member.rowVersion,
            ).takeIf { it == 1 } ?: throw KnowledgeGateException()
        }
    }

    protected fun mutation(eventType: String, body: CanonicalJsonObject, detail: CanonicalJsonObject, payload: CanonicalJsonObject) = CommandMutation(
        status = 200, body = body, resourceId = documentId, aggregateId = documentId,
        aggregateType = aggregateType, beforeVersion = rowVersion, afterVersion = rowVersion + 1,
        auditReason = eventType, auditDetail = detail,
        events = listOf(PendingEventSpec(eventType, 1, payload, rowVersion + 1)),
    )
}

private class ActivationCommand(private val request: KnowledgeActivationRequest, mapper: ObjectMapper) : KnowledgeCommand(request.documentId, mapper) {
    override val action = "knowledge.activate"
    private lateinit var candidate: Space
    private lateinit var active: Space
    private lateinit var gate: Map<String, Any>
    private lateinit var members: List<CorpusMember>
    private lateinit var candidateManifest: String
    private lateinit var previousManifest: String

    override fun lockCurrentVersion(context: CommandContext): Long {
        val spaces = lockSpaces(context, request.candidateSpaceId, request.expectedActiveSpaceId)
        candidate = spaces[request.candidateSpaceId] ?: throw KnowledgeGateException()
        active = spaces[request.expectedActiveSpaceId] ?: throw KnowledgeGateException()
        gate = context.jdbc.queryForMap(
            """SELECT decision, dataset_version_id, dataset_content_hash, corpus_manifest_digest,
                      document_manifest, evidence_hash, candidate_embedding_space_id, expected_active_space_id
               FROM ai.embedding_space_gate_result WHERE id = ? FOR SHARE""", request.gateEvaluationId,
        )
        if (gate["decision"] != "PASS" || gate["candidate_embedding_space_id"] != request.candidateSpaceId ||
            gate["expected_active_space_id"] != request.expectedActiveSpaceId || candidate.status != "BUILDING" ||
            active.status != "ACTIVE" || candidate.corpusVersion != gate["corpus_manifest_digest"]
        ) throw KnowledgeGateException()
        members = lockMembers(context, request.candidateSpaceId, gate["corpus_manifest_digest"] as String)
        setPrimary(members)
        val primary = members.single { it.documentId == documentId }
        if (primary.candidateVersion != request.candidateVersion || primary.previousVersion == request.candidateVersion) throw KnowledgeGateException()
        candidateManifest = canonicalManifest(context, members, true)
        previousManifest = canonicalManifest(context, members, false)
        if (candidateManifest != gate["document_manifest"]) throw KnowledgeGateException()
        return rowVersion
    }

    override fun execute(context: CommandContext): CommandMutation {
        context.jdbc.update("UPDATE ai.embedding_space SET status = 'RETIRED' WHERE id = ? AND status = 'ACTIVE'", request.expectedActiveSpaceId)
            .takeIf { it == 1 } ?: throw KnowledgeGateException()
        context.jdbc.update("UPDATE ai.embedding_space SET status = 'ACTIVE', activated_at = statement_timestamp() WHERE id = ? AND status = 'BUILDING'", request.candidateSpaceId)
            .takeIf { it == 1 } ?: throw KnowledgeGateException()
        updateHeads(context, members, false)
        val payload = json {
            put("documentId", documentId.toString()); put("previousSpaceId", request.expectedActiveSpaceId.toString())
            put("candidateSpaceId", request.candidateSpaceId.toString()); put("gateEvaluationId", request.gateEvaluationId.toString())
            put("corpusManifestDigest", gate["corpus_manifest_digest"] as String); put("candidateManifest", candidateManifest); put("previousManifest", previousManifest)
            put("datasetVersionId", (gate["dataset_version_id"] as UUID).toString()); put("datasetContentHash", gate["dataset_content_hash"] as String); put("evidenceHash", gate["evidence_hash"] as String)
            set<JsonNode>("members", mapper.valueToTree(members))
        }
        return mutation(
            "knowledge-document.activated",
            json { put("documentId", documentId.toString()); put("currentVersion", request.candidateVersion); put("embeddingSpaceId", request.candidateSpaceId.toString()); put("documentCount", members.size) },
            json { put("gateEvaluationId", request.gateEvaluationId.toString()); put("corpusManifestDigest", gate["corpus_manifest_digest"] as String); put("documentManifest", candidateManifest) },
            payload,
        )
    }
}

private class RollbackCommand(private val request: KnowledgeRollbackRequest, mapper: ObjectMapper) : KnowledgeCommand(request.documentId, mapper) {
    override val action = "knowledge.rollback"
    private lateinit var trace: ActivationTrace
    private lateinit var currentSpace: Space
    private lateinit var previousSpace: Space

    override fun lockCurrentVersion(context: CommandContext): Long {
        val payload = context.jdbc.queryForObject(
            """SELECT payload::text FROM audit.outbox_event WHERE aggregate_id = ?
               AND event_type = 'knowledge-document.activated' ORDER BY aggregate_version DESC LIMIT 1 FOR SHARE""",
            String::class.java, documentId,
        ) ?: throw KnowledgeGateException()
        trace = parseTrace(payload)
        if (trace.gateEvaluationId != request.gateEvaluationId || trace.documentId != documentId || trace.members.isEmpty()) throw KnowledgeGateException()
        val spaces = lockSpaces(context, trace.candidateSpaceId, trace.previousSpaceId)
        currentSpace = spaces[trace.candidateSpaceId] ?: throw KnowledgeGateException()
        previousSpace = spaces[trace.previousSpaceId] ?: throw KnowledgeGateException()
        trace.members.sortedBy { it.documentId }.forEach { member ->
            val row = context.jdbc.queryForMap("SELECT current_version, row_version, state FROM ai.knowledge_document WHERE id = ? FOR UPDATE", member.documentId)
            if ((row["current_version"] as Number).toInt() != member.candidateVersion || row["state"] != "READY") throw KnowledgeGateException()
            member.rowVersion = (row["row_version"] as Number).toLong()
        }
        setPrimary(trace.members)
        val candidate = canonicalManifest(context, trace.members, true)
        val previous = canonicalManifest(context, trace.members, false)
        if (candidate != trace.candidateManifest || previous != trace.previousManifest || currentSpace.status != "ACTIVE" || previousSpace.status != "RETIRED") throw KnowledgeGateException()
        return rowVersion
    }

    private fun parseTrace(payload: String): ActivationTrace = try {
        val node = mapper.readTree(payload)
        fun uuid(name: String) = UUID.fromString(node.path(name).textValue())
        val members = node.path("members").map { member ->
            CorpusMember(
                UUID.fromString(member.path("documentId").textValue()), member.path("previousVersion").intValue(),
                UUID.fromString(member.path("previousVersionId").textValue()), member.path("previousHash").textValue(),
                member.path("candidateVersion").intValue(), UUID.fromString(member.path("candidateVersionId").textValue()),
                member.path("candidateHash").textValue(), member.path("rowVersion").longValue(),
            )
        }
        ActivationTrace(
            uuid("documentId"), uuid("previousSpaceId"), uuid("candidateSpaceId"), uuid("gateEvaluationId"),
            node.path("corpusManifestDigest").textValue(), node.path("candidateManifest").textValue(),
            node.path("previousManifest").textValue(), members,
        )
    } catch (_: Exception) { throw KnowledgeGateException() }

    override fun execute(context: CommandContext): CommandMutation {
        context.jdbc.update("UPDATE ai.embedding_space SET status = 'RETIRED' WHERE id = ? AND status = 'ACTIVE'", trace.candidateSpaceId)
            .takeIf { it == 1 } ?: throw KnowledgeGateException()
        context.jdbc.update("UPDATE ai.embedding_space SET status = 'ACTIVE' WHERE id = ? AND status = 'RETIRED'", trace.previousSpaceId)
            .takeIf { it == 1 } ?: throw KnowledgeGateException()
        updateHeads(context, trace.members, true)
        val primary = trace.members.single { it.documentId == documentId }
        return mutation(
            "knowledge-document.rolled-back",
            json { put("documentId", documentId.toString()); put("currentVersion", primary.previousVersion); put("embeddingSpaceId", trace.previousSpaceId.toString()); put("documentCount", trace.members.size) },
            json { put("gateEvaluationId", request.gateEvaluationId.toString()); put("restoredManifest", trace.previousManifest) },
            json { put("documentId", documentId.toString()); put("restoredSpaceId", trace.previousSpaceId.toString()); put("retiredSpaceId", trace.candidateSpaceId.toString()); put("gateEvaluationId", request.gateEvaluationId.toString()); set<JsonNode>("members", mapper.valueToTree(trace.members)) },
        )
    }
}

private data class ActivationTrace(
    val documentId: UUID = UUID(0, 0),
    val previousSpaceId: UUID = UUID(0, 0),
    val candidateSpaceId: UUID = UUID(0, 0),
    val gateEvaluationId: UUID = UUID(0, 0),
    val corpusManifestDigest: String = "",
    val candidateManifest: String = "",
    val previousManifest: String = "",
    val members: List<CorpusMember> = emptyList(),
)

class KnowledgeGateException : RuntimeException("Knowledge activation gate is stale or invalid")
