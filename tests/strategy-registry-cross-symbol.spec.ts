import { before, describe, it } from "node:test";
import { expect } from "chai";
import {
    loadBuiltInStrategies,
    strategyRegistry,
} from "../strategyRegistry";
import { state } from "../lib/state";
import type {
    OHLCVData,
    StrategyExecutionContext,
} from "../lib/types/strategies";
import { relative_strength_mean_reversion } from "../lib/strategies/lib/relative_strength_mean_reversion";

function bar(time: number, close: number): OHLCVData {
    return {
        time,
        open: close,
        high: close,
        low: close,
        close,
        volume: 100,
    };
}

function buildPrimarySeries(): OHLCVData[] {
    return Array.from({ length: 40 }, (_, index) => {
        const close = index < 30 ? 100 : index < 35 ? 130 : 170;
        return bar(index + 1, close);
    });
}

function buildSecondarySeries(): OHLCVData[] {
    return Array.from({ length: 40 }, (_, index) => bar(index + 1, 100));
}

function buildCrossSymbolContext(secondaryData: OHLCVData[]): StrategyExecutionContext {
    return {
        crossSymbol: {
            primarySymbol: "XRPUSDT",
            secondarySymbol: "DOGEUSDT",
            secondaryData,
            alignedLength: secondaryData.length,
            trimmedLeadingBars: 0,
        },
    };
}

describe("strategyRegistry cross-symbol wrapper", () => {
    before(async () => {
        strategyRegistry.clear();
        await loadBuiltInStrategies();
    });

    it("forwards cross-symbol execution context when global timeframe is disabled", () => {
        const strategy = strategyRegistry.get("relative_strength_mean_reversion");
        expect(strategy, "registry strategy should be loaded").to.exist;

        const primary = buildPrimarySeries();
        const secondary = buildSecondarySeries();
        const context = buildCrossSymbolContext(secondary);
        const params = { lookback: 10, zThreshold: 1 };

        const expectedSignals = relative_strength_mean_reversion.execute(primary, params, context);
        const registrySignals = strategy!.execute(primary, params, context);

        expect(expectedSignals.length).to.be.greaterThan(0);
        expect(registrySignals).to.deep.equal(expectedSignals);
    });

    it("rejects cross-symbol execution when global strategy timeframe is enabled", () => {
        const strategy = strategyRegistry.get("relative_strength_mean_reversion");
        expect(strategy, "registry strategy should be loaded").to.exist;

        const previousEnabled = state.strategyTimeframeEnabled;
        const previousMinutes = state.strategyTimeframeMinutes;

        state.strategyTimeframeEnabled = true;
        state.strategyTimeframeMinutes = 60;

        try {
            expect(() => strategy!.execute(
                buildPrimarySeries(),
                { lookback: 10, zThreshold: 1 },
                buildCrossSymbolContext(buildSecondarySeries())
            )).to.throw(/Cross-symbol strategies cannot be used with strategy timeframe resampling/i);
        } finally {
            state.strategyTimeframeEnabled = previousEnabled;
            state.strategyTimeframeMinutes = previousMinutes;
        }
    });
});
