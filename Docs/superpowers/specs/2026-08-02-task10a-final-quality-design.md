# Task10A Final Quality Design

## Goal

Eliminate partial lifecycle-lock publication and ensure retired profile bindings can terminate requests that are still waiting for response headers.

## Atomic Lock Publication

TypeScript and both PowerShell helpers will serialize the complete strict owner record to a random same-directory temporary file. They will flush file content and metadata before publishing the lock through a no-overwrite operation: a same-volume hard link in TypeScript and `File.Move` in PowerShell. Publication failure caused by an existing destination means the contender did not acquire the lock. The contender will close and remove its temporary file on every exit path.

The final lock path will therefore be absent or contain a complete owner record. A successful owner will retain an open handle associated with the published record for the operation lifetime. Unlock will close the handle and delete the final path only after rereading and matching the random owner token.

Tests will cover concurrent no-overwrite publication, a fault after temporary-file sync but before publication, cleanup of the unpublished temporary file, and the absence of empty or partial final records.

## Legacy Malformed Recovery

Malformed final records can only come from the previous publication scheme. They remain fail-closed until their filesystem age exceeds the stale threshold. On Windows, TypeScript will invoke the already trusted System32 PowerShell executable to attempt an exclusive `FileShare.None` open. PowerShell helpers will perform the same exclusive-open probe directly. Recovery proceeds only when the probe conclusively succeeds; unavailable tooling, unsupported platforms, access errors, sharing violations, and ambiguous process state preserve the lock.

After proof, recovery still uses random quarantine rename and exact observed-byte comparison. A changed or raced lock is restored when possible and is never deleted as the stale candidate. Valid owner records continue to require exact PID and process-start liveness proof before recovery.

## Pending Profile Requests

Every `fetch` registers a binding-owned `AbortController` before calling `session.fetch`. The session receives an `AbortSignal.any` composition of the owned signal and the caller signal, or the owned signal alone when no caller signal exists. Registration remains active until headers arrive or the fetch rejects.

Retirement expiry aborts all pending controllers and expires all registered response bodies. The retired-binding limit counts bindings regardless of whether they are waiting for headers or streaming bodies, so overflow can force the oldest pending binding to expire immediately.

After `session.fetch` resolves, transport removes the pending registration and checks the composed signal and binding expiration before wrapping the response. A response arriving after either abort is cancelled without awaiting cancellation and the returned fetch rejects with the abort reason. Such a response never enters body tracking. Normal responses retain the existing one-shot release behavior through body EOF, cancellation, error, or retired expiry.

Deterministic tests will cover never-resolving headers, caller-signal composition, timeout and overflow aborts, late responses that ignore abort, immediate late-body cancellation, and isolation from current-profile requests.

## Verification

The change must pass focused red-green tests, `cert:verify`, the full desktop suite, root typecheck, strict `verify:full` with OPA 1.5.1, package, make, and packaged Playwright smoke before a new non-amended commit.
