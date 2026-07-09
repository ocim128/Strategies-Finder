import { expect } from "chai";
import { afterEach, describe, it } from "node:test";
import { resetLocalSqlitePolymarketApiAvailabilityForTests } from "../lib/local-sqlite-polymarket-api";
import { annotateBacktestResultWithPolymarketOutcomes } from "../lib/polymarket-trade-annotations";
import type { BacktestResult, OHLCVData, Time, Trade } from "../lib/types/strategies";

const ORIGINAL_FETCH = globalThis.fetch;

function makeTrade(id: number, type: Trade["type"], entryTs: number, pnl: number): Trade {
    return {
        id,
        type,
        entryTime: entryTs as Time,
        entryPrice: 30_000,
        exitTime: (entryTs + 300) as Time,
        exitPrice: pnl >= 0 ? 30_100 : 29_900,
        pnl,
        pnlPercent: pnl >= 0 ? 0.3 : -0.3,
        size: 0.1,
        exitReason: "take_profit",
    };
}

function makeBacktestResult(trades: Trade[]): BacktestResult {
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
    };
}

function makeBars(count: number, intervalSec: number, startTs: number): OHLCVData[] {
    return Array.from({ length: count }, (_, index) => ({
        time: (startTs + index * intervalSec) as Time,
        open: 30_000,
        high: 30_100,
        low: 29_900,
        close: 30_050,
        volume: 100,
    }));
}

afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    resetLocalSqlitePolymarketApiAvailabilityForTests();
});

