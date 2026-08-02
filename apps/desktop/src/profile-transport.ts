import { randomBytes } from "node:crypto";

const OK = "net::OK";
const USE_CHROMIUM_RESULT = -3;
const DENY = -2;
const DEFAULT_RETIRED_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETIRED_BINDINGS = 8;

type Certificate = { fingerprint?: string; issuerCert?: Certificate };
type VerifyRequest = { hostname: string; verificationResult: string; errorCode: number; certificate: Certificate };
type SessionLike = {
  setCertificateVerifyProc(handler: ((request: VerifyRequest, callback: (result: number) => void) => void) | null): void;
  fetch(input: URL, init?: RequestInit): Promise<Response>;
  clearStorageData(): Promise<void>;
};
type Profile = { id: string; origin: string; caFingerprint?: string | undefined };
type BodyTracker = { expire(): void };
type Binding = {
  key: string;
  session: SessionLike;
  requests: number;
  bodies: Set<BodyTracker>;
  retired: boolean;
  cleanupStarted: boolean;
  expirationStarted: boolean;
  timer?: ReturnType<typeof setTimeout>;
};

function normalize(value: string | undefined): string {
  return (value ?? "").replaceAll(":", "").toUpperCase();
}

function chainContains(certificate: Certificate, expected: string): boolean {
  let current: Certificate | undefined = certificate;
  const seen = new Set<Certificate>();
  for (let depth = 0; current && depth < 10 && !seen.has(current); depth += 1) {
    seen.add(current);
    if (normalize(current.fingerprint) === expected) return true;
    current = current.issuerCert;
  }
  return false;
}

export function createProfileTransport(dependencies: {
  fromPartition(name: string): SessionLike;
  retiredTimeoutMs?: number;
  maxRetiredBindings?: number;
}) {
  const retiredTimeoutMs = dependencies.retiredTimeoutMs ?? DEFAULT_RETIRED_TIMEOUT_MS;
  const maxRetiredBindings = dependencies.maxRetiredBindings ?? DEFAULT_MAX_RETIRED_BINDINGS;
  if (!Number.isSafeInteger(retiredTimeoutMs) || retiredTimeoutMs <= 0) throw new Error("Retired timeout must be positive");
  if (!Number.isSafeInteger(maxRetiredBindings) || maxRetiredBindings <= 0) throw new Error("Retired binding limit must be positive");
  const retired = new Set<Binding>();
  let active: Binding | undefined;

  const cleanupIfDrained = (binding: Binding) => {
    if (!binding.retired || binding.requests !== 0 || binding.cleanupStarted) return;
    binding.cleanupStarted = true;
    if (binding.timer) clearTimeout(binding.timer);
    retired.delete(binding);
    void binding.session.clearStorageData().catch(() => undefined);
  };

  const createBinding = (profile: Profile): Binding => {
    const expectedOrigin = new URL(profile.origin);
    const expectedFingerprint = normalize(profile.caFingerprint);
    const key = `${profile.id}\n${expectedOrigin.origin}\n${expectedFingerprint}`;
    const suffix = randomBytes(32).toString("hex");
    const session = dependencies.fromPartition(`persist:occ-profile-${profile.id}-${suffix}`);
    session.setCertificateVerifyProc((request, callback) => {
      const valid = request.hostname.toLowerCase() === expectedOrigin.hostname.toLowerCase()
        && request.verificationResult === OK
        && request.errorCode === 0
        && (expectedFingerprint.length === 0
          || (expectedFingerprint.length === 64 && chainContains(request.certificate, expectedFingerprint)));
      callback(valid ? USE_CHROMIUM_RESULT : DENY);
    });
    return { key, session, requests: 0, bodies: new Set(), retired: false, cleanupStarted: false, expirationStarted: false };
  };

  const expire = (binding: Binding) => {
    if (binding.expirationStarted) return;
    binding.expirationStarted = true;
    binding.bodies.forEach((body) => body.expire());
  };

  const retire = (binding: Binding) => {
    binding.retired = true;
    retired.add(binding);
    binding.timer = setTimeout(() => expire(binding), retiredTimeoutMs);
    const pending = [...retired].filter((candidate) => !candidate.expirationStarted);
    pending.slice(0, Math.max(0, pending.length - maxRetiredBindings)).forEach(expire);
    cleanupIfDrained(binding);
  };

  const transition = (profile: Profile | null): Binding | undefined => {
    if (profile) {
      const expectedOrigin = new URL(profile.origin);
      const key = `${profile.id}\n${expectedOrigin.origin}\n${normalize(profile.caFingerprint)}`;
      if (active?.key === key) return active;
    } else if (!active) return undefined;
    const previous = active;
    active = profile ? createBinding(profile) : undefined;
    if (previous) retire(previous);
    return active;
  };

  const trackResponse = (binding: Binding, response: Response, release: () => void): Response => {
    if (!response.body) {
      release();
      return response;
    }
    const reader = response.body.getReader();
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let expired: Error | undefined;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      binding.bodies.delete(tracker);
      release();
    };
    const tracker: BodyTracker = {
      expire() {
        if (finished || expired) return;
        expired = new Error("Profile response binding retired");
        try { controller?.error(expired); } catch { /* stream already terminal */ }
        void reader.cancel(expired).catch(() => undefined).finally(finish);
      },
    };
    binding.bodies.add(tracker);
    const body = new ReadableStream<Uint8Array>({
      start(value) { controller = value; },
      async pull(value) {
        if (expired) throw expired;
        try {
          const result = await reader.read();
          if (expired) throw expired;
          if (result.done) {
            value.close();
            finish();
          } else {
            value.enqueue(result.value);
          }
        } catch (error) {
          try { value.error(error); } catch { /* stream already terminal */ }
          finish();
        }
      },
      async cancel(reason) {
        try { await reader.cancel(reason); } finally { finish(); }
      },
    });
    const tracked = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    for (const property of ["url", "redirected", "type"] as const) {
      Object.defineProperty(tracked, property, { value: response[property], configurable: true });
    }
    return tracked;
  };

  return {
    async setProfile(profile: Profile | null) { transition(profile); },
    async fetch(profile: Profile, input: URL, init?: RequestInit) {
      if (input.origin !== new URL(profile.origin).origin) throw new Error("Profile transport origin mismatch");
      const binding = transition(profile);
      if (!binding) throw new Error("Profile transport unavailable");
      binding.requests += 1;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        binding.requests -= 1;
        cleanupIfDrained(binding);
      };
      try {
        return trackResponse(binding, await binding.session.fetch(input, init), release);
      } catch (error) {
        release();
        throw error;
      }
    },
  };
}
