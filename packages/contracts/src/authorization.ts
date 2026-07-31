import { z } from "zod";

import { hasUnicodeCodePointLengthWithin } from "./unicode.js";

export const AUTHORIZATION_CONTRACT_VERSION = 1;
export const ACTION_KEY_MAX_LENGTH = 128;
export const CONTEXT_MAX_PROPERTIES = 32;
export const CONTEXT_MAX_SERIALIZED_LENGTH = 4096;
export const CONTEXT_MAX_DEPTH = 8;
export const FORBIDDEN_ACTIONS_MAX_LENGTH = 128;
export const GRANTS_MAX_LENGTH = 256;
export const GRANT_ID_MAX_LENGTH = 256;
export const OUTPUT_IDS_MAX_LENGTH = GRANTS_MAX_LENGTH;

const ACTION_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const OPAQUE_REASON_ID_PATTERN = /^(?:grant|policy):[0-9a-f]{64}$/;
const OPAQUE_MATCHED_ID_PATTERN = /^grant:[0-9a-f]{64}$/;
export const NIL_UUID = "00000000-0000-0000-0000-000000000000";
export const NON_NIL_RFC_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const nonNilUuidSchema = z.string().regex(NON_NIL_RFC_UUID_PATTERN);

const POLICY_REASON_IDS = {
  INVALID_INPUT: "policy:318efe2bf46c41026f67dbd60026ad3a8056a0a70c468cd38210021dee7de176",
  PRINCIPAL_DISABLED: "policy:8941407440a3ec32c44afbc4ab1fb183748dbf7388cf926f594486cc1f8386a3",
  RESOURCE_INACTIVE: "policy:78a11476cd4e8cb5ba4afa073e8195510016228408013d8f27bfaafafad47876",
  ACTION_FORBIDDEN: "policy:105106f1faa19167cdeb0d067dd88443f361b15f20e14424553e14b7ea7e1a5f",
  NO_MATCHING_ALLOW: "policy:7ec3d68be5ac070a6d48cb53daaf85bf7b4d76d09985923af422194f7735ab7b",
} as const;

const normalizedUuid = (value: string) => value.toLowerCase();
const definedStrings = (values: Array<string | undefined>) =>
  values.filter((value): value is string => value !== undefined);

function hasUnambiguousUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 0xfffd) return false;
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

const stableActionSchema = z
  .string()
  .min(1)
  .max(ACTION_KEY_MAX_LENGTH)
  .regex(ACTION_KEY_PATTERN);

const releaseIdsSchema = z
  .object({
    PLATFORM: nonNilUuidSchema,
    DOMAIN: nonNilUuidSchema.optional(),
    CUSTOMER: nonNilUuidSchema.optional(),
  })
  .strict()
  .superRefine((releases, context) => {
    const ids = definedStrings(Object.values(releases)).map(normalizedUuid);
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
  if (!isSafeJsonValue(value, 0)) return false;
  try {
    const serialized = JSON.stringify(value);
    return serialized !== undefined &&
      Array.from(serialized).length <= CONTEXT_MAX_SERIALIZED_LENGTH &&
      JSON.parse(serialized) !== undefined;
  } catch {
    return false;
  }
}

function isSafeJsonValue(value: unknown, depth: number): boolean {
  if (depth > CONTEXT_MAX_DEPTH) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "string") return hasUnambiguousUnicode(value);
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isSafeJsonValue(item, depth + 1));
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.entries(value).every(
    ([key, item]) => hasUnambiguousUnicode(key) && isSafeJsonValue(item, depth + 1),
  );
}

const contextSchema = z.unknown().refine(isBoundedJsonObject, {
  message: "Context must be a bounded JSON object",
});

const exactUuidOrWildcardSchema = z.union([z.literal("*"), nonNilUuidSchema]);
const actionOrWildcardSchema = z.union([z.literal("*"), stableActionSchema]);

