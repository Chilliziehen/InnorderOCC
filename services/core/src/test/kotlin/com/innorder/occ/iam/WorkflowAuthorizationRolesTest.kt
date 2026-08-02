package com.innorder.occ.iam

import com.fasterxml.jackson.databind.ObjectMapper
import com.innorder.occ.authz.WorkflowAuthorizationRole
import com.innorder.occ.authz.WorkflowAuthorizationRoles
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import java.util.UUID

class WorkflowAuthorizationRolesTest {
    @Test
    fun `workflow roles expose stable production identities and exact platform grants`() {
        assertThat(WorkflowAuthorizationRoles.all).containsExactly(
            WorkflowAuthorizationRole(
                UUID.fromString("00000000-0000-7000-8000-000000000201"),
                "role:process-owner",
                "Process Owner",
            ),
            WorkflowAuthorizationRole(
                UUID.fromString("00000000-0000-7000-8000-000000000202"),
                "role:participant",
                "Participant",
            ),
            WorkflowAuthorizationRole(
                UUID.fromString("00000000-0000-7000-8000-000000000203"),
                "role:domain-modeler",
                "Domain Modeler",
            ),
        )
        assertThat(WorkflowAuthorizationRoles.processOwnerActions).containsExactlyInAnyOrder(
            "cohort.create", "cohort.read", "cohort.update", "cohort.owner.transfer", "cohort.members.manage",
            "cohort.archive", "cohort.process.start", "process.read", "process.suspend", "process.resume",
            "process.cancel", "process.fail", "process.transfer", "process.reconcile", "process.wait.release",
            "task.fail", "task.assignment.manage",
        )
        assertThat(WorkflowAuthorizationRoles.participantActions).containsExactlyInAnyOrder(
            "cohort.read", "process.read", "task.read", "task.claim", "task.complete",
        )

        val grants = ObjectMapper().readTree(BootstrapPolicyBaseline.manifest).path("roleGrants")
        val actionsByRole = grants.groupBy(
            { it.path("subjectRoleEntityKey").textValue() },
            { it.path("action").textValue() },
        ).mapValues { (_, actions) -> actions.toSet() }
        assertThat(actionsByRole).containsEntry("role:viewer", setOf("occ.read"))
            .containsEntry("role:operator", setOf("occ.execute", "occ.read"))
            .containsEntry("role:administrator", setOf("occ.admin", "occ.execute", "occ.read"))
            .containsEntry("role:process-owner", WorkflowAuthorizationRoles.processOwnerActions)
            .containsEntry("role:participant", WorkflowAuthorizationRoles.participantActions)
            .doesNotContainKey("role:domain-modeler")
        val workflowActions = WorkflowAuthorizationRoles.processOwnerActions + WorkflowAuthorizationRoles.participantActions
        assertThat(actionsByRole.filterKeys { it in setOf("role:administrator", "role:operator", "role:viewer") }
            .values.flatten()).doesNotContainAnyElementsOf(workflowActions)
    }
}
