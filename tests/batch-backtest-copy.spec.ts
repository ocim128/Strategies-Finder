import { expect } from "chai";
import { describe, it } from "node:test";
import {
    buildBatchSummaryCells,
    buildBuyHoldRows,
    buildResultRowGrid,
    computeBuyAndHoldPct,
    computeOpenTradeAssetScores,
    formatBatchOverallSummary,
    summarizeOpenScoreConcentration,
    summarizeProfitConcentration,
    summarizeRegimeSplit,
    summarizeRobustness,
} from "../lib/batch-backtest/batch-backtest-summary";
import { toScalarRow } from "../lib/batch-backtest/batch-backtest-stream-types";
import type { BatchBacktestSymbolResult } from "../lib/batch-backtest/batch-backtest-runner";
import type { OHLCVData, Time, Trade } from "../lib/types/strategies";

function candles(closes: number[]): OHLCVData[] {
    return closes.map((close, index) => ({
        time: (1_700_000_000 + index * 300) as Time,
        open: close,
        high: close + 1,
        low: close - 1,
        close,
        volume: 1000,
    }));
}

/**
 * Build a result row with only the fields the copy helpers actually read,
 * so tests can construct inputs without populating the full BacktestResult.
 */
function resultRow(
    symbol: string,
    fields: {
        netProfit?: number;
        netProfitPercent?: number;
        sharpeRatio?: number;
        totalTrades?: number;
        trades?: Trade[];
        data?: OHLCVData[];
    } = {},
): BatchBacktestSymbolResult {
    const trades = fields.trades ?? [];
    const tradesNonNull = trades.length > 0 ? trades : [{
        id: 0,
        type: "long" as const,
        entryTime: 1 as Time,
        entryPrice: 1,
        exitTime: 2 as Time,
        exitPrice: 2,
        pnl: fields.netProfit ?? 0,
        pnlPercent: fields.netProfitPercent ?? 0,
        size: 1,
        exitReason: "signal" as const,
    }];
    return {
        symbol,
        status: "profitable",
        barCount: fields.data?.length ?? 3,
        ...(fields.data ? { firstTime: fields.data[0]?.time, lastTime: fields.data[fields.data.length - 1]?.time } : {}),
        result: {
            trades: tradesNonNull,
            netProfit: fields.netProfit ?? 0,
            netProfitPercent: fields.netProfitPercent ?? 0,
            winRate: 0,
            expectancy: 0,
            avgTrade: 0,
            profitFactor: 0,
            maxDrawdown: 0,
            maxDrawdownPercent: 0,
            totalTrades: fields.totalTrades ?? tradesNonNull.length,
            winningTrades: 0,
            losingTrades: 0,
            avgWin: 0,
            avgLoss: 0,
            sharpeRatio: fields.sharpeRatio ?? 0,
            equityCurve: [],
        },
        ...(fields.data ? { data: fields.data } : {}),
    } as unknown as BatchBacktestSymbolResult;
}

function openTradeRow(
    symbol: string,
    type: "long" | "short",
    extra?: Partial<BatchBacktestSymbolResult>,
): BatchBacktestSymbolResult {
    return {
        ...resultRow(symbol, { netProfit: 1, netProfitPercent: 1 }),
        ...extra,
        result: {
            ...(extra?.result ?? resultRow(symbol).result!),
            trades: [
                { id: 0, type, entryTime: 1 as Time, entryPrice: 1, exitTime: 2 as Time, exitPrice: 2, pnl: 1, pnlPercent: 1, size: 1, exitReason: "end_of_data" },
            ],
        },
    } as unknown as BatchBacktestSymbolResult;
}

describe("computeBuyAndHoldPct", () => {
    it("returns (last/first - 1) * 100 over finite positive closes", () => {
        // 100 -> 125 = +25%
        expect(computeBuyAndHoldPct(candles([100, 110, 125]))).to.be.closeTo(25, 1e-9);
    });

    it("is negative for a downtrend", () => {
        // 100 -> 80 = -20%
        expect(computeBuyAndHoldPct(candles([100, 90, 80]))).to.be.closeTo(-20, 1e-9);
    });

    it("ignores leading/trailing non-finite closes", () => {
        const data = candles([NaN, 0, 50, 75, NaN]);
        // first usable = 50, last usable = 75 -> +50%
        expect(computeBuyAndHoldPct(data)).to.be.closeTo(50, 1e-9);
    });

    it("returns null when no finite positive close exists", () => {
        expect(computeBuyAndHoldPct(candles([NaN, 0, -1]))).to.equal(null);
    });

    it("returns null for empty / undefined input", () => {
        expect(computeBuyAndHoldPct([])).to.equal(null);
        expect(computeBuyAndHoldPct(undefined)).to.equal(null);
    });
});

