import { expect } from "chai";
import { describe, it, beforeEach } from "node:test";
import { PolymarketOutcomeLoader } from "../lib/polymarket-outcome-loader";
import type { BacktestResult, Time, Trade } from "../lib/types/strategies";
import type { PolymarketOutcomeRow } from "../lib/types/polymarket-outcomes";
import type { PolymarketEntrySelectionMode } from "../lib/polymarket-entry-selection-mode";
import type { PolymarketOutcomeInterval } from "../lib/polymarket-outcome-interval";
import type { PolymarketExitMode } from "../lib/polymarket-exit-mode";

function makeResult(trades: Trade[], overrides: Partial<BacktestResult> = {}): BacktestResult {
    return {
        trades,
        netProfit: 1,
        netProfitPercent: 1,
        winRate: 100,
        expectancy: 1,
        avgTrade: 1,
        profitFactor: 1,
        maxDrawdown: 0,
        maxDrawdownPercent: 0,
        totalTrades: trades.length,
        winningTrades: trades.length,
        losingTrades: 0,
        avgWin: 1,
        avgLoss: 0,
        sharpeRatio: 0,
        equityCurve: [],
        marketContext: {
            symbol: "BTCUSDT",
            interval: "1m",
            candleCount: 0,
            firstCandleTime: null,
            lastCandleTime: null,
        },
        ...overrides,
    };
}

function makeTrade(id: number, time: number, price = 100): Trade {
    return {
        id,
        type: "long",
        entryTime: time as Time,
        entryPrice: price,
        exitTime: (time + 300) as Time,
        exitPrice: price + 1,
        pnl: 1,
        pnlPercent: 1,
        size: 1,
    };
}

function makeOutcome(eventStartTs: number, overrides: Partial<PolymarketOutcomeRow> = {}): PolymarketOutcomeRow {
    return {
        series_id: "btc-5m",
        event_slug: `btc-event-${eventStartTs}`,
        market_slug: `btc-market-${eventStartTs}`,
        interval: "5m",
        event_start_ts: eventStartTs,
        event_end_ts: eventStartTs + 300,
        yes_token_id: `yes-${eventStartTs}`,
        no_token_id: `no-${eventStartTs}`,
        yes_open_price: 0.5,
        yes_entry_minute_1_price: 0.5,
        yes_entry_minute_2_price: 0.5,
        yes_entry_minute_3_price: 0.5,
        yes_entry_minute_4_price: 0.5,
        resolved_outcome_up: 1,
        resolution_source: "test",
        updated_at: Date.now(),
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
    exitMode?: PolymarketExitMode;
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
        readCurrentPolymarketExitMode: () => settings.exitMode ?? "resolve_hold",
        readCurrentPolymarketSignalExitAllowMultipleTradesPerEvent: () => settings.allowMultiple ?? false,
        readCurrentPolymarketOutcomeSymbol: () => settings.outcomeSymbol ?? "BTCUSDT",
        readCurrentPolymarketOutcomeInterval: () => settings.outcomeInterval ?? "5m",
        isPanelVisible: () => true,
        scheduleRender: () => {},
    });
}

describe("Polymarket annotation parity", () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
    });

    it("verifies basic resolve-hold annotation parity", async () => {
        const eventTs = 1_700_000_000;
        const trades = [makeTrade(1, eventTs + 60)];
        const outcomes = [makeOutcome(eventTs)];
        const result = makeResult(trades);

        const loader = makeLoader({
            exitMode: "resolve_hold",
            outcomeInterval: "5m",
            entrySelectionMode: "actual_entry_minute",
        });

        const enriched = await loader.attachLoadedPolymarketOutcomes(result, outcomes);
        expect(enriched.trades).to.have.length(1);
        expect(enriched.trades[0]?.polymarketOutcome).to.not.be.null;
        expect(enriched.trades[0]?.polymarketOutcome?.isWin).to.be.true;
        expect(enriched.polymarketTradeSummary).to.not.be.undefined;
        expect(enriched.polymarketTradeSummary?.evaluationMode).to.equal("resolve_hold");
    });

    it("verifies same-event signal-exit annotation parity", async () => {
        const eventTs = 1_700_000_000;
        const trades = [makeTrade(1, eventTs + 60)];
        const outcomes = [makeOutcome(eventTs)];
        const result = makeResult(trades);

        globalThis.fetch = (async (input) => {
            const url = new URL(
                typeof input === "string"
                    ? input
                    : input instanceof URL
                        ? input.toString()
                        : input.url,
                "http://localhost"
            );
            if (url.pathname === "/api/sqlite/load-polymarket-price-points") {
                return new Response(JSON.stringify({
                    ok: true,
                    rows: [
                        {
                            series_id: "btc-5m",
                            event_start_ts: eventTs,
                            event_end_ts: eventTs + 300,
                            market_slug: `btc-market-${eventTs}`,
                            yes_token_id: `yes-${eventTs}`,
                            no_token_id: `no-${eventTs}`,
                            ts: eventTs + 120,
                            yes_price: 0.6,
                            no_price: 0.4,
                            updated_at: 1,
                        },
                    ],
                }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                });
            }
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }) as typeof fetch;

        const loader = makeLoader({
            exitMode: "signal_exit_same_event",
            outcomeInterval: "5m",
        });

        const enriched = await loader.attachLoadedPolymarketOutcomes(result, outcomes);
        globalThis.fetch = originalFetch;

        expect(enriched.trades).to.have.length(1);
        expect(enriched.trades[0]?.polymarketOutcome).to.not.be.null;
        expect(enriched.polymarketTradeSummary?.evaluationMode).to.equal("signal_exit_same_event");
    });
});
