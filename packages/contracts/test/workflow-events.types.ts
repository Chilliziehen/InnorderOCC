import type { WorkflowEvent } from "../src/index.js";

type TaskAvailableEvent = Extract<WorkflowEvent, { type: "task.available" }>;

declare const available: TaskAvailableEvent;
const availableTaskId: string = available.payload.taskId;
const availableProcessId: string = available.payload.processId;
void availableTaskId;
void availableProcessId;

// @ts-expect-error task.available payloads do not contain an assignee.
available.payload.assigneeId;

export const narrowWorkflowEvent = (event: WorkflowEvent): string => {
  if (event.type === "task.available") {
    const taskId: string = event.payload.taskId;
    const processId: string = event.payload.processId;
    // @ts-expect-error narrowing must retain the exact task.available payload.
    event.payload.ownerPrincipalId;
    return `${taskId}:${processId}`;
  }
  return event.aggregateId;
};
