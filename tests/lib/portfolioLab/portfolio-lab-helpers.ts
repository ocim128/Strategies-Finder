import { timeKey, type Signal, type Time } from "../strategies";

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
