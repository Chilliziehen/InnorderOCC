package innorder.platform.authz

import rego.v1

default decision := {
    "allow": false,
    "reason_codes": ["INVALID_INPUT"],
    "reason_ids": ["platform:invalid-input"],
}

default authorized := false

decision := {
    "allow": false,
    "reason_codes": ["INVALID_INPUT"],
    "reason_ids": ["platform:invalid-input"],
} if {
    not valid_input
}

decision := {
    "allow": authorized,
    "reason_codes": sort(decision_reason_codes),
    "reason_ids": sort(decision_reason_ids),
} if {
    valid_input
}

valid_input if {
    is_object(input)
    is_object(input.principal)
    nonempty_string(input.principal.id)
    is_boolean(input.principal.enabled)
    is_object(input.entity)
    nonempty_string(input.entity.id)
    nonempty_string(input.action)
    is_object(input.resource)
    nonempty_string(input.resource.id)
    is_boolean(input.resource.active)
    is_object(input.context)
    is_array(input.forbidden_actions)
    every action in input.forbidden_actions {
        nonempty_string(action)
    }
    is_array(input.grants)
    every grant in input.grants {
        valid_grant(grant)
    }
}

valid_grant(grant) if {
    is_object(grant)
    nonempty_string(grant.id)
    grant.effect in {"ALLOW", "DENY"}
    nonempty_string(grant.action)
    nonempty_string(grant.principal_id)
    nonempty_string(grant.entity_id)
    nonempty_string(grant.resource_id)
}

nonempty_string(value) if {
    is_string(value)
    value != ""
}

value_matches(pattern, _) if {
    pattern == "*"
}

value_matches(pattern, value) if {
    pattern == value
}

grant_matches(grant) if {
    value_matches(grant.action, input.action)
    value_matches(grant.principal_id, input.principal.id)
    value_matches(grant.entity_id, input.entity.id)
    value_matches(grant.resource_id, input.resource.id)
}

grant_ref(grant) := sprintf("grant:%s", [crypto.sha256(grant.id)])

matching_allow_refs contains grant_ref(grant) if {
    grant := input.grants[_]
    grant.effect == "ALLOW"
    grant_matches(grant)
}

matching_deny_refs contains grant_ref(grant) if {
    grant := input.grants[_]
    grant.effect == "DENY"
    grant_matches(grant)
}

baseline_reason_codes contains "PRINCIPAL_DISABLED" if {
    input.principal.enabled == false
}

baseline_reason_codes contains "RESOURCE_INACTIVE" if {
    input.resource.active == false
}

baseline_reason_codes contains "ACTION_FORBIDDEN" if {
    input.action in input.forbidden_actions
}

baseline_reason_ids contains "platform:principal-disabled" if {
    input.principal.enabled == false
}

baseline_reason_ids contains "platform:resource-inactive" if {
    input.resource.active == false
}

baseline_reason_ids contains "platform:action-forbidden" if {
    input.action in input.forbidden_actions
}

authorized := true if {
    count(baseline_reason_codes) == 0
    count(matching_deny_refs) == 0
    count(matching_allow_refs) > 0
}

decision_reason_codes contains code if {
    code := baseline_reason_codes[_]
}

decision_reason_codes contains "EXPLICIT_DENY" if {
    count(matching_deny_refs) > 0
}

decision_reason_codes contains "ALLOW_GRANT_MATCH" if {
    authorized
}

decision_reason_codes contains "NO_MATCHING_ALLOW" if {
    count(baseline_reason_codes) == 0
    count(matching_deny_refs) == 0
    count(matching_allow_refs) == 0
}

decision_reason_ids contains reason_id if {
    reason_id := baseline_reason_ids[_]
}

decision_reason_ids contains grant_ref if {
    grant_ref := matching_deny_refs[_]
}

decision_reason_ids contains grant_ref if {
    authorized
    grant_ref := matching_allow_refs[_]
}
