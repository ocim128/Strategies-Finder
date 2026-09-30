import { expect } from "chai";
import { describe, it } from "node:test";
import { runAssetSwitchReplay } from "../lib/batch-backtest/open-score-replay/asset-switch";
import type { AssetSwitchDecision, Candidate, EventView } from "../lib/batch-backtest/open-score-replay/internal-types";
import type { AssetSwitchReplaySummary, ReplayArmField, RunOpenScoreUsdReplayOptions } from "../lib/batch-backtest/open-score-replay/types";
import type { OHLCVData } from "../lib/types/strategies";
import { selectTopMeanReplayTargetWindow } from "../lib/batch-backtest/top-mean-target-window";

const HOUR = 3_600;
const ORIGIN = Math.floor(Date.parse("2024-01-01T00:00:00.000Z") / 1_000);
const ARM_FIELDS: ReplayArmField[] = [
    "topRawProfitNow", "topMeanProfitNow", "topRawProfitNowConf", "topZ",
    "topRaw", "topMean", "topMeanRawUnique", "topRawProfit", "topMeanProfit",
    "botRawProfitNow", "botMeanProfitNow", "botZ", "botRaw", "botMean", "botMeanRawUnique",
];

function candidate(assetIndex: number, raw: number, mean: number, z = raw): Candidate {
    return { assetIndex, raw, mean, z, activePairs: 1, adjusted: raw };
}

const A = candidate(0, 9, 3, 6);
const B = candidate(1, 6, 6, 2);
const C = candidate(2, 3, 1, 8);
const DEFAULT_POOL = [A, B, C];

function uniqueExtreme(
    pool: readonly Candidate[],
    key: "raw" | "mean" | "z",
    direction: "max" | "min",
): number | null {
    if (pool.length === 0) return null;
    const score = (row: Candidate): number => key === "z" ? row.z ?? Number.NEGATIVE_INFINITY : row[key];
    let best = score(pool[0]!);
    for (const row of pool.slice(1)) {
        const value = score(row);
        if (direction === "max" ? value > best : value < best) best = value;
    }
    const matches = pool.filter((row) => score(row) === best);
    return matches.length === 1 ? matches[0]!.assetIndex : null;
}

function meanRawUnique(pool: readonly Candidate[], direction: "max" | "min"): number | null {
    if (pool.length === 0) return null;
    const bestMean = pool.reduce((best, row) => direction === "max" ? Math.max(best, row.mean) : Math.min(best, row.mean),
        direction === "max" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY);
    return uniqueExtreme(pool.filter((row) => row.mean === bestMean), "raw", direction);
}

function switchPicks(pools: Pick<EventView, "positives" | "profitPositives" | "profitNowPositives" | "profitNowConfidencePositives">): AssetSwitchDecision["picks"] {
    return {
        topRawProfitNow: uniqueExtreme(pools.profitNowPositives, "raw", "max"),
        topMeanProfitNow: uniqueExtreme(pools.profitNowPositives, "mean", "max"),
        topRawProfitNowConf: uniqueExtreme(pools.profitNowConfidencePositives, "raw", "max"),
        topZ: uniqueExtreme(pools.profitNowPositives, "z", "max"),
        topRaw: uniqueExtreme(pools.positives, "raw", "max"),
        topMean: uniqueExtreme(pools.positives, "mean", "max"),
        topMeanRawUnique: meanRawUnique(pools.positives, "max"),
        topRawProfit: uniqueExtreme(pools.profitPositives, "raw", "max"),
        topMeanProfit: uniqueExtreme(pools.profitPositives, "mean", "max"),
        botRawProfitNow: uniqueExtreme(pools.profitNowPositives, "raw", "min"),
        botMeanProfitNow: uniqueExtreme(pools.profitNowPositives, "mean", "min"),
        botZ: uniqueExtreme(pools.profitNowPositives, "z", "min"),
        botRaw: uniqueExtreme(pools.positives, "raw", "min"),
        botMean: uniqueExtreme(pools.positives, "mean", "min"),
        botMeanRawUnique: meanRawUnique(pools.positives, "min"),
    };
}

