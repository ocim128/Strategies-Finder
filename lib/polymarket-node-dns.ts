import dns from "node:dns";
import { createRequire } from "node:module";
import { isIP } from "node:net";

export type PolymarketDnsMode = "system" | "adguard-doh";

const ADGUARD_DOH_RESOLVE_URL = "https://dns.adguard-dns.com/resolve";
const POLYMARKET_HOST_RE = /(^|\.)polymarket\.com$/i;
const DNS_CACHE_TTL_MS = 5 * 60 * 1000;
const CONNECT_TIMEOUT_MS = 20_000;

type LookupCallback = (
    error: NodeJS.ErrnoException | null,
    address: string | dns.LookupAddress[],
    family?: number
) => void;
type LookupOptions = dns.LookupOptions & { all?: boolean };
type ConnectLookup = (hostname: string, options: LookupOptions, callback: LookupCallback) => void;
type UndiciModule = {
    Agent: new (options: { connect: { lookup: ConnectLookup; timeout?: number } }) => unknown;
    setGlobalDispatcher: (dispatcher: unknown) => void;
};
type DnsJsonAnswer = {
    type?: number;
    TTL?: number;
    data?: string;
};
type DnsJsonResponse = {
    Answer?: DnsJsonAnswer[];
};
type CacheEntry = {
    expiresAtMs: number;
    addresses: dns.LookupAddress[];
};

const require = createRequire(import.meta.url);
const dnsCache = new Map<string, CacheEntry>();
let configuredMode: PolymarketDnsMode = "system";
// True once we have attempted AdGuard DoH and found undici unresolvable.
// Keeps the fallback idempotent without misreporting configuredMode as the
// requested mode (which would break the return-value contract).
let undiciUnavailable = false;

export function resolvePolymarketDnsMode(
    value: unknown,
    fallback: PolymarketDnsMode = "system"
): PolymarketDnsMode {
    const normalized = String(value ?? "").trim().toLowerCase();
    if (!normalized) return fallback;
    if (normalized === "system" || normalized === "default") return "system";
    if (normalized === "adguard" || normalized === "adguard-doh" || normalized === "doh") return "adguard-doh";
    return fallback;
}

function isPolymarketHost(hostname: string): boolean {
    return POLYMARKET_HOST_RE.test(hostname);
}

function isValidAddressForFamily(value: unknown, family: 4 | 6): value is string {
    return typeof value === "string" && isIP(value) === family;
}

async function resolveAdguardDoh(hostname: string, family: 4 | 6): Promise<dns.LookupAddress[]> {
    const cacheKey = `${hostname}:${family}`;
    const cached = dnsCache.get(cacheKey);
    if (cached && cached.expiresAtMs > Date.now()) return cached.addresses;

    const url = new URL(ADGUARD_DOH_RESOLVE_URL);
    url.searchParams.set("name", hostname);
    url.searchParams.set("type", family === 4 ? "A" : "AAAA");

    const response = await fetch(url, {
        headers: { Accept: "application/dns-json" },
        signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
        throw new Error(`AdGuard DNS lookup failed for ${hostname}: HTTP ${response.status}`);
    }

    const payload = await response.json() as DnsJsonResponse;
    const answers = Array.isArray(payload.Answer) ? payload.Answer : [];
    const addresses = answers
        .filter((answer) => answer.type === (family === 4 ? 1 : 28))
        .map((answer) => answer.data)
        .filter((address): address is string => isValidAddressForFamily(address, family))
        .map((address) => ({ address, family }));

    if (addresses.length === 0) {
        throw new Error(`AdGuard DNS returned no ${family === 4 ? "A" : "AAAA"} records for ${hostname}`);
    }

    const ttlValues = answers.map((answer) => Number(answer.TTL)).filter(Number.isFinite);
    const ttlMs = Math.max(
        30_000,
        Math.min(DNS_CACHE_TTL_MS, (ttlValues.length > 0 ? Math.min(...ttlValues) : 300) * 1000)
    );
    dnsCache.set(cacheKey, {
        expiresAtMs: Date.now() + ttlMs,
        addresses,
    });
    return addresses;
}

function fallbackLookup(hostname: string, options: LookupOptions, callback: LookupCallback): void {
    (dns.lookup as unknown as ConnectLookup)(hostname, options, callback);
}

const adguardLookup: ConnectLookup = (hostname, options, callback) => {
    if (!isPolymarketHost(hostname)) {
        fallbackLookup(hostname, options, callback);
        return;
    }

    const requestedFamily = options.family === 6 ? 6 : 4;
    void resolveAdguardDoh(hostname, requestedFamily)
        .then((addresses) => {
            if (options.all) {
                callback(null, addresses);
                return;
            }
            const first = addresses[0];
            callback(null, first.address, first.family);
        })
        .catch(() => fallbackLookup(hostname, options, callback));
};

export function configurePolymarketNodeDns(mode: PolymarketDnsMode): PolymarketDnsMode {
    if (mode === "system" || configuredMode === mode || undiciUnavailable) return configuredMode;

    // undici is an optional peer: it ships with Node >=18 but is not declared
    // as a project dependency, and is hoisted only in some install layouts
    // (e.g. the monorepo's shared node_modules). On hosts where it isn't
    // resolvable (Vercel, minimal installs), require() would throw and abort
    // the Vite config load — breaking the whole build. Treat a missing undici
    // as "AdGuard DoH unavailable here" and fall back to the system resolver
    // instead of crashing. The DoH behavior simply won't be active in that
    // environment; nothing else regresses.
    let undici: UndiciModule;
    try {
        undici = require("undici") as UndiciModule;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[polymarket-node-dns] undici unavailable (${message}); falling back to system DNS. AdGuard DoH will not be active.`);
        undiciUnavailable = true;
        return "system";
    }
    undici.setGlobalDispatcher(new undici.Agent({
        connect: {
            lookup: adguardLookup,
            timeout: CONNECT_TIMEOUT_MS,
        },
    }));
    configuredMode = mode;
    return configuredMode;
}
