package innorder.platform.authz

import rego.v1

platform_release_id := "550e8400-e29b-41d4-a716-446655440000"
domain_release_id := "6ba7b810-9dad-41d1-80b4-00c04fd430c8"
customer_release_id := "123e4567-e89b-42d3-a456-426614174000"
principal_id := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
entity_id := "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
resource_id := "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
request_id := "dddddddd-dddd-4ddd-8ddd-dddddddddddd"

base_input := {
    "contractVersion": 1,
    "requestId": request_id,
    "authorizationRevision": 17,
    "releases": {
        "PLATFORM": platform_release_id,
        "DOMAIN": domain_release_id,
        "CUSTOMER": customer_release_id,
    },
    "principal": {"id": principal_id, "enabled": true},
    "entity": {"id": entity_id},
    "action": "resource.read",
    "resource": {"id": resource_id, "active": true},
    "context": {"correlationId": request_id},
    "forbiddenActions": [],
    "grants": [],
}

platform_allow := {
    "id": "platform-allow",
    "layer": "PLATFORM",
    "effect": "ALLOW",
    "action": "resource.read",
    "principalId": principal_id,
    "entityId": entity_id,
    "resourceId": resource_id,
}

grant(layer, effect, id) := object.union(platform_allow, {
    "id": id,
    "layer": layer,
    "effect": effect,
})

grant_ref(id) := sprintf("grant:%s", [crypto.sha256(id)])

expected(decision_value, codes, ids) := {
    "contractVersion": 1,
    "requestId": request_id,
    "authorizationRevision": 17,
    "releases": base_input.releases,
    "decision": decision_value,
    "allow": decision_value == "ALLOW",
    "reasonCodes": codes,
    "reasonIds": ids,
    "matchedPolicyIds": ids,
}

invalid_envelope := {
    "contractVersion": 1,
    "requestId": "00000000-0000-0000-0000-000000000000",
    "authorizationRevision": 0,
    "releases": {},
    "decision": "DENY",
    "allow": false,
    "reasonCodes": ["INVALID_INPUT"],
    "reasonIds": [],
    "matchedPolicyIds": [],
}

test_all_layers_can_allow if {
    every layer in ["PLATFORM", "DOMAIN", "CUSTOMER"] {
        g := grant(layer, "ALLOW", sprintf("%s-allow", [lower(layer)]))
        decision with input as object.union(base_input, {"grants": [g]}) == expected(
            "ALLOW", ["ALLOW_GRANT_MATCH"], [grant_ref(g.id)],
        )
    }
}

test_allow_and_abstain_allows if {
    result := decision with input as object.union(base_input, {"grants": [platform_allow]})
    result == expected("ALLOW", ["ALLOW_GRANT_MATCH"], [grant_ref(platform_allow.id)])
}

test_all_abstain_denies if {
    decision with input as base_input == expected("DENY", ["NO_MATCHING_ALLOW"], [])
}

test_absent_optional_layers_are_not_applicable if {
    releases := {"PLATFORM": platform_release_id}
    platform_request := object.union(object.remove(base_input, {"releases"}), {"releases": releases})
    result := decision with input as object.union(platform_request, {"grants": [platform_allow]})
    result.releases == releases
    result.allow
}

test_grant_for_absent_layer_invalidates_request if {
    request := object.union(object.remove(base_input, {"releases"}), {
        "releases": {"PLATFORM": platform_release_id},
        "grants": [grant("DOMAIN", "ALLOW", "domain-allow")],
    })
    decision with input as request == invalid_envelope
}

test_each_layer_explicit_deny_overrides_allows if {
    every layer in ["PLATFORM", "DOMAIN", "CUSTOMER"] {
        deny := grant(layer, "DENY", sprintf("%s-deny", [lower(layer)]))
        request := object.union(base_input, {"grants": [platform_allow, deny]})
        result := decision with input as request
        result.decision == "DENY"
        result.reasonCodes == ["EXPLICIT_DENY"]
        result.reasonIds == [grant_ref(deny.id)]
    }
}

test_baseline_denials_are_non_overridable if {
    disabled := object.union(base_input, {"principal": {"id": principal_id, "enabled": false}, "grants": [platform_allow]})
    inactive := object.union(base_input, {"resource": {"id": resource_id, "active": false}, "grants": [platform_allow]})
    forbidden := object.union(base_input, {"forbiddenActions": ["resource.read"], "grants": [platform_allow]})
    disabled_result := decision with input as disabled
    inactive_result := decision with input as inactive
    forbidden_result := decision with input as forbidden
    disabled_result.reasonCodes == ["PRINCIPAL_DISABLED"]
    inactive_result.reasonCodes == ["RESOURCE_INACTIVE"]
    forbidden_result.reasonCodes == ["ACTION_FORBIDDEN"]
}

