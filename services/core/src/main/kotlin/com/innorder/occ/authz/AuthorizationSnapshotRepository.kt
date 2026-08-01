package com.innorder.occ.authz

import com.fasterxml.jackson.core.JsonFactory
import com.fasterxml.jackson.core.JsonParser
import com.fasterxml.jackson.core.json.JsonWriteFeature
import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.MapperFeature
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.SerializationFeature
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.stereotype.Repository
import org.springframework.transaction.support.TransactionSynchronizationManager
import java.security.MessageDigest
import java.time.OffsetDateTime
import java.util.Collections
import java.util.UUID

@Repository
class AuthorizationSnapshotRepository(
    private val jdbc: JdbcTemplate,
    objectMapper: ObjectMapper,
) : AuthorizationSnapshotSource {
    private val mapper = objectMapper.copy().apply {
        setConfig(serializationConfig.with(MapperFeature.SORT_PROPERTIES_ALPHABETICALLY))
    }
        .enable(JsonParser.Feature.STRICT_DUPLICATE_DETECTION)
        .enable(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS)
    private val contextLengthMapper = ObjectMapper(
        JsonFactory.builder().disable(JsonWriteFeature.ESCAPE_NON_ASCII).build(),
    ).apply {
        setConfig(serializationConfig.with(MapperFeature.SORT_PROPERTIES_ALPHABETICALLY))
        enable(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS)
    }

    override fun load(request: AuthorizationRequest): AuthorizationSnapshot {
        if (!TransactionSynchronizationManager.isActualTransactionActive()) throw AuthorizationSnapshotException()
        val revision = jdbc.queryForObject(
            "SELECT authz.lock_authorization_state_for_snapshot()",
            Long::class.java,
        ) ?: throw AuthorizationSnapshotException()
        if (revision !in 0..AuthorizationDecisionValidator.MAX_SAFE_INTEGER) throw AuthorizationSnapshotException()
        val snapshotAt = jdbc.queryForObject("SELECT transaction_timestamp()", OffsetDateTime::class.java)
            ?: throw AuthorizationSnapshotException()
        validateRequest(request)

        val states = loadEntityStates(setOf(request.principalId, request.entityId, request.resourceId))
        val principalState = states[request.principalId] ?: throw AuthorizationSnapshotException()
        if (!principalState.isPrincipal) throw AuthorizationSnapshotException()
        val entityState = states[request.entityId] ?: throw AuthorizationSnapshotException()
        val resourceState = states[request.resourceId] ?: throw AuthorizationSnapshotException()

        val layers = loadReleaseLayers()
        val templates = layers.flatMap { parseManifest(it) }
        if (templates.size > MAX_GRANTS || templates.map { it.id }.toSet().size != templates.size) {
            throw AuthorizationSnapshotException()
        }
        val roleIdsByKey = loadRoles(templates.map { it.subjectRoleEntityKey }.toSet())
        val assignedRoleIds = loadAssignedRoles(request.principalId, snapshotAt)
        val grants = templates.filter { roleIdsByKey.getValue(it.subjectRoleEntityKey) in assignedRoleIds }
            .map { template ->
                AuthorizationGrant(
                    template.id,
                    template.layer,
                    template.releaseId,
                    template.effect,
                    template.action,
                    request.principalId.toString(),
                    template.entityId,
                    template.resourceId,
                )
            }.let(Collections::unmodifiableList)
        val contextBytes = canonicalBytes(request.context)
        val canonicalContext = try {
            contextLengthMapper.writeValueAsString(request.context)
        } catch (_: Exception) {
            throw AuthorizationSnapshotException()
        }
        if (canonicalContext.codePointCount(0, canonicalContext.length) > MAX_CONTEXT_CODE_POINTS) {
            throw AuthorizationSnapshotException()
        }
        val forbiddenActions = layers.flatMap { it.forbiddenActions }.distinct().sorted()
        if (forbiddenActions.size > MAX_FORBIDDEN_ACTIONS) throw AuthorizationSnapshotException()

        return AuthorizationSnapshot(
            contractVersion = 1,
            requestId = request.requestId,
            authorizationRevision = revision,
            releases = Collections.unmodifiableMap(layers.associate { it.layer to it.bundleVersionId }),
            principal = AuthorizationPrincipal(
                request.principalId,
                principalState.entityActive && principalState.principalActive,
            ),
            entity = AuthorizationEntity(request.entityId),
            action = request.action,
            resource = AuthorizationResource(request.resourceId, resourceState.entityActive),
            context = immutableContext(request.context),
            forbiddenActions = Collections.unmodifiableList(forbiddenActions),
            grants = grants,
            composedReleaseId = layers.first().composedReleaseId,
            opaRevision = layers.first().opaRevision,
            entityVersions = Collections.unmodifiableMap(mapOf(
                request.principalId to principalState.entityVersion,
                request.entityId to entityState.entityVersion,
                request.resourceId to resourceState.entityVersion,
            )),
            contextDigest = sha256(contextBytes),
            snapshotAt = snapshotAt,
            principalRowVersion = principalState.principalVersion,
        )
    }

    private fun loadEntityStates(ids: Set<UUID>): Map<UUID, EntityState> {
        val placeholders = ids.joinToString(",") { "?" }
        val rows = jdbc.query(
            """SELECT e.id, e.state, e.row_version AS entity_version,
                      p.id IS NOT NULL AS is_principal, p.status, coalesce(p.row_version, 0) AS principal_version
               FROM authz.entity e LEFT JOIN iam.principal p ON p.id = e.id
               WHERE e.id IN ($placeholders)""",
            { rs, _ ->
                EntityState(
                    rs.getObject("id", UUID::class.java),
                    rs.getString("state") == "ACTIVE",
                    rs.getLong("entity_version"),
                    rs.getBoolean("is_principal"),
                    rs.getString("status") == "ACTIVE",
                    rs.getLong("principal_version"),
                )
            },
            *ids.toTypedArray(),
        )
        if (rows.size != ids.size) throw AuthorizationSnapshotException()
        return rows.associateBy { it.id }
    }

    private fun loadReleaseLayers(): List<ReleaseLayer> {
        val rows = jdbc.query(
            """SELECT pr.id AS release_id, pr.content_hash AS release_content_hash, pr.opa_revision,
                      pb.id AS bundle_id, pb.layer, pb.status AS bundle_status,
                      pbv.id AS bundle_version_id, pbv.status AS version_status,
                      pbv.manifest::text AS manifest, pbv.content_hash
               FROM authz.policy_release pr
               JOIN authz.policy_release_item pri ON pri.release_id = pr.id
               JOIN authz.policy_bundle pb ON pb.id = pri.bundle_id
               JOIN authz.policy_bundle_version pbv ON pbv.id = pri.bundle_version_id AND pbv.bundle_id = pb.id
               WHERE pr.status = 'ACTIVE'
               ORDER BY pb.layer""",
            { rs, _ ->
                RawReleaseLayer(
                    rs.getObject("release_id", UUID::class.java),
                    rs.getString("release_content_hash"),
                    rs.getString("opa_revision"),
                    rs.getObject("bundle_id", UUID::class.java),
                    rs.getString("layer"),
                    rs.getString("bundle_status"),
                    rs.getObject("bundle_version_id", UUID::class.java),
                    rs.getString("version_status"),
                    rs.getString("manifest"),
                    rs.getString("content_hash"),
                )
            },
        )
        if (rows.isEmpty() || rows.size > PolicyLayer.entries.size || rows.map { it.releaseId }.toSet().size != 1 ||
            rows.any {
                it.opaRevision.isNullOrBlank() || it.opaRevision.length > AuthorizationDecisionValidator.OPA_REVISION_MAX_LENGTH ||
                    !OPA_REVISION.matches(it.opaRevision) || it.bundleStatus !in PINNED_BUNDLE_STATUSES ||
                    it.versionStatus != "PUBLISHED"
            }
        ) throw AuthorizationSnapshotException()
        val layers = rows.map { raw ->
            val layer = try { PolicyLayer.valueOf(raw.layer) } catch (_: Exception) { throw AuthorizationSnapshotException() }
            val manifestBytes = raw.manifest.toByteArray(Charsets.UTF_8)
            if (manifestBytes.size > MAX_MANIFEST_BYTES) throw AuthorizationSnapshotException()
            val root = try { mapper.readTree(raw.manifest) } catch (_: Exception) { throw AuthorizationSnapshotException() }
            if (sha256(canonicalBytes(root)) != raw.contentHash) throw AuthorizationSnapshotException()
            ReleaseLayer(
                raw.releaseId,
                raw.opaRevision!!,
                layer,
                raw.bundleId,
                raw.bundleVersionId,
                raw.contentHash,
                root,
            )
        }
        if (layers.map { it.layer }.toSet().size != layers.size || layers.none { it.layer == PolicyLayer.PLATFORM }) {
            throw AuthorizationSnapshotException()
        }
        val expectedReleaseHash = PolicyReleaseIntegrity.contentHash(
            layers.first().opaRevision,
            layers.map { PolicyReleaseItemIntegrity(it.layer, it.bundleId, it.bundleVersionId, it.bundleContentHash) },
        )
        if (rows.any { it.releaseContentHash != expectedReleaseHash }) throw AuthorizationSnapshotException()
        return layers
    }

    private fun parseManifest(layer: ReleaseLayer): List<RoleGrantTemplate> {
        val root = layer.manifest
        requireObjectKeys(root, setOf("version", "roleGrants", "forbiddenActions"))
        if (!root.path("version").isIntegralNumber || root.path("version").intValue() != 1) throw AuthorizationSnapshotException()
        val forbidden = parseActions(root.path("forbiddenActions"), MAX_FORBIDDEN_ACTIONS)
        val grantsNode = root.path("roleGrants")
        if (!grantsNode.isArray || grantsNode.size() > MAX_GRANTS) throw AuthorizationSnapshotException()
        val grants = grantsNode.map { node ->
            requireObjectKeys(node, setOf("id", "effect", "action", "entityId", "resourceId", "subjectRoleEntityKey"))
            val id = boundedText(node.path("id"), 1, 256)
            val effect = try { GrantEffect.valueOf(boundedText(node.path("effect"), 1, 5)) }
            catch (_: Exception) { throw AuthorizationSnapshotException() }
            val action = boundedText(node.path("action"), 1, MAX_ACTION_LENGTH)
            if (!validActionPattern(action)) throw AuthorizationSnapshotException()
            val entityId = boundedText(node.path("entityId"), 1, 36)
            val resourceId = boundedText(node.path("resourceId"), 1, 36)
            if (!validUuidPattern(entityId) || !validUuidPattern(resourceId)) throw AuthorizationSnapshotException()
            val roleKey = boundedText(node.path("subjectRoleEntityKey"), 1, 256)
            RoleGrantTemplate(id, layer.layer, layer.bundleVersionId, effect, action, entityId, resourceId, roleKey)
        }
        if (grants.map { it.id }.toSet().size != grants.size) throw AuthorizationSnapshotException()
        layer.forbiddenActions = forbidden
        return grants
    }

    private fun loadRoles(roleKeys: Set<String>): Map<String, UUID> {
        if (roleKeys.isEmpty()) return emptyMap()
        val placeholders = roleKeys.joinToString(",") { "?" }
        val rows = jdbc.query(
            """SELECT e.id, e.entity_key
               FROM authz.entity e JOIN iam.principal p ON p.id = e.id
               WHERE e.entity_key IN ($placeholders) AND e.state = 'ACTIVE'
                 AND p.status = 'ACTIVE' AND p.principal_kind = 'ROLE'""",
            { rs, _ -> rs.getString("entity_key") to rs.getObject("id", UUID::class.java) },
            *roleKeys.toTypedArray(),
        )
        if (rows.size != roleKeys.size || rows.map { it.first }.toSet().size != rows.size) throw AuthorizationSnapshotException()
        return rows.toMap()
    }

    private fun loadAssignedRoles(principalId: UUID, snapshotAt: OffsetDateTime): Set<UUID> = jdbc.query(
        """SELECT r.object_entity_id
           FROM authz.active_relationships_at(?) r
           WHERE r.relation_definition_id = ? AND r.subject_entity_id = ?""",
        { rs, _ -> rs.getObject("object_entity_id", UUID::class.java) },
        snapshotAt,
        ROLE_ASSIGNMENT_RELATION_ID,
        principalId,
    ).toSet()

    private fun validateRequest(request: AuthorizationRequest) {
        if (!validUuid(request.requestId) || !validUuid(request.principalId) || !validUuid(request.entityId) ||
            !validUuid(request.resourceId) || !validAction(request.action) || request.context.size > MAX_CONTEXT_PROPERTIES
        ) throw AuthorizationSnapshotException()
        validateContextNode(request.context, 0)
    }

    private fun validateContextNode(value: Any?, depth: Int) {
        if (depth > MAX_CONTEXT_DEPTH) throw AuthorizationSnapshotException()
        when (value) {
            null, is Boolean, is Int, is Long, is Short, is Byte -> Unit
            is Float -> if (!value.isFinite()) throw AuthorizationSnapshotException()
            is Double -> if (!value.isFinite()) throw AuthorizationSnapshotException()
            is String -> validateSafeString(value)
            is Map<*, *> -> value.forEach { (key, child) ->
                if (key !is String) throw AuthorizationSnapshotException()
                validateSafeString(key)
                validateContextNode(child, depth + 1)
            }
            is List<*> -> value.forEach { validateContextNode(it, depth + 1) }
            else -> throw AuthorizationSnapshotException()
        }
    }

    private fun validateSafeString(value: String) {
        if (value.contains('\uFFFD') || value.contains('<') || value.contains('>') || value.contains('&') ||
            value.contains('\u2028') || value.contains('\u2029')
        ) throw AuthorizationSnapshotException()
        var index = 0
        while (index < value.length) {
            val character = value[index]
            index += when {
                Character.isHighSurrogate(character) -> {
                    if (index + 1 >= value.length || !Character.isLowSurrogate(value[index + 1])) {
                        throw AuthorizationSnapshotException()
                    }
                    2
                }
                Character.isLowSurrogate(character) -> throw AuthorizationSnapshotException()
                else -> 1
            }
        }
    }

    private fun parseActions(node: JsonNode, maximum: Int): List<String> {
        if (!node.isArray || node.size() > maximum) throw AuthorizationSnapshotException()
        val actions = node.map { boundedText(it, 1, MAX_ACTION_LENGTH) }
        if (actions.any { !validAction(it) } || actions.toSet().size != actions.size) throw AuthorizationSnapshotException()
        return actions
    }

    private fun requireObjectKeys(node: JsonNode, expected: Set<String>) {
        if (!node.isObject || node.fieldNames().asSequence().toSet() != expected) throw AuthorizationSnapshotException()
    }

    private fun boundedText(node: JsonNode, minimum: Int, maximum: Int): String {
        if (!node.isTextual) throw AuthorizationSnapshotException()
        val value = node.textValue()
        validateSafeString(value)
        val length = value.codePointCount(0, value.length)
        if (length !in minimum..maximum) throw AuthorizationSnapshotException()
        return value
    }

    private fun canonicalBytes(value: Any): ByteArray = try {
        mapper.writeValueAsBytes(if (value is JsonNode) mapper.convertValue(value, Any::class.java) else value)
    }
    catch (_: Exception) { throw AuthorizationSnapshotException() }

    @Suppress("UNCHECKED_CAST")
    private fun immutableContext(context: Map<String, Any?>): Map<String, Any?> {
        val normalized = mapper.convertValue(mapper.readTree(canonicalBytes(context)), Map::class.java) as Map<String, Any?>
        return freeze(normalized) as Map<String, Any?>
    }

    private fun freeze(value: Any?): Any? = when (value) {
        is Map<*, *> -> Collections.unmodifiableMap(value.entries.associate { it.key to freeze(it.value) })
        is List<*> -> Collections.unmodifiableList(value.map(::freeze))
        else -> value
    }

    private fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
        .digest(bytes)
        .joinToString("") { "%02x".format(it) }

    private fun validAction(value: String): Boolean = value.length <= MAX_ACTION_LENGTH && ACTION.matches(value)
    private fun validActionPattern(value: String): Boolean = value == "*" || validAction(value)
    private fun validUuidPattern(value: String): Boolean = value == "*" || UUID_PATTERN.matches(value)
    private fun validUuid(value: UUID): Boolean = value != NIL_UUID && value.version() in 1..8 && value.variant() == 2

    private data class EntityState(
        val id: UUID,
        val entityActive: Boolean,
        val entityVersion: Long,
        val isPrincipal: Boolean,
        val principalActive: Boolean,
        val principalVersion: Long,
    )

    private data class RawReleaseLayer(
        val releaseId: UUID,
        val releaseContentHash: String,
        val opaRevision: String?,
        val bundleId: UUID,
        val layer: String,
        val bundleStatus: String,
        val bundleVersionId: UUID,
        val versionStatus: String,
        val manifest: String,
        val contentHash: String,
    )

    private data class ReleaseLayer(
        val composedReleaseId: UUID,
        val opaRevision: String,
        val layer: PolicyLayer,
        val bundleId: UUID,
        val bundleVersionId: UUID,
        val bundleContentHash: String,
        val manifest: JsonNode,
        var forbiddenActions: List<String> = emptyList(),
    )

    private data class RoleGrantTemplate(
        val id: String,
        val layer: PolicyLayer,
        val releaseId: UUID,
        val effect: GrantEffect,
        val action: String,
        val entityId: String,
        val resourceId: String,
        val subjectRoleEntityKey: String,
    )

    companion object {
        private val PINNED_BUNDLE_STATUSES = setOf("ACTIVE", "DEPRECATED")
        private val OPA_REVISION = Regex("^[A-Za-z0-9][A-Za-z0-9._:-]*${'$'}")
        private const val MAX_ACTION_LENGTH = 128
        private const val MAX_CONTEXT_PROPERTIES = 32
        private const val MAX_CONTEXT_CODE_POINTS = 4096
        private const val MAX_CONTEXT_DEPTH = 8
        private const val MAX_FORBIDDEN_ACTIONS = 128
        private const val MAX_GRANTS = 256
        private const val MAX_MANIFEST_BYTES = 64 * 1024
        private val NIL_UUID = UUID(0, 0)
        private val ROLE_ASSIGNMENT_RELATION_ID = UUID.fromString("00000000-0000-7000-8000-000000000002")
        private val ACTION = Regex("^[A-Za-z0-9][A-Za-z0-9._:-]*${'$'}")
        private val UUID_PATTERN = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}${'$'}")
    }
}