describe("Polymarket native outcome sessions", () => {
    it("annotates 5m chart trades against native 15m sessions", async () => {
        const eventStartTs = 1_700_000_000;
        const tradeEntryTs = eventStartTs + 600;
        const requestedSeriesIds: string[] = [];
        const ensuredSeriesIds: string[] = [];

        globalThis.fetch = (async (input, init) => {
            const url = new URL(
                typeof input === "string"
                    ? input
                    : input instanceof URL
                        ? input.toString()
                        : input.url,
                "http://localhost"
            );

            if (url.pathname === "/api/sqlite/status") {
                return new Response(JSON.stringify({ ok: true }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                });
            }

            if (url.pathname === "/api/sqlite/load-polymarket-outcomes") {
                requestedSeriesIds.push(url.searchParams.get("seriesId") ?? "");
                return new Response(JSON.stringify({
                    ok: true,
                    rows: [{
                        series_id: "10192",
                        event_slug: "btc-15m-1",
                        market_slug: "btc-15m-1",
                        interval: "15m",
                        event_start_ts: eventStartTs,
                        event_end_ts: eventStartTs + 900,
                        yes_token_id: "yes-1",
                        no_token_id: "no-1",
                        yes_open_price: 0.5,
                        yes_entry_minute_1_price: 0.51,
                        yes_entry_minute_2_price: 0.52,
                        yes_entry_minute_3_price: 0.53,
                        yes_entry_minute_4_price: 0.54,
                        resolved_outcome_up: 1,
                        resolution_source: "test",
                        updated_at: 1,
                    }],
                }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                });
            }

            if (url.pathname === "/api/sqlite/load-polymarket-price-points") {
                return new Response(JSON.stringify({ ok: true, rows: [] }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                });
            }

            if (url.pathname === "/api/sqlite/ensure-polymarket-price-points") {
                const body = JSON.parse(String(init?.body ?? "{}")) as { seriesId?: string };
                ensuredSeriesIds.push(body.seriesId ?? "");
                return new Response(JSON.stringify({
                    ok: true,
                    rows: [
                        {
                            series_id: "10192",
                            event_start_ts: eventStartTs,
                            event_end_ts: eventStartTs + 900,
                            market_slug: "btc-15m-1",
                            yes_token_id: "yes-1",
                            no_token_id: "no-1",
                            ts: tradeEntryTs - 10,
                            yes_price: 0.61,
                            no_price: 0.39,
                            updated_at: 1,
                        },
                        {
                            series_id: "10192",
                            event_start_ts: eventStartTs,
                            event_end_ts: eventStartTs + 900,
                            market_slug: "btc-15m-1",
                            yes_token_id: "yes-1",
                            no_token_id: "no-1",
                            ts: tradeEntryTs + 5,
                            yes_price: 0.63,
                            no_price: 0.37,
                            updated_at: 1,
                        },
                    ],
                }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                });
            }

            throw new Error(`Unexpected URL ${url.pathname}`);
        }) as typeof fetch;

        const result = await annotateBacktestResultWithPolymarketOutcomes(
            makeBacktestResult([makeTrade(1, "long", tradeEntryTs, 10)]),
            {
                symbol: "BTCUSDT",
                interval: "5m",
                executionModel: "next_open",
                chartData: makeBars(6, 300, eventStartTs),
                outcomeInterval: "15m",
            }
        );

        expect(requestedSeriesIds).to.deep.equal(["10192"]);
        expect(ensuredSeriesIds).to.deep.equal(["10192"]);
        expect(result.polymarketTradeSummary?.outcomeInterval).to.equal("15m");
        expect(result.polymarketTradeSummary?.entryOffset).to.equal(10);
        expect(result.polymarketTradeSummary?.timingProfile).to.have.length(15);
        expect(result.trades[0]?.polymarketOutcome?.marketSlug).to.equal("btc-15m-1");
        expect(result.trades[0]?.polymarketOutcome?.entryOffset).to.equal(10);
        expect(result.trades[0]?.polymarketOutcome?.marketEntryPrice).to.equal(0.63);
        expect(result.trades[0]?.polymarketOutcome?.isWin).to.equal(true);
    });

    it("annotates 5m chart trades against native 1h sessions", async () => {
        const eventStartTs = 1_700_010_000;
        const tradeEntryTs = eventStartTs + 1800;
        const requestedSeriesIds: string[] = [];

        globalThis.fetch = (async (input, _init) => {
            const url = new URL(
                typeof input === "string"
                    ? input
                    : input instanceof URL
                        ? input.toString()
                        : input.url,
                "http://localhost"
            );

            if (url.pathname === "/api/sqlite/status") {
                return new Response(JSON.stringify({ ok: true }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                });
            }

            if (url.pathname === "/api/sqlite/load-polymarket-outcomes") {
                requestedSeriesIds.push(url.searchParams.get("seriesId") ?? "");
                return new Response(JSON.stringify({
                    ok: true,
                    rows: [{
                        series_id: "10122",
                        event_slug: "sol-1h-1",
                        market_slug: "sol-1h-1",
                        interval: "1h",
                        event_start_ts: eventStartTs,
                        event_end_ts: eventStartTs + 3600,
                        yes_token_id: "yes-1",
                        no_token_id: "no-1",
                        yes_open_price: 0.45,
                        yes_entry_minute_1_price: 0.46,
                        yes_entry_minute_2_price: 0.47,
                        yes_entry_minute_3_price: 0.48,
                        yes_entry_minute_4_price: 0.49,
                        resolved_outcome_up: 1,
                        resolution_source: "test",
                        updated_at: 1,
                    }],
                }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                });
            }

            if (url.pathname === "/api/sqlite/load-polymarket-price-points") {
                return new Response(JSON.stringify({ ok: true, rows: [] }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                });
            }

            if (url.pathname === "/api/sqlite/ensure-polymarket-price-points") {
                return new Response(JSON.stringify({
                    ok: true,
                    rows: [{
                        series_id: "10122",
                        event_start_ts: eventStartTs,
                        event_end_ts: eventStartTs + 3600,
                        market_slug: "sol-1h-1",
                        yes_token_id: "yes-1",
                        no_token_id: "no-1",
                        ts: tradeEntryTs,
                        yes_price: 0.44,
                        no_price: 0.56,
                        updated_at: 1,
                    }],
                }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                });
            }

            throw new Error(`Unexpected URL ${url.pathname}`);
        }) as typeof fetch;

        const result = await annotateBacktestResultWithPolymarketOutcomes(
            makeBacktestResult([makeTrade(1, "long", tradeEntryTs, 12)]),
            {
                symbol: "SOLUSDT",
                interval: "5m",
                executionModel: "next_open",
                chartData: makeBars(14, 300, eventStartTs),
                outcomeInterval: "1h",
            }
        );

        expect(requestedSeriesIds).to.deep.equal(["10122"]);
        expect(result.polymarketTradeSummary?.outcomeInterval).to.equal("1h");
        expect(result.polymarketTradeSummary?.entryOffset).to.equal(30);
        expect(result.polymarketTradeSummary?.timingProfile).to.have.length(60);
        expect(result.trades[0]?.polymarketOutcome?.marketSlug).to.equal("sol-1h-1");
        expect(result.trades[0]?.polymarketOutcome?.entryOffset).to.equal(30);
        expect(result.trades[0]?.polymarketOutcome?.marketEntryPrice).to.equal(0.44);
    });

    it("supports signal-exit pricing inside native 15m sessions on 1m charts", async () => {
        const eventStartTs = 1_700_020_000;
        const tradeEntryTs = eventStartTs + 300;

        globalThis.fetch = (async (input, init) => {
            const url = new URL(
                typeof input === "string"
                    ? input
                    : input instanceof URL
                        ? input.toString()
                        : input.url,
                "http://localhost"
            );

            if (url.pathname === "/api/sqlite/status") {
                return new Response(JSON.stringify({ ok: true }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                });
            }

            if (url.pathname === "/api/sqlite/load-polymarket-outcomes") {
                return new Response(JSON.stringify({
                    ok: true,
                    rows: [{
                        series_id: "10422",
                        event_slug: "xrp-15m-signal",
                        market_slug: "xrp-15m-signal",
                        interval: "15m",
                        event_start_ts: eventStartTs,
                        event_end_ts: eventStartTs + 900,
                        yes_token_id: "yes-1",
                        no_token_id: "no-1",
                        yes_open_price: 0.5,
                        yes_entry_minute_1_price: 0.51,
                        yes_entry_minute_2_price: 0.52,
                        yes_entry_minute_3_price: 0.53,
                        yes_entry_minute_4_price: 0.54,
                        resolved_outcome_up: 1,
                        resolution_source: "test",
                        updated_at: 1,
                    }],
                }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                });
            }

            if (url.pathname === "/api/sqlite/load-polymarket-price-points") {
                return new Response(JSON.stringify({ ok: true, rows: [] }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                });
            }

            if (url.pathname === "/api/sqlite/ensure-polymarket-price-points") {
                const body = JSON.parse(String(init?.body ?? "{}")) as { seriesId?: string };
                expect(body.seriesId).to.equal("10422");
                return new Response(JSON.stringify({
                    ok: true,
                    rows: [
                        {
                            series_id: "10422",
                            event_start_ts: eventStartTs,
                            event_end_ts: eventStartTs + 900,
                            market_slug: "xrp-15m-signal",
                            yes_token_id: "yes-1",
                            no_token_id: "no-1",
                            ts: tradeEntryTs,
                            yes_price: 0.55,
                            no_price: 0.45,
                            updated_at: 1,
                        },
                        {
                            series_id: "10422",
                            event_start_ts: eventStartTs,
                            event_end_ts: eventStartTs + 900,
                            market_slug: "xrp-15m-signal",
                            yes_token_id: "yes-1",
                            no_token_id: "no-1",
                            ts: tradeEntryTs + 120,
                            yes_price: 0.63,
                            no_price: 0.37,
                            updated_at: 1,
                        },
                    ],
                }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                });
            }

            throw new Error(`Unexpected URL ${url.pathname}`);
        }) as typeof fetch;

        const signalTrade: Trade = {
            ...makeTrade(1, "long", tradeEntryTs, 9),
            exitReason: "signal",
            exitTime: (tradeEntryTs + 120) as Time,
        };

        const result = await annotateBacktestResultWithPolymarketOutcomes(
            makeBacktestResult([signalTrade]),
            {
                symbol: "XRPUSDT",
                interval: "1m",
                executionModel: "next_open",
                chartData: makeBars(20, 60, eventStartTs),
                outcomeInterval: "15m",
                polymarketExitMode: "signal_exit_same_event",
            }
        );

        expect(result.polymarketTradeSummary?.outcomeInterval).to.equal("15m");
        expect(result.polymarketTradeSummary?.evaluationMode).to.equal("signal_exit_same_event");
        expect(result.polymarketTradeSummary?.signalExitedTrades).to.equal(1);
        expect(result.trades[0]?.polymarketOutcome?.marketExitSource).to.equal("signal");
        expect(result.trades[0]?.polymarketOutcome?.marketEntryPrice).to.equal(0.55);
        expect(result.trades[0]?.polymarketOutcome?.marketExitPrice).to.equal(0.63);
    });
});