test_exact_wildcard_matches_all_dimensions if {
    wildcard := object.union(platform_allow, {
        "id": "wildcard",
        "action": "*",
        "principalId": "*",
        "entityId": "*",
        "resourceId": "*",
    })
    result := decision with input as object.union(base_input, {"grants": [wildcard]})
    result.allow
}

test_partial_wildcard_is_invalid if {
    partial := object.union(platform_allow, {"action": "resource.*"})
    decision with input as object.union(base_input, {"grants": [partial]}) == invalid_envelope
}

test_revision_and_release_ids_echo_exactly if {
    result := decision with input as object.union(base_input, {"grants": [platform_allow]})
    result.authorizationRevision == 17
    result.releases == base_input.releases
}

test_reason_and_policy_ids_are_sorted_distinct_and_opaque if {
    deny_z := grant("PLATFORM", "DENY", "SENSITIVE_GRANT_ID_Z")
    deny_a := grant("DOMAIN", "DENY", "grant-a")
    request := object.union(base_input, {
        "context": {"token": "SENSITIVE_CONTEXT_TOKEN"},
        "grants": [deny_z, deny_a],
    })
    result := decision with input as request
    refs := sort({grant_ref(deny_z.id), grant_ref(deny_a.id)})
    result.reasonIds == refs
    result.matchedPolicyIds == refs
    encoded := json.marshal(result)
    not contains(encoded, "SENSITIVE_GRANT_ID_Z")
    not contains(encoded, "SENSITIVE_CONTEXT_TOKEN")
}

test_unknown_and_malformed_fields_deny_deterministically if {
    unknown := object.union(base_input, {"secret": "DO_NOT_REFLECT"})
    malformed := object.union(base_input, {"requestId": "DO_NOT_REFLECT"})
    principal_unknown := object.union(base_input, {"principal": {"id": principal_id, "enabled": true, "secret": true}})
    decision with input as unknown == invalid_envelope
    decision with input as malformed == invalid_envelope
    decision with input as principal_unknown == invalid_envelope
}

test_duplicate_release_and_grant_ids_deny if {
    duplicate_release := object.union(base_input, {
        "releases": {"PLATFORM": platform_release_id, "DOMAIN": platform_release_id},
    })
    duplicate_grant := object.union(base_input, {
        "grants": [platform_allow, object.union(platform_allow, {"effect": "DENY"})],
    })
    decision with input as duplicate_release == invalid_envelope
    decision with input as duplicate_grant == invalid_envelope
}

test_types_uuid_and_integer_bounds_deny if {
    every patch in [
        {"contractVersion": 2},
        {"authorizationRevision": -1},
        {"authorizationRevision": 9007199254740992},
        {"principal": {"id": "not-a-uuid", "enabled": true}},
        {"context": []},
        {"forbiddenActions": "resource.read"},
    ] {
        decision with input as object.union(base_input, patch) == invalid_envelope
    }
}

test_oversized_values_deny if {
    oversized_context := {sprintf("k%03d", [i]): "x" | some i in numbers.range(0, 32)}
    oversized_forbidden := [sprintf("action.%03d", [i]) | some i in numbers.range(0, 128)]
    oversized_grants := [object.union(platform_allow, {"id": sprintf("grant-%03d", [i])}) | some i in numbers.range(0, 256)]
    every patch in [
        {"action": concat("", ["a" | some _ in numbers.range(0, 128)])},
        {"context": oversized_context},
        {"context": {"value": concat("", ["x" | some _ in numbers.range(0, 4096)])}},
        {"forbiddenActions": oversized_forbidden},
        {"grants": oversized_grants},
        {"grants": [object.union(platform_allow, {"id": concat("", ["x" | some _ in numbers.range(0, 256)])})]},
    ] {
        decision with input as object.union(base_input, patch) == invalid_envelope
    }
}

test_duplicate_forbidden_actions_and_invalid_keys_deny if {
    every actions in [["resource.read", "resource.read"], ["resource.*"], [""]] {
        request := object.union(base_input, {"forbiddenActions": actions})
        decision with input as request == invalid_envelope
    }
}

test_unknown_grant_field_and_malformed_grant_uuid_deny if {
    unknown := object.union(platform_allow, {"secret": "DO_NOT_REFLECT"})
    malformed := object.union(platform_allow, {"principalId": "not-a-uuid"})
    decision with input as object.union(base_input, {"grants": [unknown]}) == invalid_envelope
    decision with input as object.union(base_input, {"grants": [malformed]}) == invalid_envelope
}
