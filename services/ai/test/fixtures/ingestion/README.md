# Governed ingestion hostile fixtures

`manifest.json` is the reviewable control matrix. Text and XML files under `sources/` are inert source material; tests deterministically package or mutate them in memory so the repository does not store active, encrypted, oversized, or malware-bearing binaries.

The `policy` rows execute through `inspectDocument` or `parseDocument`. The `malware` rows execute through the real ClamAV-backed `IngestionWorker` integration. The `sidecar` rows execute through Worker-thread parser tests with bounded test hooks. Every test assertion includes the manifest scenario ID.
