import { timeKey, type Signal, type Time } from "../strategies";
import { parsePortfolioSyntheticPairSymbol } from "./portfolio-lab-synthetic";

const DEFAULT_PORTFOLIO_MAJOR_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "ADAUSDT"] as const;

export interface PortfolioSignalPresence {
    buy: boolean;
    sell: boolean;
}

export function buildPortfolioSignalPresenceLookup(
    signals: Array<{ time: Time; type: Signal["type"] }>
): Map<string, PortfolioSignalPresence> {
    const lookup = new Map<string, PortfolioSignalPresence>();
    for (const signal of signals) {
        const key = timeKey(signal.time);
        const existing = lookup.get(key) ?? { buy: false, sell: false };
        if (signal.type === "buy") {
            existing.buy = true;
        } else {
            existing.sell = true;
        }
        lookup.set(key, existing);
    }
    return lookup;
}

export function resolvePortfolioSignalType(
    presence: PortfolioSignalPresence | null | undefined
): Signal["type"] | null {
    if (!presence) {
        return null;
    }
    if (presence.buy === presence.sell) {
        return null;
    }
    return presence.buy ? "buy" : "sell";
}

export function resolveLatestPortfolioSignalType(
    windowKeys: string[],
    signalPresenceByTime: Map<string, PortfolioSignalPresence>
): Signal["type"] | null {
    let latestPresence: PortfolioSignalPresence | null = null;
    for (const key of windowKeys) {
        const presence = signalPresenceByTime.get(key);
        if (presence) {
            latestPresence = presence;
        }
    }
    return resolvePortfolioSignalType(latestPresence);
}

export function buildRunnablePortfolioUniverse(
    currentSymbol: string,
    benchmarkSymbol: string | null,
    majorSymbols: readonly string[] = DEFAULT_PORTFOLIO_MAJOR_SYMBOLS
): string[] {
    const unique = new Set<string>();
    const normalizedCurrent = currentSymbol.trim().toUpperCase();
    const normalizedBenchmark = benchmarkSymbol?.trim().toUpperCase() ?? "";

    if (normalizedCurrent) {
        unique.add(normalizedCurrent);
    }
    if (normalizedBenchmark) {
        unique.add(normalizedBenchmark);
    }
    for (const symbol of majorSymbols) {
        unique.add(symbol);
        if (unique.size >= 2) {
            break;
        }
    }

    return Array.from(unique).slice(0, 2);
}

const PORTFOLIO_QUOTE_SUFFIXES = ["USDT", "USDC", "USD", "BTC", "ETH", "BNB"] as const;

function stripKnownQuoteSuffix(symbol: string): string {
    for (const suffix of PORTFOLIO_QUOTE_SUFFIXES) {
        if (symbol.length > suffix.length && symbol.endsWith(suffix)) {
            return symbol.slice(0, -suffix.length);
        }
    }
    return symbol;
}

function sharesLegWithCompressedTarget(targetCompressed: string, legSymbol: string): boolean {
    const core = stripKnownQuoteSuffix(legSymbol);
    if (!core) {
        return false;
    }
    return targetCompressed.startsWith(core) || targetCompressed.endsWith(core);
}

function resolveCompressedForm(symbol: string): string | null {
    const parsed = parsePortfolioSyntheticPairSymbol(symbol);
    if (parsed) {
        return parsed.syntheticSymbol;
    }
    const normalized = symbol.trim().toUpperCase();
    return normalized || null;
}

export function isIndependentPeer(targetSymbol: string, peerSymbol: string): boolean {
    const targetCompressed = resolveCompressedForm(targetSymbol);
    const peer = parsePortfolioSyntheticPairSymbol(peerSymbol);
    if (!targetCompressed || !peer) {
        return true;
    }
    if (sharesLegWithCompressedTarget(targetCompressed, peer.baseSymbol)) {
        return false;
    }
    if (sharesLegWithCompressedTarget(targetCompressed, peer.quoteSymbol)) {
        return false;
    }
    return true;
}