describe("Batch UI summary projections", () => {
    it("projects completed results into stable summary cells", () => {
        const cells = buildBatchSummaryCells([
            resultRow("AAA", { netProfit: 25, totalTrades: 2 }),
            resultRow("BBB", { netProfit: -5, totalTrades: 3 }),
        ]);

        expect(cells).to.deep.equal([
            ["Tested", "2"],
            ["Profitable", "1"],
            ["Losing", "1"],
            ["Net", "+$20.00"],
            ["Trades", "5"],
            ["Avg/Trade", "+$4.00"],
        ]);
    });

    it("projects one result into grid metrics without changing copy data", () => {
        const row = resultRow("AAA", { netProfit: -12, totalTrades: 4, sharpeRatio: 1.25 });
        row.result!.expectancy = 3.5;
        row.result!.profitFactor = 1.8;
        row.result!.maxDrawdownPercent = 6.25;

        const grid = buildResultRowGrid(row);

        expect(grid.symbol).to.equal("AAA");
        expect(grid.net).to.deep.equal({ text: "$-12.00", sign: "loss" });
        expect(grid.expectancy).to.deep.equal({ text: "+$3.50", sign: "profit" });
        expect(grid.profitFactor).to.equal("1.80");
        expect(grid.sharpe).to.equal("1.25");
        expect(grid.drawdown).to.equal("6.25%");
        expect(grid.trades).to.equal("4");
    });
});

describe("computeOpenTradeAssetScores", () => {
    it("long synthetic pair scores base +1, quote -1 (the user's WLD+BTC example)", () => {
        const scores = computeOpenTradeAssetScores([openTradeRow("WLD+BTC", "long")]);
        const map = new Map(scores.map((s) => [s.asset, s.score]));
        expect(map.get("WLD")).to.equal(1);
        expect(map.get("BTC")).to.equal(-1);
    });

    it("short synthetic pair flips the signs", () => {
        const scores = computeOpenTradeAssetScores([openTradeRow("WLD+BTC", "short")]);
        const map = new Map(scores.map((s) => [s.asset, s.score]));
        expect(map.get("WLD")).to.equal(-1);
        expect(map.get("BTC")).to.equal(1);
    });

    it("single symbol long scores the stripped asset +1", () => {
        const scores = computeOpenTradeAssetScores([openTradeRow("BTCUSDT", "long")]);
        const map = new Map(scores.map((s) => [s.asset, s.score]));
        expect(map.get("BTC")).to.equal(1);
    });

    it("single symbol short scores the stripped asset -1", () => {
        const scores = computeOpenTradeAssetScores([openTradeRow("ETHUSDT", "short")]);
        const map = new Map(scores.map((s) => [s.asset, s.score]));
        expect(map.get("ETH")).to.equal(-1);
    });

    it("contributes nothing when no trades are open (last trade closed)", () => {
        const row = openTradeRow("WLD+BTC", "long");
        // Override the last trade to a closed exit reason.
        row.result!.trades[0]!.exitReason = "signal";
        expect(computeOpenTradeAssetScores([row])).to.deep.equal([]);
    });

    it("accumulates across multiple open trades", () => {
        // WLD+BTC long -> WLD +1, BTC -1; ETHUSDT long -> ETH +1.
        const scores = computeOpenTradeAssetScores([
            openTradeRow("WLD+BTC", "long"),
            openTradeRow("ETHUSDT", "long"),
        ]);
        const map = new Map(scores.map((s) => [s.asset, s.score]));
        expect(map.get("WLD")).to.equal(1);
        expect(map.get("BTC")).to.equal(-1);
        expect(map.get("ETH")).to.equal(1);
    });

    it("nets opposing directions on the same asset", () => {
        // WLD+BTC long (WLD +1) and WLDUSDT short (WLD -1) -> WLD nets to 0.
        const scores = computeOpenTradeAssetScores([
            openTradeRow("WLD+BTC", "long"),
            openTradeRow("WLDUSDT", "short"),
        ]);
        const map = new Map(scores.map((s) => [s.asset, s.score]));
        expect(map.get("WLD")).to.equal(0);
        // BTC still -1 from the pair leg.
        expect(map.get("BTC")).to.equal(-1);
    });

    it("sorts by abs(score) desc then asset asc", () => {
        // BTC appears at -1 (pair) and -1 (single) -> -2; WLD at +1.
        const scores = computeOpenTradeAssetScores([
            openTradeRow("WLD+BTC", "long"),
            openTradeRow("BTCUSDT", "short"),
        ]);
        // BTC (-2, abs 2) before WLD (+1, abs 1).
        expect(scores.map((s) => `${s.asset}:${s.score}`)).to.deep.equal(["BTC:-2", "WLD:1"]);
    });
});

