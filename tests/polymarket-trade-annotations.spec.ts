import { expect } from "chai";
import { afterEach, describe, it } from "node:test";
import { resetLocalSqlitePolymarketApiAvailabilityForTests } from "../lib/local-sqlite-polymarket-api";
import { annotateBacktestResultWithPolymarketOutcomes } from "../lib/polymarket-trade-annotations";
import { TradesRenderer } from "../lib/renderers/tradesRenderer";
import { ensurePricePointsForOutcomes } from "../lib/polymarket-price-points-ingest";
import type { BacktestResult, OHLCVData, Trade } from "../lib/types/strategies";

const ORIGINAL_FETCH = globalThis.fetch;

function makeTrade(id: number, type: Trade["type"], entryTs: number, pnl: number): Trade {
    return {
        id,
        type,
        entryTime: entryTs,
        entryPrice: 30_000,
        exitTime: entryTs + 300,
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

function makeBars(count: number, startTs = 1_700_000_000): OHLCVData[] {
    return Array.from({ length: count }, (_, index) => ({
        time: startTs + index * 300,
        open: 30_000,
        high: 30_100,
        low: 29_900,
        close: 30_050,
        volume: 100,
    }));
}

function makeMinuteBars(count: number, startTs = 1_700_000_000): OHLCVData[] {
    return Array.from({ length: count }, (_, index) => ({
        time: startTs + index * 60,
        open: 30_000,
        high: 30_100,
        low: 29_900,
        close: 30_050,
        volume: 100,
    }));
}

function installOutcomeFetch(rows: unknown[], onRequest?: (url: URL) => void): void {
    globalThis.fetch = (async (input) => {
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

        onRequest?.(url);
        return new Response(JSON.stringify({ ok: true, rows }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        });
    }) as typeof fetch;
}

afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    resetLocalSqlitePolymarketApiAvailabilityForTests();
});

