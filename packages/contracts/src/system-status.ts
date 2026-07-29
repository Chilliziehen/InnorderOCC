import { z } from "zod";

export const ServiceStateSchema = z.enum([
  "READY",
  "DEGRADED",
  "UNREACHABLE",
  "CHECKING",
]);

export type ServiceState = z.infer<typeof ServiceStateSchema>;

export const ComponentStatusSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    state: ServiceStateSchema,
    detail: z.string().optional(),
    checkedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export type ComponentStatus = z.infer<typeof ComponentStatusSchema>;

export const SystemStatusSchema = z
  .object({
    service: z.string(),
    version: z.string(),
    state: ServiceStateSchema,
    checkedAt: z.iso.datetime({ offset: true }),
    components: z.array(ComponentStatusSchema),
  })
  .strict();

export type SystemStatus = z.infer<typeof SystemStatusSchema>;

export const ProviderCapabilitySchema = z
  .object({
    provider: z.string(),
    models: z.array(z.string()),
    supportsTools: z.boolean(),
    supportsStructuredOutput: z.boolean(),
  })
  .strict();

export type ProviderCapability = z.infer<typeof ProviderCapabilitySchema>;
