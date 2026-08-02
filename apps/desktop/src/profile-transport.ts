import { createHash } from "node:crypto";

const OK = "net::OK";
const USE_CHROMIUM_RESULT = -3;
const DENY = -2;

type Certificate = { fingerprint?: string; issuerCert?: Certificate };
type VerifyRequest = { hostname: string; verificationResult: string; errorCode: number; certificate: Certificate };
type SessionLike = {
  setCertificateVerifyProc(handler: ((request: VerifyRequest, callback: (result: number) => void) => void) | null): void;
  fetch(input: URL, init?: RequestInit): Promise<Response>;
  clearStorageData(): Promise<void>;
};
type Profile = { id: string; origin: string; caFingerprint?: string | undefined };

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

export function createProfileTransport(dependencies: { fromPartition(name: string): SessionLike }) {
  type Binding = { key: string; profile: Profile; session: SessionLike; requests: number; drained: Array<() => void>; retirement: number };
  const bindings = new Map<string, Binding>();
  let active: Binding | undefined;

  const bindingFor = (profile: Profile): Binding => {
    const expectedOrigin = new URL(profile.origin);
    const expectedFingerprint = normalize(profile.caFingerprint);
    const key = `${profile.id}\n${expectedOrigin.origin}\n${expectedFingerprint}`;
    const existing = bindings.get(key);
    if (existing) return existing;
    const suffix = createHash("sha256").update(key).digest("hex");
    const session = dependencies.fromPartition(`persist:occ-profile-${profile.id}-${suffix}`);
    session.setCertificateVerifyProc((request, callback) => {
      const valid = request.hostname.toLowerCase() === expectedOrigin.hostname.toLowerCase()
        && request.verificationResult === OK
        && request.errorCode === 0
        && (expectedFingerprint.length === 0
          || (expectedFingerprint.length === 64 && chainContains(request.certificate, expectedFingerprint)));
      callback(valid ? USE_CHROMIUM_RESULT : DENY);
    });
    const binding = { key, profile: { ...profile }, session, requests: 0, drained: [], retirement: 0 };
    bindings.set(key, binding);
    return binding;
  };

  const waitForDrain = (binding: Binding) => binding.requests === 0
    ? Promise.resolve()
    : new Promise<void>((resolve) => binding.drained.push(resolve));

  const transition = (profile: Profile | null): { binding?: Binding; cleanup: Promise<void> } => {
    const next = profile ? bindingFor(profile) : undefined;
    if (active === next) return { ...(next ? { binding: next } : {}), cleanup: Promise.resolve() };
    const previous = active;
    active = next;
    if (!previous) return { ...(next ? { binding: next } : {}), cleanup: Promise.resolve() };
    const retirement = ++previous.retirement;
    const cleanup = waitForDrain(previous).then(async () => {
      if (active !== previous && previous.retirement === retirement) await previous.session.clearStorageData();
    });
    return { ...(next ? { binding: next } : {}), cleanup };
  };

  const setProfile = async (profile: Profile | null) => transition(profile).cleanup;
  return {
    setProfile,
    async fetch(profile: Profile, input: URL, init?: RequestInit) {
      if (input.origin !== new URL(profile.origin).origin) throw new Error("Profile transport origin mismatch");
      const { binding, cleanup } = transition(profile);
      if (!binding) throw new Error("Profile transport unavailable");
      binding.requests += 1;
      try {
        await cleanup;
        return await binding.session.fetch(input, init);
      } finally {
        binding.requests -= 1;
        if (binding.requests === 0) binding.drained.splice(0).forEach((resolve) => resolve());
      }
    },
  };
}
