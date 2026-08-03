import { createHash, createPublicKey } from "node:crypto";

import { aiGrantClaimsSchema, type AiGrantClaims } from "@innorder/contracts";
import { importSPKI, jwtVerify } from "jose";

export interface GrantVerificationKey {
  kid: string;
  publicKey: string;
}

export interface GrantVerifierOptions {
  keys: GrantVerificationKey[];
  now?: () => number;
  clockSkewSeconds?: number;
}

export interface VerifiedAiGrant {
  claims: AiGrantClaims;
  tokenHash: string;
}

const KID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export async function verifyAiGrant(token: string, options: GrantVerifierOptions): Promise<VerifiedAiGrant> {
  try {
    if (token.length < 3 || token.length > 8192 || options.keys.length < 1 || options.keys.length > 2) throw new Error();
    const skew = options.clockSkewSeconds ?? 30;
    if (!Number.isInteger(skew) || skew < 0 || skew > 30) throw new Error();
    const keyMap = new Map<string, Awaited<ReturnType<typeof importSPKI>>>();
    for (const item of options.keys) {
      if (!KID.test(item.kid) || keyMap.has(item.kid)) throw new Error();
      const details = createPublicKey(item.publicKey).asymmetricKeyDetails;
      if (details?.modulusLength === undefined || details.modulusLength < 3072) throw new Error();
      keyMap.set(item.kid, await importSPKI(item.publicKey, "RS256"));
    }
    const now = options.now?.() ?? Math.floor(Date.now() / 1000);
    const verified = await jwtVerify(token, async (header) => {
      if (header.alg !== "RS256" || typeof header.kid !== "string" || Object.keys(header).some((key) => !["alg", "kid"].includes(key))) {
        throw new Error();
      }
      const key = keyMap.get(header.kid);
      if (key === undefined) throw new Error();
      return key;
    }, {
      algorithms: ["RS256"], issuer: "innorder-core", audience: "innorder-ai",
      clockTolerance: skew, currentDate: new Date(now * 1000),
    });
    const claims = aiGrantClaimsSchema.parse(verified.payload);
    if (claims.iat > now + skew || claims.nbf > claims.iat || claims.exp - claims.iat > 300) throw new Error();
    return { claims, tokenHash: createHash("sha256").update(token, "ascii").digest("hex") };
  } catch {
    throw new Error("OCC-AI-GRANT-INVALID");
  }
}