describe("buildBuyHoldRows", () => {
    it("computes alpha = netProfitPercent - buyHoldPct per row", () => {
        // 100 -> 110 = +10% B&H; strategy netProfitPercent 25 -> alpha +15.
        const rows = buildBuyHoldRows([
            resultRow("AAA", { netProfitPercent: 25, data: candles([100, 105, 110]) }),
        ]);
        expect(rows).to.have.length(1);
        expect(rows[0]!.bh).to.be.closeTo(10, 1e-9);
        expect(rows[0]!.alpha).to.be.closeTo(15, 1e-9);
        expect(rows[0]!.strat).to.equal(25);
    });

    it("skips rows without data or result", () => {
        // No data -> computeBuyAndHoldPct returns null -> row dropped.
        expect(buildBuyHoldRows([resultRow("AAA", { netProfitPercent: 5 })])).to.have.length(0);
        // No result -> dropped.
        expect(buildBuyHoldRows([{ ...resultRow("AAA"), result: undefined }])).to.have.length(0);
    });
});

describe("server scalar batch rows", () => {
    it("preserve Copy B&H and OPEN_SCORE sections without candle or trade arrays", () => {
        const scalar = toScalarRow({
            ...openTradeRow("WLD+BTC", "long", {
                data: candles([100, 110]),
            }),
        });

        expect(scalar.data).to.equal(undefined);
        expect(scalar.result?.trades).to.deep.equal([]);
        expect(buildBuyHoldRows([scalar])[0]?.bh).to.be.closeTo(10, 1e-9);

        const scores = computeOpenTradeAssetScores([scalar]);
        expect(scores.map((s) => `${s.asset}:${s.score}`)).to.deep.equal(["BTC:-1", "WLD:1"]);

        const lines = formatBatchOverallSummary([scalar]);
        expect(lines.some((line) => line.startsWith("B&H Compare"))).to.equal(false);
        expect(lines.some((line) => line.startsWith("SUMMARY | B&H Compare"))).to.equal(true);
        expect(lines.some((line) => line.startsWith("OPEN_SCORE |"))).to.equal(true);
    });
});

describe("summarizeRegimeSplit", () => {
    it("partitions by B&H sign and reports per-bucket means", () => {
        // Up: A (bh+10, alpha+5), B (bh+20, alpha -10) -> avgBh +15, avgAlpha -2.5
        // Down: C (bh-50, alpha+30) -> avgBh -50, avgAlpha +30
        const rows = [
            { symbol: "A", strat: 15, bh: 10, alpha: 5 },
            { symbol: "B", strat: 10, bh: 20, alpha: -10 },
            { symbol: "C", strat: -20, bh: -50, alpha: 30 },
        ];
        const split = summarizeRegimeSplit(rows);
        expect(split.up.count).to.equal(2);
        expect(split.up.avgBh).to.be.closeTo(15, 1e-9);
        expect(split.up.avgAlpha).to.be.closeTo(-2.5, 1e-9);
        expect(split.down.count).to.equal(1);
        expect(split.down.avgAlpha).to.be.closeTo(30, 1e-9);
    });

    it("returns NaN stat fields for an empty bucket (count 0)", () => {
        // All uptrend -> down bucket is empty. The intent: an empty bucket
        // must not silently read as "0% alpha"; it must surface as NaN/-- so
        // a regime with no samples can't be misread as neutral.
        const split = summarizeRegimeSplit([
            { symbol: "A", strat: 5, bh: 10, alpha: -5 },
        ]);
        expect(split.down.count).to.equal(0);
        expect(Number.isNaN(split.down.avgAlpha)).to.equal(true);
    });
});

