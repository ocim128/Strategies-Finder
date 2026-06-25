import dns from "node:dns";
import { createRequire } from "node:module";
import { isIP } from "node:net";

export type BinanceDnsMode = "system" | "adguard-doh";

const ADGUARD_DOH_RESOLVE_URL = "https://dns.adguard-dns.com/resolve";
const BINANCE_HOST_RE = /(^|\.)binance\.com$/i;
const POLYMARKET_HOST_RE = /(^|\.)polymarket\.com$/i;
const DNS_CACHE_TTL_MS = 5 * 60 * 1000;

type LookupCallback = (
    error: NodeJS.ErrnoException | null,
    address: string | dns.LookupAddress[],
    family?: number
) => void;
type LookupOptions = dns.LookupOptions & { all?: boolean };
type ConnectLookup = (hostname: string, options: LookupOptions, callback: LookupCallback) => void;
type UndiciModule = {
    Agent: new (options: { connect: { lookup: ConnectLookup } }) => unknown;
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
const cache = new Map<string, CacheEntry>();
let configuredMode: BinanceDnsMode = "system";
// True once we have attempted AdGuard DoH and found undici unresolvable.
// Keeps the fallback idempotent without misreporting configuredMode.
let undiciUnavailable = false;

export function resolveBinanceDnsMode(value: unknown, fallback: BinanceDnsMode = "system"): BinanceDnsMode {
    const normalized = String(value ?? "").trim().toLowerCase();
    if (!normalized) return fallback;
    if (normalized === "system" || normalized === "default") return "system";
    if (normalized === "adguard" || normalized === "adguard-doh" || normalized === "doh") return "adguard-doh";
    return fallback;
}

function shouldUseAdguardDoh(hostname: string): boolean {
    return BINANCE_HOST_RE.test(hostname) || POLYMARKET_HOST_RE.test(hostname);
}

function isValidAddressForFamily(value: unknown, family: 4 | 6): value is string {
    return typeof value === "string" && isIP(value) === family;
}

async function resolveAdguardDoh(hostname: string, family: 4 | 6): Promise<dns.LookupAddress[]> {
    const cacheKey = `${hostname}:${family}`;
    const cached = cache.get(cacheKey);
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

    const ttlMs = Math.max(
        30_000,
        Math.min(
            DNS_CACHE_TTL_MS,
            Math.min(...answers.map((answer) => Number(answer.TTL)).filter(Number.isFinite)) * 1000
        )
    );
    cache.set(cacheKey, {
        expiresAtMs: Date.now() + ttlMs,
        addresses,
    });
    return addresses;
}

function fallbackLookup(hostname: string, options: LookupOptions, callback: LookupCallback): void {
    (dns.lookup as unknown as ConnectLookup)(hostname, options, callback);
}

async function lookupAdguardHost(hostname: string, options: LookupOptions): Promise<dns.LookupAddress[]> {
    const requestedFamily = options.family === 6 ? 6 : 4;
    return resolveAdguardDoh(hostname, requestedFamily);
}

const adguardLookup: ConnectLookup = (hostname, options, callback) => {
    if (!shouldUseAdguardDoh(hostname)) {
        fallbackLookup(hostname, options, callback);
        return;
    }

    void lookupAdguardHost(hostname, options)
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

export function configureBinanceDns(mode: BinanceDnsMode): BinanceDnsMode {
    if (mode === "system" || configuredMode === mode || undiciUnavailable) return configuredMode;

    // undici is an optional peer (see lib/polymarket-node-dns.ts for the full
    // rationale). On hosts where it isn't resolvable, fall back to the system
    // resolver instead of throwing and aborting the Vite config load / build.
    let undici: UndiciModule;
    try {
        undici = require("undici") as UndiciModule;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[binance-dns] undici unavailable (${message}); falling back to system DNS. AdGuard DoH will not be active.`);
        undiciUnavailable = true;
        return "system";
    }
    undici.setGlobalDispatcher(new undici.Agent({
        connect: {
            lookup: adguardLookup,
        },
    }));
    configuredMode = mode;
    return configuredMode;
}

export function getConfiguredBinanceDnsMode(): BinanceDnsMode {
    return configuredMode;
}
