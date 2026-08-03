# Complete Desktop Product Design

## Purpose

This design delivers the Windows Electron operations console assigned in
`Docs/AgentPrompts/04-desktop-product.md`. It turns the existing system-status
dashboard into a secure, role-aware application while preserving the restrained
Chinese operations-console visual language.

The current Core contract exposes system status, login, refresh, logout, and
current-user endpoints only. The desktop branch must therefore distinguish two
delivery stages:

- authentication, profile management, navigation, session security, runtime
  health, packaging, and renderer isolation are backed by real implementation;
- before integration, business workspaces are complete interaction surfaces with loading, empty,
  error, stale, offline, conflict, and unavailable states, but production
  commands remain disabled until their OpenAPI operations are integrated.

This branch is not final product acceptance while required operations are
unavailable. Agent 06 removes each unavailable adapter only after merging the
committed Core contract and reruns the same production-packaged journeys against
real APIs. Final release acceptance remains blocked until every required pilot
journey passes without a fixture or unavailable operation.

Production code never substitutes fixtures or local mutations for missing Core
behavior. Deterministic adapters are permitted only in component and Playwright
tests to prove role journeys and state handling.

## Approaches Considered

### Recommended: Contract-driven shell with explicit capability availability

The main process owns profiles, credentials, sessions, HTTP, cache, and SSE. A
narrow typed preload API exposes named operations. The renderer uses route and
workspace manifests to render all approved workspaces and capability-filtered
commands. Operations without a committed Core contract report `UNAVAILABLE`
with integration metadata.

This approach preserves security and honesty, provides a complete integration
target for backend branches, and permits meaningful UI and accessibility tests
now. It is the selected approach.

### Generic renderer-to-HTTP bridge

A generic `request(method, path, body)` IPC API would reduce initial code, but
it effectively gives the renderer raw network authority, weakens validation,
and makes future endpoint review difficult. This approach is rejected.

### Local desktop business store

Implementing missing workflows in a local Electron database would make demos
interactive, but it would create a second business authority and fake backend
success. Migration to Core would also be unsafe. This approach is rejected.

## Architecture

### Main process

The main process remains the only privileged boundary. It owns these modules:

- `profile-store`: validates and durably stores the selected HTTPS server
  profile and non-secret preferences under Electron user data. Development may
  bootstrap an HTTP loopback profile explicitly; production never disables TLS
  validation.
- `credential-vault`: encrypts the rotating refresh token with Electron
  `safeStorage`. The access token is held only in memory.
- `session-manager`: performs login, refresh, current-user loading, expiry,
  logout, and credential cleanup. Refresh is serialized and failed refresh
  expires the session.
- `core-client`: bounded, redirect-rejecting requests to named `/api/v1`
  operations. It validates input and response schemas, attaches bearer and
  idempotency headers in main, and normalizes Problem Details and correlation
  receipts.
- `read-cache`: stores only validated non-secret read models with update time,
  profile, customer-instance, and principal identities. Offline reads are
  visibly stale; all mutation methods reject while offline. Cached operational
  data is revealed only after local session re-entry. Logout, profile removal,
  and account removal purge it; profile switching cannot read another scope.
  Evidence content, audit payloads, and provider configuration are never cached.
- `notification-stream`: owns authenticated SSE, persists the last event
  cursor scoped by profile, customer instance, and principal, reconnects with
  bounded backoff, and emits validated notifications.
  Until the server contract exists it reports unavailable without reconnect
  loops.
- `desktop-ipc`: validates the sender, input, output, payload size, and named
  channel for every method. There is no generic network or filesystem channel.

Existing BrowserWindow hardening, exact-document navigation, production CSP,
sandbox, context isolation, popup denial, and no-Node renderer behavior remain
mandatory. Permission requests are denied by default. The app acquires a
single-instance lock and focuses the existing window on a second launch.

### Preload

The preload exposes a frozen `window.occ` object grouped around profile,
session, runtime, workspace query, command, upload, and notification methods.
The surface contains no token, path, environment, shell, or unrestricted URL
primitive. Subscription methods return disposal functions.

