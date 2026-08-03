import { describe, expect, it } from "vitest";

import { reviewSequenceSchema, workflowEventSchema, workflowEventSchemas } from "../src/index.js";

const id = "550e8400-e29b-41d4-a716-446655440000";
const otherId = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
const thirdId = "123e4567-e89b-42d3-a456-426614174000";

const payloads = {
  "cohort.created": { cohortId: id, packageVersionId: otherId, ownerPrincipalId: thirdId, status: "DRAFT" },
  "cohort.updated": { cohortId: id, status: "DRAFT" },
  "cohort.owner-transferred": { cohortId: id, previousOwnerPrincipalId: otherId, ownerPrincipalId: thirdId },
  "cohort.member-added": { cohortId: id, principalId: otherId, role: "PARTICIPANT" },
  "cohort.member-removed": { cohortId: id, principalId: otherId, role: "PARTICIPANT" },
  "cohort.activated": { cohortId: id, status: "ACTIVE" },
  "cohort.archived": { cohortId: id, status: "ARCHIVED" },
  "process.started": { processId: id, cohortId: otherId, participantId: thirdId, packageVersionId: otherId, state: "RUNNING" },
  "process.suspended": { processId: id, state: "SUSPENDED" },
  "process.resumed": { processId: id, state: "RUNNING" },
  "process.transferred": { processId: id, previousParticipantId: otherId, participantId: thirdId },
  "process.completed": { processId: id, state: "COMPLETED" },
  "process.cancelled": { processId: id, state: "CANCELLED", code: "OWNER_CANCELLED" },
  "process.failed": { processId: id, state: "FAILED", code: "WORKFLOW_FAILURE" },
  "process.projection-reconciled": { processId: id, repairedTaskIds: [otherId] },
  "task.available": { taskId: id, processId: otherId, cohortId: thirdId, activityKey: "safety-qualification" },
  "task.claimed": { taskId: id, processId: otherId, assigneeId: thirdId },
  "task.assignee-changed": { taskId: id, processId: otherId, previousAssigneeId: thirdId, assigneeId: id },
  "task.blocked": { taskId: id, processId: otherId, blockerCodes: ["EVIDENCE_REQUIRED"] },
  "task.pending-review": { taskId: id, processId: otherId, evidenceVersionId: thirdId, reviewSequence: 1 },
  "task.returned": { taskId: id, processId: otherId, assigneeId: thirdId, decision: "REJECTED" },
  "task.completed": { taskId: id, processId: otherId, state: "COMPLETED" },
  "task.cancelled": { taskId: id, processId: otherId, state: "CANCELLED", code: "PROCESS_CANCELLED" },
  "task.failed": { taskId: id, processId: otherId, state: "FAILED", code: "SAFETY_FAILED" },
  "task.projection-reconciled": { taskId: id, processId: otherId },
} as const;

const aggregateFor = (type: string): "COHORT" | "PROCESS" | "TASK" => {
  if (type.startsWith("cohort.")) return "COHORT";
  if (type.startsWith("process.")) return "PROCESS";
  return "TASK";
};

const eventFor = (type: keyof typeof payloads) => ({
  id,
  customerInstanceId: otherId,
  type,
  schemaVersion: 1,
  aggregateType: aggregateFor(type),
  aggregateId: id,
  aggregateVersion: 1,
  occurredAt: "2026-08-01T12:34:56Z",
  actorId: thirdId,
  correlationId: otherId,
  payload: payloads[type],
});

describe("workflow typed event registry", () => {
  it("explicitly registers every designed cohort, process, and task event", () => {
    expect(Object.keys(workflowEventSchemas)).toEqual(Object.keys(payloads));
    for (const type of Object.keys(payloads) as Array<keyof typeof payloads>) {
      expect(workflowEventSchemas[type].parse(eventFor(type))).toEqual(eventFor(type));
      expect(workflowEventSchema.parse(eventFor(type))).toEqual(eventFor(type));
    }
  });

  it("rejects unknown event types and envelope mismatches", () => {
    const event = eventFor("task.claimed");
    for (const invalid of [
      { ...event, type: "task.unknown" },
      { ...event, schemaVersion: 2 },
      { ...event, aggregateType: "PROCESS" },
      { ...event, aggregateId: otherId },
    ]) expect(() => workflowEventSchema.parse(invalid)).toThrow();
  });

  it("binds lifecycle event names to their exact target states", () => {
    for (const [type, state] of [
      ["process.suspended", "RUNNING"],
      ["process.resumed", "SUSPENDED"],
      ["process.completed", "RUNNING"],
      ["task.completed", "AVAILABLE"],
    ] as const) {
      const event = eventFor(type);
      expect(() => workflowEventSchema.parse({ ...event, payload: { ...event.payload, state } })).toThrow();
    }
  });

  it("uses strict minimized payloads without Flowable or sensitive fields", () => {
    const event = eventFor("task.available");
    for (const unsafe of [
      { flowableTaskId: "internal" },
      { flowableExecutionId: "internal" },
      { name: "Person Name" },
      { email: "person@example.test" },
      { content: "form contents" },
      { exception: "stack trace" },
    ]) {
      expect(() => workflowEventSchema.parse({
        ...event,
        payload: { ...event.payload, ...unsafe },
      })).toThrow();
    }
  });

  it("requires each payload aggregate ID to match the envelope aggregate ID", () => {
    for (const type of Object.keys(payloads) as Array<keyof typeof payloads>) {
      const event = eventFor(type);
      const aggregateIdKey = `${aggregateFor(type).toLowerCase()}Id`;
      expect(() => workflowEventSchema.parse({
        ...event,
        payload: { ...event.payload, [aggregateIdKey]: otherId },
      })).toThrow();
    }
  });

  it("keeps owner changes out of member event roles", () => {
    for (const type of ["cohort.member-added", "cohort.member-removed"] as const) {
      const event = eventFor(type);
      expect(() => workflowEventSchema.parse({
        ...event,
        payload: { ...event.payload, role: "OWNER" },
      })).toThrow();
    }
  });

  it("requires persisted review sequences to start at one", () => {
    expect(reviewSequenceSchema.parse(1)).toBe(1);
    expect(() => reviewSequenceSchema.parse(0)).toThrow();
    const event = eventFor("task.pending-review");
    expect(() => workflowEventSchema.parse({
      ...event,
      payload: { ...event.payload, reviewSequence: 0 },
    })).toThrow();
  });
});
