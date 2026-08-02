package com.innorder.occ.cohort

import com.innorder.occ.authz.WorkflowAuthorizationRelationDefinitions
import com.innorder.occ.authz.WorkflowAuthorizationRoles
import com.innorder.occ.catalog.EmbeddedWorkflowCatalogIds
import com.innorder.occ.iam.BootstrapIds
import com.innorder.occ.api.cursor.CursorPayload
import org.springframework.dao.DataIntegrityViolationException
import org.springframework.jdbc.core.JdbcOperations
import org.springframework.stereotype.Repository
import java.sql.ResultSet
import java.time.OffsetDateTime
import java.util.UUID

@Repository
class CohortRepository(private val jdbc: JdbcOperations) {
    fun customerRootId(): UUID = jdbc.queryForObject(
        "SELECT id FROM platform.customer_instance WHERE singleton",
        UUID::class.java,
    ) ?: throw CohortNotFoundException()

    fun publishedPackage(packageVersionId: UUID): Boolean = jdbc.queryForObject(
        "SELECT EXISTS (SELECT 1 FROM catalog.package_version WHERE id = ? AND status = 'PUBLISHED')",
        Boolean::class.java,
        packageVersionId,
    ) == true

    fun activeProcessOwner(principalId: UUID): Boolean = jdbc.queryForObject(
        """SELECT EXISTS (
             SELECT 1
             FROM iam.principal principal
             JOIN authz.entity principal_entity ON principal_entity.id = principal.id
             JOIN authz.active_relationships_at(transaction_timestamp()) assignment
               ON assignment.subject_entity_id = principal.id
              AND assignment.relation_definition_id = ?
              AND assignment.object_entity_id = ?
             JOIN iam.principal role_principal ON role_principal.id = assignment.object_entity_id
             JOIN authz.entity role_entity ON role_entity.id = role_principal.id
             WHERE principal.id = ? AND principal.principal_kind = 'USER'
               AND principal.status = 'ACTIVE' AND principal_entity.state = 'ACTIVE'
               AND role_principal.principal_kind = 'ROLE' AND role_principal.status = 'ACTIVE'
               AND role_entity.state = 'ACTIVE' AND role_entity.entity_key = ?
           )""",
        Boolean::class.java,
        BootstrapIds.ROLE_ASSIGNMENT_RELATION,
        WorkflowAuthorizationRoles.processOwner.id,
        principalId,
        WorkflowAuthorizationRoles.processOwner.key,
    ) == true

    fun activePrincipal(principalId: UUID): Boolean = jdbc.queryForObject(
        """SELECT EXISTS (
             SELECT 1 FROM iam.principal principal
             JOIN authz.entity entity ON entity.id = principal.id
             WHERE principal.id = ? AND principal.principal_kind = 'USER'
               AND principal.status = 'ACTIVE' AND entity.state = 'ACTIVE'
           )""",
        Boolean::class.java,
        principalId,
    ) == true

    fun eligibleTransferTarget(cohortId: UUID, principalId: UUID): Boolean =
        activePrincipal(principalId) && activeProcessOwner(principalId) && jdbc.queryForObject(
            """SELECT EXISTS (
                 SELECT 1 FROM authz.active_relationships_at(transaction_timestamp())
                 WHERE relation_definition_id = ? AND subject_entity_id = ? AND object_entity_id = ?
               )""",
            Boolean::class.java,
            WorkflowAuthorizationRelationDefinitions.byKey.getValue("cohort_teacher").id,
            principalId,
            cohortId,
        ) == true

    fun beginAuthorizationChange() {
        jdbc.queryForObject("SELECT authz.begin_authorization_revision_batch()", Long::class.java)
    }

    fun finishAuthorizationChange() {
        jdbc.queryForObject("SELECT authz.finish_authorization_revision_batch()", Long::class.java)
    }

