import { z } from "zod";

export const AUTHORIZATION_CONTRACT_VERSION = 1;
export const ACTION_KEY_MAX_LENGTH = 128;
export const CONTEXT_MAX_PROPERTIES = 32;
export const CONTEXT_MAX_SERIALIZED_LENGTH = 4096;
export const FORBIDDEN_ACTIONS_MAX_LENGTH = 128;
export const GRANTS_MAX_LENGTH = 256;
export const GRANT_ID_MAX_LENGTH = 256;
export const OUTPUT_IDS_MAX_LENGTH = GRANTS_MAX_LENGTH;

const ACTION_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const OPAQUE_OUTPUT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

const stableActionSchema = z
  .string()
  .min(1)
  .max(ACTION_KEY_MAX_LENGTH)
  .regex(ACTION_KEY_PATTERN);

const releaseIdsSchema = z
  .object({
    PLATFORM: z.uuid(),
    DOMAIN: z.uuid().optional(),
    CUSTOMER: z.uuid().optional(),
  })
  .strict()
  .superRefine((releases, context) => {
    const ids = Object.values(releases);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", message: "Release IDs must be distinct" });
    }
  });

function isBoundedJsonObject(value: unknown): value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) return false;

  const entries = Object.entries(value);
  if (entries.length > CONTEXT_MAX_PROPERTIES) return false;
  try {
    const serialized = JSON.stringify(value);
    return serialized !== undefined &&
      Array.from(serialized).length <= CONTEXT_MAX_SERIALIZED_LENGTH &&
      JSON.parse(serialized) !== undefined &&
      !containsNonJsonValue(value);
  } catch {
    return false;
  }
}

function containsNonJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return false;
  if (typeof value === "number") return !Number.isFinite(value);
  if (Array.isArray(value)) return value.some(containsNonJsonValue);
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return true;
  return Object.values(value).some(containsNonJsonValue);
}

const contextSchema = z.unknown().refine(isBoundedJsonObject, {
  message: "Context must be a bounded JSON object",
});

const exactUuidOrWildcardSchema = z.union([z.literal("*"), z.uuid()]);
const actionOrWildcardSchema = z.union([z.literal("*"), stableActionSchema]);

const authorizationGrantSchema = z
  .object({
    id: z.string().min(1).max(GRANT_ID_MAX_LENGTH),
    layer: z.enum(["PLATFORM", "DOMAIN", "CUSTOMER"]),
    effect: z.enum(["ALLOW", "DENY"]),
    action: actionOrWildcardSchema,
    principalId: exactUuidOrWildcardSchema,
    entityId: exactUuidOrWildcardSchema,
    resourceId: exactUuidOrWildcardSchema,
  })
  .strict();

export const authorizationInputSchema = z
  .object({
    contractVersion: z.literal(AUTHORIZATION_CONTRACT_VERSION),
    requestId: z.uuid(),
    authorizationRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    releases: releaseIdsSchema,
    principal: z.object({ id: z.uuid(), enabled: z.boolean() }).strict(),
    entity: z.object({ id: z.uuid() }).strict(),
    action: stableActionSchema,
    resource: z.object({ id: z.uuid(), active: z.boolean() }).strict(),
    context: contextSchema,
    forbiddenActions: z.array(stableActionSchema).max(FORBIDDEN_ACTIONS_MAX_LENGTH),
    grants: z.array(authorizationGrantSchema).max(GRANTS_MAX_LENGTH),
  })
  .strict()
  .superRefine((input, context) => {
    if (new Set(input.forbiddenActions).size !== input.forbiddenActions.length) {
      context.addIssue({ code: "custom", message: "Forbidden actions must be distinct" });
    }
    const grantIds = input.grants.map((grant) => grant.id);
    if (new Set(grantIds).size !== grantIds.length) {
      context.addIssue({ code: "custom", message: "Grant IDs must be distinct" });
    }
    input.grants.forEach((grant, index) => {
      if (!(grant.layer in input.releases)) {
        context.addIssue({
          code: "custom",
          path: ["grants", index, "layer"],
          message: "Grant layer must have a corresponding release",
        });
      }
    });
  });

const reasonCodeSchema = z.enum([
  "INVALID_INPUT",
  "PRINCIPAL_DISABLED",
  "RESOURCE_INACTIVE",
  "ACTION_FORBIDDEN",
  "EXPLICIT_DENY",
  "ALLOW_GRANT_MATCH",
  "NO_MATCHING_ALLOW",
]);

const sortedDistinct = (values: string[]) =>
  new Set(values).size === values.length &&
  values.every((value, index) => index === 0 || values[index - 1]! < value);

const outputIdSchema = z.string().min(1).max(128).regex(OPAQUE_OUTPUT_ID_PATTERN);

export const authorizationDecisionSchema = z
  .object({
    contractVersion: z.literal(AUTHORIZATION_CONTRACT_VERSION),
    requestId: z.union([z.uuid(), z.literal(NIL_UUID)]),
    authorizationRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    releases: z
      .object({
        PLATFORM: z.uuid().optional(),
        DOMAIN: z.uuid().optional(),
        CUSTOMER: z.uuid().optional(),
      })
      .strict(),
    decision: z.enum(["ALLOW", "DENY"]),
    allow: z.boolean(),
    reasonCodes: z.array(reasonCodeSchema).max(7),
    reasonIds: z.array(outputIdSchema).max(OUTPUT_IDS_MAX_LENGTH + 3),
    matchedPolicyIds: z.array(outputIdSchema).max(OUTPUT_IDS_MAX_LENGTH),
  })
  .strict()
  .superRefine((output, context) => {
    if (output.allow !== (output.decision === "ALLOW")) {
      context.addIssue({ code: "custom", path: ["allow"], message: "Allow must match decision" });
    }
    for (const field of ["reasonCodes", "reasonIds", "matchedPolicyIds"] as const) {
      if (!sortedDistinct(output[field])) {
        context.addIssue({ code: "custom", path: [field], message: `${field} must be sorted and distinct` });
      }
    }
    const releaseIds = Object.values(output.releases);
    if (new Set(releaseIds).size !== releaseIds.length) {
      context.addIssue({ code: "custom", path: ["releases"], message: "Release IDs must be distinct" });
    }
    if (output.reasonCodes.includes("INVALID_INPUT")) {
      const canonical =
        output.requestId === NIL_UUID &&
        output.authorizationRevision === 0 &&
        Object.keys(output.releases).length === 0 &&
        output.decision === "DENY" &&
        !output.allow &&
        output.reasonCodes.length === 1 &&
        output.reasonIds.length === 0 &&
        output.matchedPolicyIds.length === 0;
      if (!canonical) {
        context.addIssue({ code: "custom", message: "Invalid input must use the canonical deny envelope" });
      }
    } else {
      if (output.requestId === NIL_UUID) {
        context.addIssue({ code: "custom", path: ["requestId"], message: "Valid decisions require a request UUID" });
      }
      if (output.releases.PLATFORM === undefined) {
        context.addIssue({ code: "custom", path: ["releases", "PLATFORM"], message: "Valid decisions require a platform release" });
      }
    }
  });

export type AuthorizationInput = z.infer<typeof authorizationInputSchema>;
export type AuthorizationDecision = z.infer<typeof authorizationDecisionSchema>;
