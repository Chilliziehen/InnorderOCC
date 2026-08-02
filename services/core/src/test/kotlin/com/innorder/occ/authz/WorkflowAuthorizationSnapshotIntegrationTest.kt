package com.innorder.occ.authz

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import java.util.UUID

class WorkflowAuthorizationSnapshotIntegrationTest : AuthorizationSnapshotIntegrityIntegrationTest() {
    @Test
    fun `relationship facts expose the strict v2 workflow vocabulary`() {
        val subjectId = UUID.fromString("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        val objectId = UUID.fromString("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")

        val facts = AuthorizationRelation.entries.map { relation ->
            AuthorizationRelationshipFact(relation, subjectId, objectId)
        }

        assertThat(facts.map { it.relation }).containsExactly(
            AuthorizationRelation.COHORT_OWNER,
            AuthorizationRelation.COHORT_TEACHER,
            AuthorizationRelation.COHORT_PARTICIPANT,
            AuthorizationRelation.TASK_CANDIDATE,
            AuthorizationRelation.TASK_ASSIGNEE,
        )
    }

    @Test
    fun `snapshot includes only active allowlisted target relationships in immutable order`() = scenario { jdbc ->
        seedActiveRelease(
            jdbc,
            mapOf(PolicyLayer.PLATFORM to
                """{"version":1,"roleGrants":[],"forbiddenActions":[]}"""),
        )
        val principalId = UUID.fromString("73000000-0000-7000-8000-000000000007")
        val entityId = UUID.fromString("73000000-0000-7000-8000-000000000008")
        val resourceId = UUID.fromString("73000000-0000-7000-8000-000000000009")
        jdbc.update(
            """INSERT INTO occ.cohort
               (id, customer_instance_id, code, name, package_version_id, owner_principal_id,
                start_date, status, created_by, updated_by)
               VALUES (?, '00000000-0000-7000-8000-000000000001', 'authz-snapshot', 'Authz snapshot',
                       '73000000-0000-7000-8000-000000000002', ?, current_date, 'DRAFT', ?, ?)""",
            entityId, principalId, principalId, principalId,
        )
        val relationships = listOf(
            RelationshipSeed("74000000-0000-7000-8000-000000000004", resourceId, "active-candidate", "transaction_timestamp()", "NULL", "NULL"),
            RelationshipSeed("74000000-0000-7000-8000-000000000002", entityId, "expired-teacher", "transaction_timestamp() - interval '2 hours'", "transaction_timestamp() - interval '1 hour'", "NULL"),
            RelationshipSeed("74000000-0000-7000-8000-000000000003", entityId, "future-participant", "transaction_timestamp() + interval '1 hour'", "NULL", "NULL"),
            RelationshipSeed("74000000-0000-7000-8000-000000000005", resourceId, "revoked-assignee", "transaction_timestamp() - interval '2 hours'", "NULL", "transaction_timestamp() - interval '1 hour'"),
            RelationshipSeed("74000000-0000-7000-8000-000000000006", entityId, "unknown-relation", "transaction_timestamp()", "NULL", "NULL"),
        )
        relationships.forEach { relationship ->
            jdbc.update(
                """INSERT INTO authz.relationship
                   (id, relation_definition_id, subject_entity_id, object_entity_id, valid_from, valid_until,
                    revoked_at, source_kind, source_ref)
                   VALUES (?, ?::uuid, ?, ?, ${relationship.validFrom}, ${relationship.validUntil},
                           ${relationship.revokedAt}, 'SYSTEM', ?)""",
                UUID.randomUUID(), relationship.definitionId, principalId, relationship.objectId, relationship.sourceRef,
            )
        }

        val snapshot = repository(jdbc).load(request())

        assertThat(snapshot.contractVersion).isEqualTo(2)
        assertThat(snapshot.relationships).containsExactly(
            AuthorizationRelationshipFact(AuthorizationRelation.COHORT_OWNER, principalId, entityId),
            AuthorizationRelationshipFact(AuthorizationRelation.TASK_CANDIDATE, principalId, resourceId),
        )
        assertThatThrownBy { (snapshot.relationships as MutableList<AuthorizationRelationshipFact>).clear() }
            .isInstanceOf(UnsupportedOperationException::class.java)
    }

    @Test
    fun `snapshot fails closed when raw relevant relationships exceed 256`() = scenario { jdbc ->
        seedActiveRelease(
            jdbc,
            mapOf(PolicyLayer.PLATFORM to
                """{"version":1,"roleGrants":[],"forbiddenActions":[]}"""),
        )
        val principalId = UUID.fromString("73000000-0000-7000-8000-000000000007")
        val resourceId = UUID.fromString("73000000-0000-7000-8000-000000000009")
        repeat(257) { index ->
            val versionId = UUID.randomUUID()
            val relationId = UUID.randomUUID()
            jdbc.update(
                """INSERT INTO catalog.package_version(id, package_id, semver, status)
                   VALUES (?, '73000000-0000-7000-8000-000000000001', ?, 'DRAFT')""",
                versionId, "2.0.$index",
            )
            jdbc.update(
                """INSERT INTO catalog.relation_definition
                   (id, package_version_id, relation_key, subject_type_id, object_type_id, cardinality, auth_relevant)
                   VALUES (?, ?, 'task_candidate', '73000000-0000-7000-8000-000000000003',
                           '73000000-0000-7000-8000-000000000003', 'MANY_TO_MANY', true)""",
                relationId, versionId,
            )
            jdbc.update(
                """UPDATE catalog.package_version SET status = 'PUBLISHED', content_hash = ?,
                       published_at = transaction_timestamp() WHERE id = ?""",
                "%064x".format(index + 1), versionId,
            )
            jdbc.update(
                """INSERT INTO authz.relationship
                   (id, relation_definition_id, subject_entity_id, object_entity_id, source_kind, source_ref)
                   VALUES (?, ?, ?, ?, 'SYSTEM', ?)""",
                UUID.randomUUID(), relationId, principalId, resourceId, "oversize-$index",
            )
        }

        assertThatThrownBy { repository(jdbc).load(request()) }
            .isInstanceOf(AuthorizationSnapshotException::class.java)
    }

    private data class RelationshipSeed(
        val definitionId: String,
        val objectId: UUID,
        val sourceRef: String,
        val validFrom: String,
        val validUntil: String,
        val revokedAt: String,
    )
}
