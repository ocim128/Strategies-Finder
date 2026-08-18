import { expect } from "chai";
import { describe, it } from "node:test";
import { createAssetOpportunitySignalCache } from "../lib/finder/finder-asset-opportunity-search-cache";
import { runServerAssetIsSearch } from "../lib/finder/server/server-asset-is-search";
import type { CapitalSettings } from "../lib/types/backtest";
import type { FinderOptions } from "../lib/types/finder";
import type { BacktestSettings, OHLCVData, Strategy, Time } from "../lib/types/strategies";

const settings: BacktestSettings = {
    executionModel: "signal_close",
    tradeDirection: "long",
    allowSameBarExit: true,
    slippageBps: 0,
    marketMode: "all",
};

const capitalSettings: CapitalSettings = {
    initialCapital: 10_000,
    positionSize: 100,
    commission: 0,
    sizingMode: "percent",
    fixedTradeAmount: 1_000,
};

function makeCandles(length: number): OHLCVData[] {
    return Array.from({ length }, (_, index) => ({
        time: (1_700_000_000 + index * 300) as Time,
        open: 100 + index,
        high: 101 + index,
        low: 99 + index,
        close: 100 + index,
        volume: 1_000,
    }));
}

function makeOptions(): FinderOptions {
    return {
        mode: "random",
        randomSeed: 1234,
        scope: "asset_opportunity",
        sortPriority: ["netProfit"],
        useAdvancedSort: false,
        symbols: ["CACHE"],
        topN: 1,
        steps: 3,
        rangePercent: 35,
        maxRuns: 1,
        dataSlice: "all",
        tradeFilterEnabled: false,
        minTrades: 0,
        maxTrades: Number.POSITIVE_INFINITY,
        assetOpportunity: {
            symbols: ["CACHE"],
            candidatePoolSize: 1,
            minFreshSupport: 1,
            evalLastBars: 0,
        },
    } as unknown as FinderOptions;
}

describe("server Asset Opportunity signal cache", () => {
    it("reuses full-series signals without changing prefix results", async () => {
        let executeCalls = 0;
        const strategy: Strategy = {
            name: "Causal Cache Strategy",
            description: "Emits indexed entry/exit pairs from completed bars.",
            defaultParams: { marker: 1 },
            paramLabels: { marker: "Marker" },
            execute(data) {
                executeCalls += 1;
                const signals = [];
                for (let index = 0; index + 1 < data.length; index += 3) {
                    signals.push(
                        { time: data[index]!.time, type: "buy" as const, price: data[index]!.close, barIndex: index },
                        { time: data[index + 1]!.time, type: "sell" as const, price: data[index + 1]!.close, barIndex: index + 1 },
                    );
                }
                return signals;
            },
        };
        const fullData = makeCandles(40);
        const prefixData = fullData.slice(0, 30);
        const cache = createAssetOpportunitySignalCache();
        const base = {
            symbol: "CACHE",
            interval: "5m",
            options: makeOptions(),
            settings,
            capitalSettings,
            selectedStrategy: { key: "causal_cache_strategy", name: strategy.name, strategy },
            generateParamSets: () => [{ marker: 1 }],
            useRustEnginePreference: false,
            confirmationStrategiesLoaded: true,
            isCancelled: () => false,
            yieldControl: async () => undefined,
        } as const;

        const first = await runServerAssetIsSearch({
            ...base,
            ohlcvData: fullData,
            fullSignalData: fullData,
            signalCache: cache,
        });
        const callsAfterWarm = executeCalls;
        const cached = await runServerAssetIsSearch({
            ...base,
            ohlcvData: prefixData,
            fullSignalData: fullData,
            signalCache: cache,
        });
        const direct = await runServerAssetIsSearch({
            ...base,
            ohlcvData: prefixData,
        });

        expect(first.results).to.have.length(1);
        expect(first.signalCacheHits).to.equal(0);
        expect(first.signalCacheMisses).to.equal(1);
        expect(cached.signalCacheHits).to.equal(1);
        expect(cached.signalCacheMisses).to.equal(0);
        expect(cached.results).to.deep.equal(direct.results);
        expect(callsAfterWarm).to.equal(2);
        expect(executeCalls).to.equal(3);
    });
});
