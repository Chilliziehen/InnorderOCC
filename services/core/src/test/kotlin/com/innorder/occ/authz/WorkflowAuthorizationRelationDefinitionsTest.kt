package com.innorder.occ.authz

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import java.util.UUID

class WorkflowAuthorizationRelationDefinitionsTest {
    @Test
    fun `canonical workflow relation definitions expose stable production ids and keys`() {
        assertThat(WorkflowAuthorizationRelationDefinitions.all).containsExactly(
            WorkflowAuthorizationRelationDefinition(
                UUID.fromString("00000000-0000-7000-8000-000000000101"),
                "cohort_owner",
                AuthorizationRelation.COHORT_OWNER,
            ),
            WorkflowAuthorizationRelationDefinition(
                UUID.fromString("00000000-0000-7000-8000-000000000102"),
                "cohort_teacher",
                AuthorizationRelation.COHORT_TEACHER,
            ),
            WorkflowAuthorizationRelationDefinition(
                UUID.fromString("00000000-0000-7000-8000-000000000103"),
                "cohort_participant",
                AuthorizationRelation.COHORT_PARTICIPANT,
            ),
            WorkflowAuthorizationRelationDefinition(
                UUID.fromString("00000000-0000-7000-8000-000000000104"),
                "task_candidate",
                AuthorizationRelation.TASK_CANDIDATE,
            ),
            WorkflowAuthorizationRelationDefinition(
                UUID.fromString("00000000-0000-7000-8000-000000000105"),
                "task_assignee",
                AuthorizationRelation.TASK_ASSIGNEE,
            ),
        )
        assertThat(WorkflowAuthorizationRelationDefinitions.byId.keys)
            .containsExactlyElementsOf(WorkflowAuthorizationRelationDefinitions.all.map { it.id })
        assertThat(WorkflowAuthorizationRelationDefinitions.byKey.keys)
            .containsExactlyElementsOf(WorkflowAuthorizationRelationDefinitions.all.map { it.key })
        assertThatThrownBy {
            (WorkflowAuthorizationRelationDefinitions.byId as MutableMap<UUID, WorkflowAuthorizationRelationDefinition>).clear()
        }.isInstanceOf(UnsupportedOperationException::class.java)
        assertThatThrownBy {
            (WorkflowAuthorizationRelationDefinitions.byKey as MutableMap<String, WorkflowAuthorizationRelationDefinition>).clear()
        }.isInstanceOf(UnsupportedOperationException::class.java)
    }
}