### Renderer

The renderer is split into an application controller, authenticated shell,
route manifest, reusable state components, and workspace modules. It does not
import Electron or perform `fetch`.

The controller models these top-level states:

1. no server profile: profile bootstrap;
2. profile available and no session: login;
3. authenticated: capability-filtered application shell;
4. expired session: login with a non-sensitive expiry notice;
5. offline with cached identity: stale read-only shell and mutation lockout.

## Profiles And Authentication

A server profile contains a stable ID, display name, exact origin, environment
label, and TLS trust summary. HTTPS is required except when both
`!app.isPackaged` and a deliberate development flag permit a loopback profile.
Development HTTP profiles cannot be imported into or persisted by a packaged
build, and packaged tests reject every HTTP origin. URLs with credentials, query strings, fragments,
non-HTTP schemes, or non-root paths are rejected. Profile changes clear access
state and scope cached data to prevent cross-environment disclosure.

Login credentials cross preload once to a named login handler and are never
logged or persisted. On success, the refresh token is encrypted and removed
from renderer-visible results. Session snapshots contain current user,
capabilities, access expiry, profile identity, and connectivity only. Logout
attempts server revocation and always clears local credentials.

The TLS trust screen describes the selected deployment CA fingerprint and
certificate state. The Windows installer owns confirmed import of the selected
deployment CA into the current-user trust store and records its exact
thumbprint. Uninstall removes only a certificate imported by this product and
only when no retained profile references it. Wrong-host, expired, replaced, and
untrusted certificates fail closed in acceptance tests. The renderer has no
certificate-store or shell control; a signed, bounded installer helper performs
enrollment from a release-manifest-verified certificate.

## Navigation And Authorization

Routes use hash paths so packaged file navigation remains within the exact
loaded document. The route manifest defines path, Chinese label, icon,
description, required capabilities, and workspace component for:

- `/overview`
- `/my-work`
- `/processes`
- `/interventions`
- `/risks`
- `/resources`
- `/domain-design`
- `/administration`
- `/system`
- `/settings`

Navigation visibility follows effective capabilities. The initial platform
contract provides only `occ.read`, `occ.execute`, and `occ.admin`; these permit
the overview and read-only unavailable surfaces but are insufficient to expose
domain mutations. The route manifest separately names the required future
capability for every query and command. Process owner, participant, domain
modeler, resource manager, and administrator matrices are populated from the
merged `/me` response. A command stays disabled until its specific capability
exists. Renderer checks improve the UX but never replace server authorization.
Direct navigation to a hidden route renders an access-denied view and never
queries that workspace. Every route change moves focus to the page heading and
announces the title.

## Workspace Experience

All workspaces share a dense command-bar and data-view system: search, filters,
sort, cursor controls, freshness, result count, and refresh. Stable controls do
not shift between states. Each workspace defines the intended backend resource
groups and renders one of these honest states:

- loading with a labelled progress region;
- data, when a validated adapter response exists;
- empty, with the next permitted command;
- error with Problem Details code and correlation ID;
- stale/offline data with age and read-only lock;
- optimistic conflict with current version and a refresh action;
- unavailable contract with required API groups and disabled commands.

Overview combines attention, deadlines, risks, process counts, service health,
environment identity, and freshness. System Operations remains read-only and
contains no infrastructure lifecycle controls.

My Work supports available/claimed/blocked/pending-review/returned/completed
tabs and evidence/resource/AI action entry points. Processes presents cohorts,
route progress, participants, tasks, evidence, risks, and timeline.
Intervention Center covers evidence reviews, exceptions, failed automation,
policy blocks, and recommendations. Risks, Resources, Domain Design, and
Administration expose the filters and command forms described by the pilot
design. Missing API groups disable submission with a precise integration note.

## Commands, Uploads, Conflicts, And Notifications

