import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

import { providerConfigSchema, type ProviderConfig } from "@innorder/contracts";

export type DnsAnswer = Readonly<{ address: string; family: 4 | 6 }>;
export type DnsResolver = (hostname: string) => Promise<readonly DnsAnswer[]>;

export class ProviderError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(code: string, retryable = false, options?: Readonly<{ cause?: unknown; retryAfterMs?: number }>) {
    super(code, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ProviderError";
    this.code = code;
    this.retryable = retryable;
    if (options?.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
  }
}

export type ResolvedProviderTarget = Readonly<{
  url: URL;
  address: string;
  family: 4 | 6;
  servername: string;
  hostHeader: string;
}>;

type IpValue = Readonly<{ value: bigint; bits: 32 | 128 }>;

function parseIpv4(address: string): bigint | undefined {
  if (isIP(address) !== 4) return undefined;
  return address.split(".").reduce((result, octet) => (result << 8n) | BigInt(octet), 0n);
}

function parseIpv6(address: string): bigint | undefined {
  if (address.includes("%") || isIP(address) !== 6) return undefined;
  const halves = address.toLowerCase().split("::");
  if (halves.length > 2) return undefined;
  const parsePart = (part: string): number[] | undefined => {
    if (part === "") return [];
    const result: number[] = [];
    for (const segment of part.split(":")) {
      if (segment.includes(".")) {
        const ipv4 = parseIpv4(segment);
        if (ipv4 === undefined) return undefined;
        result.push(Number((ipv4 >> 16n) & 0xffffn), Number(ipv4 & 0xffffn));
      } else {
        if (!/^[0-9a-f]{1,4}$/u.test(segment)) return undefined;
        result.push(Number.parseInt(segment, 16));
      }
    }
    return result;
  };
  const left = parsePart(halves[0] ?? "");
  const right = parsePart(halves[1] ?? "");
  if (left === undefined || right === undefined) return undefined;
  const missing = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (missing < 0 || (halves.length === 1 && left.length !== 8) || (halves.length === 2 && missing < 1)) return undefined;
  const groups = [...left, ...Array<number>(missing).fill(0), ...right];
  if (groups.length !== 8) return undefined;
  return groups.reduce((result, group) => (result << 16n) | BigInt(group), 0n);
}

function parseIp(address: string): IpValue | undefined {
  const ipv4 = parseIpv4(address);
  if (ipv4 !== undefined) return { value: ipv4, bits: 32 };
  const ipv6 = parseIpv6(address);
  return ipv6 === undefined ? undefined : { value: ipv6, bits: 128 };
}

function inPrefix(value: bigint, network: bigint, bits: number, prefix: number): boolean {
  if (prefix === 0) return true;
  const shift = BigInt(bits - prefix);
  return value >> shift === network >> shift;
}

function inCidr(address: string, cidr: string): boolean {
  const separator = cidr.lastIndexOf("/");
  const value = parseIp(address);
  const network = parseIp(cidr.slice(0, separator));
  const prefix = Number(cidr.slice(separator + 1));
  return value !== undefined && network !== undefined && value.bits === network.bits && prefix >= 0 && prefix <= value.bits && inPrefix(value.value, network.value, value.bits, prefix);
}

const FORBIDDEN_V4: readonly [string, number][] = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["192.31.196.0", 24], ["192.52.193.0", 24], ["192.88.99.0", 24], ["192.175.48.0", 24],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
  ["168.63.129.16", 32],
];

const FORBIDDEN_V6: readonly [string, number][] = [
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001:2::", 48],
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20], ["5f00::", 16],
  ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
];

function mappedIpv4(value: bigint): string | undefined {
  if (value >> 32n !== 0xffffn) return undefined;
  const v4 = value & 0xffffffffn;
  return [24n, 16n, 8n, 0n].map((shift) => Number((v4 >> shift) & 255n)).join(".");
}

