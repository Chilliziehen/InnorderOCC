import {
  ProviderCapabilitySchema,
  type ProviderCapability,
} from "@innorder/contracts";
import type { Runnable } from "@langchain/core/runnables";

export type ProviderModelFactory = () => Promise<Runnable>;

interface ProviderRegistration {
  capability: ProviderCapability;
  createModel?: ProviderModelFactory;
}

const providerRegistry = [
  {
    capability: {
      provider: "openai-compatible",
      models: ["openai-compatible/*"],
      supportsTools: true,
      supportsStructuredOutput: true,
    },
  },
] satisfies readonly ProviderRegistration[];

const ProviderCapabilitiesSchema = ProviderCapabilitySchema.array();

export function parseProviderCapabilities(
  capabilities: unknown,
): ProviderCapability[] {
  return ProviderCapabilitiesSchema.parse(capabilities);
}

export function getProviderCapabilities(): ProviderCapability[] {
  return parseProviderCapabilities(
    providerRegistry.map(({ capability }) => capability),
  );
}