Named command calls create an intent handle in the renderer. Main binds the
handle to the operation and canonical request hash, generates one UUID
idempotency key, and reuses it only for transport or timeout retries of that
exact payload. Concurrent clicks are coalesced. An edited payload or terminal
response requires a new handle and key. Pending intent metadata is persisted
only for commands whose merged contract requires restart recovery. Versioned
updates require `expectedVersion`.
HTTP 409 responses never overwrite local state: the renderer presents the
current version and refreshes on request. Successful command receipts expose a
correlation ID without exposing authorization internals.

Evidence upload is a named bounded method with renderer-visible progress,
cancellation, retry, accepted media/size guidance, quarantine status, and
review history. The main process streams to Core only after the evidence API is
integrated. It never uploads directly to MinIO.

Notification delivery uses a cursor and treats SSE as an optimization. A lost
stream marks notification freshness, reconnects with backoff, and resumes from
the last cursor. Query fallback remains required once notifications endpoints
exist.

## Visual And Accessibility Design

The existing dark fixed navigation, white work surface, teal selection,
neutral borders, compact type, and 5-6 px radii remain the visual foundation.
The expanded interface uses restrained status colors and avoids decorative
cards, gradients, and oversized headings. Lucide icons identify navigation and
icon commands; narrow navigation provides keyboard-accessible tooltips.

The shell supports keyboard-only operation, visible focus, screen-reader status
announcements, 200% zoom/reflow, reduced motion, and Windows forced-colors.
Tables become labelled stacked rows where width requires it. Text wraps instead
of clipping important status or action content. No control relies on color
alone.

## Packaging And Release Boundary

Electron Forge produces a stable Windows x64 package and Squirrel installer
with `Innorder OCC` product metadata, icon, executable identity, and explicit
unsigned-development naming. Single-instance behavior and packaged smoke are
release gates. Authenticode credentials and publisher certificate remain
external; an unsigned artifact must never be described as production-signed.

Installed-app smoke installs for the current user, launches the executable,
checks profile/login rendering and security boundaries, upgrades, and
uninstalls without unrelated residue. A local environment limitation may be
reported as branch evidence, but final completion remains blocked until this
gate passes on a clean Windows standard-user VM.

## Testing

Tests are layered by boundary:

- pure unit tests for profile validation, route capability policy, Problem
  Details normalization, cache freshness, command lockout, and state reducers;
- main/IPC tests for sender validation, credential isolation, refresh rotation,
  payload bounds, redirect rejection, single-instance lifecycle, and narrow
  preload exposure;
- component tests for all workspaces, capability visibility, direct denial,
  loading/empty/error/unavailable/offline/conflict states, keyboard operation,
  route focus, and axe violations;
- Playwright packaged journeys for administrator profile/login, teacher review
  and risk, participant task/evidence/resource/guidance, domain modeler package
  publication, resource manager conflict handling, offline/reconnect, and
  conflict recovery. Test-only deterministic adapters prove pre-integration UI
  behavior; the same journeys must pass against real APIs for final acceptance;
- screenshots at wide and compact desktop windows, 200% zoom, reduced motion,
  and high contrast, reviewed for overflow and overlap;
- package and installed-app smoke for renderer isolation, CSP, external
  navigation denial, product metadata, launch, and uninstall.

The full workspace test, typecheck, build, package, and smoke gates run before
completion. Test fixtures are impossible to activate in a production package.

## Integration Contract For Agent 06

Backend integration replaces unavailable workspace adapters with generated,
schema-validated named operations without changing renderer security or route
structure. Agent 06 must supply the final OpenAPI paths, schemas, capability
strings, SSE event schema, upload contract, and backend branch commit SHAs.

The integration capability matrix covers all five roles and every workspace:
visible navigation, permitted queries and commands, redaction, direct-route and
server denial, stale/offline behavior, and optimistic conflict recovery. It is
tested from real `/me` responses rather than role-name assumptions.

The desktop branch must not edit shared business OpenAPI merely to make the UI
appear connected. Integration is complete only when each named operation is
mapped to a committed contract and its unavailable state is removed by tests.
