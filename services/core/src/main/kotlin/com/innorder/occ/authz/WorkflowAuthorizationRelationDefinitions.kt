package com.innorder.occ.authz

import java.util.UUID
import java.util.Collections

data class WorkflowAuthorizationRelationDefinition(
    val id: UUID,
    val key: String,
    val relation: AuthorizationRelation,
)

object WorkflowAuthorizationRelationDefinitions {
    const val COHORT_OWNER_ID = "00000000-0000-7000-8000-000000000101"
    const val COHORT_TEACHER_ID = "00000000-0000-7000-8000-000000000102"
    const val COHORT_PARTICIPANT_ID = "00000000-0000-7000-8000-000000000103"
    const val TASK_CANDIDATE_ID = "00000000-0000-7000-8000-000000000104"
    const val TASK_ASSIGNEE_ID = "00000000-0000-7000-8000-000000000105"

    val all = Collections.unmodifiableList(listOf(
        definition(COHORT_OWNER_ID, "cohort_owner", AuthorizationRelation.COHORT_OWNER),
        definition(COHORT_TEACHER_ID, "cohort_teacher", AuthorizationRelation.COHORT_TEACHER),
        definition(COHORT_PARTICIPANT_ID, "cohort_participant", AuthorizationRelation.COHORT_PARTICIPANT),
        definition(TASK_CANDIDATE_ID, "task_candidate", AuthorizationRelation.TASK_CANDIDATE),
        definition(TASK_ASSIGNEE_ID, "task_assignee", AuthorizationRelation.TASK_ASSIGNEE),
    ))
    val byId = Collections.unmodifiableMap(all.associateBy { it.id })
    val byKey = Collections.unmodifiableMap(all.associateBy { it.key })

    private fun definition(id: String, key: String, relation: AuthorizationRelation) =
        WorkflowAuthorizationRelationDefinition(UUID.fromString(id), key, relation)
}
