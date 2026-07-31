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
    "opaRevision": "platform-authz-v1",
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
    "releaseId": platform_release_id,
    "effect": "ALLOW",
    "action": "resource.read",
    "principalId": principal_id,
    "entityId": entity_id,
    "resourceId": resource_id,
}

grant(layer, effect, id) := object.union(platform_allow, {
    "id": id,
    "layer": layer,
    "releaseId": base_input.releases[layer],
    "effect": effect,
})

grant_ref(id) := sprintf("grant:%s", [crypto.sha256(id)])

policy_ref(id) := sprintf("policy:%s", [crypto.sha256(id)])

expected(decision_value, codes, ids) := {
    "contractVersion": 1,
    "opaRevision": "platform-authz-v1",
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
    "opaRevision": "",
    "requestId": "00000000-0000-0000-0000-000000000000",
    "authorizationRevision": 0,
    "releases": {},
    "decision": "DENY",
    "allow": false,
    "reasonCodes": ["INVALID_INPUT"],
    "reasonIds": [policy_ref("platform:invalid-input")],
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
    result := decision with input as base_input
    result.reasonCodes == ["NO_MATCHING_ALLOW"]
    result.reasonIds == [policy_ref("platform:no-matching-allow")]
    result.matchedPolicyIds == []
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
        refs := sort({grant_ref(platform_allow.id), grant_ref(deny.id)})
        result.reasonIds == refs
        result.matchedPolicyIds == refs
    }
}

test_release_mismatch_and_cross_release_reuse_are_invalid if {
    mismatch := object.union(platform_allow, {"releaseId": domain_release_id})
    cross_layer := object.union(platform_allow, {"layer": "DOMAIN", "releaseId": platform_release_id})
    reused_layer := object.union(platform_allow, {"id": "reused-layer", "releaseId": customer_release_id})
    every grants in [[mismatch], [cross_layer], [platform_allow, reused_layer]] {
        decision with input as object.union(base_input, {"grants": grants}) == invalid_envelope
    }
}

test_uuid_identity_is_case_insensitive_but_actions_are_not if {
    mixed := object.union(platform_allow, {
        "releaseId": upper(platform_release_id),
        "principalId": upper(principal_id),
        "entityId": upper(entity_id),
        "resourceId": upper(resource_id),
    })
    mixed_result := decision with input as object.union(base_input, {"grants": [mixed]})
    mixed_result.allow
    action_case := object.union(mixed, {"action": "RESOURCE.READ"})
    action_result := decision with input as object.union(base_input, {"grants": [action_case]})
    action_result.reasonCodes == ["NO_MATCHING_ALLOW"]
}

test_layer_outcomes_use_only_bound_release_grants if {
    platform_deny := grant("PLATFORM", "DENY", "platform-deny")
    domain_allow := grant("DOMAIN", "ALLOW", "domain-allow")
    result := decision with input as object.union(base_input, {"grants": [platform_deny, domain_allow]})
    result.decision == "DENY"
    result.reasonCodes == ["EXPLICIT_DENY"]
    result.matchedPolicyIds == sort({grant_ref(platform_deny.id), grant_ref(domain_allow.id)})
}

test_baseline_denials_are_non_overridable if {
    disabled := object.union(base_input, {"principal": {"id": principal_id, "enabled": false}, "grants": [platform_allow]})
    inactive := object.union(base_input, {"resource": {"id": resource_id, "active": false}, "grants": [platform_allow]})
    forbidden := object.union(base_input, {"forbiddenActions": ["resource.read"], "grants": [platform_allow]})
    disabled_result := decision with input as disabled
    inactive_result := decision with input as inactive
    forbidden_result := decision with input as forbidden
    disabled_result.reasonCodes == ["PRINCIPAL_DISABLED"]
    disabled_result.reasonIds == sort({grant_ref(platform_allow.id), policy_ref("platform:principal-disabled")})
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
    result.opaRevision == "platform-authz-v1"
    result.releases == base_input.releases
}

test_runtime_revision_mismatch_fails_closed if {
    decision with input as object.union(base_input, {"opaRevision": "platform-authz-v2"}) == invalid_envelope
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
    case_duplicate_release := object.union(base_input, {
        "releases": {"PLATFORM": platform_release_id, "DOMAIN": upper(platform_release_id)},
    })
    decision with input as duplicate_release == invalid_envelope
    decision with input as duplicate_grant == invalid_envelope
    decision with input as case_duplicate_release == invalid_envelope
}

