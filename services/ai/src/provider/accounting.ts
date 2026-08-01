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
  const estimated = input.usage === undefined;
  const inputTokens = input.usage?.inputTokens ?? input.requestBytes;
  const outputTokens = input.usage?.outputTokens ?? input.responseBytes;
  if (!safeCount(inputTokens) || !safeCount(outputTokens)) throw new ProviderError("OCC-AI-PROVIDER-ACCOUNTING");
  return {
    inputTokens,
    outputTokens,
    costMicros: componentCost(inputTokens, input.cost.inputMicrosPerMillionTokens) + componentCost(outputTokens, input.cost.outputMicrosPerMillionTokens),
    currency: input.cost.currency,
    estimated,
  };
}
