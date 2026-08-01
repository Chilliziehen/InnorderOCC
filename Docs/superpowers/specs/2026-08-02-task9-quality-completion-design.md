# Task 9 Quality Completion Design

## Goal

Close the remaining Task 9 reliability findings while keeping credentials, network ownership, filesystem paths, idempotency keys, and persisted state in Electron main.

## Offline Reads

`WorkspaceRouter` always invokes the named workspace query IPC when an authenticated or cached offline identity is available. Main captures the authenticated cache scope and session generation. If connectivity is offline, main performs only an exact scoped cache lookup and returns `stale` or an honest offline-no-cache result; it never invokes a remote function. Renderer-retained data is used only when named IPC is absent or rejects.

## Chunked Uploads

The upload API consists of `preflight`, `begin`, `append`, `finish`, and `cancel`, plus progress subscription. Renderer creates a user-intent UUID but never an idempotency key or path. It reads at most 1 MiB with `File.slice(...).arrayBuffer()` per append and sends one bounded chunk per IPC call.

Main validates metadata, allocates a main UUID session and main idempotency key, and creates a random restrictive spool file under an injected app-private directory. Append enforces exact sequence, per-chunk and declared-total bounds, incrementally updates SHA-256, and writes with awaited backpressure. At most four sessions and a bounded amount of in-flight chunk memory are permitted. Finish closes the spool, validates byte count, streams it to the named transport, validates the receipt, and deletes the file. Cancel, logout, profile switch, disposal, and startup cleanup delete owned files. Startup cleanup accepts only strict owned-name patterns, regular files under the spool root, and bounded age; renderer paths are never accepted.

Intent bindings retain canonical metadata/content hashes and terminal success, cancellation, or error receipts through TTL. Exact requests replay without server transport; changed input rejects. Active duplicate intents coalesce or deterministically reject before a second network call. Capacity and expiry are bounded.

## Lifecycle

Main reliability composition calls upload `abortAll` before session logout and `abortScope` before selected-profile mutation or cleanup, while credentials and profile origin are still current. Active append and finish work observes abort state and cannot continue transport after invalidation.

## Notifications

Every session change first clears the old stream. A new stream starts only for an available exact HTTPS endpoint. Catch-up follows at most a fixed page count, requesting each page with its `nextCursor` token. It emits validated deduplicated events in order, persists only the actual last delivered event cursor, and then opens SSE with that cursor. Cursor storage is strict, byte bounded, and LRU bounded by scope.

The stream publishes a narrow validated state: `connecting`, `online`, `reconnecting`, or `unavailable`, with `changedAt` and optional `lastEventAt`. Main forwards this on a named event channel; preload validates it; renderer uses it for a quiet stale notification indicator. Unavailable endpoints do not reconnect.

## Command Replay

The command registry assigns the server idempotency key in main. It retains exact terminal receipts with canonical identity and payload hashes through TTL. Repeating the same renderer intent replays the receipt without invocation; changed payload or target rejects; a genuinely new action requires a new renderer handle. In-flight calls coalesce and capacity cleanup covers retryable, accepted, and terminal entries.

## Cache And Persistence

Read cache entries are maintained in access-order LRU. Put replaces/touches an entry, then evicts oldest entries until both entry count and serialized byte size fit; a single oversized entry is rejected without freezing later writes. Reads touch entries through the serialized mutation queue. Notification cursor records similarly carry access timestamps and evict by count and bytes.

## Verification

Each behavior is introduced by a failing focused test, followed by focused regression runs. Final verification runs the full desktop suite, repository typecheck, Electron packaging, packaged Playwright smoke, diff checks, and a separate non-amended commit.
