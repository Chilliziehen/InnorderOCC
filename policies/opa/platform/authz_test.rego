package innorder.platform.authz

import rego.v1

base_input := {
    "principal": {"id": "principal-1", "enabled": true},
    "entity": {"id": "entity-1"},
    "action": "resource.read",
    "resource": {"id": "resource-1", "active": true},
    "context": {"correlation_id": "correlation-1"},
    "forbidden_actions": [],
    "grants": [],
}

allow_grant := {
    "id": "grant-allow",
    "effect": "ALLOW",
    "action": "resource.read",
    "principal_id": "principal-1",
    "entity_id": "entity-1",
    "resource_id": "resource-1",
}

expected_grant_ref(grant_id) := sprintf("grant:%s", [crypto.sha256(grant_id)])

test_default_deny if {
    result := decision with input as base_input
    result == {
        "allow": false,
        "reason_codes": ["NO_MATCHING_ALLOW"],
        "reason_ids": [],
    }
}

test_matching_allow if {
    request := object.union(base_input, {"grants": [allow_grant]})
    result := decision with input as request
    result == {
        "allow": true,
        "reason_codes": ["ALLOW_GRANT_MATCH"],
        "reason_ids": [expected_grant_ref("grant-allow")],
    }
}

test_explicit_deny_overrides_allow if {
    deny := object.union(allow_grant, {"id": "grant-deny", "effect": "DENY"})
    request := object.union(base_input, {"grants": [allow_grant, deny]})
    result := decision with input as request
    result == {
        "allow": false,
        "reason_codes": ["EXPLICIT_DENY"],
        "reason_ids": [expected_grant_ref("grant-deny")],
    }
}

test_nonmatching_grant_denies if {
    grant := object.union(allow_grant, {"resource_id": "another-resource"})
    request := object.union(base_input, {"grants": [grant]})
    result := decision with input as request
    not result.allow
    result.reason_codes == ["NO_MATCHING_ALLOW"]
}

test_disabled_principal_is_non_overridable if {
    request := object.union(base_input, {
        "principal": {"id": "principal-1", "enabled": false},
        "grants": [allow_grant],
    })
    result := decision with input as request
    result == {
        "allow": false,
        "reason_codes": ["PRINCIPAL_DISABLED"],
        "reason_ids": ["platform:principal-disabled"],
    }
}

test_inactive_resource_is_non_overridable if {
    request := object.union(base_input, {
        "resource": {"id": "resource-1", "active": false},
        "grants": [allow_grant],
    })
    result := decision with input as request
    result == {
        "allow": false,
        "reason_codes": ["RESOURCE_INACTIVE"],
        "reason_ids": ["platform:resource-inactive"],
    }
}

test_forbidden_action_is_non_overridable if {
    request := object.union(base_input, {
        "forbidden_actions": ["resource.read"],
        "grants": [allow_grant],
    })
    result := decision with input as request
    result == {
        "allow": false,
        "reason_codes": ["ACTION_FORBIDDEN"],
        "reason_ids": ["platform:action-forbidden"],
    }
}

test_wildcards_match_all_supported_dimensions if {
    wildcard_grant := {
        "id": "grant-wildcard",
        "effect": "ALLOW",
        "action": "*",
        "principal_id": "*",
        "entity_id": "*",
        "resource_id": "*",
    }
    request := object.union(base_input, {"grants": [wildcard_grant]})
    result := decision with input as request
    result.allow
    result.reason_ids == [expected_grant_ref("grant-wildcard")]
}

test_partial_wildcard_does_not_match if {
    grant := object.union(allow_grant, {"action": "resource.*"})
    request := object.union(base_input, {"grants": [grant]})
    result := decision with input as request
    not result.allow
    result.reason_codes == ["NO_MATCHING_ALLOW"]
}

test_malformed_input_denies if {
    malformed := object.remove(base_input, {"context"})
    result := decision with input as malformed
    result == {
        "allow": false,
        "reason_codes": ["INVALID_INPUT"],
        "reason_ids": ["platform:invalid-input"],
    }
}

test_malformed_grant_denies_entire_request if {
    malformed_grant := object.remove(allow_grant, {"id"})
    request := object.union(base_input, {"grants": [malformed_grant]})
    result := decision with input as request
    result.reason_codes == ["INVALID_INPUT"]
}

test_malformed_deny_grant_fails_closed if {
    deny := object.union(allow_grant, {"id": "grant-deny", "effect": "DENY"})
    malformed_deny := object.remove(deny, {"action"})
    request := object.union(base_input, {"grants": [allow_grant, malformed_deny]})
    result := decision with input as request
    result == {
        "allow": false,
        "reason_codes": ["INVALID_INPUT"],
        "reason_ids": ["platform:invalid-input"],
    }
}

test_nonmatching_deny_does_not_override_matching_allow if {
    deny := object.union(allow_grant, {
        "id": "grant-deny-other-resource",
        "effect": "DENY",
        "resource_id": "another-resource",
    })
    request := object.union(base_input, {"grants": [allow_grant, deny]})
    result := decision with input as request
    result == {
        "allow": true,
        "reason_codes": ["ALLOW_GRANT_MATCH"],
        "reason_ids": [expected_grant_ref("grant-allow")],
    }
}

test_reason_output_is_sorted_and_non_secret if {
    deny_z := object.union(allow_grant, {
        "id": "SENSITIVE_GRANT_ID_Z",
        "effect": "DENY",
        "private_note": "SENSITIVE_GRANT_SECRET",
    })
    deny_a := object.union(allow_grant, {"id": "grant-a", "effect": "DENY"})
    request := object.union(base_input, {
        "principal": {
            "id": "principal-1",
            "enabled": true,
            "credential": "SENSITIVE_PRINCIPAL_CREDENTIAL",
        },
        "entity": {"id": "entity-1", "private_data": "SENSITIVE_ENTITY_DATA"},
        "resource": {
            "id": "resource-1",
            "active": true,
            "secret": "SENSITIVE_RESOURCE_SECRET",
        },
        "context": {
            "correlation_id": "correlation-1",
            "token": "SENSITIVE_CONTEXT_TOKEN",
        },
        "grants": [deny_z, deny_a],
    })
    result := decision with input as request
    expected_refs := sort({
        expected_grant_ref("SENSITIVE_GRANT_ID_Z"),
        expected_grant_ref("grant-a"),
    })
    result == {
        "allow": false,
        "reason_codes": ["EXPLICIT_DENY"],
        "reason_ids": expected_refs,
    }
    encoded := json.marshal(result)
    not contains(encoded, "SENSITIVE_PRINCIPAL_CREDENTIAL")
    not contains(encoded, "SENSITIVE_ENTITY_DATA")
    not contains(encoded, "SENSITIVE_RESOURCE_SECRET")
    not contains(encoded, "SENSITIVE_CONTEXT_TOKEN")
    not contains(encoded, "SENSITIVE_GRANT_ID_Z")
    not contains(encoded, "SENSITIVE_GRANT_SECRET")
}
