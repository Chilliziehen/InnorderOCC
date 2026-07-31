# Platform Authorization Policy

Evaluate the strict version-1 contract at
`data.innorder.platform.authz.decision`. The HTTP request body wraps the policy
input under `input`:

```json
{
  "input": {
    "contractVersion": 1,
    "requestId": "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    "authorizationRevision": 17,
    "releases": {
      "PLATFORM": "550e8400-e29b-41d4-a716-446655440000",
      "DOMAIN": "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
      "CUSTOMER": "123e4567-e89b-42d3-a456-426614174000"
    },
    "principal": {
      "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "enabled": true
    },
    "entity": {"id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"},
    "action": "resource.read",
    "resource": {
      "id": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      "active": true
    },
    "context": {"correlationId": "dddddddd-dddd-4ddd-8ddd-dddddddddddd"},
    "forbiddenActions": [],
    "grants": [{
      "id": "opaque-core-grant-id",
      "layer": "PLATFORM",
      "releaseId": "550e8400-e29b-41d4-a716-446655440000",
      "effect": "ALLOW",
      "action": "resource.read",
      "principalId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "entityId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "resourceId": "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
    }]
  }
}
```

`PLATFORM` is required. `DOMAIN` and `CUSTOMER` releases are optional. A grant is
valid only when its `releaseId` is the same UUID value, compared case-insensitively,
as the release selected for its `layer`; grants cannot target an absent optional
layer. Grant selectors accept
an exact action or UUID, or the complete `*` wildcard.

Core owns relationship and policy-release loading. Before constructing this
input, Core filters relationships and grants for active, unexpired applicability.
OPA evaluates only the bounded, release-bound grant facts supplied by Core; it
does not load releases or interpret relationship validity periods.

Each applicable layer evaluates independently. A matching deny makes that layer
`DENY`; otherwise a matching allow makes it `ALLOW`; otherwise it is `ABSTAIN`.
Any layer deny or platform baseline denial wins. With no denial, at least one
layer must allow. All layers abstaining produces `DENY` with
`NO_MATCHING_ALLOW`.

A valid decision echoes the request ID, authorization revision, and exact
release object. `reasonCodes`, `reasonIds`, and `matchedPolicyIds` are sorted and
distinct. Grant references use `grant:` plus the lowercase SHA-256 digest of the
opaque grant ID. Static policy references use `policy:` plus the lowercase
SHA-256 digest of a canonical platform policy ID. Output never contains raw
grant IDs or request context.

Malformed input returns the fixed envelope with a nil request ID, revision zero,
empty releases, `INVALID_INPUT`, the hashed invalid-input policy reference, and
no matched grants. Unknown fields, nil or non-RFC input UUIDs, duplicate IDs,
partial wildcards, release mismatches, and exceeded bounds are malformed.

Run the executable policy and cross-validator suites from the repository root:

```sh
opa check --strict policies/opa
opa test policies/opa
OPA_PATH=/trusted/path/to/opa npm run test:authz-parity
```

`npm run verify:full` requires a responding Docker engine and real OPA binary;
it runs the parity corpus with `OPA_PATH`. Local workspace tests explicitly skip
the parity suite when no trusted OPA path is supplied.