    fun create(
        cohortId: UUID,
        customerId: UUID,
        request: CreateCohortRequest,
        actorId: UUID,
    ): CohortDetail {
        jdbc.update(
            """INSERT INTO authz.entity
               (id, entity_type_id, entity_type_version_id, entity_key, state, row_version,
                created_by, updated_by)
               VALUES (?, ?, ?, ?, 'ACTIVE', 1, ?, ?)""",
            cohortId,
            EmbeddedWorkflowCatalogIds.COHORT_TYPE,
            EmbeddedWorkflowCatalogIds.COHORT_TYPE_VERSION,
            "cohort:$customerId:${request.code}",
            actorId,
            actorId,
        )
        jdbc.update(
            """INSERT INTO occ.cohort
               (id, customer_instance_id, code, name, package_version_id, owner_principal_id,
                start_date, end_date, status, row_version, created_by, updated_by)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', 1, ?, ?)""",
            cohortId,
            customerId,
            request.code,
            request.name,
            request.packageVersionId,
            request.ownerPrincipalId,
            request.startDate,
            request.endDate,
            actorId,
            actorId,
        )
        return requireNotNull(find(cohortId))
    }

    fun update(cohortId: UUID, request: UpdateCohortRequest, actorId: UUID): CohortDetail {
        val current = find(cohortId) ?: throw CohortNotFoundException()
        val mergedStart = request.startDate ?: current.startDate
        val mergedEnd = if (request.endDateSpecified) request.endDate else current.endDate
        if (mergedEnd != null && mergedEnd.isBefore(mergedStart)) throw CohortInvalidRequestException()
        val changed = jdbc.update(
            """UPDATE occ.cohort
               SET name = coalesce(?, name),
                   start_date = coalesce(?, start_date),
                   end_date = CASE WHEN ? THEN ? ELSE end_date END,
                   row_version = row_version + 1,
                   updated_by = ?
               WHERE id = ? AND status <> 'ARCHIVED'""",
            request.name,
            request.startDate,
            request.endDateSpecified,
            request.endDate,
            actorId,
            cohortId,
        )
        if (changed != 1) throw CohortConflictException()
        return requireNotNull(find(cohortId))
    }

    fun addMember(
        cohortId: UUID,
        principalId: UUID,
        role: CohortMemberRole,
        validUntil: java.time.Instant?,
        actorId: UUID,
    ): CohortDetail {
        val relationId = memberRelation(role)
        val valid = validUntil == null || jdbc.queryForObject(
            "SELECT ?::timestamptz > transaction_timestamp()",
            Boolean::class.java,
            OffsetDateTime.ofInstant(validUntil, java.time.ZoneOffset.UTC),
        ) == true
        if (!activePrincipal(principalId) || !valid) throw CohortConflictException()
        try {
            jdbc.update(
                """INSERT INTO authz.relationship
                   (id, relation_definition_id, subject_entity_id, object_entity_id, valid_from,
                    valid_until, source_kind, source_ref, created_by, updated_by)
                   VALUES (?, ?, ?, ?, transaction_timestamp(), ?, 'SYSTEM', 'cohort-membership', ?, ?)""",
                UUID.randomUUID(),
                relationId,
                principalId,
                cohortId,
                validUntil?.let { OffsetDateTime.ofInstant(it, java.time.ZoneOffset.UTC) },
                actorId,
                actorId,
            )
        } catch (_: DataIntegrityViolationException) {
            throw CohortConflictException()
        }
        bump(cohortId, actorId)
        return requireNotNull(find(cohortId))
    }

    fun removeMember(
        cohortId: UUID,
        principalId: UUID,
        role: CohortMemberRole,
        actorId: UUID,
    ): CohortDetail {
        val changed = jdbc.update(
            """UPDATE authz.relationship
               SET valid_until = transaction_timestamp(), revoked_at = transaction_timestamp(),
                   revoked_by = ?, updated_by = ?
               WHERE relation_definition_id = ? AND subject_entity_id = ? AND object_entity_id = ?
                 AND revoked_at IS NULL AND valid_from <= transaction_timestamp()
                 AND (valid_until IS NULL OR valid_until > transaction_timestamp())""",
            actorId,
            actorId,
            memberRelation(role),
            principalId,
            cohortId,
        )
        if (changed != 1) throw CohortConflictException()
        bump(cohortId, actorId)
        return requireNotNull(find(cohortId))
    }

