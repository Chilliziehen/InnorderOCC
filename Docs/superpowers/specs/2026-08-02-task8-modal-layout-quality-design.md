# Task8 Modal and Packaged Layout Quality Design

## Scope

Close the remaining Task8 focus-trap defect during asynchronous profile removal and expand packaged Electron coverage across every authenticated route and representative dense layouts. The work remains within the desktop renderer and packaged Playwright smoke suite.

## Pending Removal Focus

The removal dialog remains open while `onRemove` is pending. Confirm and Cancel are disabled because the operation cannot be cancelled or safely duplicated. The dialog itself has `tabIndex={-1}` and receives focus when removal enters the pending state.

While pending:

- Escape and backdrop interaction cannot close the dialog.
- Tab and Shift+Tab are intercepted and keep focus on the dialog.
- Focus never moves to `body`, the inert shell, or another window control.
- A duplicate removal cannot be submitted.

If removal fails, the actions are re-enabled and focus returns to Confirm so the operator can retry or cancel. If removal succeeds, the existing shell-isolation acknowledgement remains authoritative: trigger focus is restored only after the shell is no longer inert.

## Packaged Fixture

The packaged authenticated fixture supplies all route capabilities, runtime status data, and operation-specific query results through test-owned IPC handler overrides. It does not add a production authentication bypass. Query results are valid for each workspace schema, with dense representative content for Resources and Administration.

Every visible authenticated route is navigated in packaged Electron and must expose its expected heading without page or renderer failure.

## Layout Matrix

Overview, Resources, and Administration run at these effective layouts:

- 1440 x 900 at 100% zoom
- 1024 x 768 at 100% zoom
- 600 x 800 at 100% zoom
- 1280 x 720 at 200% zoom, producing an effective compact viewport near 640 x 360

At every matrix point:

- `documentElement` and `body` have no horizontal overflow.
- Visible interactive controls and meaningful visible text regions do not geometrically overlap unrelated siblings.
- Compact table or grid cells expose visible labels derived from `data-label`.
- Collapsed navigation links retain accessible names, and their Ant Design tooltips can be reached through keyboard focus or hover.

The geometry checker ignores ancestor/descendant pairs, hidden elements, zero-area rectangles, and intentional text contained within its own control. Failures report selectors or accessible names and bounding boxes.

## Testing

TDD proceeds in two cycles:

1. Add a deferred-removal unit test that proves focus currently escapes to `body` when both actions disable. Implement dialog focus and pending-state key handling, then verify failure and success transitions.
2. Expand packaged Playwright tests and run them against the current package to establish layout/fixture failures. Add only the fixture, CSS, or semantic changes required for the matrix to pass.

Completion requires focused tests, the full desktop Vitest suite, TypeScript checking, Electron packaging, the targeted pending-handler browser test, and the complete packaged smoke suite.
