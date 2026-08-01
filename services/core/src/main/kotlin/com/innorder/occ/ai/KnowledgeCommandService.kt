package com.innorder.occ.ai

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

private abstract class KnowledgeCommand(protected val documentId: UUID, protected val mapper: ObjectMapper) : AuthorizedCommand {
    override val entityId = documentId
    override val resourceId = documentId
    override val aggregateType = "knowledge-document"
    override val aggregateId = documentId
    override val expectedVersionRequired = true
    override val changesAuthorizationFacts = false
    protected var rowVersion = -1L
    protected var currentVersion = -1

    override fun lockCurrentVersion(context: CommandContext): Long {
        val document = context.jdbc.queryForMap(
            "SELECT current_version, row_version, state FROM ai.knowledge_document WHERE id = ? FOR UPDATE",
            documentId,
        )
        rowVersion = (document["row_version"] as Number).toLong()
        currentVersion = (document["current_version"] as? Number)?.toInt() ?: throw KnowledgeGateException()
        if (document["state"] !in setOf("READY", "FAILED")) throw KnowledgeGateException()
        return rowVersion
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

    protected fun mutation(
        eventType: String,
        body: CanonicalJsonObject,
        detail: CanonicalJsonObject,
        payload: CanonicalJsonObject,
    ) = CommandMutation(
        status = 200, body = body, resourceId = documentId, aggregateId = documentId,
        aggregateType = aggregateType, beforeVersion = rowVersion, afterVersion = rowVersion + 1,
        auditReason = eventType, auditDetail = detail,
        events = listOf(PendingEventSpec(eventType, 1, payload, rowVersion + 1)),
    )
}

private data class Space(val id: UUID, val status: String, val corpusVersion: String)

private class ActivationCommand(
    private val request: KnowledgeActivationRequest,
    mapper: ObjectMapper,
) : KnowledgeCommand(request.documentId, mapper) {
    override val action = "knowledge.activate"
    private lateinit var candidate: Space
    private lateinit var active: Space
    private lateinit var candidateVersionId: UUID
    private lateinit var candidateHash: String

    override fun lockCurrentVersion(context: CommandContext): Long {
        val version = super.lockCurrentVersion(context)
        val spaces = lockSpaces(context, request.candidateSpaceId, request.expectedActiveSpaceId)
        candidate = spaces[request.candidateSpaceId] ?: throw KnowledgeGateException()
        active = spaces[request.expectedActiveSpaceId] ?: throw KnowledgeGateException()
        val documentVersion = context.jdbc.queryForMap(
            "SELECT id, content_hash FROM ai.knowledge_document_version WHERE document_id = ? AND version = ? FOR SHARE",
            documentId, request.candidateVersion,
        )
        candidateVersionId = documentVersion["id"] as UUID
        candidateHash = documentVersion["content_hash"] as String
        return version
    }

    override fun execute(context: CommandContext): CommandMutation {
        val gate = context.jdbc.queryForMap(
            """SELECT decision, dataset_version_id, dataset_content_hash, corpus_manifest_digest,
                      document_manifest, candidate_embedding_space_id, expected_active_space_id
               FROM ai.embedding_space_gate_result WHERE id = ? FOR SHARE""",
            request.gateEvaluationId,
        )
        if (gate["decision"] != "PASS" || gate["candidate_embedding_space_id"] != request.candidateSpaceId ||
            gate["expected_active_space_id"] != request.expectedActiveSpaceId || candidate.status != "BUILDING" ||
            active.status != "ACTIVE" || candidate.corpusVersion != gate["corpus_manifest_digest"] ||
            currentVersion == request.candidateVersion || !manifestContains(gate["document_manifest"] as String, candidateVersionId, candidateHash)
        ) throw KnowledgeGateException()

        context.jdbc.update("UPDATE ai.embedding_space SET status = 'RETIRED' WHERE id = ? AND status = 'ACTIVE'", request.expectedActiveSpaceId)
            .takeIf { it == 1 } ?: throw KnowledgeGateException()
        context.jdbc.update("UPDATE ai.embedding_space SET status = 'ACTIVE', activated_at = statement_timestamp() WHERE id = ? AND status = 'BUILDING'", request.candidateSpaceId)
            .takeIf { it == 1 } ?: throw KnowledgeGateException()
        context.jdbc.update("UPDATE ai.knowledge_document SET current_version = ?, state = 'READY' WHERE id = ? AND row_version = ?", request.candidateVersion, documentId, rowVersion)
            .takeIf { it == 1 } ?: throw KnowledgeGateException()

        val payload = json {
            put("documentId", documentId.toString()); put("previousVersion", currentVersion); put("candidateVersion", request.candidateVersion)
            put("previousSpaceId", request.expectedActiveSpaceId.toString()); put("candidateSpaceId", request.candidateSpaceId.toString())
            put("gateEvaluationId", request.gateEvaluationId.toString()); put("corpusManifestDigest", gate["corpus_manifest_digest"] as String)
            put("datasetVersionId", (gate["dataset_version_id"] as UUID).toString()); put("datasetContentHash", gate["dataset_content_hash"] as String)
        }
        return mutation(
            "knowledge-document.activated",
            json { put("documentId", documentId.toString()); put("currentVersion", request.candidateVersion); put("embeddingSpaceId", request.candidateSpaceId.toString()) },
            json { put("gateEvaluationId", request.gateEvaluationId.toString()); put("corpusManifestDigest", gate["corpus_manifest_digest"] as String) },
            payload,
        )
    }

    private fun manifestContains(manifest: String, versionId: UUID, hash: String): Boolean =
        manifest.split(',').any { it == "$versionId:$hash" }
}

private class RollbackCommand(
    private val request: KnowledgeRollbackRequest,
    mapper: ObjectMapper,
) : KnowledgeCommand(request.documentId, mapper) {
    override val action = "knowledge.rollback"
    private lateinit var activation: ActivationTrace
    private lateinit var currentSpace: Space
    private lateinit var previousSpace: Space

    override fun lockCurrentVersion(context: CommandContext): Long {
        val version = super.lockCurrentVersion(context)
        val payload = context.jdbc.queryForObject(
            """SELECT payload::text FROM audit.outbox_event
               WHERE aggregate_id = ? AND event_type = 'knowledge-document.activated'
               ORDER BY aggregate_version DESC LIMIT 1 FOR SHARE""",
            String::class.java, documentId,
        ) ?: throw KnowledgeGateException()
        val node = try { mapper.readTree(payload) } catch (_: Exception) { throw KnowledgeGateException() }
        activation = try {
            ActivationTrace(
                node.path("previousVersion").intValue(), node.path("candidateVersion").intValue(),
                UUID.fromString(node.path("previousSpaceId").textValue()), UUID.fromString(node.path("candidateSpaceId").textValue()),
                UUID.fromString(node.path("gateEvaluationId").textValue()), node.path("corpusManifestDigest").textValue(),
            )
        } catch (_: Exception) { throw KnowledgeGateException() }
        val spaces = lockSpaces(context, activation.previousSpaceId, activation.candidateSpaceId)
        previousSpace = spaces[activation.previousSpaceId] ?: throw KnowledgeGateException()
        currentSpace = spaces[activation.candidateSpaceId] ?: throw KnowledgeGateException()
        context.jdbc.queryForObject(
            "SELECT count(*) FROM ai.knowledge_document_version WHERE document_id = ? AND version = ?",
            Long::class.java, documentId, activation.previousVersion,
        ).takeIf { it == 1L } ?: throw KnowledgeGateException()
        return version
    }

    override fun execute(context: CommandContext): CommandMutation {
        val gate = context.jdbc.queryForMap(
            "SELECT decision, corpus_manifest_digest, candidate_embedding_space_id, expected_active_space_id FROM ai.embedding_space_gate_result WHERE id = ? FOR SHARE",
            request.gateEvaluationId,
        )
        if (activation.gateId != request.gateEvaluationId || gate["decision"] != "PASS" ||
            gate["corpus_manifest_digest"] != activation.corpusManifestDigest ||
            gate["candidate_embedding_space_id"] != activation.candidateSpaceId || gate["expected_active_space_id"] != activation.previousSpaceId ||
            currentVersion != activation.candidateVersion || currentSpace.status != "ACTIVE" || previousSpace.status != "RETIRED"
        ) throw KnowledgeGateException()
        context.jdbc.update("UPDATE ai.embedding_space SET status = 'RETIRED' WHERE id = ? AND status = 'ACTIVE'", activation.candidateSpaceId)
            .takeIf { it == 1 } ?: throw KnowledgeGateException()
        context.jdbc.update("UPDATE ai.embedding_space SET status = 'ACTIVE' WHERE id = ? AND status = 'RETIRED'", activation.previousSpaceId)
            .takeIf { it == 1 } ?: throw KnowledgeGateException()
        context.jdbc.update("UPDATE ai.knowledge_document SET current_version = ?, state = 'READY' WHERE id = ? AND row_version = ?", activation.previousVersion, documentId, rowVersion)
            .takeIf { it == 1 } ?: throw KnowledgeGateException()
        return mutation(
            "knowledge-document.rolled-back",
            json { put("documentId", documentId.toString()); put("currentVersion", activation.previousVersion); put("embeddingSpaceId", activation.previousSpaceId.toString()) },
            json { put("gateEvaluationId", request.gateEvaluationId.toString()); put("restoredVersion", activation.previousVersion) },
            json {
                put("documentId", documentId.toString()); put("restoredVersion", activation.previousVersion); put("replacedVersion", activation.candidateVersion)
                put("restoredSpaceId", activation.previousSpaceId.toString()); put("retiredSpaceId", activation.candidateSpaceId.toString()); put("gateEvaluationId", request.gateEvaluationId.toString())
            },
        )
    }
}

private data class ActivationTrace(
    val previousVersion: Int, val candidateVersion: Int, val previousSpaceId: UUID,
    val candidateSpaceId: UUID, val gateId: UUID, val corpusManifestDigest: String,
)

class KnowledgeGateException : RuntimeException("Knowledge activation gate is stale or invalid")
