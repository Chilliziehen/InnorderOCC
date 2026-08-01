import { readFile } from "node:fs/promises";

import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

import {
  capabilityProbeSchema,
  guidanceStatusSchema,
  knowledgeGateMetricsSchema,
  knowledgeGateResultSchema,
  knowledgeIngestionJobSchema,
  providerConfigCreateSchema,
  serviceIngestionOutcomeSchema,
  serviceOperationOutcomeSchema,
  serviceProviderProbeOutcomeSchema,
} from "../src/index.js";

const UUID = "550e8400-e29b-41d4-a716-446655440000";
const UUID_2 = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
const UUID_3 = "123e4567-e89b-42d3-a456-426614174000";
const SHA = "a".repeat(64);
const NOW = "2026-08-01T10:30:00Z";
const LATER = "2026-08-01T10:35:00Z";

type Document = { components: { schemas: Record<string, Record<string, unknown>> } };

describe("OCC Core governed AI OpenAPI AJV parity", () => {
  let document: Document;
  let ajv: Ajv2020;

  beforeAll(async () => {
    document = parse(await readFile(new URL("../openapi/occ-core.yaml", import.meta.url), "utf8")) as Document;
    ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    ajv.addFormat("cidrv4", (value) => z.cidrv4().safeParse(value).success);
    ajv.addFormat("cidrv6", (value) => z.cidrv6().safeParse(value).success);
  });

  const validator = (name: string): ValidateFunction => ajv.compile({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $ref: `#/components/schemas/${name}`,
    components: { schemas: document.components.schemas },
  });

  const expectParity = (
    name: string,
    zodSchema: z.ZodType,
    validFixtures: unknown[],
    invalidFixtures: unknown[],
  ): void => {
    const validate = validator(name);
    for (const fixture of validFixtures) {
      expect(zodSchema.safeParse(fixture).success, `${name} Zod valid`).toBe(true);
      expect(validate(fixture), `${name} AJV valid: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
    for (const fixture of invalidFixtures) {
      expect(zodSchema.safeParse(fixture).success, `${name} Zod invalid`).toBe(false);
      expect(validate(fixture), `${name} AJV invalid`).toBe(false);
    }
  };

  const capabilities = {
    chat: true,
    embeddings: false,
    structuredOutput: true,
    maxInputTokens: 128_000,
    maxOutputTokens: 4096,
    probedAt: NOW,
    snapshotHash: SHA,
  };

  it("matches capability probe status outcomes", () => {
    const probe = { id: UUID, providerId: UUID_2, requestedAt: NOW };
    expectParity("CapabilityProbe", capabilityProbeSchema, [
      { ...probe, status: "PENDING" },
      { ...probe, status: "RUNNING" },
      { ...probe, status: "SUCCEEDED", completedAt: LATER, snapshot: capabilities },
      { ...probe, status: "FAILED", completedAt: LATER, errorCode: "OCC-AI-PROBE-FAILED" },
    ], [
      { ...probe, status: "SUCCEEDED", completedAt: LATER },
      { ...probe, status: "FAILED", completedAt: LATER },
      { ...probe, status: "PENDING", errorCode: "OCC-AI-UNEXPECTED" },
    ]);
  });

  it("matches operation and internal outcome discriminants", () => {
    const operation = { operationId: UUID, expectedVersion: 2 };
    expectParity("ServiceOperationOutcome", serviceOperationOutcomeSchema, [
      { ...operation, status: "SUCCEEDED" },
      { ...operation, status: "FAILED", errorCode: "OCC-AI-RUN-FAILED" },
    ], [
      { ...operation, status: "SUCCEEDED", errorCode: "OCC-AI-UNEXPECTED" },
      { ...operation, status: "FAILED" },
    ]);

    const ingestion = { ...operation, jobId: UUID_2 };
    expectParity("ServiceIngestionOutcome", serviceIngestionOutcomeSchema, [
      { ...ingestion, status: "COMPLETED", producedDocumentVersionId: UUID_3 },
      { ...ingestion, status: "FAILED", errorCode: "OCC-AI-INGESTION-FAILED" },
    ], [
      { ...ingestion, status: "COMPLETED" },
      { ...ingestion, status: "FAILED", producedDocumentVersionId: UUID_3, errorCode: "OCC-AI-INGESTION-FAILED" },
    ]);

    const probe = { ...operation, probeId: UUID_2, completedAt: LATER };
    expectParity("ServiceProviderProbeOutcome", serviceProviderProbeOutcomeSchema, [
      { ...probe, status: "SUCCEEDED", snapshot: capabilities },
      { ...probe, status: "FAILED", errorCode: "OCC-AI-PROBE-FAILED" },
    ], [
      { ...probe, status: "SUCCEEDED", errorCode: "OCC-AI-UNEXPECTED" },
      { ...probe, status: "FAILED", snapshot: capabilities, errorCode: "OCC-AI-PROBE-FAILED" },
    ]);
  });

  it("matches every guidance status variant including dead letters", () => {
    const status = { operationId: UUID, requestedAt: NOW, updatedAt: LATER };
    expectParity("GuidanceStatus", guidanceStatusSchema, [
      { ...status, status: "PENDING" },
      { ...status, status: "RUNNING" },
      { ...status, status: "CANCELLED" },
      { ...status, status: "SUCCEEDED", recommendationId: UUID_2 },
      { ...status, status: "FAILED", errorCode: "OCC-AI-GUIDANCE-FAILED" },
      { ...status, status: "DEAD_LETTERED", errorCode: "OCC-AI-DEAD-LETTERED" },
    ], [
      { ...status, status: "SUCCEEDED" },
      { ...status, status: "DEAD_LETTERED" },
      { ...status, status: "RUNNING", errorCode: "OCC-AI-UNEXPECTED" },
    ]);
  });

  it("matches knowledge ingestion terminal exclusions and retry errors", () => {
    const job = {
      id: UUID,
      sourceId: UUID_2,
      sourceVersion: "source-v1",
      sourceObjectHash: SHA,
      normalizedContentHash: SHA,
      parserVersion: "parser-v1",
      chunkerVersion: "chunker-v1",
      candidateEmbeddingSpaceId: UUID_3,
      corpusManifestDigest: SHA,
      checkpoint: { page: 1 },
      stage: "EMBED",
      attempts: 2,
      maxAttempts: 5,
      nextAttemptAt: LATER,
      createdAt: NOW,
      updatedAt: NOW,
    };
    expectParity("KnowledgeIngestionJob", knowledgeIngestionJobSchema, [
      { ...job, status: "PENDING" },
      { ...job, status: "PROCESSING", leaseOwner: "worker-1", leaseExpiresAt: LATER },
      { ...job, status: "RETRY", errorCode: "OCC-AI-LEASE-EXPIRED-RETRY" },
      { ...job, status: "COMPLETED", stage: "COMPLETE", producedDocumentVersionId: UUID, completedAt: LATER },
      { ...job, status: "FAILED", errorCode: "OCC-AI-MAX-ATTEMPTS", completedAt: LATER },
    ], [
      { ...job, status: "PENDING", errorCode: "OCC-AI-UNEXPECTED" },
      { ...job, status: "RETRY", errorCode: "password=hunter2" },
      { ...job, status: "RETRY", errorCode: "secretAccessKey=abcdefghijklmnop" },
      { ...job, status: "RETRY", errorCode: "api_key=sk-abcdefghijklmnopqrstuvwxyz" },
      { ...job, status: "RETRY", errorCode: "Authorization: Basic dXNlcjpwYXNz" },
      { ...job, status: "RETRY", errorCode: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz" },
      { ...job, status: "RETRY", sanitizedError: "password=hunter2" },
      { ...job, status: "RETRY", producedDocumentVersionId: UUID },
      { ...job, status: "COMPLETED", stage: "COMPLETE", producedDocumentVersionId: UUID, errorCode: "OCC-AI-UNEXPECTED", completedAt: LATER },
      { ...job, status: "FAILED", producedDocumentVersionId: UUID, errorCode: "OCC-AI-FAILED", completedAt: LATER },
    ]);
  });

  it("enforces expressible gate decision thresholds", () => {
    const gate = {
      eligibleCount: 100,
      embeddedCount: 100,
      coverage: 1,
      leakageCount: 0,
      citationSupportedCount: 95,
      citationTotalCount: 100,
      citationPrecision: 0.95,
      recallAt10Sum: 17,
      recallAt10CaseCount: 20,
      recallAt10Mean: 0.85,
      minimumCoverage: 1,
      maximumLeakage: 0,
      minimumCitationPrecision: 0.95,
      minimumRecallAt10: 0.85,
      decision: "PASS",
    };
    const failedGate = {
      ...gate,
      embeddedCount: 90,
      coverage: 0.9,
      decision: "FAIL",
    };
    expectParity("KnowledgeGateMetrics", knowledgeGateMetricsSchema, [gate, failedGate], [
      { ...gate, decision: "FAIL" },
      { ...gate, eligibleCount: 0 },
      { ...gate, citationTotalCount: 0 },
      { ...gate, recallAt10CaseCount: 0 },
      { ...gate, leakageCount: 1 },
      { ...gate, citationPrecision: 0.94, citationSupportedCount: 94 },
      { ...gate, recallAt10Mean: 0.8, recallAt10Sum: 16 },
    ]);

    const resultFields = {
      id: UUID,
      status: "COMPLETED",
      datasetVersionId: UUID_2,
      datasetContentHash: SHA,
      corpusManifestDigest: SHA,
      documentManifest: `${UUID_3}:${SHA}`,
      candidateEmbeddingSpaceId: UUID,
      expectedActiveSpaceId: UUID_2,
      evidenceHash: SHA,
      evaluatedAt: LATER,
    };
    expectParity("KnowledgeGateResult", knowledgeGateResultSchema,
      [{ ...gate, ...resultFields }, { ...failedGate, ...resultFields }],
      [{ ...gate, ...resultFields, decision: "FAIL" }],
    );
  });

  it("matches approved private CIDR boundaries including compressed ULA", () => {
    const provider = {
      name: "Internal provider",
      origin: "https://models.example.test",
      apiPrefix: "/v1",
      credentialFile: "/run/secrets/provider",
      enabled: true,
    };
    const valid = [
      "10.0.0.0/8",
      "172.31.255.255/32",
      "192.168.255.255/32",
      "fc00::/7",
      "fc00:1::1/128",
      "fd12:3456:789a:1::1/64",
    ];
    const invalid = [
      "0.0.0.0/0",
      "10.0.0.0/7",
      "100.64.0.0/10",
      "169.254.169.254/32",
      "192.0.2.0/24",
      "::/0",
      "fc00::/6",
      "fe80::/10",
      "2001:db8::/32",
    ];
    expectParity("ProviderConfigCreate", providerConfigCreateSchema,
      valid.map((cidr) => ({ ...provider, approvedPrivateCidrs: [cidr] })),
      invalid.map((cidr) => ({ ...provider, approvedPrivateCidrs: [cidr] })),
    );
  });
});
