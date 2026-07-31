package innorder.platform.authz

import rego.v1

contract_version := 1
max_safe_integer := 9007199254740991
action_key_max_length := 128
context_max_properties := 32
context_max_serialized_length := 4096
context_max_depth := 8
forbidden_actions_max_length := 128
grants_max_length := 256
grant_id_max_length := 256

default decision := {
    "contractVersion": 1,
    "requestId": "00000000-0000-0000-0000-000000000000",
    "authorizationRevision": 0,
    "releases": {},
    "decision": "DENY",
    "allow": false,
    "reasonCodes": ["INVALID_INPUT"],
    "reasonIds": ["policy:318efe2bf46c41026f67dbd60026ad3a8056a0a70c468cd38210021dee7de176"],
    "matchedPolicyIds": [],
}

decision := {
    "contractVersion": contract_version,
    "requestId": input.requestId,
    "authorizationRevision": input.authorizationRevision,
    "releases": input.releases,
    "decision": decision_name,
    "allow": decision_name == "ALLOW",
    "reasonCodes": sort(reason_codes),
    "reasonIds": sort(reason_ids),
    "matchedPolicyIds": sort(matched_policy_ids),
} if {
    valid_input
}

decision_name := "DENY" if {
    count(denial_reason_codes) > 0
}

decision_name := "ALLOW" if {
    count(denial_reason_codes) == 0
    count(matching_allow_refs) > 0
}

decision_name := "DENY" if {
    count(denial_reason_codes) == 0
    count(matching_allow_refs) == 0
}

reason_codes contains code if {
    code := denial_reason_codes[_]
}

reason_codes contains "ALLOW_GRANT_MATCH" if {
    decision_name == "ALLOW"
}

reason_codes contains "NO_MATCHING_ALLOW" if {
    count(denial_reason_codes) == 0
    count(matching_allow_refs) == 0
}

reason_ids contains id if {
    id := baseline_reason_ids[_]
}

reason_ids contains id if {
    id := matching_grant_refs[_]
}

matched_policy_ids contains id if {
    id := matching_grant_refs[_]
}

denial_reason_codes contains code if {
    code := baseline_reason_codes[_]
}

denial_reason_codes contains "EXPLICIT_DENY" if {
    count(matching_deny_refs) > 0
}

baseline_reason_codes contains "PRINCIPAL_DISABLED" if {
    not input.principal.enabled
}

baseline_reason_codes contains "RESOURCE_INACTIVE" if {
    not input.resource.active
}

baseline_reason_codes contains "ACTION_FORBIDDEN" if {
    input.action in input.forbiddenActions
}

baseline_reason_ids contains policy_ref("platform:principal-disabled") if {
    not input.principal.enabled
}

baseline_reason_ids contains policy_ref("platform:resource-inactive") if {
    not input.resource.active
}

baseline_reason_ids contains policy_ref("platform:action-forbidden") if {
    input.action in input.forbiddenActions
}

baseline_reason_ids contains policy_ref("platform:no-matching-allow") if {
    count(denial_reason_codes) == 0
    count(matching_allow_refs) == 0
}

applicable_layers := object.keys(input.releases)

layer_outcome(layer) := "DENY" if {
    layer in applicable_layers
    count(layer_matching_deny_refs(layer)) > 0
}

layer_outcome(layer) := "ALLOW" if {
    layer in applicable_layers
    count(layer_matching_deny_refs(layer)) == 0
    count(layer_matching_allow_refs(layer)) > 0
}

layer_outcome(layer) := "ABSTAIN" if {
    layer in applicable_layers
    count(layer_matching_deny_refs(layer)) == 0
    count(layer_matching_allow_refs(layer)) == 0
}

layer_matching_allow_refs(layer) := {grant_ref(grant) |
    some grant in input.grants
    grant.effect == "ALLOW"
    grant_matches_layer_release(grant, layer)
}

layer_matching_deny_refs(layer) := {grant_ref(grant) |
    some grant in input.grants
    grant.effect == "DENY"
    grant_matches_layer_release(grant, layer)
}

matching_allow_refs contains ref if {
    some layer in applicable_layers
    layer_outcome(layer) in {"ALLOW", "DENY"}
    ref := layer_matching_allow_refs(layer)[_]
}

matching_deny_refs contains ref if {
    some layer in applicable_layers
    layer_outcome(layer) == "DENY"
    ref := layer_matching_deny_refs(layer)[_]
}

matching_grant_refs contains ref if {
    ref := matching_allow_refs[_]
}

matching_grant_refs contains ref if {
    ref := matching_deny_refs[_]
}

grant_matches_layer_release(grant, layer) if {
    grant.layer == layer
    lower(grant.releaseId) == lower(input.releases[layer])
    action_matches(grant.action, input.action)
    uuid_matches(grant.principalId, input.principal.id)
    uuid_matches(grant.entityId, input.entity.id)
    uuid_matches(grant.resourceId, input.resource.id)
}

action_matches("*", _)

