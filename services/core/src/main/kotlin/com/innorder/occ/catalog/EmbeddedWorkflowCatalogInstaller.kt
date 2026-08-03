package com.innorder.occ.catalog

import com.innorder.occ.authz.WorkflowAuthorizationRelationDefinitions
import com.innorder.occ.iam.BootstrapIds
import org.springframework.boot.ApplicationArguments
import org.springframework.boot.ApplicationRunner
import org.springframework.core.Ordered
import org.springframework.core.annotation.Order
import org.springframework.jdbc.core.JdbcOperations
import org.springframework.stereotype.Component
import org.springframework.transaction.support.TransactionOperations
import java.time.OffsetDateTime
import java.util.UUID

class WorkflowCatalogInstallationException : IllegalStateException(
    "Embedded workflow catalog installation conflicts with existing data",
)

object EmbeddedWorkflowCatalogIds {
    private val DNS_NAMESPACE = UUID.fromString("6ba7b810-9dad-11d1-80b4-00c04fd430c8")
    val NAMESPACE: UUID = UuidV5.from(DNS_NAMESPACE, "com.innorder.occ.workflow-catalog")
    val PACKAGE: UUID = id("package:embedded-workflow")
    val PACKAGE_VERSION: UUID = id("package-version:embedded-workflow:1.0.0")
    val COHORT_TYPE: UUID = id("entity-type:cohort")
    val COHORT_TYPE_VERSION: UUID = id("entity-type-version:cohort:1")
    val PROCESS_TYPE: UUID = id("entity-type:process")
    val PROCESS_TYPE_VERSION: UUID = id("entity-type-version:process:1")
    val TASK_TYPE: UUID = id("entity-type:task")
    val TASK_TYPE_VERSION: UUID = id("entity-type-version:task:1")

    private fun id(name: String): UUID = UuidV5.from(NAMESPACE, name)
}