invalid_optional_release(layer, value) if {
    releases := object.union(base_input.releases, {layer: value})
    request := object.union(base_input, {"releases": releases, "grants": [platform_allow]})
    result := decision with input as request
    result == invalid_envelope
}

test_malformed_optional_releases_fail_closed_with_matching_allow if {
    invalid_optional_release("DOMAIN", null)
    invalid_optional_release("DOMAIN", 42)
    invalid_optional_release("DOMAIN", true)
    invalid_optional_release("DOMAIN", [])
    invalid_optional_release("DOMAIN", {})
    invalid_optional_release("DOMAIN", "")
    invalid_optional_release("CUSTOMER", null)
    invalid_optional_release("CUSTOMER", 42)
    invalid_optional_release("CUSTOMER", false)
    invalid_optional_release("CUSTOMER", [])
    invalid_optional_release("CUSTOMER", {})
    invalid_optional_release("CUSTOMER", "")
}

test_grant_id_length_counts_unicode_code_points if {
    accepted := object.union(platform_allow, {"id": concat("", ["😀" | some _ in numbers.range(1, 200)])})
    rejected := object.union(platform_allow, {"id": concat("", ["😀" | some _ in numbers.range(1, 257)])})
    accepted_result := decision with input as object.union(base_input, {"grants": [accepted]})
    accepted_result.allow
    decision with input as object.union(base_input, {"grants": [rejected]}) == invalid_envelope
}

test_replacement_character_is_rejected_recursively if {
    bad_grant := object.union(platform_allow, {"id": "bad�grant"})
    grant_result := decision with input as object.union(base_input, {"grants": [bad_grant]})
    value_result := decision with input as object.union(base_input, {"context": {"value": "bad�value"}})
    key_result := decision with input as object.union(base_input, {"context": {"bad�key": "value"}})
    nested_result := decision with input as object.union(base_input, {"context": {"nested": [{"value": "�"}]}})
    grant_result == invalid_envelope
    value_result == invalid_envelope
    key_result == invalid_envelope
    nested_result == invalid_envelope
}

test_valid_astral_unicode_and_context_depth_boundary if {
    astral := object.union(platform_allow, {"id": "safe-😀-grant"})
    accepted_context := {"a": {"b": {"c": {"d": {"e": {"f": {"g": {"h": "safe-🚀"}}}}}}}}
    rejected_context := {"a": {"b": {"c": {"d": {"e": {"f": {"g": {"h": {"i": "unsafe"}}}}}}}}}
    accepted := object.union(base_input, {"context": accepted_context, "grants": [astral]})
    accepted_result := decision with input as accepted
    accepted_result.allow
    decision with input as object.union(base_input, {"context": rejected_context}) == invalid_envelope
}

invalid_context_value(value) if {
    result := decision with input as object.union(base_input, {"context": {"nested": {"value": value}}})
    result == invalid_envelope
}

invalid_context_key(value) if {
    result := decision with input as object.union(base_input, {"context": {value: "metadata"}})
    result == invalid_envelope
}

test_context_rejects_serializer_ambiguous_characters if {
    invalid_context_value("<")
    invalid_context_value(">")
    invalid_context_value("&")
    invalid_context_value(" ")
    invalid_context_value(" ")
    invalid_context_key("<")
    invalid_context_key(">")
    invalid_context_key("&")
    invalid_context_key(" ")
    invalid_context_key(" ")
}

test_context_accepts_escaped_controls_and_astral_unicode if {
    context := {"escaped\nkey": "tab\tquote\"slash\\nul\u0000 astral😀"}
    result := decision with input as object.union(base_input, {"context": context})
    result.reasonCodes == ["NO_MATCHING_ALLOW"]
}

test_types_uuid_and_integer_bounds_deny if {
    every patch in [
        {"contractVersion": 2},
        {"authorizationRevision": -1},
        {"authorizationRevision": 9007199254740992},
        {"principal": {"id": "not-a-uuid", "enabled": true}},
        {"requestId": "00000000-0000-0000-0000-000000000000"},
        {"requestId": "dddddddd-dddd-0ddd-8ddd-dddddddddddd"},
        {"requestId": "dddddddd-dddd-4ddd-7ddd-dddddddddddd"},
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