function embeddedIpv4(value: bigint): string | undefined {
  const mapped = mappedIpv4(value);
  if (mapped !== undefined) return mapped;
  if (value >> 32n === 0n && value > 1n) {
    const v4 = value & 0xffffffffn;
    return [24n, 16n, 8n, 0n].map((shift) => Number((v4 >> shift) & 255n)).join(".");
  }
  if (((value >> 32n) & 0xffffffffn) === 0x00005efen) {
    const v4 = value & 0xffffffffn;
    return [24n, 16n, 8n, 0n].map((shift) => Number((v4 >> shift) & 255n)).join(".");
  }
  return undefined;
}

function isForbidden(address: string): boolean {
  const parsed = parseIp(address);
  if (parsed === undefined) return true;
  if (parsed.bits === 32) {
    return FORBIDDEN_V4.some(([network, prefix]) => inPrefix(parsed.value, parseIpv4(network)!, 32, prefix));
  }
  const embedded = embeddedIpv4(parsed.value);
  if (embedded !== undefined) {
    if (parsed.value >> 32n === 0n) return true;
    return isForbidden(embedded);
  }
  return FORBIDDEN_V6.some(([network, prefix]) => inPrefix(parsed.value, parseIpv6(network)!, 128, prefix));
}

function approved(address: string, cidrs: readonly string[]): boolean {
  const parsed = parseIp(address);
  if (parsed?.bits === 128) {
    const mapped = mappedIpv4(parsed.value);
    if (mapped !== undefined) return cidrs.some((cidr) => inCidr(mapped, cidr));
  }
  return cidrs.some((cidr) => inCidr(address, cidr));
}

function validateRawEndpoint(endpoint: string): void {
  if (endpoint.includes("%") || endpoint.includes("\\")) throw new ProviderError("OCC-AI-PROVIDER-POLICY");
  const path = endpoint.startsWith("/") ? endpoint.split(/[?#]/u, 1)[0]! : new URL(endpoint).pathname;
  if (path.split("/").some((segment) => segment === "." || segment === "..")) throw new ProviderError("OCC-AI-PROVIDER-POLICY");
}

export class ProviderPolicy {
  readonly config: ProviderConfig;

  constructor(config: ProviderConfig, private readonly resolver: DnsResolver = async (hostname) =>
    (await lookup(hostname, { all: true, verbatim: true })).map(({ address, family }) => ({ address, family: family as 4 | 6 }))) {
    this.config = providerConfigSchema.parse(config);
  }

  async resolve(endpoint: string): Promise<ResolvedProviderTarget> {
    try {
      validateRawEndpoint(endpoint);
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("OCC-AI-PROVIDER-POLICY");
    }
    let url: URL;
    try {
      url = endpoint.startsWith("/") ? new URL(endpoint, this.config.origin) : new URL(endpoint);
    } catch {
      throw new ProviderError("OCC-AI-PROVIDER-POLICY");
    }
    const origin = new URL(this.config.origin);
    const prefix = this.config.apiPrefix === "/" ? "/" : `${this.config.apiPrefix}/`;
    if (url.protocol !== "https:" || url.origin !== origin.origin || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || (url.pathname !== this.config.apiPrefix && !url.pathname.startsWith(prefix))) {
      throw new ProviderError("OCC-AI-PROVIDER-POLICY");
    }
    let answers: readonly DnsAnswer[];
    try {
      answers = await this.resolver(origin.hostname);
    } catch {
      throw new ProviderError("OCC-AI-PROVIDER-DNS");
    }
    if (answers.length === 0 || answers.some(({ address, family }) => parseIp(address)?.bits !== (family === 4 ? 32 : 128))) {
      throw new ProviderError("OCC-AI-PROVIDER-ADDRESS");
    }
    if (answers.some(({ address }) => isForbidden(address) && !approved(address, this.config.approvedPrivateCidrs))) {
      throw new ProviderError("OCC-AI-PROVIDER-ADDRESS");
    }
    const selected = answers[0]!;
    return {
      url,
      address: selected.address,
      family: selected.family,
      servername: origin.hostname,
      hostHeader: origin.port === "" ? origin.hostname : `${origin.hostname}:${origin.port}`,
    };
  }
}