describe("Polymarket backtest trade annotations", () => {
    it("annotates eligible BTC 5m next_open trades and renders the outcome badge", async () => {
        const bars = makeBars(4);
        const firstEventTs = Number(bars[1]!.time);
        const secondEventTs = Number(bars[2]!.time);
        installOutcomeFetch([
            {
                series_id: "10684",
                event_slug: "btc-1",
                market_slug: "btc-1",
                interval: "5m",
                event_start_ts: firstEventTs,
                event_end_ts: firstEventTs + 300,
                yes_token_id: "yes-1",
                no_token_id: "no-1",
                yes_open_price: 0.5,
                yes_entry_minute_1_price: 0.5,
                yes_entry_minute_2_price: 0.5,
                yes_entry_minute_3_price: 0.5,
                yes_entry_minute_4_price: 0.5,
                resolved_outcome_up: 1,
                resolution_source: "test",
                updated_at: 1,
            },
            {
                series_id: "10684",
                event_slug: "btc-2",
                market_slug: "btc-2",
                interval: "5m",
                event_start_ts: secondEventTs,
                event_end_ts: secondEventTs + 300,
                yes_token_id: "yes-2",
                no_token_id: "no-2",
                yes_open_price: 0.5,
                yes_entry_minute_1_price: 0.5,
                yes_entry_minute_2_price: 0.5,
                yes_entry_minute_3_price: 0.5,
                yes_entry_minute_4_price: 0.5,
                resolved_outcome_up: 1,
                resolution_source: "test",
                updated_at: 1,
            },
        ]);

        const result = await annotateBacktestResultWithPolymarketOutcomes(
            makeBacktestResult([
                makeTrade(1, "long", firstEventTs, 10),
                makeTrade(2, "short", secondEventTs, -10),
            ]),
            {
                symbol: "BTCUSDT",
                interval: "5m",
                executionModel: "next_open",
                chartData: bars,
            }
        );

        expect(result.polymarketTradeSummary?.scoredTrades).to.equal(2);
        expect(result.trades[0]?.polymarketOutcome?.isWin).to.equal(true);
        expect(result.trades[1]?.polymarketOutcome?.isWin).to.equal(false);
        expect(result.trades[0]?.polymarketOutcome?.marketSlug).to.equal("btc-1");
        expect(result.trades[0]?.polymarketOutcome?.marketEntryPrice).to.equal(0.5);
        expect(result.trades[1]?.polymarketOutcome?.marketEntryPrice).to.equal(0.5);

        const renderer = new TradesRenderer() as unknown as {
            renderTradeItem: (trade: Trade, formatPrice: (price: number) => string, formatDate: (time: Trade["entryTime"]) => string) => string;
        };
        const html = renderer.renderTradeItem(
            result.trades[0]!,
            (price) => price.toFixed(2),
            (time) => String(time)
        );
        expect(html).to.include("Poly Win");
        expect(html).to.include("YES 50.0c->100.0c (+50.0c)");
        expect(html).to.include("YES 50.0c / NO 50.0c");
        expect(html).to.include('data-polymarket-url="https://polymarket.com/event/btc-1"');
    });

    it("annotates supported ETH 5m runs with the ETH Polymarket series", async () => {
        const bars = makeBars(4);
        const firstEventTs = Number(bars[1]!.time);
        const requestedSeriesIds: string[] = [];
        installOutcomeFetch([
            {
                series_id: "10683",
                event_slug: "eth-1",
                market_slug: "eth-1",
                interval: "5m",
                event_start_ts: firstEventTs,
                event_end_ts: firstEventTs + 300,
                yes_token_id: "yes-1",
                no_token_id: "no-1",
                yes_open_price: 0.5,
                yes_entry_minute_1_price: 0.5,
                yes_entry_minute_2_price: 0.5,
                yes_entry_minute_3_price: 0.5,
                yes_entry_minute_4_price: 0.5,
                resolved_outcome_up: 1,
                resolution_source: "test",
                updated_at: 1,
            },
        ], (url) => {
            if (url.pathname === "/api/sqlite/load-polymarket-outcomes") {
                requestedSeriesIds.push(url.searchParams.get("seriesId") ?? "");
            }
        });

        const result = await annotateBacktestResultWithPolymarketOutcomes(
            makeBacktestResult([makeTrade(1, "long", firstEventTs, 10)]),
            {
                symbol: "ETHUSDT",
                interval: "5m",
                executionModel: "next_open",
                chartData: bars,
            }
        );

        expect(requestedSeriesIds).to.deep.equal(["10683"]);
        expect(result.polymarketTradeSummary?.seriesId).to.equal("10683");
        expect(result.trades[0]?.polymarketOutcome?.marketSlug).to.equal("eth-1");
    });

    it("annotates cross-symbol 5m runs with the selected Polymarket outcome symbol", async () => {
        const bars = makeBars(4);
        const firstEventTs = Number(bars[1]!.time);
        const requestedSeriesIds: string[] = [];
        installOutcomeFetch([
            {
                series_id: "10683",
                event_slug: "eth-override-1",
                market_slug: "eth-override-1",
                interval: "5m",
                event_start_ts: firstEventTs,
                event_end_ts: firstEventTs + 300,
                yes_token_id: "yes-1",
                no_token_id: "no-1",
                yes_open_price: 0.48,
                yes_entry_minute_1_price: 0.49,
                yes_entry_minute_2_price: 0.5,
                yes_entry_minute_3_price: 0.51,
                yes_entry_minute_4_price: 0.52,
                resolved_outcome_up: 1,
                resolution_source: "test",
                updated_at: 1,
            },
        ], (url) => {
            if (url.pathname === "/api/sqlite/load-polymarket-outcomes") {
                requestedSeriesIds.push(url.searchParams.get("seriesId") ?? "");
            }
        });

        const result = await annotateBacktestResultWithPolymarketOutcomes(
            makeBacktestResult([makeTrade(1, "long", firstEventTs, 10)]),
            {
                symbol: "NEARUSDT",
                interval: "5m",
                executionModel: "next_open",
                chartData: bars,
                outcomeSymbol: "ETHUSDT",
            }
        );

        expect(requestedSeriesIds).to.deep.equal(["10683"]);
        expect(result.polymarketTradeSummary?.seriesId).to.equal("10683");
        expect(result.polymarketTradeSummary?.outcomeSymbol).to.equal("ETHUSDT");
        expect(result.trades[0]?.polymarketOutcome?.marketSlug).to.equal("eth-override-1");
    });

    it("annotates 1m bridge runs using the selected offset and ignores same-event duplicates", async () => {
        const bars = makeMinuteBars(12);
        const eventStartTs = 1_700_000_300;
        installOutcomeFetch([
            {
                series_id: "10684",
                event_slug: "btc-bridge-1",
                market_slug: "btc-bridge-1",
                interval: "5m",
                event_start_ts: eventStartTs,
                event_end_ts: eventStartTs + 300,
                yes_token_id: "yes-1",
                no_token_id: "no-1",
                yes_open_price: 0.5,
                yes_entry_minute_1_price: 0.52,
                yes_entry_minute_2_price: 0.54,
                yes_entry_minute_3_price: 0.56,
                yes_entry_minute_4_price: 0.58,
                resolved_outcome_up: 1,
                resolution_source: "test",
                updated_at: 1,
            },
        ]);

        const firstEligibleEntry = eventStartTs + 60;
        const duplicateEntry = eventStartTs + 90;
        const result = await annotateBacktestResultWithPolymarketOutcomes(
            makeBacktestResult([
                makeTrade(1, "long", firstEligibleEntry, 10),
                makeTrade(2, "long", duplicateEntry, 8),
            ]),
            {
                symbol: "BTCUSDT",
                interval: "1m",
                executionModel: "next_open",
                chartData: bars,
            },
            1
        );

        expect(result.polymarketTradeSummary?.entryOffset).to.equal(1);
        expect(result.polymarketTradeSummary?.scoredTrades).to.equal(1);
        expect(result.polymarketTradeSummary?.missingOutcomeTrades).to.equal(0);
        expect(result.polymarketTradeSummary?.unscoredTrades).to.equal(1);
        expect(result.polymarketTradeSummary?.duplicateTradesIgnored).to.equal(1);
        expect(result.polymarketTradeSummary?.timingProfile?.map((entry) => entry.entryOffset)).to.deep.equal([0, 1, 2, 3, 4]);
        expect(result.polymarketTradeSummary?.timingProfile?.find((entry) => entry.entryOffset === 1)?.scoredTrades).to.equal(1);
        expect(result.trades[0]?.polymarketOutcome?.isWin).to.equal(true);
        expect(result.trades[0]?.polymarketOutcome?.entryOffset).to.equal(1);
        expect(result.trades[0]?.polymarketOutcome?.marketEntryPrice).to.equal(0.52);
        expect(result.trades[1]?.polymarketOutcome?.marketExitSource).to.equal("duplicate");
    });

    it("labels fixed-offset resolve-hold rows that were skipped by minute selection or same-event duplication", async () => {
        const bars = makeMinuteBars(12);
        const eventStartTs = 1_700_000_300;
        installOutcomeFetch([
            {
                series_id: "10684",
                event_slug: "btc-bridge-2",
                market_slug: "btc-bridge-2",
                interval: "5m",
                event_start_ts: eventStartTs,
                event_end_ts: eventStartTs + 300,
                yes_token_id: "yes-1",
                no_token_id: "no-1",
                yes_open_price: 0.5,
                yes_entry_minute_1_price: 0.52,
                yes_entry_minute_2_price: 0.54,
                yes_entry_minute_3_price: 0.56,
                yes_entry_minute_4_price: 0.58,
                resolved_outcome_up: 1,
                resolution_source: "test",
                updated_at: 1,
            },
        ]);

        const filteredEntry = eventStartTs;
        const selectedEntry = eventStartTs + 60;
        const duplicateEntry = eventStartTs + 90;
        const result = await annotateBacktestResultWithPolymarketOutcomes(
            makeBacktestResult([
                makeTrade(1, "long", filteredEntry, 10),
                makeTrade(2, "long", selectedEntry, 9),
                makeTrade(3, "long", duplicateEntry, 8),
            ]),
            {
                symbol: "BTCUSDT",
                interval: "1m",
                executionModel: "next_open",
                chartData: bars,
            },
            1
        );

        expect(result.trades[0]?.polymarketOutcome?.marketExitSource).to.equal("filtered");
        expect(result.trades[0]?.polymarketOutcome?.entryOffset).to.equal(0);
        expect(result.trades[1]?.polymarketOutcome?.marketExitSource).to.equal(undefined);
        expect(result.trades[2]?.polymarketOutcome?.marketExitSource).to.equal("duplicate");

        const renderer = new TradesRenderer() as unknown as {
            renderTradeItem: (trade: Trade, formatPrice: (price: number) => string, formatDate: (time: Trade["entryTime"]) => string) => string;
        };
        const filteredHtml = renderer.renderTradeItem(
            result.trades[0]!,
            (price) => price.toFixed(2),
            (time) => String(time)
        );
        const duplicateHtml = renderer.renderTradeItem(
            result.trades[2]!,
            (price) => price.toFixed(2),
            (time) => String(time)
        );
        expect(filteredHtml).to.include("Poly skip m0");
        expect(duplicateHtml).to.include("Poly dup");
    });

    it("annotates 1m resolve-hold runs in auto mode using each trade's actual minute and event-level deduplication", async () => {
        const bars = makeMinuteBars(18);
        const firstEventStartTs = 1_700_000_300;
        const secondEventStartTs = firstEventStartTs + 300;
        installOutcomeFetch([
            {
                series_id: "10684",
                event_slug: "btc-auto-1",
                market_slug: "btc-auto-1",
                interval: "5m",
                event_start_ts: firstEventStartTs,
                event_end_ts: firstEventStartTs + 300,
                yes_token_id: "yes-1",
                no_token_id: "no-1",
                yes_open_price: 0.5,
                yes_entry_minute_1_price: 0.52,
                yes_entry_minute_2_price: 0.54,
                yes_entry_minute_3_price: 0.56,
                yes_entry_minute_4_price: 0.58,
                resolved_outcome_up: 1,
                resolution_source: "test",
                updated_at: 1,
            },
            {
                series_id: "10684",
                event_slug: "btc-auto-2",
                market_slug: "btc-auto-2",
                interval: "5m",
                event_start_ts: secondEventStartTs,
                event_end_ts: secondEventStartTs + 300,
                yes_token_id: "yes-2",
                no_token_id: "no-2",
                yes_open_price: 0.45,
                yes_entry_minute_1_price: 0.47,
                yes_entry_minute_2_price: 0.49,
                yes_entry_minute_3_price: 0.51,
                yes_entry_minute_4_price: 0.53,
                resolved_outcome_up: 1,
                resolution_source: "test",
                updated_at: 1,
            },
        ]);

        const result = await annotateBacktestResultWithPolymarketOutcomes(
            makeBacktestResult([
                makeTrade(1, "long", firstEventStartTs + 120, 10),
                makeTrade(2, "long", firstEventStartTs + 180, 9),
                makeTrade(3, "long", secondEventStartTs + 240, 8),
            ]),
            {
                symbol: "BTCUSDT",
                interval: "1m",
                executionModel: "next_open",
                chartData: bars,
            },
            0,
            undefined,
            "actual_entry_minute"
        );

        expect(result.polymarketTradeSummary?.entrySelectionMode).to.equal("actual_entry_minute");
        expect(result.polymarketTradeSummary?.entryOffset).to.equal(undefined);
        expect(result.polymarketTradeSummary?.scoredTrades).to.equal(2);
        expect(result.polymarketTradeSummary?.unscoredTrades).to.equal(1);
        expect(result.polymarketTradeSummary?.duplicateTradesIgnored).to.equal(1);
        expect(result.trades[0]?.polymarketOutcome?.entryOffset).to.equal(2);
        expect(result.trades[0]?.polymarketOutcome?.marketEntryPrice).to.equal(0.54);
        expect(result.trades[1]?.polymarketOutcome?.marketExitSource).to.equal("duplicate");
        expect(result.trades[1]?.polymarketOutcome?.entryOffset).to.equal(3);
        expect(result.trades[2]?.polymarketOutcome?.entryOffset).to.equal(4);
        expect(result.trades[2]?.polymarketOutcome?.marketEntryPrice).to.equal(0.53);
    });

    it("annotates 1m signal-exit runs with entry and exit prices from stored price points", async () => {
        const bars = makeMinuteBars(12);
        const eventStartTs = 1_700_000_300;
        installOutcomeFetch([
            {
                series_id: "10684",
                event_slug: "btc-signal-exit-1",
                market_slug: "btc-signal-exit-1",
                interval: "5m",
                event_start_ts: eventStartTs,
                event_end_ts: eventStartTs + 300,
                yes_token_id: "yes-1",
                no_token_id: "no-1",
                yes_open_price: 0.5,
                yes_entry_minute_1_price: 0.52,
                yes_entry_minute_2_price: 0.54,
                yes_entry_minute_3_price: 0.56,
                yes_entry_minute_4_price: 0.58,
                resolved_outcome_up: 1,
                resolution_source: "test",
                updated_at: 1,
            },
        ]);

        const entryTs = eventStartTs + 60;
        const exitTs = eventStartTs + 180;
        const result = await annotateBacktestResultWithPolymarketOutcomes(
            makeBacktestResult([
                {
                    ...makeTrade(1, "long", entryTs, 10),
                    exitTime: exitTs,
                    exitReason: "signal",
                },
            ]),
            {
                symbol: "BTCUSDT",
                interval: "1m",
                executionModel: "next_open",
                chartData: bars,
                polymarketExitMode: "signal_exit_same_event",
            },
            undefined,
            [
                {
                    series_id: "10684",
                    event_start_ts: eventStartTs,
                    event_end_ts: eventStartTs + 300,
                    market_slug: "btc-signal-exit-1",
                    yes_token_id: "yes-1",
                    no_token_id: "no-1",
                    ts: entryTs,
                    yes_price: 0.52,
                    no_price: 0.48,
                    updated_at: 1,
                },
                {
                    series_id: "10684",
                    event_start_ts: eventStartTs,
                    event_end_ts: eventStartTs + 300,
                    market_slug: "btc-signal-exit-1",
                    yes_token_id: "yes-1",
                    no_token_id: "no-1",
                    ts: exitTs,
                    yes_price: 0.64,
                    no_price: 0.36,
                    updated_at: 1,
                },
            ]
        );

        expect(result.polymarketTradeSummary?.evaluationMode).to.equal("signal_exit_same_event");
        expect(result.polymarketTradeSummary?.scoredTrades).to.equal(1);
        expect(result.polymarketTradeSummary?.signalExitedTrades).to.equal(1);
        expect(result.polymarketTradeSummary?.resolvedTrades).to.equal(0);
        expect(result.polymarketTradeSummary?.expectancy).to.be.closeTo(0.12, 1e-12);
        expect(result.polymarketTradeSummary?.profitFactor).to.equal(Infinity);
        expect(result.trades[0]?.polymarketOutcome?.marketEntryPrice).to.equal(0.52);
        expect(result.trades[0]?.polymarketOutcome?.marketExitPrice).to.equal(0.64);
        expect(result.trades[0]?.polymarketOutcome?.marketPnl).to.be.closeTo(0.12, 1e-12);
        expect(result.trades[0]?.polymarketOutcome?.marketExitSource).to.equal("signal");

        const renderer = new TradesRenderer() as unknown as {
            renderTradeItem: (trade: Trade, formatPrice: (price: number) => string, formatDate: (time: Trade["entryTime"]) => string) => string;
        };
        const html = renderer.renderTradeItem(
            result.trades[0]!,
            (price) => price.toFixed(2),
            (time) => String(time)
        );

        expect(html).to.include("Poly Exit");
        expect(html).to.include("exited same-event");
    });

    it("reuses the entry quote as a flat same-event exit when no newer quote exists before exit", async () => {
        const bars = makeMinuteBars(12);
        const eventStartTs = 1_700_000_300;
        installOutcomeFetch([
            {
                series_id: "10684",
                event_slug: "btc-missing-price-1",
                market_slug: "btc-missing-price-1",
                interval: "5m",
                event_start_ts: eventStartTs,
                event_end_ts: eventStartTs + 300,
                yes_token_id: "yes-1",
                no_token_id: "no-1",
                yes_open_price: 0.5,
                yes_entry_minute_1_price: 0.52,
                yes_entry_minute_2_price: 0.54,
                yes_entry_minute_3_price: 0.56,
                yes_entry_minute_4_price: 0.58,
                resolved_outcome_up: 1,
                resolution_source: "test",
                updated_at: 1,
            },
        ]);

        const entryTs = eventStartTs + 60;
        const result = await annotateBacktestResultWithPolymarketOutcomes(
            makeBacktestResult([
                {
                    ...makeTrade(1, "long", entryTs, 10),
                    exitTime: entryTs + 120,
                    exitReason: "signal",
                },
            ]),
            {
                symbol: "BTCUSDT",
                interval: "1m",
                executionModel: "next_open",
                chartData: bars,
                polymarketExitMode: "signal_exit_same_event",
            },
            undefined,
            [
                {
                    series_id: "10684",
                    event_start_ts: eventStartTs,
                    event_end_ts: eventStartTs + 300,
                    market_slug: "btc-missing-price-1",
                    yes_token_id: "yes-1",
                    no_token_id: "no-1",
                    ts: entryTs,
                    yes_price: 0.52,
                    no_price: 0.48,
                    updated_at: 1,
                },
            ]
        );

        expect(result.polymarketTradeSummary?.evaluationMode).to.equal("signal_exit_same_event");
        expect(result.polymarketTradeSummary?.scoredTrades).to.equal(1);
        expect(result.polymarketTradeSummary?.missingPriceTrades).to.equal(0);
        expect(result.trades[0]?.polymarketOutcome?.marketExitSource).to.equal("signal");
        expect(result.trades[0]?.polymarketOutcome?.marketPnl).to.equal(0);

        const renderer = new TradesRenderer() as unknown as {
            renderTradeItem: (trade: Trade, formatPrice: (price: number) => string, formatDate: (time: Trade["entryTime"]) => string) => string;
        };
        const html = renderer.renderTradeItem(
            result.trades[0]!,
            (price) => price.toFixed(2),
            (time) => String(time)
        );

        expect(html).to.include("Poly Exit");
        expect(html).to.include("YES 52.0c->52.0c (+0.0c)");
    });

    it("keeps true missing same-event exit quotes unscored instead of rendering a fake resolution badge", async () => {
        const bars = makeMinuteBars(12);
        const eventStartTs = 1_700_000_300;
        installOutcomeFetch([
            {
                series_id: "10684",
                event_slug: "btc-missing-price-2",
                market_slug: "btc-missing-price-2",
                interval: "5m",
                event_start_ts: eventStartTs,
                event_end_ts: eventStartTs + 300,
                yes_token_id: "yes-1",
                no_token_id: "no-1",
                yes_open_price: 0.5,
                yes_entry_minute_1_price: 0.52,
                yes_entry_minute_2_price: 0.54,
                yes_entry_minute_3_price: 0.56,
                yes_entry_minute_4_price: 0.58,
                resolved_outcome_up: 1,
                resolution_source: "test",
                updated_at: 1,
            },
        ]);

        const entryTs = eventStartTs + 60;
        const result = await annotateBacktestResultWithPolymarketOutcomes(
            makeBacktestResult([
                {
                    ...makeTrade(1, "long", entryTs, 10),
                    exitTime: entryTs + 120,
                    exitReason: "signal",
                },
            ]),
            {
                symbol: "BTCUSDT",
                interval: "1m",
                executionModel: "next_open",
                chartData: bars,
                polymarketExitMode: "signal_exit_same_event",
            },
            undefined,
            [
                {
                    series_id: "10684",
                    event_start_ts: eventStartTs,
                    event_end_ts: eventStartTs + 300,
                    market_slug: "btc-missing-price-2",
                    yes_token_id: "yes-1",
                    no_token_id: "no-1",
                    ts: entryTs + 180,
                    yes_price: 0.60,
                    no_price: 0.40,
                    updated_at: 1,
                },
            ]
        );

        expect(result.polymarketTradeSummary?.evaluationMode).to.equal("signal_exit_same_event");
        expect(result.polymarketTradeSummary?.scoredTrades).to.equal(0);
        expect(result.polymarketTradeSummary?.missingPriceTrades).to.equal(1);
        expect(result.trades[0]?.polymarketOutcome).to.equal(null);

        const renderer = new TradesRenderer() as unknown as {
            renderTradeItem: (trade: Trade, formatPrice: (price: number) => string, formatDate: (time: Trade["entryTime"]) => string) => string;
        };
        const html = renderer.renderTradeItem(
            result.trades[0]!,
            (price) => price.toFixed(2),
            (time) => String(time)
        );

        expect(html).to.not.include("Poly n/a");
        expect(html).to.not.include("Poly Settle");
        expect(html).to.not.include("Poly Exit");
    });

    it("renders zero-pnl signal-exit trades as same-event Polymarket exits", async () => {
        const bars = makeMinuteBars(12);
        const eventStartTs = 1_700_000_300;
        installOutcomeFetch([
            {
                series_id: "10684",
                event_slug: "btc-flat-price-1",
                market_slug: "btc-flat-price-1",
                interval: "5m",
                event_start_ts: eventStartTs,
                event_end_ts: eventStartTs + 300,
                yes_token_id: "yes-1",
                no_token_id: "no-1",
                yes_open_price: 0.5,
                yes_entry_minute_1_price: 0.52,
                yes_entry_minute_2_price: 0.54,
                yes_entry_minute_3_price: 0.56,
                yes_entry_minute_4_price: 0.58,
                resolved_outcome_up: 1,
                resolution_source: "test",
                updated_at: 1,
            },
        ]);

        const entryTs = eventStartTs + 60;
        const exitTs = eventStartTs + 180;
        const result = await annotateBacktestResultWithPolymarketOutcomes(
            makeBacktestResult([
                {
                    ...makeTrade(1, "long", entryTs, 10),
                    exitTime: exitTs,
                    exitReason: "signal",
                },
            ]),
            {
                symbol: "BTCUSDT",
                interval: "1m",
                executionModel: "next_open",
                chartData: bars,
                polymarketExitMode: "signal_exit_same_event",
            },
            undefined,
            [
                {
                    series_id: "10684",
                    event_start_ts: eventStartTs,
                    event_end_ts: eventStartTs + 300,
                    market_slug: "btc-flat-price-1",
                    yes_token_id: "yes-1",
                    no_token_id: "no-1",
                    ts: entryTs,
                    yes_price: 0.52,
                    no_price: 0.48,
                    updated_at: 1,
                },
                {
                    series_id: "10684",
                    event_start_ts: eventStartTs,
                    event_end_ts: eventStartTs + 300,
                    market_slug: "btc-flat-price-1",
                    yes_token_id: "yes-1",
                    no_token_id: "no-1",
                    ts: exitTs,
                    yes_price: 0.52,
                    no_price: 0.48,
                    updated_at: 1,
                },
            ]
        );

        expect(result.trades[0]?.polymarketOutcome?.marketPnl).to.equal(0);
        expect(result.trades[0]?.polymarketOutcome?.isProfitable).to.equal(null);

        const renderer = new TradesRenderer() as unknown as {
            renderTradeItem: (trade: Trade, formatPrice: (price: number) => string, formatDate: (time: Trade["entryTime"]) => string) => string;
        };
        const html = renderer.renderTradeItem(
            result.trades[0]!,
            (price) => price.toFixed(2),
            (time) => String(time)
        );

        expect(html).to.include("Poly Exit");
        expect(html).to.include("exited same-event");
        expect(html).to.not.include("Poly Settle");
    });

    it("renders non-signal chart exits as event-end Polymarket settlements", async () => {
        const bars = makeMinuteBars(12);
        const eventStartTs = 1_700_000_300;
        installOutcomeFetch([
            {
                series_id: "10684",
                event_slug: "btc-resolution-1",
                market_slug: "btc-resolution-1",
                interval: "5m",
                event_start_ts: eventStartTs,
                event_end_ts: eventStartTs + 300,
                yes_token_id: "yes-1",
                no_token_id: "no-1",
                yes_open_price: 0.5,
                yes_entry_minute_1_price: 0.52,
                yes_entry_minute_2_price: 0.54,
                yes_entry_minute_3_price: 0.56,
                yes_entry_minute_4_price: 0.58,
                resolved_outcome_up: 1,
                resolution_source: "test",
                updated_at: 1,
            },
        ]);

        const entryTs = eventStartTs + 60;
        const result = await annotateBacktestResultWithPolymarketOutcomes(
            makeBacktestResult([
                {
                    ...makeTrade(1, "long", entryTs, 10),
                    exitTime: entryTs + 120,
                    exitReason: "take_profit",
                },
            ]),
            {
                symbol: "BTCUSDT",
                interval: "1m",
                executionModel: "next_open",
                chartData: bars,
                polymarketExitMode: "signal_exit_same_event",
            },
            undefined,
            [
                {
                    series_id: "10684",
                    event_start_ts: eventStartTs,
                    event_end_ts: eventStartTs + 300,
                    market_slug: "btc-resolution-1",
                    yes_token_id: "yes-1",
                    no_token_id: "no-1",
                    ts: entryTs,
                    yes_price: 0.52,
                    no_price: 0.48,
                    updated_at: 1,
                },
            ]
        );

        expect(result.trades[0]?.polymarketOutcome?.marketExitSource).to.equal("resolution");

        const renderer = new TradesRenderer() as unknown as {
            renderTradeItem: (trade: Trade, formatPrice: (price: number) => string, formatDate: (time: Trade["entryTime"]) => string) => string;
        };
        const html = renderer.renderTradeItem(
            result.trades[0]!,
            (price) => price.toFixed(2),
            (time) => String(time)
        );

        expect(html).to.include("Poly Settle");
        expect(html).to.include("settled at event end");
        expect(html).to.include("take profit");
    });

    it("loads stored price points by event key so same-event exit quotes are not missed", async () => {
        globalThis.fetch = (async (input) => {
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

            if (url.pathname === "/api/sqlite/load-polymarket-price-points") {
                expect(url.searchParams.get("eventStartTs")).to.equal("1700000300");
                expect(url.searchParams.get("startTs")).to.equal(null);
                expect(url.searchParams.get("endTs")).to.equal(null);
                return new Response(JSON.stringify({
                    ok: true,
                    rows: [
                        {
                            series_id: "10684",
                            event_start_ts: 1_700_000_300,
                            event_end_ts: 1_700_000_600,
                            market_slug: "btc-event",
                            yes_token_id: "yes-1",
                            no_token_id: "no-1",
                            ts: 1_700_000_580,
                            yes_price: 0.61,
                            no_price: 0.39,
                            updated_at: 1,
                        },
                    ],
                }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                });
            }

            if (url.pathname === "/api/polymarket-history" || url.pathname === "/prices-history") {
                throw new Error("history fetch should not run when the event already has stored price points");
            }

            if (url.pathname === "/api/sqlite/store-polymarket-price-points") {
                return new Response(JSON.stringify({ ok: true, upserted: 0 }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                });
            }

            throw new Error(`Unexpected fetch: ${url.pathname}`);
        }) as typeof fetch;

        const points = await ensurePricePointsForOutcomes([
            {
                series_id: "10684",
                event_slug: "btc-event",
                market_slug: "btc-event",
                interval: "5m",
                event_start_ts: 1_700_000_300,
                event_end_ts: 1_700_000_600,
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
            },
        ], "10684", {
            startTs: 1_700_000_300,
            endTs: 1_700_000_360,
        });

        expect(points).to.have.length(1);
        expect(points[0]?.ts).to.equal(1_700_000_580);
    });

    it("chunks large stored price-point lookups so signal-exit runs do not drop coverage", async () => {
        const requestedChunks: string[] = [];
        globalThis.fetch = (async (input) => {
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

            if (url.pathname === "/api/sqlite/load-polymarket-price-points") {
                const chunk = url.searchParams.get("eventStartTs") ?? "";
                requestedChunks.push(chunk);
                const rows = chunk
                    .split(",")
                    .map((value) => Number(value.trim()))
                    .filter((value) => Number.isFinite(value))
                    .map((eventStartTs) => ({
                        series_id: "10684",
                        event_start_ts: eventStartTs,
                        event_end_ts: eventStartTs + 300,
                        market_slug: `btc-${eventStartTs}`,
                        yes_token_id: `yes-${eventStartTs}`,
                        no_token_id: `no-${eventStartTs}`,
                        ts: eventStartTs + 60,
                        yes_price: 0.55,
                        no_price: 0.45,
                        updated_at: 1,
                    }));

                return new Response(JSON.stringify({
                    ok: true,
                    rows,
                }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                });
            }

            if (url.pathname === "/api/sqlite/ensure-polymarket-price-points") {
                throw new Error("ensure route should not run when stored chunks already cover every event");
            }

            throw new Error(`Unexpected fetch: ${url.pathname}`);
        }) as typeof fetch;

        const outcomes = Array.from({ length: 205 }, (_, index) => {
            const eventStartTs = 1_700_100_000 + index * 300;
            return {
                series_id: "10684",
                event_slug: `btc-${eventStartTs}`,
                market_slug: `btc-${eventStartTs}`,
                interval: "5m",
                event_start_ts: eventStartTs,
                event_end_ts: eventStartTs + 300,
                yes_token_id: `yes-${eventStartTs}`,
                no_token_id: `no-${eventStartTs}`,
                yes_open_price: 0.5,
                yes_entry_minute_1_price: 0.51,
                yes_entry_minute_2_price: 0.52,
                yes_entry_minute_3_price: 0.53,
                yes_entry_minute_4_price: 0.54,
                resolved_outcome_up: 1 as const,
                resolution_source: "test",
                updated_at: 1,
            };
        });

        const points = await ensurePricePointsForOutcomes(outcomes, "10684");

        expect(points).to.have.length(205);
        expect(requestedChunks).to.have.length(3);
        expect(requestedChunks.map((chunk) => chunk.split(",").filter(Boolean).length)).to.deep.equal([100, 100, 5]);
    });

    it("batches large stored price-point lookups so concurrent SQLite loads do not fail", async () => {
        const requestedChunks: string[] = [];
        let activeLoadRequests = 0;
        let peakLoadRequests = 0;

        globalThis.fetch = (async (input) => {
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

            if (url.pathname === "/api/sqlite/load-polymarket-price-points") {
                const chunk = url.searchParams.get("eventStartTs") ?? "";
                requestedChunks.push(chunk);
                activeLoadRequests++;
                peakLoadRequests = Math.max(peakLoadRequests, activeLoadRequests);
                if (activeLoadRequests > 4) {
                    activeLoadRequests--;
                    throw new Error("Failed to fetch");
                }

                await new Promise((resolve) => setTimeout(resolve, 1));

                const rows = chunk
                    .split(",")
                    .map((value) => Number(value.trim()))
                    .filter((value) => Number.isFinite(value))
                    .map((eventStartTs) => ({
                        series_id: "10684",
                        event_start_ts: eventStartTs,
                        event_end_ts: eventStartTs + 300,
                        market_slug: `btc-${eventStartTs}`,
                        yes_token_id: `yes-${eventStartTs}`,
                        no_token_id: `no-${eventStartTs}`,
                        ts: eventStartTs + 60,
                        yes_price: 0.55,
                        no_price: 0.45,
                        updated_at: 1,
                    }));

                activeLoadRequests--;
                return new Response(JSON.stringify({
                    ok: true,
                    rows,
                }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                });
            }

            if (url.pathname === "/api/sqlite/ensure-polymarket-price-points") {
                throw new Error("ensure route should not run when stored chunks already cover every event");
            }

            throw new Error(`Unexpected fetch: ${url.pathname}`);
        }) as typeof fetch;

        const outcomes = Array.from({ length: 605 }, (_, index) => {
            const eventStartTs = 1_700_200_000 + index * 300;
            return {
                series_id: "10684",
                event_slug: `btc-${eventStartTs}`,
                market_slug: `btc-${eventStartTs}`,
                interval: "5m",
                event_start_ts: eventStartTs,
                event_end_ts: eventStartTs + 300,
                yes_token_id: `yes-${eventStartTs}`,
                no_token_id: `no-${eventStartTs}`,
                yes_open_price: 0.5,
                yes_entry_minute_1_price: 0.51,
                yes_entry_minute_2_price: 0.52,
                yes_entry_minute_3_price: 0.53,
                yes_entry_minute_4_price: 0.54,
                resolved_outcome_up: 1 as const,
                resolution_source: "test",
                updated_at: 1,
            };
        });

        const points = await ensurePricePointsForOutcomes(outcomes, "10684");

        expect(points).to.have.length(605);
        expect(requestedChunks).to.have.length(7);
        expect(peakLoadRequests).to.be.at.most(4);
    });

    it("re-fetches events when the local cache only has a single stored quote", async () => {
        let ensureCalls = 0;

        globalThis.fetch = (async (input) => {
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

            if (url.pathname === "/api/sqlite/load-polymarket-price-points") {
                return new Response(JSON.stringify({
                    ok: true,
                    rows: [
                        {
                            series_id: "10684",
                            event_start_ts: 1_700_000_300,
                            event_end_ts: 1_700_000_600,
                            market_slug: "btc-event",
                            yes_token_id: "yes-1",
                            no_token_id: "no-1",
                            ts: 1_700_000_360,
                            yes_price: 0.55,
                            no_price: 0.45,
                            updated_at: 1,
                        },
                    ],
                }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                });
            }

            if (url.pathname === "/api/sqlite/ensure-polymarket-price-points") {
                ensureCalls++;
                return new Response(JSON.stringify({
                    ok: true,
                    rows: [
                        {
                            series_id: "10684",
                            event_start_ts: 1_700_000_300,
                            event_end_ts: 1_700_000_600,
                            market_slug: "btc-event",
                            yes_token_id: "yes-1",
                            no_token_id: "no-1",
                            ts: 1_700_000_360,
                            yes_price: 0.55,
                            no_price: 0.45,
                            updated_at: 1,
                        },
                        {
                            series_id: "10684",
                            event_start_ts: 1_700_000_300,
                            event_end_ts: 1_700_000_600,
                            market_slug: "btc-event",
                            yes_token_id: "yes-1",
                            no_token_id: "no-1",
                            ts: 1_700_000_540,
                            yes_price: 0.61,
                            no_price: 0.39,
                            updated_at: 1,
                        },
                    ],
                }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                });
            }

            throw new Error(`Unexpected fetch: ${url.pathname}`);
        }) as typeof fetch;

        const points = await ensurePricePointsForOutcomes([
            {
                series_id: "10684",
                event_slug: "btc-event",
                market_slug: "btc-event",
                interval: "5m",
                event_start_ts: 1_700_000_300,
                event_end_ts: 1_700_000_600,
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
            },
        ], "10684");

        expect(ensureCalls).to.equal(1);
        expect(points).to.have.length(2);
        expect(points.map((point) => point.ts)).to.deep.equal([1_700_000_360, 1_700_000_540]);
    });

    it("skips annotation for unsupported runs", async () => {
        globalThis.fetch = (async () => {
            throw new Error("fetch should not run for unsupported symbol");
        }) as typeof fetch;

        const original = makeBacktestResult([makeTrade(1, "long", 1_700_000_300, 10)]);
        const result = await annotateBacktestResultWithPolymarketOutcomes(original, {
            symbol: "ADAUSDT",
            interval: "5m",
            executionModel: "next_open",
            chartData: makeBars(3),
        });

        expect(result).to.equal(original);
    });

    it("skips annotation for non-canonical BTC symbols", async () => {
        globalThis.fetch = (async () => {
            throw new Error("fetch should not run for non-canonical BTC symbols");
        }) as typeof fetch;

        const original = makeBacktestResult([makeTrade(1, "long", 1_700_000_300, 10)]);
        const result = await annotateBacktestResultWithPolymarketOutcomes(original, {
            symbol: "BTCUSD",
            interval: "5m",
            executionModel: "next_open",
            chartData: makeBars(3),
        });

        expect(result).to.equal(original);
    });
});
