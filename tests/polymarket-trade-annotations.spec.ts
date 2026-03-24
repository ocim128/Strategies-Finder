import { expect } from "chai";
import { afterEach, describe, it } from "node:test";
import { annotateBacktestResultWithPolymarketOutcomes } from "../lib/polymarket-trade-annotations";
import { TradesRenderer } from "../lib/renderers/tradesRenderer";
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

function installOutcomeFetch(rows: unknown[]): void {
    globalThis.fetch = (async () => {
        return new Response(JSON.stringify({ ok: true, rows }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        });
    }) as typeof fetch;
}

afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
});

describe("Polymarket backtest trade annotations", () => {
    it("annotates eligible BTC 5m next_open trades and renders the outcome badge", async () => {
        const bars = makeBars(4);
        const firstSignalTs = Number(bars[0]!.time);
        const secondSignalTs = Number(bars[1]!.time);
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
                makeTrade(1, "long", firstSignalTs, 10),
                makeTrade(2, "short", secondSignalTs, -10),
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

        const renderer = new TradesRenderer() as unknown as {
            renderTradeItem: (trade: Trade, formatPrice: (price: number) => string, formatDate: (time: Trade["entryTime"]) => string) => string;
        };
        const html = renderer.renderTradeItem(
            result.trades[0]!,
            (price) => price.toFixed(2),
            (time) => String(time)
        );
        expect(html).to.include("Poly Win");
        expect(html).to.include('data-polymarket-url="https://polymarket.com/event/btc-1"');
    });

    it("skips annotation for unsupported runs", async () => {
        globalThis.fetch = (async () => {
            throw new Error("fetch should not run for unsupported symbol");
        }) as typeof fetch;

        const original = makeBacktestResult([makeTrade(1, "long", 1_700_000_300, 10)]);
        const result = await annotateBacktestResultWithPolymarketOutcomes(original, {
            symbol: "ETHUSDT",
            interval: "5m",
            executionModel: "next_open",
            chartData: makeBars(3),
        });

        expect(result).to.equal(original);
    });
});