function view(
    timeSec: number,
    pools: Partial<Pick<EventView, "positives" | "profitPositives" | "profitNowPositives" | "profitNowConfidencePositives">> = {},
): AssetSwitchDecision {
    const positives = pools.positives ?? DEFAULT_POOL;
    const profitPositives = pools.profitPositives ?? DEFAULT_POOL;
    const profitNowPositives = pools.profitNowPositives ?? DEFAULT_POOL;
    const profitNowConfidencePositives = pools.profitNowConfidencePositives ?? DEFAULT_POOL;
    return {
        timeSec,
        picks: switchPicks({ positives, profitPositives, profitNowPositives, profitNowConfidencePositives }),
    };
}

function candles(rows: Array<[number, number, number]>): OHLCVData[] {
    return rows.map(([time, open, close]) => ({ time, open, close, high: Math.max(open, close), low: Math.min(open, close), volume: 1 })) as unknown as OHLCVData[];
}

async function replay(args: {
    views: AssetSwitchDecision[];
    data: Record<string, OHLCVData[] | null>;
    endSec?: number;
    cutoffSec?: number;
    sampleFromSec?: number;
    interval?: string;
    slippageRate?: number;
    commissionRate?: number;
    horizons?: number[];
    shouldStop?: () => boolean;
    onLoad?: () => void;
    onAssetSwitchTrade?: RunOpenScoreUsdReplayOptions["onAssetSwitchTrade"];
    includeEventDetails?: boolean;
    assetNames?: string[];
}): Promise<{ ok: true; result: AssetSwitchReplaySummary } | { ok: false }> {
    const endSec = args.endSec ?? ORIGIN + 80 * HOUR;
    const options: RunOpenScoreUsdReplayOptions = {
        mode: "asset_switch",
        interval: args.interval ?? "1h",
        horizons: args.horizons,
        sampleFromSec: args.sampleFromSec ?? ORIGIN,
        sampleToSec: endSec,
        evaluationCutoffSec: args.cutoffSec ?? Math.max(ORIGIN + 100 * HOUR, endSec),
        includeEventDetails: args.includeEventDetails ?? true,
        onAssetSwitchTrade: args.onAssetSwitchTrade,
        loadTargetDataset: async (asset) => {
            args.onLoad?.();
            return args.data[asset] ?? null;
        },
    };
    const result = await runAssetSwitchReplay({
        views: args.views,
        assetNames: args.assetNames ?? ["A", "B", "C"],
        options,
        slippageRate: args.slippageRate ?? 0,
        commissionRate: args.commissionRate ?? 0,
        onPhase: () => undefined,
        shouldStop: args.shouldStop ?? (() => false),
        pairCount: 3,
        assetCount: 3,
    });
    return result.ok ? result : { ok: false };
}

function okResult(result: Awaited<ReturnType<typeof replay>>): AssetSwitchReplaySummary {
    if (!result.ok) throw new Error("Expected a completed asset-switch replay.");
    return result.result;
}