@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 2)
class EmbeddedWorkflowCatalogInstaller(
    private val jdbc: JdbcOperations,
    private val transactions: TransactionOperations,
) : ApplicationRunner {
    override fun run(args: ApplicationArguments) {
        installPackage()
    }

    fun installPackage() {
        try {
            transactions.executeWithoutResult {
                if (!catalogSchemaInstalled()) return@executeWithoutResult
                jdbc.queryForObject("SELECT pg_advisory_xact_lock(?) IS NULL", Boolean::class.java, INSTALL_LOCK)
                if (!platformUserTypeInstalled()) fail()
                installLocked()
            }
        } catch (failure: WorkflowCatalogInstallationException) {
            throw failure
        } catch (_: Exception) {
            throw WorkflowCatalogInstallationException()
        }
    }

    private fun catalogSchemaInstalled(): Boolean = count(
        """SELECT count(*) FROM information_schema.tables
           WHERE lower(table_schema) = 'catalog' AND lower(table_name) = 'entity_type'""",
    ) == 1L

    private fun platformUserTypeInstalled(): Boolean = count(
        """SELECT count(*) FROM catalog.domain_package dp
           JOIN catalog.package_version pv ON pv.package_id = dp.id
           JOIN catalog.entity_type et ON et.package_id = dp.id
           JOIN catalog.entity_type_version etv ON etv.entity_type_id = et.id
           WHERE dp.id = ? AND dp.package_key = 'platform-iam' AND dp.status = 'ACTIVE'
             AND pv.id = ? AND pv.semver = '1.0.0' AND pv.status = 'PUBLISHED'
             AND et.id = ? AND et.type_key = 'platform.user'
             AND et.entity_kind = 'PRINCIPAL' AND et.authorizable
             AND etv.id = ? AND etv.package_version_id = pv.id AND etv.schema_version = 1
             AND etv.json_schema = '{}'::jsonb AND etv.ui_schema = '{}'::jsonb
             AND etv.auth_schema = '{}'::jsonb AND etv.index_spec = '{}'::jsonb""",
        BootstrapIds.PACKAGE,
        BootstrapIds.PACKAGE_VERSION,
        BootstrapIds.USER_TYPE,
        BootstrapIds.USER_TYPE_VERSION,
    ) == 1L

    private fun installLocked() {
        val now = jdbc.queryForObject("SELECT transaction_timestamp()", OffsetDateTime::class.java) ?: fail()
        ensure(
            "catalog.domain_package",
            "id = ? OR package_key = 'embedded-workflow'",
            arrayOf(EmbeddedWorkflowCatalogIds.PACKAGE),
            """id = ? AND package_key = 'embedded-workflow' AND name = 'Embedded Workflow'
               AND description = 'Immutable workflow authorization catalog prerequisites' AND status = 'ACTIVE'
               AND row_version = 0 AND created_by IS NULL AND updated_by IS NULL""",
            arrayOf(EmbeddedWorkflowCatalogIds.PACKAGE),
        ) {
            jdbc.update(
                """INSERT INTO catalog.domain_package
                   (id, package_key, name, description, status, created_at, updated_at)
                   VALUES (?, 'embedded-workflow', 'Embedded Workflow',
                           'Immutable workflow authorization catalog prerequisites', 'ACTIVE', ?, ?)""",
                EmbeddedWorkflowCatalogIds.PACKAGE,
                now,
                now,
            )
        }
        ensurePackageVersion(now)
        val status = jdbc.queryForObject(
            "SELECT status FROM catalog.package_version WHERE id = ?",
            String::class.java,
            EmbeddedWorkflowCatalogIds.PACKAGE_VERSION,
        )
        if (status == "PUBLISHED") {
            ensureCustomerRoot(now)
            verifyAssets()
            return
        }
        if (status != "DRAFT") fail()

        TYPES.forEach { type ->
            ensureType(type)
            ensureTypeVersion(type)
        }
        RELATIONS.forEach(::ensureRelation)
        ensureCustomerRoot(now)
        verifyAssets(draft = true)
        jdbc.update(
            """UPDATE catalog.package_version
               SET status = 'PUBLISHED', content_hash = ?, published_at = ?
               WHERE id = ? AND status = 'DRAFT'""",
            CONTENT_HASH,
            now,
            EmbeddedWorkflowCatalogIds.PACKAGE_VERSION,
        )
        verifyAssets()
    }

    private fun ensurePackageVersion(now: OffsetDateTime) = ensure(
        "catalog.package_version",
        "id = ? OR (package_id = ? AND semver = '1.0.0')",
        arrayOf(EmbeddedWorkflowCatalogIds.PACKAGE_VERSION, EmbeddedWorkflowCatalogIds.PACKAGE),
        """id = ? AND package_id = ? AND semver = '1.0.0' AND status IN ('DRAFT', 'PUBLISHED')
           AND manifest = ?::jsonb AND created_by IS NULL AND published_by IS NULL
           AND ((status = 'DRAFT' AND content_hash IS NULL AND published_at IS NULL)
                OR (status = 'PUBLISHED' AND content_hash = ? AND published_at IS NOT NULL))""",
        arrayOf(
            EmbeddedWorkflowCatalogIds.PACKAGE_VERSION,
            EmbeddedWorkflowCatalogIds.PACKAGE,
            MANIFEST,
            CONTENT_HASH,
        ),
    ) {
        jdbc.update(
            """INSERT INTO catalog.package_version(id, package_id, semver, status, manifest, created_at)
               VALUES (?, ?, '1.0.0', 'DRAFT', ?::jsonb, ?)""",
            EmbeddedWorkflowCatalogIds.PACKAGE_VERSION,
            EmbeddedWorkflowCatalogIds.PACKAGE,
            MANIFEST,
            now,
        )
    }

    private fun ensureType(type: TypeSpec) = ensure(
        "catalog.entity_type",
        "id = ? OR (package_id = ? AND type_key = ?)",
        arrayOf(type.id, EmbeddedWorkflowCatalogIds.PACKAGE, type.key),
        """id = ? AND package_id = ? AND type_key = ? AND name = ?
           AND entity_kind = 'RESOURCE' AND authorizable""",
        arrayOf(type.id, EmbeddedWorkflowCatalogIds.PACKAGE, type.key, type.name),
    ) {
        jdbc.update(
            """INSERT INTO catalog.entity_type(id, package_id, type_key, name, entity_kind, authorizable)
               VALUES (?, ?, ?, ?, 'RESOURCE', true)""",
            type.id,
            EmbeddedWorkflowCatalogIds.PACKAGE,
            type.key,
            type.name,
        )
    }

    private fun ensureTypeVersion(type: TypeSpec) = ensure(
        "catalog.entity_type_version",
        "id = ? OR (entity_type_id = ? AND schema_version = 1) OR (entity_type_id = ? AND package_version_id = ?)",
        arrayOf(type.versionId, type.id, type.id, EmbeddedWorkflowCatalogIds.PACKAGE_VERSION),
        """id = ? AND entity_type_id = ? AND package_version_id = ? AND schema_version = 1
           AND json_schema = '{}'::jsonb AND ui_schema = '{}'::jsonb
           AND auth_schema = '{}'::jsonb AND index_spec = '{}'::jsonb""",
        arrayOf(type.versionId, type.id, EmbeddedWorkflowCatalogIds.PACKAGE_VERSION),
    ) {
        jdbc.update(
            """INSERT INTO catalog.entity_type_version
               (id, entity_type_id, package_version_id, schema_version, json_schema)
               VALUES (?, ?, ?, 1, '{}'::jsonb)""",
            type.versionId,
            type.id,
            EmbeddedWorkflowCatalogIds.PACKAGE_VERSION,
        )
    }

    private fun ensureRelation(relation: RelationSpec) = ensure(
        "catalog.relation_definition",
        "id = ? OR (package_version_id = ? AND relation_key = ?)",
        arrayOf(relation.id, EmbeddedWorkflowCatalogIds.PACKAGE_VERSION, relation.key),
        """id = ? AND package_version_id = ? AND relation_key = ?
           AND subject_type_id = ? AND object_type_id = ? AND cardinality = ?
           AND NOT transitive AND NOT acyclic AND auth_relevant
           AND max_subjects IS NULL AND max_objects IS NULL""",
        arrayOf(
            relation.id,
            EmbeddedWorkflowCatalogIds.PACKAGE_VERSION,
            relation.key,
            BootstrapIds.USER_TYPE,
            relation.objectTypeId,
            relation.cardinality,
        ),
    ) {
        jdbc.update(
            """INSERT INTO catalog.relation_definition
               (id, package_version_id, relation_key, subject_type_id, object_type_id, cardinality,
                transitive, acyclic, auth_relevant)
               VALUES (?, ?, ?, ?, ?, ?, false, false, true)""",
            relation.id,
            EmbeddedWorkflowCatalogIds.PACKAGE_VERSION,
            relation.key,
            BootstrapIds.USER_TYPE,
            relation.objectTypeId,
            relation.cardinality,
        )
    }

    private fun ensureCustomerRoot(now: OffsetDateTime) {
        // Customer root identity is the existing deployment singleton, not a catalog-derived UUID.
        val customer = jdbc.queryForMap(
            "SELECT id, instance_key FROM platform.customer_instance WHERE singleton",
        )
        val id = customer["id"] as? UUID ?: fail()
        val key = customer["instance_key"] as? String ?: fail()
        ensure(
            "authz.entity",
            "id = ? OR (entity_type_id = ? AND entity_key = ?)",
            arrayOf(id, EmbeddedWorkflowCatalogIds.COHORT_TYPE, "customer:$key"),
            """id = ? AND entity_type_id = ? AND entity_type_version_id = ? AND entity_key = ?
               AND state = 'ACTIVE' AND auth_attributes = '{}'::jsonb AND row_version = 0
               AND created_by IS NULL AND updated_by IS NULL""",
            arrayOf(
                id,
                EmbeddedWorkflowCatalogIds.COHORT_TYPE,
                EmbeddedWorkflowCatalogIds.COHORT_TYPE_VERSION,
                "customer:$key",
            ),
        ) {
            jdbc.update(
                """INSERT INTO authz.entity
                   (id, entity_type_id, entity_type_version_id, entity_key, state, created_at, updated_at)
                   VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?)""",
                id,
                EmbeddedWorkflowCatalogIds.COHORT_TYPE,
                EmbeddedWorkflowCatalogIds.COHORT_TYPE_VERSION,
                "customer:$key",
                now,
                now,
            )
        }
    }

    private fun verifyAssets(draft: Boolean = false) {
        if (count("SELECT count(*) FROM catalog.entity_type WHERE package_id = ?", EmbeddedWorkflowCatalogIds.PACKAGE) != 3L ||
            count(
                "SELECT count(*) FROM catalog.entity_type_version WHERE package_version_id = ?",
                EmbeddedWorkflowCatalogIds.PACKAGE_VERSION,
            ) != 3L ||
            count(
                "SELECT count(*) FROM catalog.relation_definition WHERE package_version_id = ?",
                EmbeddedWorkflowCatalogIds.PACKAGE_VERSION,
            ) != 5L ||
            count(
                """SELECT (SELECT count(*) FROM catalog.action_definition WHERE package_version_id = ?)
                          + (SELECT count(*) FROM catalog.form_definition WHERE package_version_id = ?)
                          + (SELECT count(*) FROM catalog.evidence_requirement WHERE package_version_id = ?)
                          + (SELECT count(*) FROM catalog.risk_rule_definition WHERE package_version_id = ?)
                          + (SELECT count(*) FROM catalog.workflow_definition WHERE package_version_id = ?)""",
                *Array(5) { EmbeddedWorkflowCatalogIds.PACKAGE_VERSION },
            ) != 0L
        ) fail()
        TYPES.forEach { type ->
            if (count(
                    """SELECT count(*) FROM catalog.entity_type et
                       JOIN catalog.entity_type_version etv ON etv.entity_type_id = et.id
                       WHERE et.id = ? AND et.package_id = ? AND et.type_key = ? AND et.name = ?
                         AND et.entity_kind = 'RESOURCE' AND et.authorizable
                         AND etv.id = ? AND etv.package_version_id = ? AND etv.schema_version = 1
                         AND etv.json_schema = '{}'::jsonb AND etv.ui_schema = '{}'::jsonb
                         AND etv.auth_schema = '{}'::jsonb AND etv.index_spec = '{}'::jsonb""",
                    type.id,
                    EmbeddedWorkflowCatalogIds.PACKAGE,
                    type.key,
                    type.name,
                    type.versionId,
                    EmbeddedWorkflowCatalogIds.PACKAGE_VERSION,
                ) != 1L
            ) fail()
        }
        RELATIONS.forEach { relation ->
            if (count(
                    """SELECT count(*) FROM catalog.relation_definition
                       WHERE id = ? AND package_version_id = ? AND relation_key = ?
                         AND subject_type_id = ? AND object_type_id = ? AND cardinality = ?
                         AND NOT transitive AND NOT acyclic AND auth_relevant
                         AND max_subjects IS NULL AND max_objects IS NULL""",
                    relation.id,
                    EmbeddedWorkflowCatalogIds.PACKAGE_VERSION,
                    relation.key,
                    BootstrapIds.USER_TYPE,
                    relation.objectTypeId,
                    relation.cardinality,
                ) != 1L
            ) fail()
        }
        if (!draft && count(
                """SELECT count(*) FROM catalog.package_version
                   WHERE id = ? AND status = 'PUBLISHED' AND manifest = ?::jsonb
                     AND content_hash = ? AND published_at IS NOT NULL""",
                EmbeddedWorkflowCatalogIds.PACKAGE_VERSION,
                MANIFEST,
                CONTENT_HASH,
            ) != 1L
        ) fail()
    }

    private fun ensure(
        table: String,
        collisionPredicate: String,
        collisionArguments: Array<Any>,
        expectedPredicate: String,
        expectedArguments: Array<Any>,
        insert: () -> Unit,
    ) {
        val collisions = count("SELECT count(*) FROM $table WHERE $collisionPredicate", *collisionArguments)
        if (collisions == 0L) {
            insert()
        } else if (collisions != 1L ||
            count("SELECT count(*) FROM $table WHERE $expectedPredicate", *expectedArguments) != 1L
        ) fail()
    }

    private fun count(sql: String, vararg arguments: Any): Long =
        jdbc.queryForObject(sql, Long::class.java, *arguments) ?: fail()

    private fun fail(): Nothing = throw WorkflowCatalogInstallationException()

    private data class TypeSpec(val id: UUID, val versionId: UUID, val key: String, val name: String)
    private data class RelationSpec(val id: UUID, val key: String, val objectTypeId: UUID, val cardinality: String)

    companion object {
        private const val INSTALL_LOCK = 0x4f43435746434cL
        private const val MANIFEST = """{"catalog":"embedded-workflow","version":1}"""
        private val TYPES = listOf(
            TypeSpec(EmbeddedWorkflowCatalogIds.COHORT_TYPE, EmbeddedWorkflowCatalogIds.COHORT_TYPE_VERSION, "cohort", "Cohort"),
            TypeSpec(EmbeddedWorkflowCatalogIds.PROCESS_TYPE, EmbeddedWorkflowCatalogIds.PROCESS_TYPE_VERSION, "process", "Process"),
            TypeSpec(EmbeddedWorkflowCatalogIds.TASK_TYPE, EmbeddedWorkflowCatalogIds.TASK_TYPE_VERSION, "task", "Task"),
        )
        // Task5 relation IDs are upstream production literals and intentionally exempt from UUIDv5 derivation.
        private val RELATIONS = listOf(
            relation(0, EmbeddedWorkflowCatalogIds.COHORT_TYPE, "ONE_TO_MANY"),
            relation(1, EmbeddedWorkflowCatalogIds.COHORT_TYPE, "MANY_TO_MANY"),
            relation(2, EmbeddedWorkflowCatalogIds.COHORT_TYPE, "MANY_TO_MANY"),
            relation(3, EmbeddedWorkflowCatalogIds.TASK_TYPE, "MANY_TO_MANY"),
            relation(4, EmbeddedWorkflowCatalogIds.TASK_TYPE, "ONE_TO_MANY"),
        )
        private val CONTENT_HASH = EmbeddedWorkflowCatalogContentHash.contentHash()

        private fun relation(index: Int, objectTypeId: UUID, cardinality: String): RelationSpec {
            val definition = WorkflowAuthorizationRelationDefinitions.all[index]
            return RelationSpec(definition.id, definition.key, objectTypeId, cardinality)
        }
    }
}