const authorizationGrantSchema = z
  .object({
    id: z.string().refine(
      (value) =>
        hasUnambiguousUnicode(value) &&
        hasUnicodeCodePointLengthWithin(value, 1, GRANT_ID_MAX_LENGTH),
      `Grant ID must contain 1-${GRANT_ID_MAX_LENGTH} Unicode code points`,
    ),
    layer: z.enum(["PLATFORM", "DOMAIN", "CUSTOMER"]),
    releaseId: nonNilUuidSchema,
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
    requestId: nonNilUuidSchema,
    authorizationRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    releases: releaseIdsSchema,
    principal: z.object({ id: nonNilUuidSchema, enabled: z.boolean() }).strict(),
    entity: z.object({ id: nonNilUuidSchema }).strict(),
    action: stableActionSchema,
    resource: z.object({ id: nonNilUuidSchema, active: z.boolean() }).strict(),
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
      const releaseId = input.releases[grant.layer];
      if (releaseId === undefined) {
        context.addIssue({
          code: "custom",
          path: ["grants", index, "layer"],
          message: "Grant layer must have a corresponding release",
        });
      } else if (normalizedUuid(grant.releaseId) !== normalizedUuid(releaseId)) {
        context.addIssue({
          code: "custom",
          path: ["grants", index, "releaseId"],
          message: "Grant releaseId must match its layer release",
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

const equalSorted = (left: string[], right: string[]) =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const reasonIdSchema = z.string().regex(OPAQUE_REASON_ID_PATTERN);
const matchedPolicyIdSchema = z.string().regex(OPAQUE_MATCHED_ID_PATTERN);

export const authorizationDecisionSchema = z
  .object({
    contractVersion: z.literal(AUTHORIZATION_CONTRACT_VERSION),
    requestId: z.union([nonNilUuidSchema, z.literal(NIL_UUID)]),
    authorizationRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    releases: z
      .object({
        PLATFORM: nonNilUuidSchema.optional(),
        DOMAIN: nonNilUuidSchema.optional(),
        CUSTOMER: nonNilUuidSchema.optional(),
      })
      .strict(),
    decision: z.enum(["ALLOW", "DENY"]),
    allow: z.boolean(),
    reasonCodes: z.array(reasonCodeSchema).max(7),
    reasonIds: z.array(reasonIdSchema).max(OUTPUT_IDS_MAX_LENGTH + 4),
    matchedPolicyIds: z.array(matchedPolicyIdSchema).max(OUTPUT_IDS_MAX_LENGTH),
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
    const releaseIds = definedStrings(Object.values(output.releases)).map(normalizedUuid);
    if (new Set(releaseIds).size !== releaseIds.length) {
      context.addIssue({ code: "custom", path: ["releases"], message: "Release IDs must be distinct" });
    }
    const grantReasonIds = output.reasonIds.filter((id) => id.startsWith("grant:"));
    const policyReasonIds = output.reasonIds.filter((id) => id.startsWith("policy:"));
    if (!equalSorted(grantReasonIds, output.matchedPolicyIds)) {
      context.addIssue({ code: "custom", path: ["reasonIds"], message: "Grant reason IDs must exactly equal matchedPolicyIds" });
    }
    if (output.reasonCodes.includes("INVALID_INPUT")) {
      const canonical =
        output.requestId === NIL_UUID &&
        output.authorizationRevision === 0 &&
        Object.keys(output.releases).length === 0 &&
        output.decision === "DENY" &&
        !output.allow &&
        output.reasonCodes.length === 1 &&
        output.reasonIds.length === 1 &&
        output.reasonIds[0] === POLICY_REASON_IDS.INVALID_INPUT &&
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
      const baselineCodes = [
        "PRINCIPAL_DISABLED",
        "RESOURCE_INACTIVE",
        "ACTION_FORBIDDEN",
      ] as const;
      if (output.decision === "ALLOW") {
        if (!equalSorted(output.reasonCodes, ["ALLOW_GRANT_MATCH"])) {
          context.addIssue({ code: "custom", path: ["reasonCodes"], message: "Allow requires only ALLOW_GRANT_MATCH" });
        }
        if (output.matchedPolicyIds.length === 0) {
          context.addIssue({ code: "custom", path: ["matchedPolicyIds"], message: "Allow requires a matching grant" });
        }
        if (policyReasonIds.length !== 0) {
          context.addIssue({ code: "custom", path: ["reasonIds"], message: "Allow cannot include policy reason IDs" });
        }
      } else {
        if (output.reasonCodes.includes("NO_MATCHING_ALLOW")) {
          const exactNoMatch =
            equalSorted(output.reasonCodes, ["NO_MATCHING_ALLOW"]) &&
            output.matchedPolicyIds.length === 0 &&
            equalSorted(policyReasonIds, [POLICY_REASON_IDS.NO_MATCHING_ALLOW]);
          if (!exactNoMatch) {
            context.addIssue({ code: "custom", message: "NO_MATCHING_ALLOW requires its exact deny envelope" });
          }
        } else {
          const hasExplicitDeny = output.reasonCodes.includes("EXPLICIT_DENY");
          const presentBaselineCodes = baselineCodes.filter((code) => output.reasonCodes.includes(code));
          const onlyPossibleDenyCodes = output.reasonCodes.every(
            (code) => code === "EXPLICIT_DENY" || baselineCodes.includes(code as typeof baselineCodes[number]),
          );
          if (!onlyPossibleDenyCodes || (!hasExplicitDeny && presentBaselineCodes.length === 0)) {
            context.addIssue({ code: "custom", path: ["reasonCodes"], message: "Deny requires baseline or explicit-deny codes" });
          }
          if (hasExplicitDeny && output.matchedPolicyIds.length === 0) {
            context.addIssue({ code: "custom", path: ["matchedPolicyIds"], message: "Explicit deny requires a matching grant" });
          }
          const expectedPolicyIds = presentBaselineCodes.map((code) => POLICY_REASON_IDS[code]).sort();
          if (!equalSorted(policyReasonIds, expectedPolicyIds)) {
            context.addIssue({ code: "custom", path: ["reasonIds"], message: "Policy reason IDs must exactly match baseline reason codes" });
          }
        }
      }
    }
  });

export type AuthorizationInput = z.infer<typeof authorizationInputSchema>;
export type AuthorizationDecision = z.infer<typeof authorizationDecisionSchema>;