    fun transferOwner(cohortId: UUID, ownerId: UUID, actorId: UUID): CohortDetail {
        if (!eligibleTransferTarget(cohortId, ownerId)) throw CohortConflictException()
        val changed = jdbc.update(
            """UPDATE occ.cohort
               SET owner_principal_id = ?, row_version = row_version + 1, updated_by = ?
               WHERE id = ? AND status <> 'ARCHIVED' AND owner_principal_id <> ?""",
            ownerId,
            actorId,
            cohortId,
            ownerId,
        )
        if (changed != 1) throw CohortConflictException()
        return requireNotNull(find(cohortId))
    }

    fun archive(cohortId: UUID, actorId: UUID): CohortDetail {
        val changed = jdbc.update(
            """UPDATE occ.cohort cohort
               SET status = 'ARCHIVED', archived_at = transaction_timestamp(),
                   row_version = row_version + 1, updated_by = ?
               WHERE cohort.id = ? AND cohort.status IN ('DRAFT', 'ACTIVE')
                 AND NOT EXISTS (
                   SELECT 1 FROM occ.process_instance process
                   WHERE process.cohort_id = cohort.id AND process.state IN ('RUNNING', 'SUSPENDED')
                 )""",
            actorId,
            cohortId,
        )
        if (changed != 1) throw CohortConflictException()
        return requireNotNull(find(cohortId))
    }

    fun eligibleParticipantProcessStart(request: ParticipantProcessStart): Boolean = jdbc.queryForObject(
        """SELECT EXISTS (
             SELECT 1 FROM occ.cohort cohort
             JOIN catalog.package_version package ON package.id = cohort.package_version_id
             JOIN authz.active_relationships_at(transaction_timestamp()) participant
               ON participant.object_entity_id = cohort.id
              AND participant.subject_entity_id = ?
              AND participant.relation_definition_id = ?
             JOIN iam.principal principal ON principal.id = participant.subject_entity_id
             JOIN authz.entity entity ON entity.id = principal.id
             WHERE cohort.id = ? AND cohort.row_version = ? AND cohort.status = 'ACTIVE'
               AND cohort.start_date <= current_date
               AND (cohort.end_date IS NULL OR cohort.end_date >= current_date)
               AND package.status = 'PUBLISHED'
               AND principal.status = 'ACTIVE' AND entity.state = 'ACTIVE'
           )""",
        Boolean::class.java,
        request.participantId,
        participantRelationId,
        request.cohortId,
        request.expectedCohortVersion,
    ) == true

    fun find(cohortId: UUID): CohortDetail? {
        val cohort = jdbc.query(
            """SELECT id, code, name, package_version_id, owner_principal_id, start_date, end_date,
                      status, row_version, created_at, updated_at
               FROM occ.cohort WHERE id = ?""",
            { rs, _ -> detail(rs, emptyList()) },
            cohortId,
        ).singleOrNull() ?: return null
        return cohort.copy(members = members(cohortId))
    }

    fun findAuthorized(cohortId: UUID, principalId: UUID): CohortDetail? {
        val rows = jdbc.query(
            """WITH active AS MATERIALIZED (
                 SELECT relationship.*
                 FROM authz.active_relationships_at(transaction_timestamp()) relationship
                 WHERE relationship.relation_definition_id IN (?, ?, ?)
               )
               SELECT cohort.id, cohort.code, cohort.name, cohort.package_version_id,
                      cohort.owner_principal_id, cohort.start_date, cohort.end_date, cohort.status,
                      cohort.row_version, cohort.created_at, cohort.updated_at,
                      member.subject_entity_id AS member_id, definition.relation_key,
                      member.valid_from, member.valid_until
               FROM occ.cohort cohort
               LEFT JOIN active member ON member.object_entity_id = cohort.id
               LEFT JOIN catalog.relation_definition definition ON definition.id = member.relation_definition_id
               WHERE cohort.id = ? AND EXISTS (
                 SELECT 1 FROM active visible
                 WHERE visible.object_entity_id = cohort.id AND visible.subject_entity_id = ?
               )
               ORDER BY CASE definition.relation_key
                          WHEN 'cohort_owner' THEN 0 WHEN 'cohort_teacher' THEN 1 ELSE 2 END,
                        member.subject_entity_id""",
            { rs, _ ->
                AuthorizedDetailRow(
                    detail(rs, emptyList()),
                    rs.getObject("member_id", UUID::class.java)?.let {
                        CohortMember(
                            it,
                            when (rs.getString("relation_key")) {
                                "cohort_owner" -> CohortMemberRole.OWNER
                                "cohort_teacher" -> CohortMemberRole.TEACHER
                                else -> CohortMemberRole.PARTICIPANT
                            },
                            rs.getObject("valid_from", OffsetDateTime::class.java).toInstant(),
                            rs.getObject("valid_until", OffsetDateTime::class.java)?.toInstant(),
                        )
                    },
                )
            },
            *visibilityArguments(cohortId, principalId),
        )
        if (rows.isEmpty()) return null
        return rows.first().detail.copy(members = rows.mapNotNull(AuthorizedDetailRow::member))
    }

