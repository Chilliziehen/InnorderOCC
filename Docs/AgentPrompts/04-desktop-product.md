# Initial Prompt: Complete Desktop Product Agent

You own the complete Windows Electron operations console. Deliver an installable, role-aware product UI, not a static dashboard or collection of placeholders.

Create isolated branch/worktree `feature/desktop-product` from latest `feature/deployable-pilot`. Read the deployable product design, current Electron security code/styles/tests, all OpenAPI/contracts, intended actor workflows, deployment architecture, and backend branch integration notes available to you. Preserve the existing restrained operations-console visual language.

You have full delegated product/design/engineering authority. Use brainstorming/specification, frontend implementation guidance, TDD, Playwright screenshots and accessibility tests, and iterative spec/code/design review. Make conservative assumptions and build complete loading/empty/error/offline/conflict states. Continue automatically until tests and packaged smoke pass.

Scope:

- Durable server-profile bootstrap and settings, TLS trust profile, login/refresh/logout, safeStorage refresh credential, in-memory access token, session expiry and environment identity.
- Typed main-process HTTP/SSE client. Renderer has no raw network/filesystem/token access; preload IPC stays narrow.
- Real navigation/routes, role/capability visibility, direct-route denial and route focus management.
- Overview, My Work, Processes, Intervention Center, Risks, Resources, Domain Design, Administration, and System Operations workspaces from the approved information architecture.
- Query/filter/sort/cursor states, command idempotency, optimistic conflict refresh, Problem Details/correlation receipts, SSE notifications/reconnect cursor, stale/offline read-only cache and mutation lockout.
- Evidence upload/progress/retry/review, task/process commands, reservations, risk handling, package import/validate/publish, people/policy/provider/knowledge administration as supported by contracts.
- Keyboard operation, screen-reader announcements, 200% zoom/reflow, reduced motion, high contrast, safe tooltips and no overlap at supported viewports.
- Windows x64 Forge installer preparation, branding/icon/product metadata, single-instance handling and installed-app smoke. Signing credentials remain external.

Conflict rules:

- Do not invent backend success. Use generated typed clients and explicit unavailable states until integration agent merges APIs.
- Keep shared contract edits separate; coordinate expected endpoints through integration notes.
- Do not expose infrastructure lifecycle shell controls in renderer.

Acceptance:

- Playwright role journeys cover administrator bootstrap/login, teacher cohort/review/risk, participant task/evidence/resource and AI guidance, offline/reconnect/conflict paths.
- Component, IPC/security, accessibility and packaged/installed smoke tests pass on desktop/mobile-sized windows with screenshots reviewed for layout.
- No renderer secret access, external navigation, CSP bypass, stale mutation or fake business data.
- Full workspace/type/build/package/smoke gates pass.

Return branch/commits, routes/workflows, API assumptions, screenshots/artifacts, test counts, installer status, residual signing requirements and integration instructions for agent 06.
