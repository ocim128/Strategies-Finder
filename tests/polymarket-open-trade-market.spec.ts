import { expect } from "chai";
import { afterEach, describe, it } from "node:test";
import { TradesRenderer } from "../lib/renderers/tradesRenderer";
import { state } from "../lib/state";
import { buildAlertStreamId } from "../lib/alert-service";
import { livePositionsService } from "../lib/live-positions-service";
import type { PolymarketExitMode } from "../lib/polymarket-exit-mode";
import type { BacktestResult, Time, Trade } from "../lib/types/strategies";

const PREVIOUS_STATE = {
    currentBacktestResult: state.currentBacktestResult,
    currentBacktestResultSource: state.currentBacktestResultSource,
    currentSymbol: state.currentSymbol,
    currentInterval: state.currentInterval,
    currentStrategyKey: state.currentStrategyKey,
    ohlcvData: state.ohlcvData,
    livePositionsState: livePositionsService.getState(),
    livePositionsPollTimer: (livePositionsService as any).pollTimer,
};

function makeTrade(id: number, exitReason: Trade["exitReason"] = "end_of_data"): Trade {
    const baseTs = 1_699_999_800;
    return {
        id,
        type: "long",
        entryTime: (baseTs + id * 60) as Time,
        entryPrice: 30_000,
        exitTime: (baseTs + 60 + id * 60) as Time,
        exitPrice: 30_050,
        pnl: 5,
        pnlPercent: 0.1,
        size: 0.1,
        exitReason,
    };
}

function makeBacktestResult(
    trades: Trade[],
    evaluationMode: PolymarketExitMode = "signal_exit_same_event"
): BacktestResult {
    return {
        trades,
        netProfit: trades.reduce((sum, trade) => sum + trade.pnl, 0),
        netProfitPercent: 0,
        winRate: 50,
        expectancy: 0,
        avgTrade: 0,
        profitFactor: 1,
        maxDrawdown: 0,
        maxDrawdownPercent: 0,
        totalTrades: trades.length,
        winningTrades: trades.filter((trade) => trade.pnl > 0).length,
        losingTrades: trades.filter((trade) => trade.pnl <= 0).length,
        avgWin: 0,
        avgLoss: 0,
        sharpeRatio: 0,
        equityCurve: [],
        polymarketTradeSummary: {
            seriesId: "10684",
            outcomeRowsLoaded: 0,
            scoredTrades: 0,
            missingOutcomeTrades: 0,
            evaluationMode,
        },
        marketContext: {
            symbol: "BTCUSDT",
            interval: "1m",
            candleCount: 0,
            firstCandleTime: null,
            lastCandleTime: null,
        },
    };
}

function seedWorkerBackedOpenPosition(trade: Trade, options?: { mismatch?: boolean; polling?: boolean }): void {
    const streamId = buildAlertStreamId(state.currentSymbol, state.currentInterval, state.currentStrategyKey);
    (livePositionsService as any).state = {
        positions: [{
            streamId,
            symbol: state.currentSymbol,
            interval: state.currentInterval,
            strategyKey: state.currentStrategyKey,
            strategyParams: {},
            backtestSettings: {},
            configName: null,
            direction: trade.type,
            entryPrice: trade.entryPrice,
            entryTime: Number(trade.entryTime),
            currentPrice: trade.entryPrice,
            unrealizedPnl: 0,
            unrealizedPnlPercent: 0,
            stopLossPrice: trade.stopLossPrice ?? null,
            takeProfitPrice: trade.takeProfitPrice ?? null,
            isOpen: true,
            lastSignalFromWorker: null,
            localBacktestTrade: { ...trade },
            mismatch: options?.mismatch ?? false,
            mismatchReason: options?.mismatch ? "worker/local mismatch" : null,
            lastUpdated: Date.now(),
        }],
        closedTrades: [],
        lastPollTime: Date.now(),
        isPolling: false,
        viewMode: "open",
        error: null,
    };
    (livePositionsService as any).pollTimer = options?.polling === false ? null : 1;
}

afterEach(() => {
    state.currentBacktestResult = PREVIOUS_STATE.currentBacktestResult;
    state.currentBacktestResultSource = PREVIOUS_STATE.currentBacktestResultSource;
    state.currentSymbol = PREVIOUS_STATE.currentSymbol;
    state.currentInterval = PREVIOUS_STATE.currentInterval;
    state.currentStrategyKey = PREVIOUS_STATE.currentStrategyKey;
    state.ohlcvData = PREVIOUS_STATE.ohlcvData;
    (livePositionsService as any).state = PREVIOUS_STATE.livePositionsState;
    (livePositionsService as any).pollTimer = PREVIOUS_STATE.livePositionsPollTimer;
});

