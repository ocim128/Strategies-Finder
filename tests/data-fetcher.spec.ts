import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { DataCache } from "../lib/data/data-cache";
import { DataFetcher } from "../lib/data/data-fetcher";
import type { OHLCVData } from "../lib/types/strategies";

function makeCandles(count: number): OHLCVData[] {
    return Array.from({ length: count }, (_, index) => {
        const base = index + 1;
        return {
            time: base,
            open: base,
            high: base + 1,
            low: base - 1,
            close: base + 0.5,
            volume: 1000 + index,
        };
    });
}

function createFetcher(options: {
    cache?: DataCache;
    importedDataByKey?: Map<string, OHLCVData[]>;
    getLookbackBars: () => number | null;
}): DataFetcher {
    const providerRouter = {
        getProvider: () => "spot",
        getStorageSymbol: (symbol: string) => symbol,
        getProviderStorageLabel: () => "Binance Spot",
    };

    return new DataFetcher(
        providerRouter as any,
        options.cache ?? new DataCache(),
        {} as any,
        () => options.importedDataByKey ?? new Map<string, OHLCVData[]>(),
        options.getLookbackBars,
        {}
    );
}

describe("DataFetcher chart lookback", () => {
    it("applies the current lookback to cached chart data", async () => {
        const cache = new DataCache();
        const candles = makeCandles(26_000);
        cache.set("ETHUSDT::1m", candles, "network");

        let lookbackBars = 300;
        const fetcher = createFetcher({
            cache,
            getLookbackBars: () => lookbackBars,
        });

        const trimmed = await fetcher.fetchData("ETHUSDT", "1m");
        assert.equal(trimmed.length, 300);
        assert.deepEqual(trimmed, candles.slice(-300));

        lookbackBars = 1_000;
        const expanded = await fetcher.fetchData("ETHUSDT", "1m");
        assert.equal(expanded.length, 1_000);
        assert.deepEqual(expanded, candles.slice(-1_000));
    });

    it("applies the current lookback to imported chart data", async () => {
        const candles = makeCandles(1_200);
        const importedDataByKey = new Map<string, OHLCVData[]>([
            ["ETHUSDT::1m", candles],
        ]);

        const fetcher = createFetcher({
            importedDataByKey,
            getLookbackBars: () => 300,
        });

        const trimmed = await fetcher.fetchData("ETHUSDT", "1m");
        assert.equal(trimmed.length, 300);
        assert.deepEqual(trimmed, candles.slice(-300));
    });
});
