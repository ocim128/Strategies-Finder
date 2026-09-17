import { runOpenScoreUsdReplay, type OpenScoreUsdTarget } from "./lib/batch-backtest/batch-open-score-usd-replay-engine";
import type { BatchSyntheticPairArtifact } from "./lib/batch-backtest/batch-synthetic-artifact";
import type { BacktestResult, OHLCVData, Time, Trade } from "./lib/types/strategies";

const T0 = 1_700_000_000;
function emptyResult(): BacktestResult {
    return { trades: [], netProfit: 0, netProfitPercent: 0, winRate: 0, expectancy: 0, avgTrade: 0, profitFactor: 0, maxDrawdown: 0, maxDrawdownPercent: 0, totalTrades: 0, winningTrades: 0, losingTrades: 0, avgWin: 0, avgLoss: 0, sharpeRatio: 0, equityCurve: [] };
}
let tradeId = 0;
function makeTrade(type: "long" | "short", entrySec: number, exitSec: number | null, pnl = 0): Trade {
    return { id: tradeId += 1, type, entryTime: entrySec as Time, entryPrice: 1, exitTime: (exitSec ?? entrySec) as Time, exitPrice: 1, pnl, pnlPercent: 0, size: 1, exitReason: exitSec === null ? "end_of_data" : "signal" };
}
function makePair(base: string, quote: string, trades: Trade[], netProfit = 0): BatchSyntheticPairArtifact {
    return { symbol: `${base}+${quote}`, baseAsset: base, quoteAsset: quote, data: [], signals: [], result: { ...emptyResult(), totalTrades: trades.length, trades, netProfit } };
}
function makeTarget(asset: string, bars: number): OpenScoreUsdTarget {
    const data: OHLCVData[] = Array.from({ length: bars }, (_, i) => ({ time: (T0 + i * 1000) as Time, open: 100, high: 100, low: 100, close: 100, volume: 1 }));
    return { asset, symbol: `${asset}USDT`, data };
}
async function* fromArray<T>(items: T[]): AsyncIterable<T> { for (const item of items) yield item; }

async function main(): Promise<void> {
    // ---- fixture 18 (causal-only event) ----
    const pairs18 = [
        makePair("AAA", "X1", [makeTrade("long", T0 + 500, T0 + 800, 10), makeTrade("long", T0 + 1000, null, 0)], 10),
        makePair("BBB", "Y1", [makeTrade("long", T0 + 500, T0 + 800, 10), makeTrade("long", T0 + 1000, null, 0)], 10),
        makePair("DDD", "BBB", [makeTrade("long", T0 + 1000, null, 0)], 0),
        makePair("EEE", "DDD", [makeTrade("long", T0 + 1000, null, 0)], 0),
        makePair("EEE", "AAA", [makeTrade("short", T0 + 1000, null, 0)], 0),
    ];
    const targets18 = ["AAA", "BBB", "DDD", "EEE", "X1", "Y1"].map((a) => makeTarget(a, 10));
    const r18 = await runOpenScoreUsdReplay(() => fromArray(pairs18), () => fromArray(targets18), { horizons: [2], slippageRate: 0, commissionRate: 0, blockCount: 1, includeEventDetails: true });
    console.log("=== F18 ===");
    console.log("events:", r18.totalEvents, "candidate:", r18.candidateEvents);
    console.log("nowByAsset:", JSON.stringify(r18.horizons[0]!.topRawProfitNowByAsset));
    console.log("now rows:", JSON.stringify((r18.eventDetails ?? []).filter((r) => r.selector === "TOP_RAW_PROFIT_NOW")));
    console.log("warnings:", JSON.stringify(r18.warnings.filter((w) => !w.includes("discontinu"))));

    // ---- fixture 20 (FIFO overlap) ----
    const pairs20 = [
        makePair("AAA", "X1", [
            makeTrade("long", T0 + 500, T0 + 800, 10),
            makeTrade("long", T0 + 1000, T0 + 4500, 5),
            makeTrade("long", T0 + 2000, T0 + 3000, -50),
            makeTrade("long", T0 + 3500, T0 + 4000, 5),
        ], -30),
        makePair("BBB", "Y1", [makeTrade("long", T0 + 500, T0 + 800, 10), makeTrade("long", T0 + 1000, null, 5)], 15),
        makePair("CCC", "Z1", [makeTrade("long", T0 + 500, T0 + 800, 10), makeTrade("long", T0 + 4000, null, 5)], 15),
        makePair("DDD", "W1", [makeTrade("long", T0 + 500, T0 + 800, 10), makeTrade("long", T0 + 5000, null, 5)], 15),
    ];
    const targets20 = ["AAA", "BBB", "CCC", "DDD", "X1", "Y1", "Z1", "W1"].map((a) => makeTarget(a, 12));
    const r20 = await runOpenScoreUsdReplay(() => fromArray(pairs20), () => fromArray(targets20), { horizons: [2], slippageRate: 0, commissionRate: 0, blockCount: 1, includeEventDetails: true });
    console.log("=== F20 ===");
    console.log("events:", r20.totalEvents, "candidate:", r20.candidateEvents);
    console.log("now rows:", JSON.stringify((r20.eventDetails ?? []).filter((r) => r.selector === "TOP_RAW_PROFIT_NOW")));
}
main();