describe("Current-bucket unresolved Polymarket badges", () => {
    it("renders Poly open only when worker-backed live state confirms the matching trade is still open", () => {
        const latestOpenTrade = {
            ...makeTrade(1, "end_of_data"),
            polymarketOutcome: {
                eventStartTs: 0,
                eventEndTs: 0,
                eventSlug: "",
                marketSlug: "",
                prediction: "yes" as const,
                actualOutcomeUp: 0 as const,
                isWin: null,
                marketExitSource: "no_event" as const,
            },
        };
        state.currentSymbol = "BTCUSDT";
        state.currentInterval = "1m";
        state.currentStrategyKey = "ema_cross";
        state.currentBacktestResult = makeBacktestResult([latestOpenTrade]);
        state.currentBacktestResultSource = "backtest";
        state.ohlcvData = [
            {
                time: 1_699_999_999 as Time,
                open: 1,
                high: 1,
                low: 1,
                close: 1,
                volume: 1,
            },
        ];
        seedWorkerBackedOpenPosition(latestOpenTrade);

        const renderer = new TradesRenderer() as unknown as {
            renderTradeItem: (trade: Trade, formatPrice: (price: number) => string, formatDate: (time: Trade["entryTime"]) => string) => string;
        };
        const html = renderer.renderTradeItem(
            latestOpenTrade,
            (price) => price.toFixed(2),
            (time) => String(time)
        );

        expect(html).to.include("Poly open");
        expect(html).to.not.include("Poly no event");
    });

    it("renders Poly open for chart-exit same-event runs when worker state confirms the trade is still open", () => {
        const latestOpenTrade = {
            ...makeTrade(1, "end_of_data"),
            polymarketOutcome: {
                eventStartTs: 0,
                eventEndTs: 0,
                eventSlug: "",
                marketSlug: "",
                prediction: "yes" as const,
                actualOutcomeUp: 0 as const,
                isWin: null,
                evaluationMode: "chart_exit_same_event" as const,
                marketExitSource: "no_event" as const,
            },
        };
        state.currentSymbol = "BTCUSDT";
        state.currentInterval = "1m";
        state.currentStrategyKey = "ema_cross";
        state.currentBacktestResult = makeBacktestResult([latestOpenTrade], "chart_exit_same_event");
        state.currentBacktestResultSource = "backtest";
        state.ohlcvData = [
            {
                time: 1_699_999_999 as Time,
                open: 1,
                high: 1,
                low: 1,
                close: 1,
                volume: 1,
            },
        ];
        seedWorkerBackedOpenPosition(latestOpenTrade);

        const renderer = new TradesRenderer() as unknown as {
            renderTradeItem: (trade: Trade, formatPrice: (price: number) => string, formatDate: (time: Trade["entryTime"]) => string) => string;
        };
        const html = renderer.renderTradeItem(
            latestOpenTrade,
            (price) => price.toFixed(2),
            (time) => String(time)
        );

        expect(html).to.include("Poly open");
        expect(html).to.not.include("Poly no event");
    });

    it("does not render a Polymarket badge for the latest unresolved open trade in the current 5m bucket", () => {
        const latestOpenTrade = makeTrade(1, "end_of_data");
        state.currentBacktestResult = makeBacktestResult([latestOpenTrade]);
        state.currentBacktestResultSource = "backtest";
        state.ohlcvData = [
            {
                time: 1_699_999_999 as Time,
                open: 1,
                high: 1,
                low: 1,
                close: 1,
                volume: 1,
            },
        ];

        const renderer = new TradesRenderer() as unknown as {
            renderTradeItem: (trade: Trade, formatPrice: (price: number) => string, formatDate: (time: Trade["entryTime"]) => string) => string;
        };
        const html = renderer.renderTradeItem(
            latestOpenTrade,
            (price) => price.toFixed(2),
            (time) => String(time)
        );

        expect(html).to.not.include("Poly open");
        expect(html).to.not.include("Poly no event");
    });

    it("keeps current-bucket no-event rows silent instead of claiming live-open state", () => {
        const latestOpenTrade = {
            ...makeTrade(1, "end_of_data"),
            polymarketOutcome: {
                eventStartTs: 0,
                eventEndTs: 0,
                eventSlug: "",
                marketSlug: "",
                prediction: "yes" as const,
                actualOutcomeUp: 0 as const,
                isWin: null,
                marketExitSource: "no_event" as const,
            },
        };
        state.currentBacktestResult = makeBacktestResult([latestOpenTrade]);
        state.currentBacktestResultSource = "backtest";
        state.ohlcvData = [
            {
                time: 1_699_999_999 as Time,
                open: 1,
                high: 1,
                low: 1,
                close: 1,
                volume: 1,
            },
        ];

        const renderer = new TradesRenderer() as unknown as {
            renderTradeItem: (trade: Trade, formatPrice: (price: number) => string, formatDate: (time: Trade["entryTime"]) => string) => string;
        };
        const html = renderer.renderTradeItem(
            latestOpenTrade,
            (price) => price.toFixed(2),
            (time) => String(time)
        );

        expect(html).to.not.include("Poly open");
        expect(html).to.not.include("Poly no event");
    });

    it("keeps earlier unresolved trades in the same current 5m bucket silent when a later trade exists", () => {
        const earlierTradeInBucket = makeTrade(1, "signal");
        const laterScoredTradeInSameBucket = {
            ...makeTrade(2, "signal"),
            polymarketOutcome: {
                eventStartTs: 1_699_999_800,
                eventEndTs: 1_700_000_100,
                eventSlug: "current-event",
                marketSlug: "current-event",
                prediction: "yes" as const,
                actualOutcomeUp: 0 as const,
                isWin: false,
                evaluationMode: "signal_exit_same_event" as const,
                isProfitable: false,
                marketEntryPrice: 0.62,
                marketExitPrice: 1,
                marketExitTs: 1_700_000_100,
                marketExitSource: "resolution" as const,
                marketPnl: 0.38,
            },
        };
        state.currentBacktestResult = makeBacktestResult([
            earlierTradeInBucket,
            laterScoredTradeInSameBucket,
        ]);
        state.currentBacktestResultSource = "backtest";
        state.ohlcvData = [
            {
                time: 1_699_999_999 as Time,
                open: 1,
                high: 1,
                low: 1,
                close: 1,
                volume: 1,
            },
        ];

        const renderer = new TradesRenderer() as unknown as {
            renderTradeItem: (trade: Trade, formatPrice: (price: number) => string, formatDate: (time: Trade["entryTime"]) => string) => string;
        };
        const html = renderer.renderTradeItem(
            earlierTradeInBucket,
            (price) => price.toFixed(2),
            (time) => String(time)
        );

        expect(html).to.not.include("Poly open");
        expect(html).to.not.include("Poly no event");
    });

    it("keeps the badge hidden when worker state disagrees with the local open trade", () => {
        const latestOpenTrade = makeTrade(1, "end_of_data");
        state.currentSymbol = "BTCUSDT";
        state.currentInterval = "1m";
        state.currentStrategyKey = "ema_cross";
        state.currentBacktestResult = makeBacktestResult([latestOpenTrade]);
        state.currentBacktestResultSource = "backtest";
        state.ohlcvData = [
            {
                time: 1_699_999_999 as Time,
                open: 1,
                high: 1,
                low: 1,
                close: 1,
                volume: 1,
            },
        ];
        seedWorkerBackedOpenPosition(latestOpenTrade, { mismatch: true });

        const renderer = new TradesRenderer() as unknown as {
            renderTradeItem: (trade: Trade, formatPrice: (price: number) => string, formatDate: (time: Trade["entryTime"]) => string) => string;
        };
        const html = renderer.renderTradeItem(
            latestOpenTrade,
            (price) => price.toFixed(2),
            (time) => String(time)
        );

        expect(html).to.not.include("Poly open");
    });

    it("keeps Poly no event for unresolved trades outside the current 5m bucket", () => {
        const historicalNoEventTrade = {
            ...makeTrade(1, "signal"),
            polymarketOutcome: {
                eventStartTs: 0,
                eventEndTs: 0,
                eventSlug: "",
                marketSlug: "",
                prediction: "yes" as const,
                actualOutcomeUp: 0 as const,
                isWin: null,
                marketExitSource: "no_event" as const,
            },
        };
        const latestOpenTrade = makeTrade(7, "end_of_data");
        state.currentBacktestResult = makeBacktestResult([
            historicalNoEventTrade,
            latestOpenTrade,
        ]);
        state.currentBacktestResultSource = "backtest";
        state.ohlcvData = [
            {
                time: 1_700_000_180 as Time,
                open: 1,
                high: 1,
                low: 1,
                close: 1,
                volume: 1,
            },
        ];

        const renderer = new TradesRenderer() as unknown as {
            renderTradeItem: (trade: Trade, formatPrice: (price: number) => string, formatDate: (time: Trade["entryTime"]) => string) => string;
        };
        const html = renderer.renderTradeItem(
            historicalNoEventTrade,
            (price) => price.toFixed(2),
            (time) => String(time)
        );

        expect(html).to.include("Poly no event");
        expect(html).to.not.include("Poly open");
    });
});