describe("OPEN_SCORE asset-switch replay", () => {
    it("emits all 15 independent long-only arm summaries, including singleton and profit-only picks", async () => {
        const singleton = candidate(0, 2, 2);
        const result = okResult(await replay({
            views: [view(ORIGIN, {
                positives: [singleton],
                profitPositives: [singleton],
                profitNowPositives: [singleton],
                profitNowConfidencePositives: [singleton],
            })],
            data: { A: candles([[ORIGIN + HOUR, 100, 110], [ORIGIN + 2 * HOUR, 110, 120]]) },
            endSec: ORIGIN + 2 * HOUR,
        }));
        expect(Object.keys(result.arms)).to.have.length(15);
        for (const arm of ARM_FIELDS) {
            expect(result.arms[arm].status, arm).to.equal("complete");
            expect(result.arms[arm].enteredCount, arm).to.equal(1);
            expect(result.arms[arm].completedTrades, arm).to.equal(0);
            expect(result.arms[arm].openPosition?.asset, arm).to.equal("A");
        }
        expect(result.trades).to.have.length(15);
    });

    it("uses fixed-notional accounting with slippage embedded once and commission on both sides", async () => {
        const result = okResult(await replay({
            views: [view(ORIGIN)],
            data: { A: candles([[ORIGIN + HOUR, 100, 110], [ORIGIN + 2 * HOUR, 120, 120]]) },
            endSec: ORIGIN + 2 * HOUR,
            slippageRate: 0.01,
            commissionRate: 0.001,
        }));
        const arm = result.arms.topRaw;
        const quantity = 1_000 / 101;
        const entryFee = quantity * 101 * 0.001;
        const expectedOpenPnl = quantity * (110 - 101) - entryFee;
        expect(arm.openPosition?.entryPrice).to.equal(101);
        expect(arm.openPosition?.markPrice).to.equal(110);
        expect(arm.openPositionNetPnl).to.be.closeTo(expectedOpenPnl, 1e-9);
        expect(arm.totalNetPnl).to.be.closeTo(expectedOpenPnl, 1e-9);
        expect(arm.totalCosts).to.be.closeTo(quantity + entryFee, 1e-9);
        expect(arm.status).to.equal("complete");
    });

    it("holds on ties and cancels pending orders on empty decision pools", async () => {
        const tie = [candidate(0, 5, 2), candidate(1, 5, 1)];
        const result = okResult(await replay({
            views: [view(ORIGIN, { positives: [A] }), view(ORIGIN + HOUR, { positives: tie }), view(ORIGIN + 2 * HOUR, {
                positives: [], profitPositives: [], profitNowPositives: [], profitNowConfidencePositives: [],
            })],
            data: { A: candles([[ORIGIN + 2 * HOUR, 100, 110], [ORIGIN + 3 * HOUR, 110, 120]]) },
            endSec: ORIGIN + 3 * HOUR,
        }));
        expect(result.arms.topRaw.status).to.equal("no_entry");
        expect(result.arms.topRaw.enteredCount).to.equal(0);
        expect(result.arms.topRaw.pendingOrder).to.equal(null);
        // TOP_MEAN is unique in the tie fixture, so that arm's pending order is not cancelled.
        expect(result.arms.topMean.enteredCount).to.equal(1);
    });

    it("does not postpone a repeated pending pick and lets a changed pick replace its destination", async () => {
        const repeated = okResult(await replay({
            views: [view(ORIGIN, { positives: [A] }), view(ORIGIN + HOUR, { positives: [A] })],
            data: { A: candles([[ORIGIN + 2 * HOUR, 100, 105], [ORIGIN + 3 * HOUR, 105, 110]]) },
            endSec: ORIGIN + 3 * HOUR,
        }));
        expect(repeated.trades?.find((trade) => trade.arm === "topRaw")?.entryTimeSec).to.equal(ORIGIN + 2 * HOUR);

        const superseded = okResult(await replay({
            views: [view(ORIGIN, { positives: [A] }), view(ORIGIN + HOUR, { positives: [B] })],
            data: {
                A: candles([[ORIGIN + 2 * HOUR, 100, 100]]),
                B: candles([[ORIGIN + 2 * HOUR, 50, 60], [ORIGIN + 3 * HOUR, 60, 70]]),
            },
            endSec: ORIGIN + 3 * HOUR,
        }));
        const topRaw = superseded.arms.topRaw;
        expect(topRaw.openPosition?.asset).to.equal("B");
        expect(topRaw.openPosition?.entryDecisionTimeSec).to.equal(ORIGIN + HOUR);
        expect(topRaw.openPosition?.entryTimeSec).to.equal(ORIGIN + 2 * HOUR);
    });

    it("cancels A-to-B-to-A before sale, and serializes asynchronous sale then replacement opens", async () => {
        const returnsToHeld = okResult(await replay({
            views: [view(ORIGIN, { positives: [A] }), view(ORIGIN + 2 * HOUR, { positives: [B] }), view(ORIGIN + 3 * HOUR, { positives: [A] })],
            data: {
                A: candles([[ORIGIN + HOUR, 100, 105], [ORIGIN + 4 * HOUR, 105, 110]]),
                B: candles([[ORIGIN + 3 * HOUR, 50, 55], [ORIGIN + 4 * HOUR, 55, 60]]),
            },
            endSec: ORIGIN + 5 * HOUR,
        }));
        expect(returnsToHeld.arms.topRaw.completedTrades).to.equal(0);
        expect(returnsToHeld.arms.topRaw.openPosition?.asset).to.equal("A");
        expect(returnsToHeld.arms.topRaw.pendingOrder).to.equal(null);

        const switched = okResult(await replay({
            views: [view(ORIGIN, { positives: [A] }), view(ORIGIN + 2 * HOUR, { positives: [B] })],
            data: {
                A: candles([[ORIGIN + HOUR, 100, 105], [ORIGIN + 3 * HOUR, 105, 106]]),
                B: candles([[ORIGIN + 3 * HOUR, 50, 55], [ORIGIN + 4 * HOUR, 55, 60]]),
            },
            endSec: ORIGIN + 4 * HOUR,
        }));
        const trade = switched.trades?.find((row) => row.arm === "topRaw" && row.status === "closed");
        expect(trade?.exitTimeSec).to.equal(ORIGIN + 3 * HOUR);
        expect(switched.arms.topRaw.openPosition?.asset).to.equal("B");
        expect(switched.arms.topRaw.openPosition?.entryTimeSec).to.equal(ORIGIN + 3 * HOUR);
    });

    it("preserves a scheduled sale when the destination changes, and buys the latest destination", async () => {
        const changedWhileHeld = okResult(await replay({
            views: [
                view(ORIGIN, { positives: [A] }),
                view(ORIGIN + 2 * HOUR, { positives: [B] }),
                view(ORIGIN + 2 * HOUR + 1_800, { positives: [C] }),
            ],
            data: {
                A: candles([[ORIGIN + HOUR, 100, 105], [ORIGIN + 3 * HOUR, 105, 106]]),
                B: candles([[ORIGIN + 3 * HOUR, 50, 55]]),
                C: candles([[ORIGIN + 3 * HOUR, 25, 30], [ORIGIN + 4 * HOUR, 30, 35]]),
            },
            endSec: ORIGIN + 4 * HOUR,
        }));
        const arm = changedWhileHeld.arms.topRaw;
        const closedA = changedWhileHeld.trades?.find((row) => row.arm === "topRaw" && row.status === "closed");
        expect(closedA?.asset).to.equal("A");
        expect(closedA?.exitTimeSec).to.equal(ORIGIN + 3 * HOUR);
        expect(arm.openPosition?.asset).to.equal("C");
        expect(arm.openPosition?.entryTimeSec).to.equal(ORIGIN + 3 * HOUR);
        expect(arm.openPosition?.entryDecisionTimeSec).to.equal(ORIGIN + 2 * HOUR + 1_800);
    });

    it("re-enters a prior asset at a fresh open after the sale has completed in cash", async () => {
        const remainsInCash = okResult(await replay({
            views: [view(ORIGIN, { positives: [A] }), view(ORIGIN + 2 * HOUR, { positives: [B] })],
            data: {
                A: candles([[ORIGIN + HOUR, 100, 105], [ORIGIN + 3 * HOUR, 105, 106]]),
                B: candles([[ORIGIN + 5 * HOUR, 50, 55]]),
            },
            endSec: ORIGIN + 4 * HOUR,
        }));
        expect(remainsInCash.arms.topRaw.completedTrades).to.equal(1);
        expect(remainsInCash.arms.topRaw.openPosition).to.equal(null);
        expect(remainsInCash.arms.topRaw.openPositionNetPnl).to.equal(0);
        expect(remainsInCash.arms.topRaw.totalNetPnl).to.equal(remainsInCash.arms.topRaw.realizedNetPnl);

        const result = okResult(await replay({
            views: [
                view(ORIGIN, { positives: [A] }),
                view(ORIGIN + 2 * HOUR, { positives: [B] }),
                view(ORIGIN + 3 * HOUR + 1_800, { positives: [A] }),
            ],
            data: {
                A: candles([
                    [ORIGIN + HOUR, 100, 105],
                    [ORIGIN + 3 * HOUR, 105, 106],
                    [ORIGIN + 4 * HOUR, 110, 115],
                ]),
                // The healthy B series has no executable open at the sale,
                // leaving the arm in cash until the next selection replaces it.
                B: candles([[ORIGIN + 5 * HOUR, 50, 55]]),
            },
            endSec: ORIGIN + 6 * HOUR,
        }));
        const arm = result.arms.topRaw;
        const rows = result.trades?.filter((row) => row.arm === "topRaw") ?? [];
        expect(arm.completedTrades).to.equal(1);
        expect(rows[0]?.asset).to.equal("A");
        expect(rows[0]?.exitTimeSec).to.equal(ORIGIN + 3 * HOUR);
        expect(arm.openPosition?.asset).to.equal("A");
        expect(arm.openPosition?.entryTimeSec).to.equal(ORIGIN + 4 * HOUR);
        expect(arm.openPosition?.entryDecisionTimeSec).to.equal(ORIGIN + 3 * HOUR + 1_800);
    });

    it("keeps an end-of-window buy pending and marks a held position only from a fully closed candle", async () => {
        const pending = okResult(await replay({
            views: [view(ORIGIN)],
            data: { A: candles([[ORIGIN - HOUR, 90, 95]]) },
            endSec: ORIGIN + HOUR,
        }));
        expect(pending.arms.topRaw.status).to.equal("no_entry");
        expect(pending.arms.topRaw.pendingOrder).to.deep.include({ side: "buy", destinationAsset: "A", scheduledTimeSec: null });

        const partialFinal = okResult(await replay({
            views: [view(ORIGIN + HOUR)],
            data: { A: candles([[ORIGIN + HOUR, 100, 105], [ORIGIN + 2 * HOUR, 105, 110]]) },
            endSec: ORIGIN + 2 * HOUR + HOUR / 2,
        }));
        // Entry occurs at the open inside the window; that candle is not fully closed by the end.
        expect(partialFinal.arms.topRaw.status).to.equal("incomplete");
        expect(partialFinal.arms.topRaw.openPosition?.asset).to.equal("A");
        expect(partialFinal.arms.topRaw.openPosition?.markTimeSec).to.equal(null);
        expect(partialFinal.arms.topRaw.totalNetPnl).to.equal(null);
    });

    it("clips fills and terminal marks to the earlier frozen cutoff", async () => {
        const cutoff = ORIGIN + HOUR + HOUR / 2;
        const result = okResult(await replay({
            views: [view(ORIGIN, { positives: [A] })],
            data: { A: candles([
                [ORIGIN + HOUR, 100, 105],
                [ORIGIN + 2 * HOUR, 105, 110],
            ]) },
            endSec: ORIGIN + 5 * HOUR,
            cutoffSec: cutoff,
        }));
        const arm = result.arms.topRaw;
        expect(result.windowEndSec).to.equal(cutoff);
        expect(arm.enteredCount).to.equal(1, "the open occurs inside the frozen window");
        expect(arm.openPosition?.entryTimeSec).to.equal(ORIGIN + HOUR);
        expect(arm.openPosition?.markTimeSec).to.equal(null, "the cutoff excludes the candle close");
        expect(arm.status).to.equal("incomplete");
        expect(arm.totalNetPnl).to.equal(null);
    });

    it("fills a scheduled sale at the cutoff from the current candle open", async () => {
        const cutoff = ORIGIN + 2 * HOUR + HOUR / 2;
        const aWindow = selectTopMeanReplayTargetWindow(candles([
            [ORIGIN + HOUR, 100, 120],
            [ORIGIN + 2 * HOUR, 120, 125],
        ]), "1h", cutoff);
        const bWindow = selectTopMeanReplayTargetWindow(candles([
            [ORIGIN + HOUR, 50, 55],
            [ORIGIN + 3 * HOUR, 55, 60],
        ]), "1h", cutoff);
        expect(aWindow.executionCandles).to.have.length(2);
        expect(aWindow.closedCandleTimeSec).to.equal(ORIGIN + HOUR);
        expect(bWindow.executionCandles).to.have.length(1, "future opens stay outside the frozen cutoff");

        const result = okResult(await replay({
            views: [view(ORIGIN, { positives: [A] }), view(ORIGIN + HOUR, { positives: [B] })],
            data: { A: aWindow.executionCandles, B: bWindow.executionCandles },
            endSec: cutoff,
            cutoffSec: cutoff,
        }));
        const arm = result.arms.topRaw;
        expect(arm.completedTrades).to.equal(1);
        expect(arm.realizedNetPnl).to.equal(200);
        expect(arm.pendingOrder?.side).to.equal("buy");
        expect(arm.status).to.equal("complete");
    });

    it("marks a pending replacement incomplete when its wait crosses a long data gap", async () => {
        const end = ORIGIN + 50 * 86_400;
        const result = okResult(await replay({
            views: [view(ORIGIN, { positives: [A] }), view(ORIGIN + HOUR, { positives: [B] })],
            data: {
                A: candles([[ORIGIN + HOUR, 100, 100], [ORIGIN + 2 * HOUR, 110, 110]]),
                B: candles([[ORIGIN, 50, 50], [ORIGIN + 100 * 86_400, 55, 55]]),
            },
            endSec: end,
        }));
        const arm = result.arms.topRaw;
        expect(arm.pendingOrder?.side).to.equal("buy");
        expect(arm.status).to.equal("incomplete");
        expect(arm.diagnosticCounts.dataGap).to.be.greaterThan(0);
        expect(arm.totalNetPnl).to.equal(null);
    });

    it("marks missing, corrupt, invalid-price, and in-exposure-gap arms unavailable while preserving valid arms", async () => {
        const missing = okResult(await replay({
            views: [view(ORIGIN, { positives: [A] })],
            data: { A: null },
        }));
        expect(missing.arms.topRaw.status).to.equal("incomplete");
        expect(missing.arms.topRaw.diagnosticCounts.missingTarget).to.be.greaterThan(0);

        const corrupt = okResult(await replay({
            views: [view(ORIGIN, { positives: [A] })],
            data: { A: candles([[ORIGIN + HOUR, 100, 100], [ORIGIN + HOUR, 101, 101]]) },
        }));
        expect(corrupt.arms.topRaw.status).to.equal("incomplete");
        expect(corrupt.arms.topRaw.diagnosticCounts.invalidTimestamp).to.be.greaterThan(0);

        const nonmonotonic = okResult(await replay({
            views: [view(ORIGIN, { positives: [A] })],
            data: { A: candles([[ORIGIN + 2 * HOUR, 100, 100], [ORIGIN + HOUR, 101, 101]]) },
        }));
        expect(nonmonotonic.arms.topRaw.status).to.equal("incomplete");
        expect(nonmonotonic.arms.topRaw.diagnosticCounts.invalidTimestamp).to.be.greaterThan(0);

        const badPrice = okResult(await replay({
            views: [view(ORIGIN, { positives: [A] })],
            data: { A: candles([[ORIGIN + HOUR, 0, 0], [ORIGIN + 2 * HOUR, 10, 10]]) },
        }));
        expect(badPrice.arms.topRaw.status).to.equal("incomplete");
        expect(badPrice.arms.topRaw.diagnosticCounts.invalidPrice).to.be.greaterThan(0);

        const outsideGap = ORIGIN + 31 * 86_400;
        const gapOutsideExposure = okResult(await replay({
            views: [view(outsideGap, { positives: [A] })],
            data: { A: candles([[ORIGIN, 90, 90], [outsideGap, 100, 105], [outsideGap + HOUR, 105, 110]]) },
            endSec: outsideGap + 2 * HOUR,
        }));
        expect(gapOutsideExposure.arms.topRaw.status).to.equal("complete");

        const gapInsideExposure = okResult(await replay({
            views: [view(ORIGIN, { positives: [A] })],
            data: { A: candles([[ORIGIN + HOUR, 100, 105], [ORIGIN + 31 * 86_400, 105, 110]]) },
            endSec: ORIGIN + 31 * 86_400 + HOUR,
        }));
        expect(gapInsideExposure.arms.topRaw.status).to.equal("incomplete");
        expect(gapInsideExposure.arms.topRaw.diagnosticCounts.dataGap).to.be.greaterThan(0);
    });

    it("stops sale and replacement execution at sell-side and buy-side gap failures", async () => {
        const fortyDays = 40 * 86_400;
        const onlyA = {
            positives: [A], profitPositives: [A],
            profitNowPositives: [A], profitNowConfidencePositives: [A],
        };
        const onlyB = {
            positives: [B], profitPositives: [B],
            profitNowPositives: [B], profitNowConfidencePositives: [B],
        };
        const sellGapArchive: Array<{ arm: ReplayArmField; asset: string; status: string }> = [];
        const sellGap = okResult(await replay({
            views: [view(ORIGIN, onlyA), view(ORIGIN + 39 * 86_400, onlyB)],
            data: {
                A: candles([[ORIGIN + HOUR, 100, 100], [ORIGIN + fortyDays, 110, 111]]),
                B: candles([[ORIGIN + fortyDays, 50, 51], [ORIGIN + fortyDays + HOUR, 51, 52]]),
            },
            endSec: ORIGIN + fortyDays + HOUR,
            onAssetSwitchTrade: (row) => { sellGapArchive.push({ arm: row.arm, asset: row.asset, status: row.status }); },
        }));
        expect(sellGap.arms.topRaw.status).to.equal("incomplete");
        expect(sellGap.arms.topRaw.diagnosticCounts.dataGap).to.be.greaterThan(0);
        expect(sellGap.arms.topRaw.completedTrades).to.equal(0);
        expect(sellGap.arms.topRaw.enteredCount).to.equal(1);
        expect(sellGap.arms.topRaw.partialRealizedNetPnl).to.equal(0);
        expect(sellGap.arms.topRaw.openPosition?.asset).to.equal("A");
        const topRawSellGapTrades = sellGap.trades?.filter((row) => row.arm === "topRaw") ?? [];
        expect(topRawSellGapTrades).to.have.length(1);
        expect(topRawSellGapTrades[0]).to.deep.include({ asset: "A", status: "open", exitTimeSec: null });
        expect(sellGap.trades?.some((row) => row.arm === "topRaw" && row.asset === "B")).to.equal(false);
        expect(sellGapArchive.filter((row) => row.arm === "topRaw")).to.deep.equal([
            { arm: "topRaw", asset: "A", status: "open" },
        ]);

        const buyGapArchive: Array<{ arm: ReplayArmField; asset: string; status: string }> = [];
        const buyGap = okResult(await replay({
            views: [view(ORIGIN, onlyA), view(ORIGIN + HOUR, onlyB)],
            data: {
                A: candles([[ORIGIN + HOUR, 100, 100], [ORIGIN + 2 * HOUR, 101, 102]]),
                B: candles([[ORIGIN + HOUR, 50, 50], [ORIGIN + fortyDays, 60, 61]]),
            },
            endSec: ORIGIN + fortyDays + HOUR,
            onAssetSwitchTrade: (row) => { buyGapArchive.push({ arm: row.arm, asset: row.asset, status: row.status }); },
        }));
        expect(buyGap.arms.topRaw.status).to.equal("incomplete");
        expect(buyGap.arms.topRaw.diagnosticCounts.dataGap).to.be.greaterThan(0);
        expect(buyGap.arms.topRaw.completedTrades).to.equal(1, "the sale before the replacement gap is valid history");
        expect(buyGap.arms.topRaw.enteredCount).to.equal(1);
        expect(buyGap.arms.topRaw.openPosition).to.equal(null);
        expect(buyGap.trades?.filter((row) => row.arm === "topRaw")).to.have.length(1);
        expect(buyGap.trades?.some((row) => row.arm === "topRaw" && row.asset === "B")).to.equal(false);
        expect(buyGapArchive.filter((row) => row.arm === "topRaw")).to.deep.equal([
            { arm: "topRaw", asset: "A", status: "closed" },
        ]);
    });

    it("normalizes seconds, milliseconds, ISO strings, and BusinessDay timestamps", async () => {
        const day = Math.floor(Date.parse("2024-02-01T00:00:00.000Z") / 1_000);
        const data = [
            { time: day, open: 100, close: 101, high: 101, low: 100, volume: 1 },
            { time: (day + 86_400) * 1_000, open: 101, close: 102, high: 102, low: 101, volume: 1 },
            { time: "2024-02-03T00:00:00.000Z", open: 102, close: 103, high: 103, low: 102, volume: 1 },
            { time: { year: 2024, month: 2, day: 4 }, open: 103, close: 104, high: 104, low: 103, volume: 1 },
        ] as unknown as OHLCVData[];
        const result = okResult(await replay({
            views: [view(day + 12 * HOUR, { positives: [A] })],
            data: { A: data },
            interval: "1d",
            endSec: day + 4 * 86_400,
        }));
        expect(result.arms.topRaw.status).to.equal("complete");
        expect(result.arms.topRaw.openPosition?.entryTimeSec).to.equal(day + 86_400);
        expect(result.arms.topRaw.openPosition?.markTimeSec).to.equal(day + 4 * 86_400);
    });

    it("keeps causal-prefix fills unchanged when future candles or decisions are appended and ignores horizons", async () => {
        const baseViews = [view(ORIGIN, { positives: [A], profitPositives: [], profitNowPositives: [A] })];
        const baseData = { A: candles(Array.from({ length: 8 }, (_, i) => [
            ORIGIN + (i + 1) * HOUR,
            100 + i * 5,
            105 + i * 5,
        ] as [number, number, number])) };
        const baseline = okResult(await replay({ views: baseViews, data: baseData, horizons: [1, 2], endSec: ORIGIN + 9 * HOUR }));
        const noHorizonEffect = okResult(await replay({ views: baseViews, data: baseData, horizons: [500, 1_000], endSec: ORIGIN + 9 * HOUR }));
        expect(noHorizonEffect.arms).to.deep.equal(baseline.arms);
        expect(baseline.arms.topRawProfitNow.openPosition?.holdingDurationSec).to.be.greaterThan(2 * HOUR);
        const extended = okResult(await replay({
            views: [...baseViews, view(ORIGIN + 2 * HOUR, { positives: [B], profitPositives: [], profitNowPositives: [B] })],
            data: { A: [...baseData.A!, ...candles([[ORIGIN + 9 * HOUR, 140, 145]])], B: candles([[ORIGIN + 3 * HOUR, 50, 60]]) },
            horizons: [500, 1_000],
            endSec: ORIGIN + 9 * HOUR,
        }));
        const earlierBaselineTrade = baseline.trades?.find((trade) => trade.arm === "topRawProfitNow");
        const earlierExtendedTrade = extended.trades?.find((trade) => trade.arm === "topRawProfitNow");
        expect(earlierExtendedTrade?.asset).to.equal("A");
        expect(earlierExtendedTrade?.entryTimeSec).to.equal(earlierBaselineTrade?.entryTimeSec);
        expect(earlierExtendedTrade?.entryPrice).to.equal(earlierBaselineTrade?.entryPrice);
    });

    it("streams every trade while keeping bounded previews for every arm beyond 1,000 rows", async () => {
        const decisionCount = 1_105;
        const views = Array.from({ length: decisionCount }, (_, index) => {
            const selected = candidate(index % 2, 1, 1);
            return view(ORIGIN + index * HOUR, {
                positives: [selected],
                profitPositives: [selected],
                profitNowPositives: [selected],
                profitNowConfidencePositives: [selected],
            });
        });
        const rows = Array.from({ length: decisionCount + 2 }, (_, index) => [
            ORIGIN + (index + 1) * HOUR,
            100,
            101,
        ] as [number, number, number]);
        const streamedByArm = new Map<ReplayArmField, number>(ARM_FIELDS.map((arm) => [arm, 0]));
        const result = okResult(await replay({
            views,
            data: { A: candles(rows), B: candles(rows) },
            endSec: ORIGIN + (decisionCount + 1) * HOUR,
            onAssetSwitchTrade: (row) => { streamedByArm.set(row.arm, streamedByArm.get(row.arm)! + 1); },
        }));

        const streamedTradeCount = result.tradeCount ?? 0;
        expect(streamedTradeCount).to.be.greaterThan(1_000);
        expect([...streamedByArm.values()].reduce((sum, count) => sum + count, 0)).to.equal(streamedTradeCount);
        expect(result.trades).to.have.length(ARM_FIELDS.length * 1_000);
        for (const arm of ARM_FIELDS) {
            expect(streamedByArm.get(arm), `${arm} full records stream`).to.be.greaterThan(1_000);
            expect(result.trades?.filter((row) => row.arm === arm), `${arm} preview uses its own bound`).to.have.length(1_000);
        }
        expect(result.trades?.some((row) => row.arm === "topMean"), "TOP_MEAN details remain available").to.equal(true);
    });

    it("keeps the 15-arm switch working set cached while replaying 30 assets", async () => {
        const assetNames = Array.from({ length: 30 }, (_, index) => `ASSET${index}`);
        const decisionCount = 60;
        const views: AssetSwitchDecision[] = Array.from({ length: decisionCount }, (_, eventIndex) => ({
            timeSec: ORIGIN + eventIndex * HOUR,
            picks: Object.fromEntries(ARM_FIELDS.map((arm, armIndex) => [
                arm,
                (eventIndex + armIndex) % assetNames.length,
            ])) as Record<ReplayArmField, number | null>,
        }));
        const candleRows = Array.from({ length: decisionCount + 2 }, (_, index) => [
            ORIGIN + (index + 1) * HOUR,
            100,
            101,
        ] as [number, number, number]);
        let loads = 0;
        const result = okResult(await replay({
            views,
            data: Object.fromEntries(assetNames.map((asset) => [asset, candles(candleRows)])),
            assetNames,
            endSec: ORIGIN + (decisionCount + 1) * HOUR,
            onLoad: () => { loads += 1; },
        }));
        expect(result.decisionCount).to.equal(decisionCount);
        expect(loads, "the bounded cache retains the active and replacement assets").to.be.at.most(assetNames.length);
    });

    it("returns interrupted output when Stop arrives during target loading", async () => {
        let stopped = false;
        const result = await replay({
            views: [view(ORIGIN)],
            data: { A: candles([[ORIGIN + HOUR, 100, 105]]) },
            onLoad: () => { stopped = true; },
            shouldStop: () => stopped,
        });
        expect(result.ok).to.equal(false);
    });
});