describe("summarizeProfitConcentration", () => {
    it("reports top-K share of gross positive profit and effective N via HHI", () => {
        // Profits: 60, 30, 10. Gross positive = 100.
        // Top1 = 60%, Top3 = 100%. Shares 0.6/0.3/0.1 -> HHI 0.46 -> EffN ~2.17.
        const c = summarizeProfitConcentration([
            resultRow("A", { netProfit: 60 }),
            resultRow("B", { netProfit: 30 }),
            resultRow("C", { netProfit: 10 }),
        ]);
        expect(c.totalNet).to.equal(100);
        expect(c.top1Share).to.be.closeTo(0.6, 1e-9);
        expect(c.top3Share).to.be.closeTo(1.0, 1e-9);
        expect(c.effectiveN).to.be.closeTo(1 / 0.46, 1e-6);
    });

    it("top-K share is computed against gross POSITIVE, so losers don't dilute it", () => {
        // One winner 100, two losers -20 each. Gross positive = 100, so
        // Top1 must read 100%, not 100/60. EffN = 1 (single winner).
        const c = summarizeProfitConcentration([
            resultRow("A", { netProfit: 100 }),
            resultRow("B", { netProfit: -20 }),
            resultRow("C", { netProfit: -20 }),
        ]);
        expect(c.top1Share).to.be.closeTo(1.0, 1e-9);
        expect(c.effectiveN).to.be.closeTo(1, 1e-9);
        expect(c.totalNet).to.equal(60);
    });

    it("returns effectiveN null when nothing is profitable", () => {
        const c = summarizeProfitConcentration([
            resultRow("A", { netProfit: -10 }),
            resultRow("B", { netProfit: -20 }),
        ]);
        expect(c.effectiveN).to.equal(null);
        expect(c.top1Share).to.equal(0);
    });
});

describe("summarizeRobustness", () => {
    it("counts Sharpe thresholds and THIN (<15 trades) over rows with a result", () => {
        const rows = [
            resultRow("A", { sharpeRatio: 1.5, totalTrades: 30 }), // >1, not thin
            resultRow("B", { sharpeRatio: 2.5, totalTrades: 20 }), // >2, not thin
            resultRow("C", { sharpeRatio: 0.2, totalTrades: 10 }), // thin
        ];
        const r = summarizeRobustness(rows);
        expect(r.total).to.equal(3);
        expect(r.sharpeGt1).to.equal(2);
        expect(r.sharpeGt2).to.equal(1);
        expect(r.thin).to.equal(1);
    });

    it("ignores rows without a result", () => {
        const r = summarizeRobustness([{ ...resultRow("A"), result: undefined }]);
        expect(r.total).to.equal(0);
        expect(r.sharpeGt1).to.equal(0);
    });
});

describe("summarizeOpenScoreConcentration", () => {
    it("effective N = 1/HHI on gross |score|; top-3 share of gross exposure", () => {
        // Scores: A 4, B 2, C 2 -> gross 8 -> shares 0.5/0.25/0.25
        // HHI = 0.25+0.0625+0.0625 = 0.375 -> EffN ~2.67
        // Top3 = (4+2+2)/8 = 100%
        const c = summarizeOpenScoreConcentration([
            { asset: "A", score: 4 },
            { asset: "B", score: 2 },
            { asset: "C", score: 2 },
        ]);
        expect(c.effectiveN).to.be.closeTo(1 / 0.375, 1e-6);
        expect(c.top3Share).to.be.closeTo(1.0, 1e-9);
        expect(c.top3Assets[0]).to.equal("A +4");
    });

    it("signs are preserved in top-3 labels and signed scores use the gross |score| for share", () => {
        // A +3, B -3 -> gross 6, equal concentration, EffN 2, top-3 share 100%.
        const c = summarizeOpenScoreConcentration([
            { asset: "A", score: 3 },
            { asset: "B", score: -3 },
        ]);
        expect(c.effectiveN).to.be.closeTo(2, 1e-6);
        expect(c.top3Share).to.be.closeTo(1.0, 1e-9);
        expect(c.top3Assets).to.include("A +3");
        expect(c.top3Assets).to.include("B -3");
    });

    it("returns effectiveN 0 when there is no gross exposure", () => {
        const c = summarizeOpenScoreConcentration([]);
        expect(c.effectiveN).to.equal(0);
        expect(c.top3Share).to.equal(0);
    });
});