action_matches(pattern, value) if {
    pattern != "*"
    pattern == value
}

uuid_matches("*", _)

uuid_matches(pattern, value) if {
    pattern != "*"
    lower(pattern) == lower(value)
}

grant_ref(grant) := sprintf("grant:%s", [crypto.sha256(grant.id)])

policy_ref(id) := sprintf("policy:%s", [crypto.sha256(id)])

valid_input if {
    is_object(input)
    object.keys(input) == {
        "contractVersion", "requestId", "authorizationRevision", "releases",
        "principal", "entity", "action", "resource", "context",
        "forbiddenActions", "grants",
    }
    input.contractVersion == contract_version
    valid_uuid(input.requestId)
    valid_revision(input.authorizationRevision)
    valid_releases(input.releases)
    valid_principal(input.principal)
    valid_entity(input.entity)
    valid_action(input.action)
    valid_resource(input.resource)
    valid_context(input.context)
    valid_forbidden_actions(input.forbiddenActions)
    valid_grants(input.grants, input.releases)
}

valid_revision(value) if {
    is_number(value)
    value >= 0
    value <= max_safe_integer
    round(value) == value
}

valid_releases(releases) if {
    is_object(releases)
    object.keys(releases) - {"PLATFORM", "DOMAIN", "CUSTOMER"} == set()
    valid_uuid(releases.PLATFORM)
    every key in object.keys(releases) {
        valid_uuid(releases[key])
    }
    release_ids := [lower(id) | some key; id := releases[key]]
    every id in release_ids {
        valid_uuid(id)
    }
    count(release_ids) == count({id | some id in release_ids})
}

valid_principal(principal) if {
    is_object(principal)
    object.keys(principal) == {"id", "enabled"}
    valid_uuid(principal.id)
    is_boolean(principal.enabled)
}

valid_entity(entity) if {
    is_object(entity)
    object.keys(entity) == {"id"}
    valid_uuid(entity.id)
}

valid_resource(resource) if {
    is_object(resource)
    object.keys(resource) == {"id", "active"}
    valid_uuid(resource.id)
    is_boolean(resource.active)
}

valid_context(context) if {
    is_object(context)
    count(context) <= context_max_properties
    count(json.marshal(context)) <= context_max_serialized_length
    walked := [entry | entry := walk(context)]
    every entry in walked {
        count(entry[0]) <= context_max_depth
        valid_context_path(entry[0])
        valid_context_node(entry[1])
    }
}

valid_context_path(path) if {
    every segment in path {
        valid_context_path_segment(segment)
    }
}

valid_context_path_segment(segment) if {
    not is_string(segment)
}

valid_context_path_segment(segment) if {
    is_string(segment)
    safe_context_string(segment)
}

valid_context_node(value) if {
    not is_string(value)
}

valid_context_node(value) if {
    is_string(value)
    safe_context_string(value)
}

safe_context_string(value) if {
    safe_unicode(value)
    not contains(value, "<")
    not contains(value, ">")
    not contains(value, "&")
    not contains(value, " ")
    not contains(value, " ")
}

safe_unicode(value) if {
    not contains(value, "�")
}

valid_forbidden_actions(actions) if {
    is_array(actions)
    count(actions) <= forbidden_actions_max_length
    every action in actions {
        valid_action(action)
    }
    count(actions) == count({action | some action in actions})
}

valid_grants(grants, releases) if {
    is_array(grants)
    count(grants) <= grants_max_length
    every grant in grants {
        valid_grant(grant, releases)
    }
    count(grants) == count({grant.id | some grant in grants})
}

valid_grant(grant, releases) if {
    is_object(grant)
    object.keys(grant) == {
        "id", "layer", "releaseId", "effect", "action", "principalId", "entityId", "resourceId",
    }
    is_string(grant.id)
    safe_unicode(grant.id)
    count(grant.id) >= 1
    count(grant.id) <= grant_id_max_length
    grant.layer in {"PLATFORM", "DOMAIN", "CUSTOMER"}
    grant.layer in object.keys(releases)
    valid_uuid(grant.releaseId)
    lower(grant.releaseId) == lower(releases[grant.layer])
    grant.effect in {"ALLOW", "DENY"}
    valid_action_or_wildcard(grant.action)
    valid_uuid_or_wildcard(grant.principalId)
    valid_uuid_or_wildcard(grant.entityId)
    valid_uuid_or_wildcard(grant.resourceId)
}

valid_action(value) if {
    is_string(value)
    count(value) >= 1
    count(value) <= action_key_max_length
    regex.match("^[A-Za-z0-9][A-Za-z0-9._:-]*$", value)
}

valid_action_or_wildcard("*")

valid_action_or_wildcard(value) if {
    value != "*"
    valid_action(value)
}

valid_uuid_or_wildcard("*")

valid_uuid_or_wildcard(value) if {
    value != "*"
    valid_uuid(value)
}

valid_uuid(value) if {
    is_string(value)
    regex.match("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$", value)
}
