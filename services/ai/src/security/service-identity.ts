import type { PeerCertificate } from "node:tls";

type PeerFacts = Partial<Pick<PeerCertificate, "subjectaltname" | "ext_key_usage" | "serialNumber" | "valid_from" | "valid_to" | "subject">>;

const CLIENT_AUTH_EKU = "1.3.6.1.5.5.7.3.2";
const SPIFFE = /^spiffe:\/\/innorder\/(?:core|ai)$/u;

export function verifyServiceIdentity(
  peer: PeerFacts,
  tlsAuthorized: boolean,
  expectedIdentity: "spiffe://innorder/core" | "spiffe://innorder/ai",
  revokedSerials: ReadonlySet<string>,
  nowMs = Date.now(),
  usage: "client" | "server" = "client",
): boolean {
  if (!tlsAuthorized || typeof peer.subjectaltname !== "string" || typeof peer.serialNumber !== "string") return false;
  const uriSans = peer.subjectaltname.split(/,\s*/u)
    .filter((entry) => entry.startsWith("URI:"))
    .map((entry) => entry.slice(4));
  if (uriSans.length !== 1 || uriSans[0] !== expectedIdentity || !SPIFFE.test(uriSans[0])) return false;
  const requiredEku = usage === "client" ? CLIENT_AUTH_EKU : "1.3.6.1.5.5.7.3.1";
  if (!peer.ext_key_usage?.includes(requiredEku)) return false;
  const notBefore = Date.parse(peer.valid_from ?? "");
  const notAfter = Date.parse(peer.valid_to ?? "");
  if (!Number.isFinite(notBefore) || !Number.isFinite(notAfter) || nowMs < notBefore || nowMs >= notAfter) return false;
  return !new Set([...revokedSerials].map((serial) => serial.toUpperCase())).has(peer.serialNumber.toUpperCase());
}

export function parseRevokedSerials(value: string): Set<string> {
  if (Buffer.byteLength(value, "ascii") > 64 * 1024 || value.includes("\0")) throw new Error("Invalid revocation list");
  const serials = value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (serials.some((serial) => !/^[A-Fa-f0-9]{1,64}$/u.test(serial))) throw new Error("Invalid revocation list");
  return new Set(serials.map((serial) => serial.toUpperCase()));
}
