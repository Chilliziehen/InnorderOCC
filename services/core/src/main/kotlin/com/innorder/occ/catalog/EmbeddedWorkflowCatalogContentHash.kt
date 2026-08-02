package com.innorder.occ.catalog

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.SerializationFeature
import com.innorder.occ.authz.WorkflowAuthorizationRelationDefinitions
import com.innorder.occ.iam.BootstrapIds
import java.security.MessageDigest
import java.util.UUID

object EmbeddedWorkflowCatalogContentHash {
    private val mapper = ObjectMapper().enable(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS)

    fun contentHash(): String = hash(semanticDocument())

    fun hash(value: Any): String = MessageDigest.getInstance("SHA-256")
        .digest(mapper.writeValueAsBytes(value))
        .joinToString("") { "%02x".format(it) }

    private fun semanticDocument(): Map<String, Any> = linkedMapOf(
        "schemaVersion" to 1,
        "package" to linkedMapOf(
            "id" to EmbeddedWorkflowCatalogIds.PACKAGE.toString(),
            "packageKey" to "embedded-workflow",
            "name" to "Embedded Workflow",
            "description" to "Immutable workflow authorization catalog prerequisites",
            "status" to "ACTIVE",
        ),
        "packageVersion" to linkedMapOf(
            "id" to EmbeddedWorkflowCatalogIds.PACKAGE_VERSION.toString(),
            "packageId" to EmbeddedWorkflowCatalogIds.PACKAGE.toString(),
            "semver" to "1.0.0",
            "status" to "PUBLISHED",
            "manifest" to linkedMapOf("catalog" to "embedded-workflow", "version" to 1),
        ),
        "entityTypes" to TYPE_FIELDS.map { (id, _, key, name) ->
            linkedMapOf(
                "id" to id.toString(),
                "packageId" to EmbeddedWorkflowCatalogIds.PACKAGE.toString(),
                "typeKey" to key,
                "name" to name,
                "entityKind" to "RESOURCE",
                "authorizable" to true,
            )
        },
        "entityTypeVersions" to TYPE_FIELDS.map { (id, versionId) ->
            linkedMapOf(
                "id" to versionId.toString(),
                "entityTypeId" to id.toString(),
                "packageVersionId" to EmbeddedWorkflowCatalogIds.PACKAGE_VERSION.toString(),
                "schemaVersion" to 1,
                "jsonSchema" to emptyMap<String, Any>(),
                "uiSchema" to emptyMap<String, Any>(),
                "authSchema" to emptyMap<String, Any>(),
                "indexSpec" to emptyMap<String, Any>(),
            )
        },
        "relationDefinitions" to RELATION_FIELDS.map { (index, objectTypeId, cardinality) ->
            val relation = WorkflowAuthorizationRelationDefinitions.all[index]
            linkedMapOf(
                "id" to relation.id.toString(),
                "packageVersionId" to EmbeddedWorkflowCatalogIds.PACKAGE_VERSION.toString(),
                "relationKey" to relation.key,
                "subjectTypeId" to BootstrapIds.USER_TYPE.toString(),
                "objectTypeId" to objectTypeId.toString(),
                "cardinality" to cardinality,
                "transitive" to false,
                "acyclic" to false,
                "authRelevant" to true,
                "maxSubjects" to null,
                "maxObjects" to null,
            )
        },
        "actionDefinitions" to emptyList<Any>(),
        "formDefinitions" to emptyList<Any>(),
        "evidenceRequirements" to emptyList<Any>(),
        "riskRuleDefinitions" to emptyList<Any>(),
        "workflowDefinitions" to emptyList<Any>(),
    )

    private data class TypeFields(val id: UUID, val versionId: UUID, val key: String, val name: String)
    private data class RelationFields(val index: Int, val objectTypeId: UUID, val cardinality: String)

    private val TYPE_FIELDS = listOf(
        TypeFields(EmbeddedWorkflowCatalogIds.COHORT_TYPE, EmbeddedWorkflowCatalogIds.COHORT_TYPE_VERSION, "cohort", "Cohort"),
        TypeFields(EmbeddedWorkflowCatalogIds.PROCESS_TYPE, EmbeddedWorkflowCatalogIds.PROCESS_TYPE_VERSION, "process", "Process"),
        TypeFields(EmbeddedWorkflowCatalogIds.TASK_TYPE, EmbeddedWorkflowCatalogIds.TASK_TYPE_VERSION, "task", "Task"),
    )
    private val RELATION_FIELDS = listOf(
        RelationFields(0, EmbeddedWorkflowCatalogIds.COHORT_TYPE, "ONE_TO_MANY"),
        RelationFields(1, EmbeddedWorkflowCatalogIds.COHORT_TYPE, "MANY_TO_MANY"),
        RelationFields(2, EmbeddedWorkflowCatalogIds.COHORT_TYPE, "MANY_TO_MANY"),
        RelationFields(3, EmbeddedWorkflowCatalogIds.TASK_TYPE, "MANY_TO_MANY"),
        RelationFields(4, EmbeddedWorkflowCatalogIds.TASK_TYPE, "ONE_TO_MANY"),
    )
}
