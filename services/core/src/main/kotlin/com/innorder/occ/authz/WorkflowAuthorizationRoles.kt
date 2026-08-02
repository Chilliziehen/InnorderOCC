package com.innorder.occ.authz

import java.util.Collections
import java.util.UUID

data class WorkflowAuthorizationRole(val id: UUID, val key: String, val displayName: String)

object WorkflowAuthorizationRoles {
    const val PROCESS_OWNER_ID = "00000000-0000-7000-8000-000000000201"
    const val PARTICIPANT_ID = "00000000-0000-7000-8000-000000000202"
    const val DOMAIN_MODELER_ID = "00000000-0000-7000-8000-000000000203"

    val processOwner = role(PROCESS_OWNER_ID, "role:process-owner", "Process Owner")
    val participant = role(PARTICIPANT_ID, "role:participant", "Participant")
    val domainModeler = role(DOMAIN_MODELER_ID, "role:domain-modeler", "Domain Modeler")
    val all = Collections.unmodifiableList(listOf(processOwner, participant, domainModeler))
    val byId = Collections.unmodifiableMap(all.associateBy { it.id })
    val byKey = Collections.unmodifiableMap(all.associateBy { it.key })

    val processOwnerActions = Collections.unmodifiableSet(linkedSetOf(
        "cohort.create", "cohort.read", "cohort.update", "cohort.owner.transfer", "cohort.members.manage",
        "cohort.archive", "cohort.process.start", "process.read", "process.suspend", "process.resume",
        "process.cancel", "process.fail", "process.transfer", "process.reconcile", "process.wait.release",
        "task.fail", "task.assignment.manage",
    ))
    val participantActions = Collections.unmodifiableSet(linkedSetOf(
        "cohort.read", "process.read", "task.read", "task.claim", "task.complete",
    ))
    val capabilitiesByRoleKey = Collections.unmodifiableMap(linkedMapOf(
        processOwner.key to processOwnerActions,
        participant.key to participantActions,
        domainModeler.key to emptySet(),
    ))

    private fun role(id: String, key: String, displayName: String) =
        WorkflowAuthorizationRole(UUID.fromString(id), key, displayName)
}