    fun listAuthorized(
        principalId: UUID,
        filter: CohortListFilter,
        seek: CursorPayload?,
        limit: Int,
    ): List<CohortSummary> = jdbc.query(
        """SELECT cohort.id, cohort.code, cohort.name, cohort.package_version_id,
                  cohort.owner_principal_id, cohort.start_date, cohort.end_date, cohort.status,
                  cohort.row_version, cohort.created_at, cohort.updated_at
           FROM occ.cohort cohort
           WHERE EXISTS (
             SELECT 1 FROM authz.active_relationships_at(transaction_timestamp()) visible
             WHERE visible.object_entity_id = cohort.id AND visible.subject_entity_id = ?
               AND visible.relation_definition_id IN (?, ?, ?)
           )
             AND (?::text IS NULL OR cohort.status = ?)
             AND (?::uuid IS NULL OR cohort.package_version_id = ?)
             AND (?::timestamptz IS NULL OR cohort.updated_at < ?)
             AND (?::timestamptz IS NULL OR cohort.updated_at < ?
                  OR (cohort.updated_at = ? AND cohort.id < ?::uuid))
           ORDER BY cohort.updated_at DESC, cohort.id DESC
           LIMIT ?""",
        { rs, _ -> summary(rs) },
        principalId,
        ownerRelationId,
        teacherRelationId,
        participantRelationId,
        filter.status?.name,
        filter.status?.name,
        filter.packageVersionId,
        filter.packageVersionId,
        filter.updatedBefore?.let(::offset),
        filter.updatedBefore?.let(::offset),
        seek?.sortTimestamp?.let(::offset),
        seek?.sortTimestamp?.let(::offset),
        seek?.sortTimestamp?.let(::offset),
        seek?.lastId,
        limit,
    )

    fun listCandidates(filter: CohortListFilter): List<CohortSummary> = jdbc.query(
        """SELECT id, code, name, package_version_id, owner_principal_id, start_date, end_date,
                  status, row_version, created_at, updated_at
           FROM occ.cohort
           WHERE (?::text IS NULL OR status = ?)
             AND (?::uuid IS NULL OR package_version_id = ?)
             AND (?::timestamptz IS NULL OR updated_at < ?)
           ORDER BY updated_at DESC, id DESC""",
        { rs, _ -> summary(rs) },
        filter.status?.name,
        filter.status?.name,
        filter.packageVersionId,
        filter.packageVersionId,
        filter.updatedBefore?.let { OffsetDateTime.ofInstant(it, java.time.ZoneOffset.UTC) },
        filter.updatedBefore?.let { OffsetDateTime.ofInstant(it, java.time.ZoneOffset.UTC) },
    )

