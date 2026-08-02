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
  let active: { profile: Profile; session: SessionLike } | undefined;
  const setProfile = async (profile: Profile | null) => {
    if (active && active.profile.id === profile?.id && active.profile.origin === profile.origin && active.profile.caFingerprint === profile.caFingerprint) return;
    if (active) {
      active.session.setCertificateVerifyProc(null);
      await active.session.clearStorageData();
      active = undefined;
    }
    if (!profile) return;
    const expectedOrigin = new URL(profile.origin);
    const expectedFingerprint = normalize(profile.caFingerprint);
    const session = dependencies.fromPartition(`persist:occ-profile-${profile.id}`);
    session.setCertificateVerifyProc((request, callback) => {
      const valid = request.hostname.toLowerCase() === expectedOrigin.hostname.toLowerCase()
        && request.verificationResult === OK
        && request.errorCode === 0
        && (expectedFingerprint.length === 0
          || (expectedFingerprint.length === 64 && chainContains(request.certificate, expectedFingerprint)));
      callback(valid ? USE_CHROMIUM_RESULT : DENY);
    });
    active = { profile: { ...profile }, session };
  };
  return {
    setProfile,
    async fetch(profile: Profile, input: URL, init?: RequestInit) {
      if (input.origin !== new URL(profile.origin).origin) throw new Error("Profile transport origin mismatch");
      await setProfile(profile);
      if (!active) throw new Error("Profile transport unavailable");
      return active.session.fetch(input, init);
    },
  };
}
