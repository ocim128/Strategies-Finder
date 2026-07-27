import { stripIbkrMarker } from "../local-daily-datasets";

export type IbkrCatalogAsset = {
    symbol: string;
    name: string;
    intervals?: string[];
    lastTimes?: Partial<Record<string, string | null>>;
};

export type StaleIbkrSymbolsResult = {
    freshestTime: string | null;
    symbols: string[];
};

export function findStaleIbkrSymbols(
    assets: readonly IbkrCatalogAsset[],
    interval: string,
): StaleIbkrSymbolsResult {
    const candidates = assets
        .map((asset) => ({
            symbol: stripIbkrMarker(asset.name || asset.symbol),
            lastTime: asset.lastTimes?.[interval] ?? null,
            timeMs: Date.parse(asset.lastTimes?.[interval] ?? ""),
        }))
        .filter((asset) => asset.symbol && Number.isFinite(asset.timeMs));
    const freshestTimeMs = candidates.reduce(
        (freshest, asset) => Math.max(freshest, asset.timeMs),
        Number.NEGATIVE_INFINITY,
    );

    if (!Number.isFinite(freshestTimeMs)) {
        return { freshestTime: null, symbols: [] };
    }

    return {
        freshestTime: new Date(freshestTimeMs).toISOString(),
        symbols: candidates
            .filter((asset) => asset.timeMs < freshestTimeMs)
            .map((asset) => asset.symbol)
            .sort((a, b) => a.localeCompare(b)),
    };
}

export function appendUniqueIbkrSymbols(
    currentValue: string,
    symbols: readonly string[],
): { value: string; appended: string[] } {
    const existing = new Set(
        currentValue
            .split(/[\s,]+/)
            .map((symbol) => stripIbkrMarker(symbol))
            .filter(Boolean),
    );
    const appended: string[] = [];

    for (const value of symbols) {
        const symbol = stripIbkrMarker(value);
        if (!symbol || existing.has(symbol)) continue;
        existing.add(symbol);
        appended.push(symbol);
    }

    if (appended.length === 0) {
        return { value: currentValue, appended };
    }

    const separator = currentValue.length === 0 || /[\s,]$/.test(currentValue) ? "" : "\n";
    return {
        value: `${currentValue}${separator}${appended.join("\n")}`,
        appended,
    };
}