    private fun members(cohortId: UUID): List<CohortMember> = jdbc.query(
        """SELECT relationship.subject_entity_id, definition.relation_key,
                  relationship.valid_from, relationship.valid_until
           FROM authz.active_relationships_at(transaction_timestamp()) relationship
           JOIN catalog.relation_definition definition
             ON definition.id = relationship.relation_definition_id
           WHERE relationship.object_entity_id = ?
             AND definition.id IN (?, ?, ?)
           ORDER BY CASE definition.relation_key
                      WHEN 'cohort_owner' THEN 0 WHEN 'cohort_teacher' THEN 1 ELSE 2 END,
                    relationship.subject_entity_id""",
        { rs, _ ->
            CohortMember(
                rs.getObject("subject_entity_id", UUID::class.java),
                when (rs.getString("relation_key")) {
                    "cohort_owner" -> CohortMemberRole.OWNER
                    "cohort_teacher" -> CohortMemberRole.TEACHER
                    else -> CohortMemberRole.PARTICIPANT
                },
                rs.getObject("valid_from", OffsetDateTime::class.java).toInstant(),
                rs.getObject("valid_until", OffsetDateTime::class.java)?.toInstant(),
            )
        },
        cohortId,
        WorkflowAuthorizationRelationDefinitions.byKey.getValue("cohort_owner").id,
        WorkflowAuthorizationRelationDefinitions.byKey.getValue("cohort_teacher").id,
        WorkflowAuthorizationRelationDefinitions.byKey.getValue("cohort_participant").id,
    )

    private fun bump(cohortId: UUID, actorId: UUID) {
        if (jdbc.update(
                """UPDATE occ.cohort SET row_version = row_version + 1, updated_by = ?
                   WHERE id = ? AND status <> 'ARCHIVED'""",
                actorId,
                cohortId,
            ) != 1
        ) throw CohortConflictException()
    }

    private fun memberRelation(role: CohortMemberRole): UUID = when (role) {
        CohortMemberRole.TEACHER -> WorkflowAuthorizationRelationDefinitions.byKey.getValue("cohort_teacher").id
        CohortMemberRole.PARTICIPANT -> WorkflowAuthorizationRelationDefinitions.byKey.getValue("cohort_participant").id
        CohortMemberRole.OWNER -> throw CohortConflictException()
    }

    private fun visibilityArguments(cohortId: UUID, principalId: UUID): Array<Any> = arrayOf(
        ownerRelationId, teacherRelationId, participantRelationId, cohortId, principalId,
    )

    private fun offset(value: java.time.Instant): OffsetDateTime =
        OffsetDateTime.ofInstant(value, java.time.ZoneOffset.UTC)

    private val ownerRelationId get() = WorkflowAuthorizationRelationDefinitions.byKey.getValue("cohort_owner").id
    private val teacherRelationId get() = WorkflowAuthorizationRelationDefinitions.byKey.getValue("cohort_teacher").id
    private val participantRelationId get() = WorkflowAuthorizationRelationDefinitions.byKey.getValue("cohort_participant").id

    private data class AuthorizedDetailRow(val detail: CohortDetail, val member: CohortMember?)

    private fun detail(rs: ResultSet, members: List<CohortMember>) = CohortDetail(
        rs.getObject("id", UUID::class.java),
        rs.getString("code"),
        rs.getString("name"),
        rs.getObject("package_version_id", UUID::class.java),
        rs.getObject("owner_principal_id", UUID::class.java),
        rs.getObject("start_date", java.time.LocalDate::class.java),
        rs.getObject("end_date", java.time.LocalDate::class.java),
        CohortStatus.valueOf(rs.getString("status")),
        rs.getLong("row_version"),
        rs.getObject("created_at", OffsetDateTime::class.java).toInstant(),
        rs.getObject("updated_at", OffsetDateTime::class.java).toInstant(),
        members,
    )

    private fun summary(rs: ResultSet) = CohortSummary(
        rs.getObject("id", UUID::class.java),
        rs.getString("code"),
        rs.getString("name"),
        rs.getObject("package_version_id", UUID::class.java),
        rs.getObject("owner_principal_id", UUID::class.java),
        rs.getObject("start_date", java.time.LocalDate::class.java),
        rs.getObject("end_date", java.time.LocalDate::class.java),
        CohortStatus.valueOf(rs.getString("status")),
        rs.getLong("row_version"),
        rs.getObject("created_at", OffsetDateTime::class.java).toInstant(),
        rs.getObject("updated_at", OffsetDateTime::class.java).toInstant(),
    )
}
