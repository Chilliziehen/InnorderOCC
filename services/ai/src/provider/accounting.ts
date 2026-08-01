import type { ProviderProfile } from "@innorder/contracts";

import { ProviderError } from "./provider-policy.js";

export type TokenUsage = Readonly<{ inputTokens: number; outputTokens: number }>;
export type AccountingInput = Readonly<{
  requestBytes: number;
  responseBytes: number;
  usage?: TokenUsage;
  cost: ProviderProfile["cost"];
}>;
export type AccountingResult = Readonly<TokenUsage & { costMicros: bigint; currency: string; estimated: boolean }>;

function safeCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function componentCost(tokens: number, microsPerMillion: number): bigint {
  const numerator = BigInt(tokens) * BigInt(microsPerMillion);
  return numerator === 0n ? 0n : (numerator + 999_999n) / 1_000_000n;
}

export function calculateAccounting(input: AccountingInput): AccountingResult {
  if (!safeCount(input.requestBytes) || !safeCount(input.responseBytes) || !safeCount(input.cost.inputMicrosPerMillionTokens) || !safeCount(input.cost.outputMicrosPerMillionTokens) || !/^[A-Z]{3}$/u.test(input.cost.currency)) {
    throw new ProviderError("OCC-AI-PROVIDER-ACCOUNTING");
  }
  if (input.usage !== undefined && (!safeCount(input.usage.inputTokens) || !safeCount(input.usage.outputTokens))) throw new ProviderError("OCC-AI-PROVIDER-ACCOUNTING");
  const inputTokens = Math.max(input.usage?.inputTokens ?? 0, input.requestBytes);
  const outputTokens = Math.max(input.usage?.outputTokens ?? 0, input.responseBytes);
  const estimated = input.usage === undefined || inputTokens !== input.usage.inputTokens || outputTokens !== input.usage.outputTokens;
  return {
    inputTokens,
    outputTokens,
    costMicros: componentCost(inputTokens, input.cost.inputMicrosPerMillionTokens) + componentCost(outputTokens, input.cost.outputMicrosPerMillionTokens),
    currency: input.cost.currency,
    estimated,
  };
}
