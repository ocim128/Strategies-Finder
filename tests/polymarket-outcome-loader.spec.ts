import { expect } from "chai";
import { describe, it } from "node:test";
import { PolymarketOutcomeLoader } from "../lib/polymarket-outcome-loader";
import type { BacktestResult } from "../lib/types/strategies";
import type { PolymarketEntrySelectionMode } from "../lib/polymarket-entry-selection-mode";
import type { PolymarketOutcomeInterval } from "../lib/polymarket-outcome-interval";

function makeResult(overrides: Partial<BacktestResult> = {}): BacktestResult {
    return {
        trades: [
            {
                id: 1,
                type: "long",
                entryTime: 1_700_000_000,
                entryPrice: 100,
                exitTime: 1_700_000_300,
                exitPrice: 101,
                pnl: 1,
                pnlPercent: 1,
                size: 1,
            },
        ],
        netProfit: 1,
        netProfitPercent: 1,
        winRate: 100,
        expectancy: 1,
        avgTrade: 1,
        profitFactor: 1,
        maxDrawdown: 0,
        maxDrawdownPercent: 0,
        totalTrades: 1,
        winningTrades: 1,
        losingTrades: 0,
        avgWin: 1,
        avgLoss: 0,
        sharpeRatio: 0,
        equityCurve: [],
        marketContext: {
            symbol: "BTCUSDT",
            interval: "1m",
        },
        ...overrides,
    };
}

function makeLoader(settings: {
    executionModel?: string;
    entryOffset?: number | null;
    entryPriceFilterCents?: number;
    slippageCents?: number;
    cutoffEnabled?: boolean;
    cutoffSeconds?: number;
    entrySelectionMode?: PolymarketEntrySelectionMode;
    exitMode?: "resolve_hold" | "signal_exit_same_event";
    allowMultiple?: boolean;
    outcomeSymbol?: string | null;
    outcomeInterval?: PolymarketOutcomeInterval;
}): PolymarketOutcomeLoader {
    return new PolymarketOutcomeLoader({
        getDom: () => ({}) as never,
        readCurrentExecutionModel: () => settings.executionModel ?? "next_open",
        readCurrentPolymarketEntryOffset: () => settings.entryOffset ?? 0,
        readCurrentPolymarketEntryPriceFilterCents: () => settings.entryPriceFilterCents ?? 100,
        readCurrentPolymarketBacktestSlippageCents: () => settings.slippageCents ?? 0,
        readCurrentPolymarketEntryCutoffEnabled: () => settings.cutoffEnabled ?? false,
        readCurrentPolymarketEntryCutoffSeconds: () => settings.cutoffSeconds ?? 0,
        readCurrentPolymarketEntrySelectionMode: () => settings.entrySelectionMode ?? "fixed_offset",
        readCurrentPolymarketExitMode: () => settings.exitMode,
        readCurrentPolymarketSignalExitAllowMultipleTradesPerEvent: () => settings.allowMultiple ?? false,
        readCurrentPolymarketOutcomeSymbol: () => settings.outcomeSymbol ?? "BTCUSDT",
        readCurrentPolymarketOutcomeInterval: () => settings.outcomeInterval ?? "5m",
        isPanelVisible: () => true,
        scheduleRender: () => {},
    });
}

describe("PolymarketOutcomeLoader result signature", () => {
    it("includes current settings that alter annotation output", () => {
        const result = makeResult();
        const base = makeLoader({ exitMode: "resolve_hold" }).getResultSignature(result);

        expect(makeLoader({ exitMode: "signal_exit_same_event" }).getResultSignature(result)).to.not.equal(base);
        expect(makeLoader({ allowMultiple: true }).getResultSignature(result)).to.not.equal(base);
        expect(makeLoader({ slippageCents: 5 }).getResultSignature(result)).to.not.equal(base);
        expect(makeLoader({ cutoffEnabled: true }).getResultSignature(result)).to.not.equal(base);
        expect(makeLoader({ cutoffSeconds: 30 }).getResultSignature(result)).to.not.equal(base);
        expect(makeLoader({ executionModel: "signal_close" }).getResultSignature(result)).to.not.equal(base);
    });

    it("keeps stored summary mode fields ahead of live UI-only mode fields", () => {
        const result = makeResult({
            polymarketTradeSummary: {
                seriesId: "btc-5m",
                outcomeRowsLoaded: 1,
                scoredTrades: 1,
                missingOutcomeTrades: 0,
                unscoredTrades: 0,
                duplicateTradesIgnored: 0,
                entryPriceFilteredTrades: 0,
                entryTimeFilteredTrades: 0,
                evaluationMode: "signal_exit_same_event",
                signalExitAllowMultipleTradesPerEvent: false,
                wins: 1,
                losses: 0,
                neutralTrades: 0,
                winRate: 1,
                expectancy: 0.4,
                avgEntryPrice: 0.6,
                netPnl: 0.4,
            },
        });

        const base = makeLoader({
            exitMode: "resolve_hold",
            allowMultiple: false,
            executionModel: "next_open",
        }).getResultSignature(result);

        const changedLiveModeOnly = makeLoader({
            exitMode: "resolve_hold",
            allowMultiple: true,
            executionModel: "signal_close",
        }).getResultSignature(result);

        expect(changedLiveModeOnly).to.equal(base);
    });
});
