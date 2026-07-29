# Platform Authorization Policy

The policy exposes `data.innorder.platform.authz.decision`. Send a document with
this shape to OPA:

```json
{
  "input": {
    "principal": {"id": "principal-1", "enabled": true},
    "entity": {"id": "entity-1"},
    "action": "resource.read",
    "resource": {"id": "resource-1", "active": true},
    "context": {"correlation_id": "correlation-1"},
    "forbidden_actions": [],
    "grants": [{
      "id": "grant-1",
      "effect": "ALLOW",
      "action": "resource.read",
      "principal_id": "principal-1",
      "entity_id": "entity-1",
      "resource_id": "resource-1"
    }]
  }
}
```

Every field shown is required. Grant selectors match only the exact value or the
complete `*` wildcard. Invalid input is denied. A matching `DENY` grant and the
platform baselines for disabled principals, inactive resources, and forbidden
actions always override matching `ALLOW` grants.

The decision contains an `allow` boolean plus sorted `reason_codes` and
`reason_ids`. Matching grant references use `grant:` followed by a SHA-256
digest; the policy never returns caller-supplied grant IDs. These values are
stable audit metadata and never echo request context or credentials.

Run the executable policy suite from the repository root:

```sh
opa check --strict policies/opa
opa test policies/opa
```

When OPA is unavailable, `npm run test:infra` performs deterministic static
contract checks while retaining the Rego tests for CI or container execution.
