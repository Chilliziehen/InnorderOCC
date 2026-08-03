import type { ConsumedGrant, PostgresAiRepository } from "../persistence/postgres.js";
import { verifyAiGrant, type GrantVerifierOptions } from "../security/grant-verifier.js";

export class GrantConsumer {
  constructor(
    private readonly verifier: GrantVerifierOptions,
    private readonly repository: PostgresAiRepository,
  ) {}

  async consume(token: string, signal?: AbortSignal): Promise<ConsumedGrant> {
    const grant = await verifyAiGrant(token, this.verifier);
    return this.repository.consumeGrant(grant, signal);
  }
}
