# Evidence Content Quality Hardening Design

## Scope

Close four Task 3 quality gaps without changing persistence or external evidence contracts: strict OOXML QName handling, enforceable scanner process isolation, structure-aware polyglot and nested-container detection, and bounded opt-in Docker lifecycle integration tests.

## Scanner Isolation

Production scanning uses `ProcessScannerSandbox`, not an arbitrary in-process callback. It launches a digest-pinned scanner image through a validated absolute Docker executable with a generated 96-bit container name, `--rm`, no network, bounded memory and PIDs, read-only root, no-new-privileges, all capabilities dropped, bounded hardened `/tmp`, and one read-only evidence mount. A bounded binary protocol carries scan metadata and provenance.

The adapter limits concurrent scans and waiting callers, bounds request/output/process/control durations, and drains output through one fixed bounded facility. Timeout, interruption, saturation, malformed protocol, nonzero exit, or uncertain cleanup returns scanner error. Every invocation runs bounded `docker rm -f` and accepts cleanup only after a successful exact-name `docker ps -a` query returns empty bounded output.

`DeterministicMalwareScanner` remains test-only. Agent 05 supplies the scanner image and worker integration.

## OOXML Validation

StAX parsing preserves element and attribute `QName`s. OPC content-type and relationship roots and children require their exact standard namespaces. Required OPC attributes must be unqualified, unique by local name, and cannot be replaced or shadowed by namespaced attributes. Word, spreadsheet, and presentation main roots require their exact application namespace. Wrong namespaces, shadow attributes, and duplicate-local attributes fail as malformed archives.

## Structural Detection

Whole-file raw signature searching is removed. Top-level format selection uses only the leading format boundary. Strict PDF validation establishes the terminal `%%EOF` boundary and permits only trailing PDF whitespace, so appended formats are rejected while JPEG/DCT stream bytes remain valid. ZIP validation continues to require a terminal EOCD.

Nested entries are rejected by archive filename or by a validated container probe, not a short magic match. Probes validate ZIP central-directory layout including self-extracting prefixes, gzip framing/trailer by bounded decompression, TAR header checksum, and sufficiently complete checksummed headers for the other recognized formats. Incidental magic bytes remain ordinary payload.

## Integration Tests

Docker lifecycle tests carry a `full-integration` tag and require the explicit `innorder.fullIntegration=true` system property, supplied from `-PfullEvidenceIntegration=true`. Default unit runs skip them visibly. Forced strict runs set the property and assert zero skips. Docker command helpers drain bounded output concurrently, wait with a deadline, kill timed-out CLI processes, and never call blocking `readText()` before timed wait.

## Verification

TDD runs each focused regression red before production changes. Final verification runs the forced evidence unit suite with full integration disabled and the forced Docker lifecycle classes with full integration enabled, strict dependency verification, rerun tasks, and no caches.
