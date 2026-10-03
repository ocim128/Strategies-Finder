import { expect } from "chai";
import { describe, it } from "node:test";
import {
    blockBootstrapMedianCi,
    computeProfitNowConfidenceWeight,
    runOpenScoreUsdReplay,
    type OpenScoreUsdTarget,
    type PoolSnapshotRecord,
} from "../lib/batch-backtest/batch-open-score-usd-replay-engine";
import { MAX_ACTIVE_BLOCK_COUNT, MAX_ACTIVE_BOOTSTRAP_SEED } from "../lib/batch-backtest/max-active-research-contract";
import { selectClosedCandleWindow, selectExecutionAwareClosedCandles } from "../lib/alert-evaluation-window";
import type { BatchSyntheticPairArtifact } from "../lib/batch-backtest/batch-synthetic-artifact";
import type { BacktestResult, OHLCVData, Time, Trade } from "../lib/types/strategies";

const T0 = 1_700_000_000;

describe("block bootstrap median", () => {
    it("preserves the exact sorted-block median while using the formal block count", () => {
        const blocks = Array.from({ length: MAX_ACTIVE_BLOCK_COUNT }, (_, blockIndex) => [
            blockIndex - 5,
            blockIndex * 0.25,
            20 - blockIndex,
        ]);
        const result = blockBootstrapMedianCi(blocks, 32);

        expect(result).to.deep.equal({ lower: 0.75, upper: 2.25 });
    });
});


describe("block bootstrap median parity (weighted-rank vs pooled-sort reference)", () => {
    // Reference twin of the FORMER implementation: identical LCG seed and draw
    // order, then pool the drawn blocks and fully sort. The old k-way heap
    // merge emitted exactly this sorted pooled order up to the middle, so the
    // medians must match the weighted-rank implementation draw-for-draw.
    function referenceMedianCi(blocks: readonly (readonly number[])[], resamples: number): { lower: number | null; upper: number | null } {
        const finiteOrNull = (value: number): number | null => (Number.isFinite(value) ? value : null);
        const b = blocks.length;
        if (b < MAX_ACTIVE_BLOCK_COUNT) return { lower: null, upper: null };
        const sortedBlocks = blocks.map((blk) => [...blk].sort((x, y) => x - y));
        let seed = (Math.floor(MAX_ACTIVE_BOOTSTRAP_SEED) >>> 0) || 0x9e3779b9;
        const next = (): number => {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            return seed / 0x100000000;
        };
        const medians: number[] = [];
        for (let r = 0; r < resamples; r += 1) {
            const drawnAt: number[] = new Array<number>(b).fill(0);
            let total = 0;
            for (let k = 0; k < b; k += 1) {
                const blockIndex = Math.floor(next() * b);
                drawnAt[k] = blockIndex;
                total += sortedBlocks[blockIndex]!.length;
            }
            // The former merge emitted equal values in ascending POSITION
            // order (heap tie-break), so the pooled sequence must concatenate
            // drawn blocks by position; its stable sort then preserves that
            // order within equal-value runs.
            const pooled: number[] = [];
            for (let k = 0; k < b; k += 1) pooled.push(...sortedBlocks[drawnAt[k]!]!);
            if (total === 0) {
                medians.push(0);
                continue;
            }
            pooled.sort((x, y) => x - y);
            const midLo = (total - 1) >> 1;
            const midHi = total >> 1;
            medians.push(midLo === midHi ? pooled[midLo]! : (pooled[midLo]! + pooled[midHi]!) / 2);
        }
        medians.sort((x, y) => x - y);
        const lo = medians[Math.max(0, Math.floor(0.025 * resamples))]!;
        const hi = medians[Math.min(resamples - 1, Math.floor(0.975 * resamples))]!;
        return { lower: finiteOrNull(lo), upper: finiteOrNull(hi) };
    }

    const expectParity = (blocks: readonly (readonly number[])[], resamples: number): void => {
        expect(blockBootstrapMedianCi(blocks, resamples)).to.deep.equal(referenceMedianCi(blocks, resamples));
    };
    // The formal CI requires exactly MAX_ACTIVE_BLOCK_COUNT blocks; pad the
    // hand-written fixtures up to it so both sides compute real values instead
    // of returning the same null CI from the insufficient-blocks guard.
    const pad = (blocks: readonly (readonly number[])[]): readonly (readonly number[])[] => [
        ...blocks,
        ...Array.from({ length: MAX_ACTIVE_BLOCK_COUNT - blocks.length }, (_, i) => [10 + i, -(i + 1)] as const),
    ];

    it("matches the pooled-sort reference with duplicate values across blocks", () => {
        expectParity(pad([
            [3, 1, 3, 2],
            [2, 3, 1],
            [3, 3, 3],
            [1, 2],
        ]), 400);
    });

    it("matches the reference for even and odd pooled sizes with negatives", () => {
        expectParity(pad([
            [-5, -1, -1, 0],
            [-2, 7],
            [4, -3, -3, 9, 9],
            [0],
        ]), 400);
        expectParity(pad([
            [1, 2, 3],
            [2],
            [0, -1, 5, 5],
            [4, 4, 4],
        ]), 400);
    });

    it("matches the reference when some sampled blocks are empty", () => {
        expectParity(pad([
            [],
            [6, 2],
            [2, 2, 1],
            [7, 3, 3, 3, 0],
        ]), 400);
    });

    it("matches the reference on randomized blocks", () => {
        let seed = 987654321;
        const rand = (): number => {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            return seed / 0x100000000;
        };
        for (let trial = 0; trial < 12; trial += 1) {
            const blocks = Array.from({ length: MAX_ACTIVE_BLOCK_COUNT }, () =>
                Array.from({ length: 1 + Math.floor(rand() * 8) }, () =>
                    Math.round((rand() - 0.5) * 10 * 2) / 2));
            expectParity(blocks, 200);
        }
    });
});

function emptyResult(): BacktestResult {
    return {
        trades: [], netProfit: 0, netProfitPercent: 0, winRate: 0, expectancy: 0,
        avgTrade: 0, profitFactor: 0, maxDrawdown: 0, maxDrawdownPercent: 0,
        totalTrades: 0, winningTrades: 0, losingTrades: 0, avgWin: 0, avgLoss: 0,
        sharpeRatio: 0, equityCurve: [],
    };
}

let tradeId = 0;
function makeTrade(type: "long" | "short", entrySec: number, exitSec: number | null, pnl = 0): Trade {
    return {
        id: tradeId += 1,
        type,
        entryTime: entrySec as Time,
        entryPrice: 1,
        exitTime: (exitSec ?? entrySec) as Time,
        exitPrice: 1,
        pnl,
        pnlPercent: 0,
        size: 1,
        exitReason: exitSec === null ? "end_of_data" : "signal",
    };
}

/** Pair artifact whose data/signals are unused by the replay engine (only trades matter). */
function makePair(base: string, quote: string, trades: Trade[], netProfit = 0): BatchSyntheticPairArtifact {
    return {
        symbol: `${base}+${quote}`,
        baseAsset: base,
        quoteAsset: quote,
        data: [],
        signals: [],
        result: { ...emptyResult(), totalTrades: trades.length, trades, netProfit },
    };
}

function makeDirectMarket(asset: string, trades: Trade[]): BatchSyntheticPairArtifact {
    return {
        symbol: `${asset}USDT`,
        baseAsset: asset,
        quoteAsset: "",
        data: [],
        signals: [],
        result: { ...emptyResult(), totalTrades: trades.length, trades },
    };
}



/** Target OHLCV: bars at T0, T0+1000, T0+2000, ... with constant price. */
function makeTarget(asset: string, bars: number, priceAt: (i: number) => number): OpenScoreUsdTarget {
    const data: OHLCVData[] = Array.from({ length: bars }, (_, i) => {
        const p = priceAt(i);
        return { time: (T0 + i * 1000) as Time, open: p, high: p, low: p, close: p, volume: 1 };
    });
    return { asset, symbol: `${asset}USDT`, data };
}

async function* fromArray<T>(items: T[]): AsyncIterable<T> {
    for (const item of items) yield item;
}

describe("ranking consistency alongside replay", () => {
    const assets = ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF"];
    function fixture(switchAt = 7) {
        const pairs = assets.map((asset, index) => makeDirectMarket(asset, [
            makeTrade("long", T0 + 1, T0 + 2, 1),
            ...Array.from({ length: 6 - index }, () => makeTrade("long", T0 + 1000, T0 + (switchAt + 1) * 1000, 1)),
            ...Array.from({ length: index + 1 }, () => makeTrade("long", T0 + (switchAt + 1) * 1000, null)),
        ]));
        const targets = assets.map((asset, index) => makeTarget(asset, 100, (bar) => 100 + (6 - index) * bar));
        return { pairs, targets };
    }
    for (const mode of ["horizon", "asset_switch"] as const) {
        it("preserves original " + mode + " return fields and uses 20-bar measurement regardless of switches", async () => {
            for (const switchAt of [7, 50]) {
                const { pairs, targets } = fixture(switchAt);
                const options = { mode, interval: "1m", horizons: [20], sampleToSec: T0 + 90_000, evaluationCutoffSec: T0 + 100_000,
                    loadTargetDataset: async (asset: string) => targets.find((target) => target.asset === asset)?.data ?? null };
                const off = await runOpenScoreUsdReplay(() => fromArray(pairs), undefined, options);
                const on = await runOpenScoreUsdReplay(() => fromArray(pairs), undefined, { ...options, rankingHorizon: 20 });
                const { rankingMeasurement, ...original } = on;
                expect({ ...original, reportLines: [] }).to.deep.equal({ ...off, reportLines: [] });
                expect(rankingMeasurement?.horizonBars).to.equal(20);
                expect(rankingMeasurement?.arms.topRaw.meanAccuracy).not.to.equal(null);
                expect(rankingMeasurement?.arms.topRaw.eligibleEvents).to.equal(3);
                expect(rankingMeasurement?.arms.topRaw.scoredEvents).to.equal(3);
            }
        });
    }
    it("measurement-only missing targets preserve switch trading status and P&L", async () => {
        const { pairs, targets } = fixture();
        const options = { mode: "asset_switch" as const, interval: "1m", sampleToSec: T0 + 90_000, evaluationCutoffSec: T0 + 100_000,
            loadTargetDataset: async (asset: string) => asset === "CCC" ? null : targets.find((target) => target.asset === asset)?.data ?? null };
        const off = await runOpenScoreUsdReplay(() => fromArray(pairs), undefined, options);
        const on = await runOpenScoreUsdReplay(() => fromArray(pairs), undefined, { ...options, rankingHorizon: 20 });
        expect(on.assetSwitch).to.deep.equal(off.assetSwitch);
        expect(on.complete).to.equal(off.complete);
        expect(on.rankingMeasurement?.arms.topRaw.skippedReasons.missing_target).to.be.greaterThan(0);
    });
    it("censors switch ranking at the frozen completed-candle cutoff while preserving current-open fills", async () => {
        const { pairs, targets } = fixture();
        const on = await runOpenScoreUsdReplay(() => fromArray(pairs), undefined, { mode: "asset_switch", interval: "1m", rankingHorizon: 20,
            sampleToSec: T0 + 8_000, evaluationCutoffSec: T0 + 8_000,
            loadTargetDataset: async (asset) => targets.find((target) => target.asset === asset)?.data ?? null });
        expect(on.rankingMeasurement?.arms.topRaw.scoredEvents).to.equal(0);
        expect(on.rankingMeasurement?.arms.topRaw.skippedReasons.right_censored).to.be.greaterThan(0);
        expect(on.assetSwitch?.arms.topRaw.enteredCount).to.be.greaterThan(0);
    });
    it("shares horizon target requests and reports calendar misalignment without replacing frozen members", async () => {
        const { pairs, targets } = fixture();
        let loads = 0;
        const on = await runOpenScoreUsdReplay(() => fromArray(pairs), undefined, { horizons: [20], rankingHorizon: 20,
            loadTargetDataset: async (asset) => {
                loads += 1;
                const data = targets.find((target) => target.asset === asset)?.data ?? null;
                return asset === "CCC" ? data!.map((bar) => ({ ...bar, time: (Number(bar.time) + 100) as Time })) : data;
            } });
        expect(loads).to.equal(6);
        expect(on.rankingMeasurement?.arms.topRaw.skippedReasons.calendar_mismatch).to.be.greaterThan(0);
        expect(on.rankingMeasurement?.arms.topRaw.meanAccuracy).to.equal(null);
    });
    it("does not promote cancelled switch measurements", async () => {
        const { pairs, targets } = fixture();
        let cancel = false;
        const result = await runOpenScoreUsdReplay(() => fromArray(pairs), undefined, { mode: "asset_switch", interval: "1m", rankingHorizon: 20,
            sampleToSec: T0 + 90_000, evaluationCutoffSec: T0 + 100_000, shouldStop: () => cancel,
            onPhase(phase) { if (phase === "outcomes") cancel = true; },
            loadTargetDataset: async (asset) => targets.find((target) => target.asset === asset)?.data ?? null });
        expect(result.complete).to.equal(false);
        expect(result.rankingMeasurement?.arms.topRaw.scoredEvents).to.equal(0);
    });
    it("measures normalized cost-adjusted returns across all supported time shapes", async () => {
        const start = Date.parse("2024-01-01T00:00:00Z") / 1000;
        const shape = (sec: number, format: string): Time => {
            if (format === "milliseconds") return (sec * 1000) as Time;
            if (format === "iso") return new Date(sec * 1000).toISOString() as Time;
            if (format === "business_day") { const date = new Date(sec * 1000); return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() } as Time; }
            return sec as Time;
        };
        let reference: unknown;
        for (const format of ["seconds", "milliseconds", "iso", "business_day"]) {
            const pairs = assets.map((asset, index) => makeDirectMarket(asset, Array.from({ length: 6 - index }, () => ({
                ...makeTrade("long", start, start + 86400, 1), entryTime: shape(start, format), exitTime: shape(start + 86400, format),
            }))));
            const targets = assets.map((asset, index) => ({ asset, symbol: asset, data: Array.from({ length: 10 }, (_, bar) => {
                const price = 100 + (6 - index) * bar;
                return { time: shape(start + bar * 86400, format), open: price, close: price, high: price, low: price, volume: 1 };
            }) }));
            const result = await runOpenScoreUsdReplay(() => fromArray(pairs), () => fromArray(targets), { horizons: [3], rankingHorizon: 3, commissionRate: 0.001, slippageRate: 0.002 });
            if (reference === undefined) reference = result.rankingMeasurement;
            expect(result.rankingMeasurement).to.deep.equal(reference);
            expect(result.rankingMeasurement?.arms.topRaw.meanAccuracy).to.equal(1);
        }
    });
    it("counts a forward data gap beyond the decision-window end as a ranking omission", async () => {
        const { pairs, targets } = fixture();
        targets[2]!.data = targets[2]!.data.map((bar, index) => index < 10 ? bar : { ...bar, time: (Number(bar.time) + 31 * 86400) as Time });
        const result = await runOpenScoreUsdReplay(() => fromArray(pairs), () => fromArray(targets), { horizons: [20], rankingHorizon: 20, sampleToSec: T0 + 2_000 });
        expect(result.rankingMeasurement?.arms.topRaw.skippedReasons.data_gap).to.be.greaterThan(0);
        expect(result.rankingMeasurement?.arms.topRaw.scoredEvents).to.equal(0);
    });
});

describe("batch-open-score-usd-replay-engine", () => {
    it("shrinks causal profit confidence for sparse or inconsistent realized pnl", () => {
        expect(computeProfitNowConfidenceWeight(1, 10, 10)).to.equal(0.5);
        expect(computeProfitNowConfidenceWeight(4, 40, 40)).to.equal(0.8);
        expect(computeProfitNowConfidenceWeight(2, 50, 150)).to.be.closeTo((2 / 3) * (1 / 3), 1e-12);
        expect(computeProfitNowConfidenceWeight(0, 10, 10)).to.equal(0);
        expect(computeProfitNowConfidenceWeight(2, -10, 10)).to.equal(0);
    });

    it("TOP_RAW_PROFIT_NOW_CONF selects the stronger causal winner", async () => {
        const decision = T0 + 1000;
        const markets = [
            makeDirectMarket("AAA", [
                makeTrade("long", T0 + 100, T0 + 200, 10),
                makeTrade("long", decision, null),
            ]),
            makeDirectMarket("BBB", [
                makeTrade("long", T0 + 100, T0 + 200, 10),
                makeTrade("long", T0 + 300, T0 + 400, 10),
                makeTrade("long", T0 + 500, T0 + 600, 10),
                makeTrade("long", T0 + 700, T0 + 800, 10),
                makeTrade("long", decision, null),
            ]),
        ];
        const targets = [
            makeTarget("AAA", 10, () => 100),
            makeTarget("BBB", 10, () => 100),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(markets),
            () => fromArray(targets),
            {
                horizons: [2],
                slippageRate: 0,
                commissionRate: 0,
                blockCount: 1,
                includeEventDetails: true,
            },
        );

        const horizon = result.horizons[0]!;
        expect(horizon.topRawProfitNowConf.events).to.equal(1);
        expect(horizon.topRawProfitNowConfByAsset).to.have.length(1);
        expect(horizon.topRawProfitNowConfByAsset[0]!.asset).to.equal("BBB");
        expect(horizon.topRawProfitNowConfByAsset[0]!.events).to.equal(1);
        const detail = result.eventDetails?.find(
            (row) => row.selector === "TOP_RAW_PROFIT_NOW_CONF" && row.decisionTime === decision,
        );
        expect(detail?.asset).to.equal("BBB");
        expect(detail?.eligibleCandidates).to.equal(2);
        expect(result.latestSelections?.selections.find(
            (selection) => selection.selector === "TOP_RAW_PROFIT_NOW_CONF",
        )?.asset).to.equal("BBB");
        const report = result.reportLines.join("\n");
        expect(report).to.include("TOP_RAW_PROFIT_NOW_CONF selected assets = BBB:n=1");
        expect(report).to.include("RAW_PROFIT_NOW_CONF_EX_");
    });

    it("TOP_Z ranks by per-asset score surprise, not the absolute vote count", async () => {
        // Event 1 (T0+1000): AAA and BBB each have one profit-now vote (z is
        // each asset's first sighting, so z = raw). BBB exits before event 2.
        // Event 2 (T0+5000): CCC enters with one vote while AAA still has one.
        // AAA's own history is [1] -> z = (1-1)/max(0,1) = 0 (no surprise);
        // CCC's history is [0] -> z = (1-0)/1 = 1. Same raw scores, but TOP_Z
        // must pick CCC while TOP_RAW_PROFIT_NOW resolves the tie by digest.
        const decision1 = T0 + 1000;
        const decision2 = T0 + 5000;
        const markets = [
            makeDirectMarket("AAA", [
                makeTrade("long", T0 + 100, T0 + 200, 10),
                makeTrade("long", decision1, null),
            ]),
            makeDirectMarket("BBB", [
                makeTrade("long", T0 + 100, T0 + 200, 10),
                makeTrade("long", decision1, T0 + 2000, 5),
            ]),
            makeDirectMarket("CCC", [
                makeTrade("long", T0 + 300, T0 + 400, 10),
                makeTrade("long", decision2, null),
            ]),
        ];
        const targets = ["AAA", "BBB", "CCC"].map((asset) => makeTarget(asset, 12, () => 100));
        const result = await runOpenScoreUsdReplay(
            () => fromArray(markets),
            () => fromArray(targets),
            {
                horizons: [2],
                slippageRate: 0,
                commissionRate: 0,
                blockCount: 1,
                includeEventDetails: true,
            },
        );

        const horizon = result.horizons[0]!;
        const zDetailAtDecision2 = result.eventDetails?.find(
            (row) => row.selector === "TOP_Z" && row.decisionTime === decision2,
        );
        expect(zDetailAtDecision2?.asset).to.equal("CCC");
        expect(zDetailAtDecision2?.eligibleCandidates).to.equal(2);
        expect(horizon.topZByAsset.some((row) => row.asset === "CCC" && row.events === 1)).to.equal(true);
        expect(result.latestSelections?.selections.find(
            (selection) => selection.selector === "TOP_Z",
        )?.asset).to.equal("CCC");
        const report = result.reportLines.join("\n");
        expect(report).to.include("TOP_Z selected assets = ");
        expect(report).to.include("TOP_Z_EX_");
    });

    it("returns a no-horizon message when horizons are empty", async () => {
        const result = await runOpenScoreUsdReplay(
            () => fromArray([]),
            () => fromArray([]),
            { horizons: [] },
        );
        expect(result.reportLines.join("\n")).to.match(/no valid horizons/i);
    });

    it("returns a no-deltas message when artifacts have no trades", async () => {
        const result = await runOpenScoreUsdReplay(
            () => fromArray([makePair("AAA", "BBB", [])]),
            () => fromArray([]),
            { horizons: [3] },
        );
        expect(result.pairs).to.equal(1);
        expect(result.reportLines.join("\n")).to.match(/no trade deltas/i);
    });

    it("creates a decision event only on entry timestamps, never on exits alone", async () => {
        // Pair enters long at bar 1, exits at bar 3. Exit-only timestamp (bar 3)
        // must NOT create an event. Only the entry timestamp (bar 1) is an event.
        const pair = makePair("AAA", "BBB", [makeTrade("long", T0 + 1000, T0 + 3000)]);
        const targets = [
            makeTarget("AAA", 10, () => 100),
            makeTarget("BBB", 10, () => 50),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray([pair]),
            () => fromArray(targets),
            { horizons: [2] },
        );
        // Long AAA/BBB -> AAA +1, BBB -1 at entry. Only ONE positive candidate
        // (AAA), so the event is ineligible for top-vs-random (< 2 positives).
        expect(result.totalEvents).to.equal(1);
        expect(result.eligibleEvents).to.equal(0);
    });

    it("emits opt-in scalar selector details with exact event times and net returns", async () => {
        const decision = T0 + 1000;
        const markets = [
            makeDirectMarket("AAA", [makeTrade("long", decision, null)]),
            makeDirectMarket("BBB", [makeTrade("long", decision, null)]),
        ];
        const targets = [
            makeTarget("AAA", 10, (i) => 100 + i),
            makeTarget("BBB", 10, (i) => 100 - i),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(markets),
            () => fromArray(targets),
            {
                horizons: [2],
                slippageRate: 0,
                commissionRate: 0,
                blockCount: 1,
                includeEventDetails: true,
            },
        );

        const details = result.eventDetails ?? [];
        expect(details.map((row) => row.selector)).to.include.members([
            "TOP_RAW",
            "TOP_MEAN",
        ]);
        const topMean = details.find((row) => row.selector === "TOP_MEAN")!;
        expect(topMean.decisionTime).to.equal(decision);
        expect(topMean.entryTime).to.equal(T0 + 2000);
        expect(topMean.exitTime).to.equal(T0 + 3000);
        expect(topMean.horizonBars).to.equal(2);
        expect(topMean.direction).to.equal("long");
        expect(topMean.eligibleCandidates).to.equal(2);
        const expectedReturn = topMean.asset === "AAA"
            ? (103 - 102) / 102
            : (97 - 98) / 98;
        const expectedControl = topMean.asset === "AAA"
            ? (97 - 98) / 98
            : (103 - 102) / 102;
        expect(topMean.selectedReturn).to.be.closeTo(expectedReturn, 1e-12);
        expect(topMean.controlReturn).to.be.closeTo(expectedControl, 1e-12);
        expect(topMean.delta).to.be.closeTo(expectedReturn - expectedControl, 1e-12);

        const summaryOnly = await runOpenScoreUsdReplay(
            () => fromArray(markets),
            () => fromArray(targets),
            { horizons: [2], slippageRate: 0, commissionRate: 0, blockCount: 1 },
        );
        expect(summaryOnly.eventDetails).to.equal(undefined);
    });

    it("gates Phase 0b diagnostics and covers every catalog asset with explicit missing states", async () => {
        const decision = T0 + 1000;
        const markets = [
            makeDirectMarket("AAA", [makeTrade("long", decision, null)]),
            makeDirectMarket("BBB", [makeTrade("long", decision, null)]),
        ];
        const targets = [
            makeTarget("AAA", 4, (i) => 100 + i),
            makeTarget("BBB", 4, (i) => 100 - i),
            makeTarget("CCC", 4, () => 100),
        ];
        const baseline = await runOpenScoreUsdReplay(
            () => fromArray(markets),
            () => fromArray(targets.slice(0, 2)),
            { horizons: [2, 5], interval: "1h", blockCount: 1 },
        );
        const result = await runOpenScoreUsdReplay(
            () => fromArray(markets),
            () => fromArray(targets),
            {
                horizons: [2, 5],
                interval: "1h",
                blockCount: 1,
                includePoolSnapshots: true,
                includeCandidateOutcomes: true,
                catalogAssets: ["AAA", "BBB", "CCC", "DDD"],
                poolVersion: "BAL679.v1",
            },
        );

        expect(result.reportLines).to.deep.equal(baseline.reportLines);
        expect(result.poolSnapshots).to.have.length(result.totalEvents * 4);
        expect(result.candidateOutcomes).to.have.length(result.totalEvents * 2 * 2 * 4);
        expect(result.poolSnapshots!.every((row) => row.eventId === `1h:${decision}`)).to.equal(true);
        expect(result.poolSnapshots!.map((row) => row.asset)).to.deep.equal(["AAA", "BBB", "CCC", "DDD"]);

        const rows = result.candidateOutcomes!;
        const ccc = rows.filter((row) => row.asset === "CCC");
        expect(ccc).to.have.length(4);
        expect(ccc.filter((row) => row.horizonBars === 2).every((row) => row.eligible === false && row.status === "ok" && row.return !== null)).to.equal(true);
        const censored = rows.filter((row) => row.horizonBars === 5 && row.asset !== "DDD");
        expect(censored.every((row) => row.status === "right_censored" && row.return === null)).to.equal(true);
        const missing = rows.filter((row) => row.asset === "DDD");
        expect(missing).to.have.length(4);
        expect(missing.every((row) => row.status === "missing_target" && row.return === null && row.entryTimeSec === null)).to.equal(true);
        expect(baseline.poolSnapshots).to.equal(undefined);
        expect(baseline.candidateOutcomes).to.equal(undefined);
    });

    it("replays direct crypto markets as one-asset signals", async () => {
        const markets = [
            makeDirectMarket("AAA", [makeTrade("long", T0 + 1000, null)]),
            makeDirectMarket("BBB", [makeTrade("long", T0 + 1000, null)]),
        ];
        const targets = [
            makeTarget("AAA", 10, (i) => 100 + i),
            makeTarget("BBB", 10, (i) => 100 - i),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(markets),
            () => fromArray(targets),
            { horizons: [2] },
        );
        expect(result.pairs).to.equal(2);
        expect(result.assets).to.equal(2);
        expect(result.totalEvents).to.equal(1);
        expect(result.eligibleEvents).to.equal(1);
    });

    it("long entry maps base +1 / quote -1; short entry maps base -1 / quote +1", async () => {
        // Two pairs sharing asset AAA as base: one long (AAA+1) one short (AAA-1).
        // Net AAA raw = 0 -> AAA not positive. Quote of long pair (BBB) = -1,
        // quote of short pair (CCC) = +1. Only CCC positive -> 1 candidate.
        const pairs = [
            makePair("AAA", "BBB", [makeTrade("long", T0 + 1000, null)]),
            makePair("AAA", "CCC", [makeTrade("short", T0 + 1000, null)]),
        ];
        const targets = [
            makeTarget("AAA", 10, () => 100),
            makeTarget("BBB", 10, () => 50),
            makeTarget("CCC", 10, () => 25),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2] },
        );
        expect(result.totalEvents).to.equal(1);
        // Only CCC has rawScore > 0 -> ineligible (needs >= 2 positives).
        expect(result.eligibleEvents).to.equal(0);
        expect(result.degree.max).to.equal(2); // AAA has static degree 2
    });

    it("applies all same-timestamp entries+exits before forming candidates (no leak)", async () => {
        // At T1: pair1 long AAA/BBB exits (AAA -1, BBB +1) AND pair2 long CCC/DDD enters.
        // Post-execution score must reflect the exit. We assert the event exists
        // (an entry occurred at T1) and that USD lookup starts on the FOLLOWING bar.
        const pairs = [
            makePair("AAA", "BBB", [makeTrade("long", T0, T0 + 1000)]),   // exit at T1
            makePair("CCC", "DDD", [makeTrade("long", T0 + 1000, null)]), // entry at T1
        ];
        // Targets: constant price so return is 0; we only care about event timing.
        const targets = [
            makeTarget("AAA", 10, () => 100),
            makeTarget("BBB", 10, () => 50),
            makeTarget("CCC", 10, () => 25),
            makeTarget("DDD", 10, () => 10),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2] },
        );
        // Two entry timestamps: T0 (pair1 entry) and T1 (pair2 entry). T1 also has
        // pair1's exit, but only one event per timestamp.
        expect(result.totalEvents).to.equal(2);
    });

    it("picks the top raw-score asset and beats the exact random control by the known amount", async () => {
        // Event at T1: three pairs enter long. raw: AAA=2, BBB=1, CCC=-1, DDD=-1.
        // Positives: AAA(2), BBB(1). topRaw=AAA, random control = BBB only.
        // Eligibility requires EVERY positive candidate to have target data, so
        // both AAA and BBB datasets are provided.
        const pairs = [
            makePair("AAA", "CCC", [makeTrade("long", T0 + 1000, null)]), // AAA+1 CCC-1
            makePair("AAA", "DDD", [makeTrade("long", T0 + 1000, null)]), // AAA+1 DDD-1
            makePair("BBB", "EEE", [makeTrade("long", T0 + 1000, null)]), // BBB+1 EEE-1
        ];
        // Linear ramps: AAA +10%/bar, BBB +2%/bar. Decision at bar 1, so the USD
        // entry is bar 2's open (first bar strictly after T1). horizon 3 -> exit
        // at close of bar 2+3-1 = bar 4.
        const targets = [
            makeTarget("AAA", 10, (i) => 100 * (1 + 0.10 * i)),
            makeTarget("BBB", 10, (i) => 50 * (1 + 0.02 * i)),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [3], slippageRate: 0, commissionRate: 0, blockCount: 1 },
        );
        expect(result.eligibleEvents).to.equal(1);
        const h = result.horizons[0]!;
        expect(h.bars).to.equal(3);
        // AAA open(2)=120, close(4)=140 -> 140/120-1 = 1/6
        // BBB open(2)=52,  close(4)=54  -> 54/52-1
        const expectedTop = 140 / 120 - 1;
        const expectedRand = 54 / 52 - 1;
        expect(h.topRaw.topMean).to.be.closeTo(expectedTop, 1e-9);
        expect(h.topRaw.randomMean).to.be.closeTo(expectedRand, 1e-9);
        expect(h.topRaw.delta).to.be.closeTo(expectedTop - expectedRand, 1e-9);
    });

    it("reports the median per-event delta so one fat-tailed event cannot flip the window", async () => {
        // Three decision events (bars 1, 3, 5), each with a unique TOP_RAW
        // winner and a flat pool control, so the per-event deltas are exactly
        // +0.10, +0.20, +1.00. The mean delta would be 0.4333...; the
        // reported delta must be the median 0.20 so a single outlier mover
        // (the +100% EEE event) cannot dominate the headline.
        const pairs = [
            makePair("AAA", "X1", [makeTrade("long", T0 + 1000, T0 + 2000)]),
            makePair("AAA", "X2", [makeTrade("long", T0 + 1000, T0 + 2000)]),
            makePair("BBB", "Y1", [makeTrade("long", T0 + 1000, T0 + 2000)]),
            makePair("CCC", "Z1", [makeTrade("long", T0 + 3000, T0 + 4000)]),
            makePair("CCC", "Z2", [makeTrade("long", T0 + 3000, T0 + 4000)]),
            makePair("DDD", "W1", [makeTrade("long", T0 + 3000, null)]),
            makePair("EEE", "V1", [makeTrade("long", T0 + 5000, null)]),
            makePair("EEE", "V2", [makeTrade("long", T0 + 5000, null)]),
            makePair("FFF", "U1", [makeTrade("long", T0 + 5000, null)]),
        ];
        const targets = [
            makeTarget("AAA", 10, (i) => i === 3 ? 110 : 100),
            makeTarget("BBB", 10, () => 100),
            makeTarget("CCC", 10, (i) => i === 5 ? 120 : 100),
            makeTarget("DDD", 10, () => 100),
            makeTarget("EEE", 10, (i) => i >= 7 ? 200 : 100),
            makeTarget("FFF", 10, () => 100),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], slippageRate: 0, commissionRate: 0, blockCount: 1 },
        );
        const horizon = result.horizons[0]!;
        expect(horizon.topRaw.events).to.equal(3);
        // Median of (+0.10, +0.20, +1.00) — NOT the mean 0.4333....
        expect(horizon.topRaw.delta).to.be.closeTo(0.20, 1e-9);
        // `top`/`rand` stay plain means of the selected/control returns.
        expect(horizon.topRaw.topMean).to.be.closeTo((0.10 + 0.20 + 1.00) / 3, 1e-9);
        expect(horizon.topRaw.randomMean).to.be.closeTo(0, 1e-9);
    });

    it("latest picks carry each arm's top-3 ranked candidates, capped at 3", async () => {
        // One decision event. Each candidate asset votes only via its own
        // pairs against dedicated sink quotes (Q01..Q12), so quote-leg votes
        // never touch another candidate: AAA raw=4/cnt=4/mean=1, BBB 3/3/1,
        // CCC 2/4/0.5 (one opposing short vote), DDD 1/1/1.
        // TOP_RAW ranks raw: AAA, BBB, CCC, DDD -> cap keeps [AAA, BBB, CCC].
        // TOP_MEAN ties on mean=1 (AAA, BBB, DDD) -> tied, detail ranked by
        // mean then name: [AAA, BBB, DDD].
        // TOP_MEAN_RAW_UNIQUE breaks that tie by raw -> AAA, detail mean-then-raw.
        const pairs = [
            makePair("AAA", "Q01", [makeTrade("long", T0 + 1000, null)]),
            makePair("AAA", "Q02", [makeTrade("long", T0 + 1000, null)]),
            makePair("AAA", "Q03", [makeTrade("long", T0 + 1000, null)]),
            makePair("AAA", "Q04", [makeTrade("long", T0 + 1000, null)]),
            makePair("BBB", "Q05", [makeTrade("long", T0 + 1000, null)]),
            makePair("BBB", "Q06", [makeTrade("long", T0 + 1000, null)]),
            makePair("BBB", "Q07", [makeTrade("long", T0 + 1000, null)]),
            makePair("CCC", "Q08", [makeTrade("long", T0 + 1000, null)]),
            makePair("CCC", "Q09", [makeTrade("long", T0 + 1000, null)]),
            makePair("CCC", "Q10", [makeTrade("long", T0 + 1000, null)]),
            makePair("CCC", "Q11", [makeTrade("short", T0 + 1000, null)]),
            makePair("DDD", "Q12", [makeTrade("long", T0 + 1000, null)]),
        ];
        const targets = ["AAA", "BBB", "CCC", "DDD"].map((asset) => makeTarget(asset, 10, () => 100));
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [3], slippageRate: 0, commissionRate: 0, blockCount: 1 },
        );
        const latest = result.latestSelections!;
        expect(latest.decisionTime).to.equal(T0 + 1000);
        const byName = new Map(latest.selections.map((selection) => [selection.selector, selection]));

        const topRaw = byName.get("TOP_RAW")!;
        expect(topRaw.reason).to.equal("selected");
        expect(topRaw.asset).to.equal("AAA");
        // Capped at 3: DDD (raw 1) is ranked but must not ride along.
        expect(topRaw.topCandidates!.map((candidate) => candidate.asset)).to.deep.equal(["AAA", "BBB", "CCC"]);
        expect(topRaw.topCandidates![0]).to.deep.equal({ asset: "AAA", score: 4, mean: 1, activePairs: 4 });
        expect(topRaw.topCandidates![2]).to.deep.equal({ asset: "CCC", score: 2, mean: 0.5, activePairs: 4 });

        const topMean = byName.get("TOP_MEAN")!;
        expect(topMean.reason).to.equal("tied");
        expect(topMean.asset).to.equal(null);
        expect(topMean.topCandidates!.map((candidate) => candidate.asset)).to.deep.equal(["AAA", "BBB", "DDD"]);

        const unique = byName.get("TOP_MEAN_RAW_UNIQUE")!;
        expect(unique.reason).to.equal("selected");
        expect(unique.asset).to.equal("AAA");
        expect(unique.topCandidates!.map((candidate) => candidate.asset)).to.deep.equal(["AAA", "BBB", "DDD"]);
    });

    it("same-score ties break deterministically by the frozen FNV-1a digest every run", async () => {
        // Two assets with identical raw score (both +1). Per the Phase 0 freeze,
        // tie-break = the smallest FNV-1a 64 digest of
        // `max_active_tie_v1|1|truncatedEventTimeSec|scoringAsset` — NOT asset
        // name, NOT input order. Both runs must produce byte-identical reports.
        const pairs = [
            makePair("ZZZ", "QQQ", [makeTrade("long", T0 + 1000, null)]), // ZZZ+1
            makePair("AAA", "QQQ", [makeTrade("long", T0 + 1000, null)]), // AAA+1 (QQQ now -2)
        ];
        // raw: ZZZ=1, AAA=1, QQQ=-2. Positives: ZZZ, AAA. Tie.
        const targets = [
            makeTarget("AAA", 10, () => 100),
            makeTarget("ZZZ", 10, () => 50),
        ];
        const run = () => runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], blockCount: 1 },
        );
        const r1 = await run();
        const r2 = await run();
        expect(r1.eligibleEvents).to.equal(1);
        // Determinism: both runs produce the same selection and report.
        expect(r1.horizons[0]!.topRaw.delta).to.equal(r2.horizons[0]!.topRaw.delta);
        expect(r1.reportLines.join("\n")).to.equal(r2.reportLines.join("\n"));
        // The tie counter must fire for the RAW selector.
        expect(r1.horizons[0]!.tieRates.RAW.sameSelection).to.equal(1);
        expect(r1.horizons[0]!.tieRates.RAW.events).to.equal(1);
    });

    it("applies slippage and commission identically to both arms", async () => {
        const pairs = [
            makePair("AAA", "CCC", [makeTrade("long", T0 + 1000, null)]),
            makePair("BBB", "DDD", [makeTrade("long", T0 + 1000, null)]),
        ];
        const targets = [
            makeTarget("AAA", 10, (i) => 100 + i),
            makeTarget("BBB", 10, (i) => 50 + i * 0.5),
        ];
        const base = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], slippageRate: 0, commissionRate: 0, blockCount: 1 },
        );
        const costed = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], slippageRate: 0.001, commissionRate: 0.0005, blockCount: 1 },
        );
        expect(base.eligibleEvents).to.equal(1);
        expect(costed.eligibleEvents).to.equal(1);
        // Costs reduce the top return but leave the delta structure intact.
        const topBase = base.horizons[0]!.topRaw.topMean!;
        const topCosted = costed.horizons[0]!.topRaw.topMean!;
        expect(topCosted).to.be.lessThan(topBase);
        // Commission round-trip = 2 * 0.0005 = 0.001 drag, plus slippage on both sides.
        expect(topBase - topCosted).to.be.greaterThan(0.001);
    });

    it("omits right-censored events instead of zero-filling them", async () => {
        // Event at T1 with horizon 5, but target only has 3 bars -> censored.
        const pairs = [
            makePair("AAA", "CCC", [makeTrade("long", T0 + 1000, null)]),
            makePair("BBB", "DDD", [makeTrade("long", T0 + 1000, null)]),
        ];
        const targets = [
            makeTarget("AAA", 3, () => 100), // too short for horizon 5
            makeTarget("BBB", 3, () => 50),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [5], blockCount: 1, includeEventDetails: true },
        );
        // No eligible events (all censored) and a warning is emitted — never a fake 0 return.
        expect(result.eligibleEvents).to.equal(0);
        expect(result.warnings.join(" ")).to.match(/right-censored/i);
        // EVERY arm reports its pick as ONGOING with the unrealized
        // mark-to-market return, not just TOP_MEAN — including the inverted
        // ordinary arms. (Both *_RAW_UNIQUE arms skip: the tied-set raw
        // pick is a residual tie here, so they made no pick to report.)
        const ongoing = result.ongoingEventDetails ?? [];
        expect(ongoing).to.have.length(4);
        expect(ongoing.map((row) => row.selector).sort()).to.deep.equal([
            "BOT_MEAN", "BOT_RAW", "TOP_MEAN", "TOP_RAW",
        ]);
        for (const row of ongoing) {
            expect(row.decisionTime).to.equal(T0 + 1000);
            expect(row.entryTime).to.equal(T0 + 2000);
            expect(row.horizonBars).to.equal(5);
            expect(["AAA", "BBB"]).to.include(row.asset);
            expect(row.eligibleCandidates).to.equal(2);
            // Flat 100/50 prices with zero default costs: the unrealized MTM
            // is exactly 0 (entry open to last close, no move).
            expect(row.unrealizedReturn).to.equal(0);
        }
    });

    it("skips assets whose large data gap overlaps the selected window without labeling them ongoing", async () => {
        const day = 24 * 60 * 60;
        const decision = T0 + day;
        const gapFrom = T0 + 2 * day;
        const gapTo = gapFrom + 31 * day;
        const makeGappedTarget = (asset: string): OpenScoreUsdTarget => ({
            asset,
            symbol: `${asset}USDT`,
            data: [gapFrom, gapTo, gapTo + day].map((time, index) => ({
                time: time as Time,
                open: 100 + index,
                high: 100 + index,
                low: 100 + index,
                close: 100 + index,
                volume: 1,
            })),
        });
        const result = await runOpenScoreUsdReplay(
            () => fromArray([
                makePair("AAA", "CCC", [makeTrade("long", decision, null)]),
                makePair("BBB", "DDD", [makeTrade("long", decision, null)]),
            ]),
            () => fromArray([makeGappedTarget("AAA"), makeGappedTarget("BBB")]),
            {
                horizons: [2],
                sampleFromSec: T0,
                sampleToSec: gapTo + day,
                includeEventDetails: true,
                blockCount: 1,
            },
        );
        expect(result.eligibleEvents).to.equal(0);
        expect(result.ongoingEventDetails ?? []).to.have.length(0);
        expect(result.warnings.join(" ")).to.match(/data gap.*selected replay window/i);
    });

    it("removes gapped assets from the pool without invalidating the event", async () => {
        const day = 24 * 60 * 60;
        const decision = T0 + day;
        const gapFrom = T0 + 2 * day;
        const gapTo = gapFrom + 31 * day;
        const makeGappedTarget = (asset: string): OpenScoreUsdTarget => ({
            asset,
            symbol: `${asset}USDT`,
            data: [gapFrom, gapTo, gapTo + day].map((time, index) => ({
                time: time as Time,
                open: 100 + index,
                high: 100 + index,
                low: 100 + index,
                close: 100 + index,
                volume: 1,
            })),
        });
        const result = await runOpenScoreUsdReplay(
            () => fromArray([
                makeDirectMarket("AAA", [makeTrade("long", decision, null)]),
                makeDirectMarket("NEG", [makeTrade("short", decision, null)]),
                makeDirectMarket("BBB", [makeTrade("long", decision, null)]),
                makeDirectMarket("CCC", [makeTrade("long", decision, null)]),
            ]),
            () => fromArray([
                makeGappedTarget("AAA"),
                makeGappedTarget("NEG"),
                makeTarget("BBB", 100, () => 100),
                makeTarget("CCC", 100, () => 100),
            ]),
            {
                horizons: [2],
                sampleFromSec: T0,
                sampleToSec: gapTo + day,
                includeEventDetails: true,
                blockCount: 1,
            },
        );
        // BBB and CCC remain a valid positive pool; gapped AAA and negative
        // NEG are excluded without invalidating the whole event.
        expect(result.eligibleEvents).to.equal(1);
        expect(result.omittedAssets).to.equal(1);
        const topMean = result.latestSelections?.selections.find((selection) => selection.selector === "TOP_MEAN");
        expect(topMean?.asset).to.not.equal("AAA");
        expect(topMean?.asset).to.not.equal("NEG");
        expect(result.eventDetails?.some((row) => row.selector === "TOP_MEAN")).to.equal(true);
    });

    it("surfaces missing target datasets as incomplete, never as zero returns", async () => {
        const pairs = [
            makePair("AAA", "CCC", [makeTrade("long", T0 + 1000, null)]),
            makePair("BBB", "DDD", [makeTrade("long", T0 + 1000, null)]),
        ];
        // Only AAA's dataset is provided; BBB (a positive candidate) is missing.
        const targets = [makeTarget("AAA", 10, () => 100)];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], blockCount: 1 },
        );
        expect(result.complete).to.equal(false);
        expect(result.omittedAssets).to.equal(1);
        expect(result.eligibleEvents).to.equal(0);
        expect(result.warnings.join(" ")).to.match(/no usable target dataset/i);
    });

    it("reports unequal static pair degree without altering raw-score math", async () => {
        // AAA appears in 3 pairs (degree 3), BBB in 1 (degree 1). Raw score is a
        // plain vote count — degree is reported but does not normalize raw.
        const pairs = [
            makePair("AAA", "XXX", [makeTrade("long", T0 + 1000, null)]),
            makePair("AAA", "YYY", [makeTrade("long", T0 + 1000, null)]),
            makePair("AAA", "ZZZ", [makeTrade("long", T0 + 1000, null)]),
            makePair("BBB", "WWW", [makeTrade("long", T0 + 1000, null)]),
        ];
        // raw: AAA=3, BBB=1. Positives AAA,BBB -> top=AAA (higher raw).
        const targets = [
            makeTarget("AAA", 10, () => 100),
            makeTarget("BBB", 10, () => 50),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], blockCount: 1 },
        );
        expect(result.degree.max).to.equal(3);
        expect(result.degree.min).to.equal(1);
        expect(result.eligibleEvents).to.equal(1);
        // Adjusted = raw/sqrt(activePairCount): AAA 3/sqrt(3)=1.732, BBB 1/sqrt(1)=1.
        // So TOP_RAW picks AAA (3>1); both arms still produce a finite delta.
        expect(result.horizons[0]!.topRaw.topMean).to.not.equal(null);
    });

    it("profit-gated arms rank only pairs whose pair backtest netted positive", async () => {
        // Event at T1. Unfiltered raw: AAA=2 (2 winning pairs), BBB=3 (3
        // losing pairs), CCC=1 (1 winning pair) -> TOP_RAW picks BBB.
        // Profit-gated pool: only AAA(2) and CCC(1) -> TOP_RAW_PROFIT picks AAA
        // outright, so its selected return is AAA's known ramp return while
        // TOP_RAW's is BBB's flat 0.
        const pairs = [
            makePair("AAA", "X1", [makeTrade("long", T0 + 1000, null)], 100),
            makePair("AAA", "X2", [makeTrade("long", T0 + 1000, null)], 100),
            makePair("BBB", "Y1", [makeTrade("long", T0 + 1000, null)], -50),
            makePair("BBB", "Y2", [makeTrade("long", T0 + 1000, null)], -50),
            makePair("BBB", "Y3", [makeTrade("long", T0 + 1000, null)], -50),
            makePair("CCC", "Z1", [makeTrade("long", T0 + 1000, null)], 10),
        ];
        const flat = () => 100;
        const targets = [
            makeTarget("AAA", 10, (i) => 100 * (1 + 0.10 * i)),
            makeTarget("BBB", 10, flat),
            makeTarget("CCC", 10, flat),
            makeTarget("X1", 10, flat), makeTarget("X2", 10, flat),
            makeTarget("Y1", 10, flat), makeTarget("Y2", 10, flat), makeTarget("Y3", 10, flat),
            makeTarget("Z1", 10, flat),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], slippageRate: 0, commissionRate: 0, blockCount: 1, includeEventDetails: true },
        );
        const h = result.horizons[0]!;
        // Unfiltered arms are untouched by the pnl filter.
        expect(h.topRaw.events).to.equal(1);
        expect(h.topRaw.topMean).to.be.closeTo(0, 1e-9);
        expect(h.topMean.events).to.equal(1);
        // The gated pool is {AAA, CCC}; TOP_RAW_PROFIT picks AAA (2 > 1).
        // AAA: entry bar 2 open=120, exit bar 3 close=130 -> 130/120-1.
        expect(h.topRawProfit.events).to.equal(1);
        expect(h.topRawProfit.topMean).to.be.closeTo(130 / 120 - 1, 1e-9);
        expect(h.topRawProfitByAsset.map((x) => x.asset)).to.deep.equal(["AAA"]);
        expect(h.topRawProfitDominantAsset).to.equal("AAA");
        expect(h.topRawProfitExDominant.events).to.equal(0);
        // TOP_MEAN_PROFIT ties AAA (mean 1.0) vs CCC (mean 1.0) -> digest
        // decides, but exactly one selection is recorded per event.
        expect(h.topMeanProfit.events).to.equal(1);
        expect(h.topMeanProfitByAsset).to.have.length(1);
        // Scalar detail rows exist for both gated arms (Show OPEN_SCORE
        // Details): pool is the profit-gated {AAA, CCC}, direction is long.
        const rawPnlDetail = result.eventDetails?.find((row) => row.selector === "TOP_RAW_PROFIT");
        expect(rawPnlDetail?.asset).to.equal("AAA");
        expect(rawPnlDetail?.direction).to.equal("long");
        expect(rawPnlDetail?.eligibleCandidates).to.equal(2);
        expect(rawPnlDetail?.selectedReturn).to.be.closeTo(130 / 120 - 1, 1e-9);
        expect(result.eventDetails?.some((row) => row.selector === "TOP_MEAN_PROFIT")).to.equal(true);
        // Report carries both arms + breakdowns + exclusions.
        const report = result.reportLines.join("\n");
        expect(report).to.include("TOP_RAW_PROFIT");
        expect(report).to.include("RAW_PROFIT_EX_AAA");
        expect(report).to.include("TOP_MEAN_PROFIT");
        expect(report).to.include("MEAN_PROFIT_EX_");
        expect(report).to.include("TOP_RAW_PROFIT selected assets = ");
        expect(report).to.include("TOP_MEAN_PROFIT selected assets = ");
        expect(report).to.include("TOP_RAW_PROFIT=raw score counted only from pairs whose pair backtest netted >0");
    });

    it("PROFIT_NOW arms are causal: a pair only votes once its pnl realized at or before the event is positive", async () => {
        // P1 (AAA) loses -50 first, then opens a winning trade. P2 (BBB) and
        // P3 (CCC) each realize +10/+20 before re-entering.
        // Event T0+1000: everyone open, nothing realized yet -> causal pool
        // empty -> NOW arms fire 0 (the look-ahead PROFIT arms, whose filter
        // uses the pairs' FINAL net pnl, fire here — proving the difference).
        // Event T0+3000: P1 realized -50 (muted), P2/P3 realized +10/+20
        // (counted) -> causal pool {BBB, CCC}.
        const pairs = [
            makePair("AAA", "X1", [
                makeTrade("long", T0 + 1000, T0 + 2000, -50),
                makeTrade("long", T0 + 3000, null, 100),
            ], 50),
            makePair("BBB", "Y1", [
                makeTrade("long", T0 + 1000, T0 + 2000, 10),
                makeTrade("long", T0 + 3000, null, 5),
            ], 15),
            makePair("CCC", "Z1", [
                makeTrade("long", T0 + 1000, T0 + 2000, 20),
                makeTrade("long", T0 + 3000, null, 5),
            ], 25),
        ];
        const flat = () => 100;
        const targets = [
            makeTarget("AAA", 10, flat), makeTarget("BBB", 10, flat), makeTarget("CCC", 10, flat),
            makeTarget("X1", 10, flat), makeTarget("Y1", 10, flat), makeTarget("Z1", 10, flat),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], slippageRate: 0, commissionRate: 0, blockCount: 1, includeEventDetails: true },
        );
        const h = result.horizons[0]!;
        // Two decision events (T0+1000 and T0+3000); both have >= 2 positives.
        expect(h.topRaw.events).to.equal(2);
        // Look-ahead PROFIT arms: the pairs' FINAL pnl is +50/+15/+25 (all
        // positive), so the pool is full at BOTH events.
        expect(h.topRawProfit.events).to.equal(2);
        // Causal NOW arms: at T0+1000 nothing is realized yet (pool empty);
        // at T0+3000 only BBB and CCC have positive realized pnl (P1's -50
        // mutes AAA). Exactly one of the two events contributes.
        expect(h.topRawProfitNow.events).to.equal(1);
        expect(h.topMeanProfitNow.events).to.equal(1);
        // The causal winner comes from {BBB, CCC} — never AAA.
        const nowWinner = h.topRawProfitNowByAsset[0]!.asset;
        expect(["BBB", "CCC"]).to.include(nowWinner);
        expect(h.topRawProfitNowByAsset).to.have.length(1);
        expect(h.topRawProfitNowDominantAsset).to.equal(nowWinner);
        expect(h.topRawProfitNowExDominant.events).to.equal(0);
        // Detail rows exist for the NOW arms with the causal pool size (2).
        const nowDetail = result.eventDetails?.find((row) => row.selector === "TOP_RAW_PROFIT_NOW");
        expect(nowDetail?.direction).to.equal("long");
        expect(nowDetail?.eligibleCandidates).to.equal(2);
        expect(nowDetail?.decisionTime).to.equal(T0 + 3000);
        // Report carries the causal lines + legend.
        const report = result.reportLines.join("\n");
        expect(report).to.include("TOP_RAW_PROFIT_NOW");
        expect(report).to.include("RAW_PROFIT_NOW_EX_" + nowWinner);
        expect(report).to.include("TOP_RAW_PROFIT_NOW selected assets = ");
        expect(report).to.include("TOP_MEAN_PROFIT_NOW selected assets = ");
        expect(report).to.include("TOP_RAW_PROFIT_NOW=same filter using only pnl realized at or before each event (causal)");
    });

    it("PROFIT_NOW removes a pair's vote when it exits on an exit-only timestamp (no leak)", async () => {
        // Regression: the causal accumulators were only maintained on
        // timestamps that produced a decision event, so a profitable pair
        // exiting on an exit-only timestamp kept its +1 in the filtered score
        // forever. Exact accounting: AAA's +1 must be subtracted at its
        // T0+4000 exit (an exit-only timestamp), leaving {BBB, DDD} as the
        // only positive causal-score assets at the final event.
        const pairs = [
            // AAA: wins early so its second trade enters masked; exits at
            // T0+4000 with no entry anywhere at that timestamp.
            makePair("AAA", "X1", [
                makeTrade("long", T0 + 1000, T0 + 2000, 10),
                makeTrade("long", T0 + 3000, T0 + 4000, 5),
            ], 15),
            // BBB: wins before entering, then stays open to end of data.
            makePair("BBB", "Y1", [
                makeTrade("long", T0 + 500, T0 + 800, 10),
                makeTrade("long", T0 + 1000, null, 5),
            ], 15),
            // CCC: wins before entering; exits again on an exit-only
            // timestamp so it drops out of the causal pool at the end.
            makePair("CCC", "Z1", [
                makeTrade("long", T0 + 500, T0 + 800, 10),
                makeTrade("long", T0 + 3000, T0 + 4500, 5),
            ], 15),
            // DDD: wins before entering late, keeps the final pool >= 2.
            makePair("DDD", "W1", [
                makeTrade("long", T0 + 500, T0 + 800, 10),
                makeTrade("long", T0 + 5000, null, 5),
            ], 15),
        ];
        const flat = () => 100;
        const targets = [
            makeTarget("AAA", 12, flat), makeTarget("BBB", 12, flat),
            makeTarget("CCC", 12, flat), makeTarget("DDD", 12, flat),
            makeTarget("X1", 12, flat), makeTarget("Y1", 12, flat),
            makeTarget("Z1", 12, flat), makeTarget("W1", 12, flat),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], slippageRate: 0, commissionRate: 0, blockCount: 1, includeEventDetails: true },
        );
        // The final decision event (T0+5000) must see exactly the open
        // masked votes: BBB (+1, still open) and DDD (+1, just entered).
        // AAA and CCC exited on exit-only timestamps, so with exact
        // accounting their filtered scores are back to 0 there — a pool of
        // exactly 2, never AAA. (With the leak, AAA kept its phantom +1 and
        // the pool at T0+5000 was 3.)
        const nowRows = (result.eventDetails ?? []).filter((row) => row.selector === "TOP_RAW_PROFIT_NOW");
        const finalRow = nowRows.find((row) => row.decisionTime === T0 + 5000);
        expect(finalRow, "NOW arm must fire at the final event").to.not.equal(undefined);
        expect(finalRow!.eligibleCandidates).to.equal(2);
        expect(["BBB", "DDD"]).to.include(finalRow!.asset);
    });

    it("PROFIT_NOW fires on events with < 2 ordinary positives (causal-only coverage)", async () => {
        // At T0+1000 exactly ONE asset is ordinarily positive (AAA): BBB's +1
        // is cancelled by P3's quote leg, and every intermediate +1 is
        // cancelled by a further -1 (DDD, EEE). But causally, only the two
        // prior winners (P1 on AAA, P2 on BBB) have realized pnl > 0 -- the
        // cancelling pairs carry pnl 0 and are muted -- so the causal pool is
        // {AAA, BBB} and the arm must fire even though no view forms.
        const pairs = [
            makePair("AAA", "X1", [
                makeTrade("long", T0 + 500, T0 + 800, 10),
                makeTrade("long", T0 + 1000, null, 0),
            ], 10),
            makePair("BBB", "Y1", [
                makeTrade("long", T0 + 500, T0 + 800, 10),
                makeTrade("long", T0 + 1000, null, 0),
            ], 10),
            // Cancels BBB's +1: DDD +1 / BBB -1 (pnl 0 -> causal-muted).
            makePair("DDD", "BBB", [makeTrade("long", T0 + 1000, null, 0)], 0),
            // Cancels DDD's +1: EEE +1 / DDD -1 (pnl 0 -> causal-muted).
            makePair("EEE", "DDD", [makeTrade("long", T0 + 1000, null, 0)], 0),
            // Cancels EEE's +1 back onto AAA: AAA +1 / EEE -1.
            makePair("EEE", "AAA", [makeTrade("short", T0 + 1000, null, 0)], 0),
        ];
        const flat = () => 100;
        const targets = [
            makeTarget("AAA", 10, flat), makeTarget("BBB", 10, flat),
            makeTarget("DDD", 10, flat), makeTarget("EEE", 10, flat),
            makeTarget("X1", 10, flat), makeTarget("Y1", 10, flat),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], slippageRate: 0, commissionRate: 0, blockCount: 1, includeEventDetails: true },
        );
        // T0+500 forms an ordinary view (AAA,BBB both fresh +1); T0+1000 has
        // exactly one ordinary positive, so it must NOT produce TOP_RAW rows.
        expect(result.horizons[0]!.topRawProfitNow.events).to.equal(1);
        const nowRows = (result.eventDetails ?? []).filter((row) => row.selector === "TOP_RAW_PROFIT_NOW");
        expect(nowRows).to.have.length(1);
        expect(nowRows[0]!.decisionTime).to.equal(T0 + 1000);
        expect(nowRows[0]!.eligibleCandidates).to.equal(2);
        expect(["AAA", "BBB"]).to.include(nowRows[0]!.asset);
        const rawRowsAtEvent = (result.eventDetails ?? []).filter(
            (row) => row.selector === "TOP_RAW" && row.decisionTime === T0 + 1000,
        );
        expect(rawRowsAtEvent).to.have.length(0);
    });

    it("PROFIT_NOW mutes a pair with any missing/non-finite trade pnl (mixed history)", async () => {
        // AAA has one finite winning trade and one open trade whose pnl is
        // NaN: the pair must be pnl-unknown and muted for the causal arms
        // even though its realized-so-far (+10) is positive. BBB and CCC are
        // fully known winners, so the causal pool is exactly {BBB, CCC}.
        const pairs = [
            makePair("AAA", "X1", [
                makeTrade("long", T0 + 500, T0 + 800, 10),
                makeTrade("long", T0 + 1000, null, NaN),
            ], 10),
            makePair("BBB", "Y1", [
                makeTrade("long", T0 + 500, T0 + 800, 10),
                makeTrade("long", T0 + 1000, null, 5),
            ], 15),
            makePair("CCC", "Z1", [
                makeTrade("long", T0 + 500, T0 + 800, 10),
                makeTrade("long", T0 + 1000, null, 5),
            ], 15),
        ];
        const flat = () => 100;
        const targets = [
            makeTarget("AAA", 10, flat), makeTarget("BBB", 10, flat), makeTarget("CCC", 10, flat),
            makeTarget("X1", 10, flat), makeTarget("Y1", 10, flat), makeTarget("Z1", 10, flat),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], slippageRate: 0, commissionRate: 0, blockCount: 1, includeEventDetails: true },
        );
        const nowRows = (result.eventDetails ?? []).filter((row) => row.selector === "TOP_RAW_PROFIT_NOW");
        expect(nowRows).to.have.length(1);
        expect(nowRows[0]!.eligibleCandidates).to.equal(2);
        expect(["BBB", "CCC"]).to.include(nowRows[0]!.asset);
    });

    it("PROFIT_NOW pairs exit-exit bookkeeping exactly under overlapping trades (FIFO)", async () => {
        // AAA runs three overlapping trades: two applied entries (mask on at
        // both entry times) and one later entry AFTER a loss flipped the pair
        // pnl-unknown-negative (mask off at entry). Exact accounting: the two
        // applied votes are each removed by their own exit; the unapplied
        // entry stays out. With the old single-flag scheme the last exit
        // found a stale flag and leaked AAA's vote forever.
        const pairs = [
            makePair("AAA", "X1", [
                makeTrade("long", T0 + 500, T0 + 800, 10),
                makeTrade("long", T0 + 1000, T0 + 4500, 5),
                makeTrade("long", T0 + 2000, T0 + 3000, -50),
                makeTrade("long", T0 + 3500, T0 + 4000, 5),
            ], -30),
            makePair("BBB", "Y1", [
                makeTrade("long", T0 + 500, T0 + 800, 10),
                makeTrade("long", T0 + 1000, null, 5),
            ], 15),
            makePair("CCC", "Z1", [
                makeTrade("long", T0 + 500, T0 + 800, 10),
                makeTrade("long", T0 + 4000, null, 5),
            ], 15),
            makePair("DDD", "W1", [
                makeTrade("long", T0 + 500, T0 + 800, 10),
                makeTrade("long", T0 + 5000, null, 5),
            ], 15),
        ];
        const flat = () => 100;
        const targets = [
            makeTarget("AAA", 12, flat), makeTarget("BBB", 12, flat),
            makeTarget("CCC", 12, flat), makeTarget("DDD", 12, flat),
            makeTarget("X1", 12, flat), makeTarget("Y1", 12, flat),
            makeTarget("Z1", 12, flat), makeTarget("W1", 12, flat),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], slippageRate: 0, commissionRate: 0, blockCount: 1, includeEventDetails: true },
        );
        const nowRows = (result.eventDetails ?? []).filter((row) => row.selector === "TOP_RAW_PROFIT_NOW");
        // Event at T0+4000: AAA's applied entry is still open (its vote is in
        // the accumulator), so the causal pool is {AAA, BBB, CCC}.
        const midRow = nowRows.find((row) => row.decisionTime === T0 + 4000);
        expect(midRow, "NOW arm must fire at T0+4000").to.not.equal(undefined);
        expect(midRow!.eligibleCandidates).to.equal(3);
        // Event at T0+5000: AAA exited at T0+4500 and its vote was removed,
        // so AAA must be OUT of the pool ({BBB, CCC, DDD} only). The leaked
        // accounting would show a pool of 4 (AAA phantom vote included).
        const finalRow = nowRows.find((row) => row.decisionTime === T0 + 5000);
        expect(finalRow, "NOW arm must fire at T0+5000").to.not.equal(undefined);
        expect(finalRow!.eligibleCandidates).to.equal(3);
        expect(finalRow!.asset).to.not.equal("AAA");
    });

    it("PROFIT_NOW output is deterministic under reversed artifact arrival order", async () => {
        const buildPairs = () => [
            makePair("AAA", "X1", [
                makeTrade("long", T0 + 500, T0 + 800, 10),
                makeTrade("long", T0 + 1000, T0 + 2000, 4),
                makeTrade("long", T0 + 3000, null, 6),
            ], 20),
            makePair("BBB", "Y1", [
                makeTrade("long", T0 + 500, T0 + 800, -5),
                makeTrade("long", T0 + 2000, T0 + 3000, 25),
                makeTrade("long", T0 + 3000, null, 1),
            ], 21),
            makePair("CCC", "Z1", [
                makeTrade("long", T0 + 1000, T0 + 2000, 3),
                makeTrade("long", T0 + 4000, null, 2),
            ], 5),
        ];
        const flat = () => 100;
        const targets = [
            makeTarget("AAA", 10, flat), makeTarget("BBB", 10, flat), makeTarget("CCC", 10, flat),
            makeTarget("X1", 10, flat), makeTarget("Y1", 10, flat), makeTarget("Z1", 10, flat),
        ];
        const opts = { horizons: [2], slippageRate: 0, commissionRate: 0, blockCount: 1 };
        const forward = await runOpenScoreUsdReplay(() => fromArray(buildPairs()), () => fromArray(targets), opts);
        const reverse = await runOpenScoreUsdReplay(() => fromArray(buildPairs().reverse()), () => fromArray(targets), opts);
        expect(reverse.horizons[0]!.topRawProfitNow).to.deep.equal(forward.horizons[0]!.topRawProfitNow);
        expect(reverse.horizons[0]!.topMeanProfitNow).to.deep.equal(forward.horizons[0]!.topMeanProfitNow);
        expect(reverse.reportLines).to.deep.equal(forward.reportLines);
    });

    it("losing pairs' votes never reach the profit-gated pool (no zero-fill)", async () => {
        // AAA's two votes both come from losing pairs; BBB's single vote from
        // a winner. The unfiltered pool is {AAA(2), BBB(1)} so TOP_RAW fires,
        // but the profit-gated pool is {BBB} (< 2) -> both gated arms are empty,
        // not zero-filled.
        const pairs = [
            makePair("AAA", "X1", [makeTrade("long", T0 + 1000, null)], -1),
            makePair("AAA", "X2", [makeTrade("long", T0 + 1000, null)], -1),
            makePair("BBB", "Y1", [makeTrade("long", T0 + 1000, null)], 5),
        ];
        const flat = () => 100;
        const targets = [
            makeTarget("AAA", 10, flat),
            makeTarget("BBB", 10, flat),
            makeTarget("X1", 10, flat), makeTarget("X2", 10, flat),
            makeTarget("Y1", 10, flat),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], slippageRate: 0, commissionRate: 0, blockCount: 1 },
        );
        const h = result.horizons[0]!;
        expect(h.topRaw.events).to.equal(1);
        expect(h.topRawProfit.events).to.equal(0);
        expect(h.topMeanProfit.events).to.equal(0);
        expect(h.topRawProfitDominantAsset).to.equal(null);
        expect(h.topMeanProfitDominantAsset).to.equal(null);
        const report = result.reportLines.join("\n");
        expect(report).to.include("TOP_RAW_PROFIT ");
        expect(report).to.include("TOP_MEAN_PROFIT ");
    });

    it("reports coverage controls that separate score edge from pair-degree concentration", async () => {
        // At T1 the positive candidates intentionally produce different
        // winners for every diagnostic rule:
        //   TOP_RAW / MAX_ACTIVE -> AAA (raw=3, active=5)
        //   TOP_ADJUSTED         -> BBB (2/sqrt(2) > 3/sqrt(5))
        //   TOP_MEAN             -> tie (BBB, AAB, ZZZ, DDD all raw/active=1)
        //                          broken by the FNV-1a digest of
        //                          `max_active_tie_v1|1|t|asset`. At t=1700001000
        //                          ZZZ has the smallest digest, so TOP_MEAN -> ZZZ.
        //   MAX_STATIC           -> DDD (six submitted pairs, one active)
        // This proves the report is evaluating genuinely different selectors,
        // rather than printing aliases of TOP_RAW.
        const pairs = [
            makePair("AAA", "X1", [makeTrade("long", T0 + 1000, null)]),
            makePair("AAA", "X2", [makeTrade("long", T0 + 1000, null)]),
            makePair("AAA", "X3", [makeTrade("long", T0 + 1000, null)]),
            makePair("AAA", "X4", [makeTrade("long", T0 + 1000, null)]),
            makePair("AAA", "ZZZ", [makeTrade("short", T0 + 1000, null)]),
            makePair("BBB", "Y1", [makeTrade("long", T0 + 1000, null)]),
            makePair("BBB", "Y2", [makeTrade("long", T0 + 1000, null)]),
            makePair("AAB", "Y3", [makeTrade("long", T0 + 1000, null)]),
            makePair("DDD", "Y4", [makeTrade("long", T0 + 1000, null)]),
            ...Array.from({ length: 5 }, (_, i) => makePair("DDD", `EMPTY${i}`, [])),
        ];
        const targetWithReturn = (asset: string, forwardReturn: number): OpenScoreUsdTarget =>
            makeTarget(asset, 10, (i) => i === 3 ? 100 * (1 + forwardReturn) : 100);
        const targets = [
            targetWithReturn("AAA", 0.10),
            targetWithReturn("BBB", 0.20),
            targetWithReturn("AAB", 0.30),
            targetWithReturn("DDD", 0.40),
            targetWithReturn("ZZZ", 0.05),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], slippageRate: 0, commissionRate: 0, blockCount: 1 },
        );
        const horizon = result.horizons[0]!;
        expect(horizon.topRaw.topMean).to.be.closeTo(0.10, 1e-9);
        // TOP_MEAN tie (BBB=AAB=ZZZ=DDD=1.0) -> FNV-1a digest picks ZZZ.
        expect(horizon.topMean.topMean).to.be.closeTo(0.05, 1e-9);
        expect(horizon.dominantAsset).to.equal("AAA");
        expect(horizon.topRawExDominant.events).to.equal(0);
        const aaaSummary = horizon.topRawByAsset.find((x) => x.asset === "AAA")!;
        expect(aaaSummary.events).to.equal(1);
        expect(aaaSummary.share).to.equal(1);
        expect(aaaSummary.topMean).to.be.closeTo(0.10, 1e-9);
        expect(aaaSummary.randomMean).to.be.closeTo(0.2375, 1e-9);
        expect(aaaSummary.delta).to.be.closeTo(-0.1375, 1e-9);
        expect(result.reportLines.join("\n")).to.include("controls | TOP_MEAN=raw/activePairs");
    });

    it("labels zero-event horizons as unusable even when all datasets loaded", async () => {
        const pairs = [
            makePair("AAA", "CCC", [makeTrade("long", T0 + 1000, null)]),
            makePair("BBB", "DDD", [makeTrade("long", T0 + 1000, null)]),
        ];
        const targets = [
            makeTarget("AAA", 3, () => 100),
            makeTarget("BBB", 3, () => 50),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [5], blockCount: 1 },
        );
        expect(result.complete).to.equal(true);
        expect(result.candidateEvents).to.equal(1);
        expect(result.reportLines.join("\n")).to.include("coverage=0/1 (0.0%) NO_USABLE_EVENTS");
        expect(result.reportLines[0]).to.include("DATA_COMPLETE");
    });

    it("reports TOP_RAW performance after removing the dominant selected asset", async () => {
        const pairs = [
            makePair("AAA", "X1", [makeTrade("long", T0 + 1000, T0 + 2000)]),
            makePair("AAA", "X2", [makeTrade("long", T0 + 1000, T0 + 2000)]),
            makePair("BBB", "Y1", [makeTrade("long", T0 + 1000, T0 + 2000)]),
            makePair("CCC", "Z1", [makeTrade("long", T0 + 3000, null)]),
            makePair("CCC", "Z2", [makeTrade("long", T0 + 3000, null)]),
            makePair("DDD", "W1", [makeTrade("long", T0 + 3000, null)]),
        ];
        const targets = [
            makeTarget("AAA", 10, (i) => i === 3 ? 110 : 100),
            makeTarget("BBB", 10, () => 100),
            makeTarget("CCC", 10, (i) => i === 5 ? 120 : 100),
            makeTarget("DDD", 10, () => 100),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], slippageRate: 0, commissionRate: 0, blockCount: 1 },
        );
        const horizon = result.horizons[0]!;
        // AAA and CCC each win once; the deterministic count/name ordering
        // names AAA dominant. Removing AAA's event must leave CCC's +20%
        // return against DDD's flat random control.
        expect(horizon.dominantAsset).to.equal("AAA");
        expect(horizon.topRawExDominant.events).to.equal(1);
        expect(horizon.topRawExDominant.topMean).to.be.closeTo(0.20, 1e-9);
        expect(horizon.topRawExDominant.delta).to.be.closeTo(0.20, 1e-9);
    });

    it("cancels during the artifact scan when shouldStop returns true", async () => {
        const pairs = [makePair("AAA", "BBB", [makeTrade("long", T0 + 1000, null)])];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray([]),
            { horizons: [2], shouldStop: () => true },
        );
        expect(result.reportLines.join("\n")).to.match(/cancelled/i);
    });

    it("cancels candidate construction before loading target data in both replay modes", async () => {
        const pairs = [makePair("AAA", "BBB", [makeTrade("long", T0 + 1000, null)])];
        for (const mode of ["horizon", "asset_switch"] as const) {
            let stopRequested = false;
            let targetLoads = 0;
            const result = await runOpenScoreUsdReplay(
                () => fromArray(pairs),
                async function* () {
                    targetLoads += 1;
                },
                {
                    mode,
                    horizons: mode === "horizon" ? [2] : [],
                    shouldStop: () => stopRequested,
                    onPhase: (phase, detail) => {
                        if (phase === "targets" && detail.startsWith("forming ")) stopRequested = true;
                    },
                },
            );
            expect(result.reportLines.join("\n"), mode).to.match(/cancelled during candidate selection/i);
            expect(targetLoads, mode).to.equal(0);
        }
    });

    it("decrements activePairCount on exit deltas so TOP_ADJUSTED is not corrupted by round-trips", async () => {
        // Audit F1 regression: activePairCount must track CURRENTLY-OPEN pairs
        // (entries +1, exits -1). The previous implementation added abs(delta)
        // on every delta, so the adjusted denominator grew on each exit too
        // and TOP_ADJUSTED silently picked the wrong asset.
        //
        // Setup: at T1 two pairs enter long. Pair1 closes normally at T2.
        //   Pair1 long AAA/CCC: AAA +1, CCC -1 at T1; AAA -1, CCC +1 at T2.
        //   Pair2 long BBB/DDD: BBB +1, DDD -1 at T1; never closes.
        // At T1 (the decision event): rawScore AAA=1, BBB=1, CCC=-1, DDD=-1.
        //   Positives: AAA(1), BBB(1). activePairCount: AAA=1, BBB=1.
        //   adjustedScore: AAA=1/sqrt(1)=1, BBB=1/sqrt(1)=1 -> tie, name asc -> AAA.
        // If the bug were still present, AAA's count would still be 1 at T1
        // (the exit hadn't happened yet), so the bug needs a LATER event to
        // manifest. To catch the post-exit inflation we add a second decision
        // event at T3 where pair2 is still open and pair1 has cycled:
        //   Pair3 long AAA/EEE enters at T3 (AAA +1, EEE -1), never closes.
        // At T3: rawScore AAA=1 (pair1 round-trip nets 0 + pair3 +1), BBB=1, EEE=-1.
        //   activePairCount CORRECT: AAA=1 (pair1 gone, pair3 open), BBB=1.
        //   adjustedScore CORRECT: AAA=1/sqrt(1)=1, BBB=1/sqrt(1)=1.
        //   activePairCount BUGGY (abs(delta)): AAA=3 (pair1 +1 entry +1 exit + pair3 +1), BBB=1.
        //     -> adjustedScore AAA = 1/sqrt(3) = 0.577 < BBB's 1.0
        //     -> TOP_ADJUSTED picks BBB (wrong) instead of AAA (tie).
        const pairs = [
            makePair("AAA", "CCC", [makeTrade("long", T0 + 1000, T0 + 2000)]), // T1 entry, T2 exit
            makePair("BBB", "DDD", [makeTrade("long", T0 + 1000, null)]),      // T1 entry, open
            makePair("AAA", "EEE", [makeTrade("long", T0 + 3000, null)]),      // T3 entry, open
        ];
        const targets = [
            makeTarget("AAA", 10, () => 100),
            makeTarget("BBB", 10, () => 50),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], blockCount: 1 },
        );
        // Both decision events (T1 and T3) qualify. At T3 the corrected
        // activePairCount makes AAA tie BBB at adjustedScore=1; tie breaks by
        // name -> AAA. With the bug, BBB strictly wins T3's TOP_ADJUSTED and
        // the report's TOP_ADJUSTED events would be skewed. Assert the
        // candidateDegree's max active pair count is 1 (not 3) for AAA.
        const horizon = result.horizons[0]!;
        // maxActivePairs across events = 1 (only one pair open per asset at
        // any decision event). The bug would have surfaced max=3.
        expect(horizon.candidateDegree.max).to.equal(1);
        // Eligible events are 2 (T1 and T3); both have >= 2 positive
        // candidates with valid target data for AAA and BBB, and the
        // corrected activePairCount keeps TOP_MEAN on both.
        expect(result.eligibleEvents).to.equal(2);
        expect(horizon.topMean.events).to.equal(2);
    });

    it("reports active coverage from positive candidates, not a negative-score asset", async () => {
        const pairs = [
            makePair("AAA", "A1", [makeTrade("long", T0 + 1000, null)]),
            makePair("BBB", "B1", [makeTrade("long", T0 + 1000, null)]),
            makePair("NEG", "N1", [makeTrade("short", T0 + 1000, null)]),
            makePair("NEG", "N2", [makeTrade("short", T0 + 1000, null)]),
            makePair("NEG", "N3", [makeTrade("short", T0 + 1000, null)]),
        ];
        const targets = ["AAA", "BBB", "N1", "N2", "N3"].map((asset) => makeTarget(asset, 10, () => 100));
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], blockCount: 1 },
        );
        // NEG has three active pair votes but a negative score. Every positive
        // candidate has one active pair, so the reported candidate coverage is 1.
        expect(result.horizons[0]!.candidateDegree.max).to.equal(1);
    });

    it("merges per-pair delta streams in global timestamp order (k-way merge parity)", async () => {
        // Audit F2 parity: artifacts arrive in arbitrary order; the merged
        // delta sequence must be the same as a global sort regardless of the
        // order the artifactLoader yields them. Same setup as the
        // "same-timestamp exits+entries" test, but with the pairs yielded in
        // reverse so the per-pair streams arrive out of chronological order.
        const pairsInOrder = [
            makePair("AAA", "BBB", [makeTrade("long", T0, T0 + 1000)]),   // exit at T1
            makePair("CCC", "DDD", [makeTrade("long", T0 + 1000, null)]), // entry at T1
        ];
        const reversed = [...pairsInOrder].reverse();
        const targets = [
            makeTarget("AAA", 10, () => 100),
            makeTarget("BBB", 10, () => 50),
            makeTarget("CCC", 10, () => 25),
            makeTarget("DDD", 10, () => 10),
        ];
        const inOrder = await runOpenScoreUsdReplay(
            () => fromArray(pairsInOrder),
            () => fromArray(targets),
            { horizons: [2] },
        );
        const outOfOrder = await runOpenScoreUsdReplay(
            () => fromArray(reversed),
            () => fromArray(targets),
            { horizons: [2] },
        );
        // Both arrival orders must produce identical reports (deterministic
        // k-way merge with stream-index tie-break).
        expect(outOfOrder.totalEvents).to.equal(inOrder.totalEvents);
        expect(outOfOrder.eligibleEvents).to.equal(inOrder.eligibleEvents);
        expect(outOfOrder.reportLines.join("\n")).to.equal(inOrder.reportLines.join("\n"));
    });

    it("counts an artifact with no trades as omitted and still reports static pair degree", async () => {
        // Audit F3 + F5: a pair with zero usable trades (e.g. disk read
        // failure yielding a tombstone, or a pair that simply produced no
        // signals) must be counted as omittedPair, but its legs must still
        // contribute to static pair degree so the coverage-bias answer
        // describes the submitted pair list, not just the pairs that traded.
        const pairs = [
            makePair("BBB", "DDD", []),                                  // 0 trades; unique legs
            makePair("AAA", "CCC", [makeTrade("long", T0 + 1000, null)]),
        ];
        const targets = [makeTarget("AAA", 10, () => 100)];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], blockCount: 1 },
        );
        // One pair omitted (the empty-trades one).
        expect(result.omittedPairs).to.equal(1);
        expect(result.pairs).to.equal(2);
        // The omitted pair's unique legs must still be part of the submitted
        // asset universe and static degree. If asset registration happened
        // after the no-trade check, these two assets would disappear.
        expect(result.assets).to.equal(4);
        expect(result.degree.min).to.equal(1);
        expect(result.degree.max).to.equal(1);
    });

});

// ============================================================================
// Ordinary positive-pool aggregation (allocation reduction plan phase 1):
// the replay validates and sums the ordinary pool in ONE traversal over
// view.positives instead of building a per-(event, horizon) return map. These
// tests pin the semantics that made the map removable: a unique positive
// pool, picks/tied pools as subsets of it, perAsset shared with profit-only
// assets, exact leave-one-out control math, and censoring that omits the
// whole ordinary comparison.
// ============================================================================

describe("ordinary positive-pool aggregation without a per-event return map", () => {
    const detailAt = (
        result: Awaited<ReturnType<typeof runOpenScoreUsdReplay>>,
        selector: string,
        decisionTime: number,
    ) => (result.eventDetails ?? []).filter((row) => row.selector === selector && row.decisionTime === decisionTime);

    it("scores the TOP_RAW winner against the exact leave-one-out control at every horizon", async () => {
        // Two independent events; per event AAA raw +2, BBB raw +1. Unequal
        // ramp rates make winner and control returns unequal so the exact
        // control math is observable per horizon (h=1 lands on a same-bar
        // exit and both returns are 0).
        const pairs = [
            makePair("AAA", "X", [makeTrade("long", T0 + 1000, null), makeTrade("long", T0 + 5000, null)]),
            makePair("AAA", "Y", [makeTrade("long", T0 + 1000, null), makeTrade("long", T0 + 5000, null)]),
            makePair("BBB", "Z", [makeTrade("long", T0 + 1000, null), makeTrade("long", T0 + 5000, null)]),
        ];
        const targets = [
            makeTarget("AAA", 12, (i) => 100 * (1 + 0.2 * i)),
            makeTarget("BBB", 12, (i) => 50 * (1 + 0.04 * i)),
            makeTarget("X", 12, () => 10),
            makeTarget("Y", 12, () => 10),
            makeTarget("Z", 12, () => 10),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [1, 3], slippageRate: 0, commissionRate: 0, blockCount: 1, includeEventDetails: true },
        );
        expect(result.eligibleEvents).to.equal(2);
        for (const bars of [1, 3]) {
            const rows = detailAt(result, "TOP_RAW", T0 + 1000).filter((row) => row.horizonBars === bars);
            expect(rows).to.have.length(1);
            const top = rows[0]!;
            expect(top.asset).to.equal("AAA");
            expect(top.direction).to.equal("long");
            // The control pool is exactly {BBB}: denominator 2 — never
            // perAsset's size, which also carries profit-only assets.
            expect(top.eligibleCandidates).to.equal(2);
            // Decision at T0+1000 (bar 1): entry at bar 2's open, exit at
            // close of bar 2 + bars - 1.
            // Entry is bar 2's OPEN (price index 2); exit is the close of
            // bar 2 + bars - 1 (price index bars + 1). At bars=1 both legs
            // are bar 2 and the return is exactly 0.
            const aaaReturn = (1 + 0.2 * (1 + bars)) / (1 + 0.2 * 2) - 1;
            const bbbReturn = (1 + 0.04 * (1 + bars)) / (1 + 0.04 * 2) - 1;
            expect(top.selectedReturn).to.be.closeTo(aaaReturn, 1e-12);
            expect(top.controlReturn).to.be.closeTo(bbbReturn, 1e-12);
            expect(top.delta).to.be.closeTo(aaaReturn - bbbReturn, 1e-12);
        }
    });

    it("breaks raw-score ties deterministically and reports the tie rate", async () => {
        // Per event AAA and BBB raw +1 each (mean = raw with one active pair),
        // so BOTH selectors tie at every event and the FNV digest path runs.
        const pairs = [
            makePair("AAA", "X", [makeTrade("long", T0 + 1000, null), makeTrade("long", T0 + 5000, null)]),
            makePair("BBB", "Y", [makeTrade("long", T0 + 1000, null), makeTrade("long", T0 + 5000, null)]),
        ];
        const targets = [
            makeTarget("AAA", 12, () => 100),
            makeTarget("BBB", 12, () => 50),
            makeTarget("X", 12, () => 10),
            makeTarget("Y", 12, () => 10),
        ];
        const run = () => runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], slippageRate: 0, commissionRate: 0, blockCount: 1, includeEventDetails: true },
        );
        const first = await run();
        const second = await run();
        expect(first.horizons[0]!.tieRates.RAW.sameSelection).to.equal(2);
        expect(first.horizons[0]!.tieRates.MEAN.sameSelection).to.equal(2);
        expect(first.horizons[0]!.topRaw.topMean).to.equal(second.horizons[0]!.topRaw.topMean);
        const picks = (res: Awaited<ReturnType<typeof runOpenScoreUsdReplay>>) =>
            (res.eventDetails ?? [])
                .filter((row) => row.selector === "TOP_RAW")
                .map((row) => `${row.decisionTime}:${row.asset}`)
                .sort();
        expect(picks(first)).to.deep.equal(picks(second));
    });

    it("keeps profit-only assets out of the ordinary pool and its control denominator", async () => {
        // T0+1000 event: ordinary scores AAA +4, BBB +1, PPP 0 (its +1 is
        // cancelled by QQQ's cross vote); the causal realized-pnl pool is
        // {AAA, BBB, PPP}. The ordinary control for the TOP_RAW winner must
        // stay {BBB} (eligibleCandidates 2) while the causal arm's control is
        // {BBB, PPP} (eligibleCandidates 3): a leaked PPP would inflate the
        // ordinary denominator even though PPP's ordinary score is zero.
        // Four AAA legs give AAA mean 4/3 > BBB's 1.0, so no mean tie and the
        // digest never hands a pick to the censored asset in the TOP arms.
        const entry = (pnl: number): Trade[] => [
            makeTrade("long", T0 + 500, T0 + 800, pnl),
            makeTrade("long", T0 + 1000, null, 0),
        ];
        const pairs = [
            makePair("AAA", "P1", entry(10), 10),
            makePair("AAA", "P2", entry(10), 10),
            makePair("AAA", "P4", entry(10), 10),
            makePair("AAA", "P5", entry(10), 10),
            makePair("BBB", "P3", entry(5), 5),
            makePair("PPP", "QQQ", entry(7), 7),
            makePair("QQQ", "PPP", [makeTrade("long", T0 + 1000, null, 0)], 0),
        ];
        const targets = [
            makeTarget("AAA", 12, (i) => 100 + i),
            makeTarget("BBB", 12, () => 50),
            makeTarget("PPP", 12, () => 70),
            makeTarget("P1", 12, () => 10),
            makeTarget("P2", 12, () => 10),
            makeTarget("P3", 12, () => 10),
            makeTarget("P4", 12, () => 10),
            makeTarget("P5", 12, () => 10),
            makeTarget("QQQ", 12, () => 10),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], slippageRate: 0, commissionRate: 0, blockCount: 1, includeEventDetails: true },
        );
        // Ordinary views at T0+500 and T0+1000; causal arms fire only on
        // T0+1000 where realized pnl exists.
        expect(result.horizons[0]!.topRaw.events).to.equal(2);
        expect(result.horizons[0]!.topRawProfitNow.events).to.equal(1);
        const ordinaryTop = detailAt(result, "TOP_RAW", T0 + 1000)[0]!;
        expect(ordinaryTop.asset).to.equal("AAA");
        expect(ordinaryTop.eligibleCandidates).to.equal(2);
        const causalTop = detailAt(result, "TOP_RAW_PROFIT_NOW", T0 + 1000)[0]!;
        expect(causalTop.asset).to.equal("AAA");
        expect(causalTop.eligibleCandidates).to.equal(3);
    });

    it("omits the ordinary comparison when a pool return is censored while the causal arms still fire", async () => {
        // T0+1000 event: ordinary pool {AAA +4, BBB +1}; BBB realized a LOSS
        // so the causal pool is {AAA, PPP} (BBB muted). BBB's 4-bar target
        // covers the T0+500 event's horizon but is one bar short for the
        // T0+1000 event: the ordinary comparison there must be omitted
        // (ONGOING rows, never a zero-filled return) while TOP_RAW_PROFIT_NOW
        // still completes on the untouched causal pool. Four AAA legs keep
        // AAA's mean (4/3) strictly above BBB's (1.0), so the digest cannot
        // hand a TOP pick to the censored asset.
        const entry = (pnl: number): Trade[] => [
            makeTrade("long", T0 + 500, T0 + 800, pnl),
            makeTrade("long", T0 + 1000, null, 0),
        ];
        const pairs = [
            makePair("AAA", "P1", entry(10), 10),
            makePair("AAA", "P2", entry(10), 10),
            makePair("AAA", "P4", entry(10), 10),
            makePair("AAA", "P5", entry(10), 10),
            makePair("BBB", "P3", entry(-3), -3),
            makePair("PPP", "QQQ", entry(7), 7),
            makePair("QQQ", "PPP", [makeTrade("long", T0 + 1000, null, 0)], 0),
        ];
        const targets = [
            makeTarget("AAA", 12, () => 100),
            makeTarget("BBB", 4, () => 50),
            makeTarget("PPP", 12, () => 70),
            makeTarget("P1", 12, () => 10),
            makeTarget("P2", 12, () => 10),
            makeTarget("P3", 12, () => 10),
            makeTarget("P4", 12, () => 10),
            makeTarget("P5", 12, () => 10),
            makeTarget("QQQ", 12, () => 10),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [3], slippageRate: 0, commissionRate: 0, blockCount: 1, includeEventDetails: true },
        );
        // Ordinary h=3 series: only the T0+500 event; the censored T0+1000
        // event is omitted entirely.
        expect(result.horizons[0]!.topRaw.events).to.equal(1);
        // Every positive asset's mean is exactly raw/cnt = 1.0 with all-+1
        // positional votes, so TOP_MEAN ties and the frozen FNV digest
        // deterministically picks BBB — the censored asset — which surfaces as
        // an ONGOING row. TOP_RAW (raw +4 vs +1) completes with AAA and earns
        // no ONGOING row. The picks are censored-event reports, never
        // zero-filled returns.
        const ongoingAtEvent = (result.ongoingEventDetails ?? []).filter((row) => row.decisionTime === T0 + 1000);
        expect(ongoingAtEvent.map((row) => row.selector).sort()).to.deep.equal([
            "BOT_MEAN", "BOT_MEAN_RAW_UNIQUE", "BOT_RAW", "TOP_MEAN",
        ]);
        for (const row of ongoingAtEvent) expect(row.asset).to.equal("BBB");
        // The causal pool {AAA, PPP} is intact: the arm fires with its own
        // two-member denominator.
        expect(result.horizons[0]!.topRawProfitNow.events).to.equal(1);
        const causalTop = detailAt(result, "TOP_RAW_PROFIT_NOW", T0 + 1000)[0]!;
        expect(causalTop.asset).to.equal("AAA");
        expect(causalTop.eligibleCandidates).to.equal(2);
    });
});

// ============================================================================
// Ordinary candidate construction gated on raw > 0 (redundant-work plan
// phase 1): the literal and its adjusted/mean arithmetic are only built for
// the positive pool, while the causal pools and TOP_Z history still process
// every asset. These tests pin that non-positive ordinary scores never lose
// profit/causal participation or TOP_Z history coverage.
// ============================================================================

describe("ordinary candidates constructed only when positive", () => {
    const detailAt = (
        result: Awaited<ReturnType<typeof runOpenScoreUsdReplay>>,
        selector: string,
        decisionTime: number,
    ) => (result.eventDetails ?? []).filter((row) => row.selector === selector && row.decisionTime === decisionTime);

    it("keeps causal coverage alive when the ordinary score is negative but causal votes persist", async () => {
        // At T0+1000 each scored asset (AAA / BBB) carries one profitable,
        // open LONG entry (+1, voteApplied -> causal vote) and two open
        // SHORT entries (-2, unprofitable -> not voteApplied), so the
        // cumulative ordinary score is NEGATIVE and the asset is excluded
        // from every ordinary pool — while the causal pool {AAA, BBB} stays
        // intact. The short quotes sit positive but targetless, so the
        // ordinary comparison is censored; the causal arm must still
        // complete on {AAA, BBB}.
        const negativeOrdinarySet = (asset: string, longEntry: number): BatchSyntheticPairArtifact[] => [
            makePair(asset, `${asset}L`, [
                makeTrade("long", T0 + 500, T0 + 800, 10),
                makeTrade("long", longEntry, null, 0),
            ], 10),
            makePair(asset, `${asset}S1`, [makeTrade("short", T0 + 1000, null, 0)], 0),
            makePair(asset, `${asset}S2`, [makeTrade("short", T0 + 1000, null, 0)], 0),
        ];
        // AAA's fresh entry at T0+900 is alone (no causal pool there);
        // BBB joins at T0+1000, the single firing event.
        const pairs = [
            ...negativeOrdinarySet("AAA", T0 + 900),
            ...negativeOrdinarySet("BBB", T0 + 1000),
        ];
        const targets = [
            makeTarget("AAA", 30, () => 100),
            makeTarget("BBB", 30, () => 50),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], slippageRate: 0, commissionRate: 0, blockCount: 1, includeEventDetails: true },
        );
        expect(detailAt(result, "TOP_RAW", T0 + 1000)).to.have.length(0);
        expect(result.horizons[0]!.topRawProfitNow.events).to.equal(1);
        const causalTop = detailAt(result, "TOP_RAW_PROFIT_NOW", T0 + 1000)[0]!;
        expect(causalTop.eligibleCandidates).to.equal(2);
        expect(["AAA", "BBB"]).to.include(causalTop.asset);
    });

    it("emits TOP_Z for causal positives whose ordinary score is negative", async () => {
        // The same negative-ordinary-score construction for CCC and DDD: the
        // causal pool {CCC, DDD} exists independently of the ordinary pools,
        // so TOP_Z must fire on it — a non-positive ordinary score must not
        // suppress causal arms.
        const negativeOrdinarySet = (asset: string): BatchSyntheticPairArtifact[] => [
            makePair(asset, `${asset}L`, [
                makeTrade("long", T0 + 500, T0 + 800, 10),
                makeTrade("long", T0 + 900, null, 0),
            ], 10),
            makePair(asset, `${asset}S1`, [makeTrade("short", T0 + 1000, null, 0)], 0),
            makePair(asset, `${asset}S2`, [makeTrade("short", T0 + 1000, null, 0)], 0),
        ];
        const pairs = [
            ...negativeOrdinarySet("CCC"),
            ...negativeOrdinarySet("DDD"),
        ];
        const targets = [
            makeTarget("CCC", 30, () => 80),
            makeTarget("DDD", 30, () => 60),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], slippageRate: 0, commissionRate: 0, blockCount: 1, includeEventDetails: true },
        );
        expect(detailAt(result, "TOP_RAW", T0 + 1000)).to.have.length(0);
        const topZ = detailAt(result, "TOP_Z", T0 + 1000);
        expect(topZ).to.have.length(1);
        expect(topZ[0]!.eligibleCandidates).to.equal(2);
        expect(["CCC", "DDD"]).to.include(topZ[0]!.asset);
    });
});

// ============================================================================
// Bootstrap sorted-sample reuse (redundant-work plan phase 3): the optional
// pre-sorted whole-sample view must produce EXACTLY the two-argument path's
// interval — including the sign of zero — because the union feeds only
// <=-rank counts while medians come from the sorted blocks. Sign-aware
// equality (Object.is), non-mutation, and randomized samples pin that.
// ============================================================================

describe("blockBootstrapMedianCi sorted-sample reuse", () => {
    // Sign-exact endpoint equality: null only equals null, and -0 never
    // equals +0 (Object.is).
    const sameEndpoint = (x: number | null, y: number | null): boolean =>
        x === null || y === null ? x === null && y === null : Object.is(x, y);
    const intervalsEqual = (
        a: { lower: number | null; upper: number | null },
        b: { lower: number | null; upper: number | null },
    ): boolean => sameEndpoint(a.lower, b.lower) && sameEndpoint(a.upper, b.upper);

    it("optional and two-argument paths agree exactly across degenerate inputs", () => {
        const scenarios: Array<[string, number[][]]> = [
            ["duplicates everywhere", [[1, 1, -2], [1, 0, 0], [-2, 1, 1]]],
            ["all identical", [[5], [5], [5], [5]]],
            ["signed zeros", [[0, -0, 1], [-0, 0, -1], [0, 2, -0]]],
            ["all signed zeros", [[-0, 0], [0, -0], [-0, -0]]],
            ["negatives only", [[-3, -1], [-2, -1], [-4, -1]]],
            ["uneven sizes", [[1, 2, 3, 4, 5], [0], [9, -9], [2, 2, 2]]],
            ["insufficient blocks", [[1, 2], [3, 4]]],
        ];
        for (const [name, blocks] of scenarios) {
            const sorted = Object.freeze([...blocks.flat()].sort((a, b) => a - b));
            const twoArg = blockBootstrapMedianCi(blocks, 500);
            const threeArg = blockBootstrapMedianCi(blocks, 500, sorted);
            if (!intervalsEqual(twoArg, threeArg)) {
                throw new Error(`${name}: two-arg ${JSON.stringify(twoArg)} != three-arg ${JSON.stringify(threeArg)}`);
            }
        }
    });

    it("optional and two-argument paths agree on randomized duplicate-heavy samples", () => {
        // Fixed-seed LCG so the scenario set is reproducible.
        let seed = 0x9e3779b9;
        const next = (): number => {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            return seed / 0x100000000;
        };
        for (let trial = 0; trial < 30; trial += 1) {
            const blockCount = 4 + Math.floor(next() * 5);
            const blocks: number[][] = [];
            for (let k = 0; k < blockCount; k += 1) {
                const len = 1 + Math.floor(next() * 8);
                const blk: number[] = [];
                for (let i = 0; i < len; i += 1) {
                    // Coarse grid -> heavy duplication; occasional zeros.
                    const roll = next();
                    blk.push(roll < 0.15 ? (roll < 0.075 ? -0 : 0) : Math.round((next() * 2 - 1) * 10) / 4);
                }
                blocks.push(blk);
            }
            const sorted = [...blocks.flat()].sort((a, b) => a - b);
            const twoArg = blockBootstrapMedianCi(blocks, 300);
            const threeArg = blockBootstrapMedianCi(blocks, 300, sorted);
            if (!intervalsEqual(twoArg, threeArg)) {
                throw new Error(`trial ${trial}: ${JSON.stringify(blocks)} -> ${JSON.stringify(twoArg)} != ${JSON.stringify(threeArg)}`);
            }
        }
    });
});

// ============================================================================
// Cap-tilt weighting (docs/open-score-cap-tilt.md)
// ============================================================================

/** Pair artifact carrying marked leg symbols, as the Batch server stores them. */
function makePairWithSymbols(
    base: string,
    quote: string,
    baseSymbol: string,
    quoteSymbol: string,
    trades: Trade[],
): BatchSyntheticPairArtifact {
    return { ...makePair(base, quote, trades), baseSymbol, quoteSymbol };
}

/**
 * Round-trip fixture: pair AAA/BBB long enters at T0+1000 and exits at
 * T0+3000; an UNRELATED pair CCC/DDD long enters (open, end_of_data) at
 * T0+5000. Decision events exist at the two entry timestamps; because the
 * second event's pair does not touch AAA/BBB, the snapshot at T0+5000
 * observes AAA/BBB's rawScore AFTER the round trip exactly — the
 * exact-return invariant.
 */
function capTiltFixture() {
    const roundTrip = makePairWithSymbols("AAA", "BBB", "AAA•", "BBB•", [makeTrade("long", T0 + 1000, T0 + 3000)]);
    const laterEntry = makePairWithSymbols("CCC", "DDD", "CCC•", "DDD•", [makeTrade("long", T0 + 5000, null)]);
    const targets = [
        makeTarget("AAA", 10, () => 100),
        makeTarget("BBB", 10, () => 50),
        makeTarget("CCC", 10, () => 100),
        makeTarget("DDD", 10, () => 100),
    ];
    return { pairs: [roundTrip, laterEntry], targets };
}

function signedVotesByAsset(snapshots: PoolSnapshotRecord[], timeSec: number): Map<string, number> {
    const byAsset = new Map<string, number>();
    for (const row of snapshots) {
        if (row.decisionTimeSec === timeSec) byAsset.set(row.asset, row.signedVotes);
    }
    return byAsset;
}

describe("batch-open-score-usd-replay-engine cap-tilt weighting", () => {
    const T_ENTRY = T0 + 1000;
    const T_AFTER_EXIT = T0 + 5000;

    it("smallBase2x doubles the base entry delta when base cap < quote cap, and rawScore returns exactly to its prior value after the round trip", async () => {
        const fixture = capTiltFixture();
        const result = await runOpenScoreUsdReplay(
            () => fromArray(fixture.pairs),
            () => fromArray(fixture.targets),
            {
                horizons: [2],
                capTiltWeight: "smallBase2x",
                lookupMarketCap: (symbol) => (symbol === "AAA•" ? 100 : symbol === "BBB•" ? 500 : null),
                includePoolSnapshots: true,
            },
        );
        const atEntry = signedVotesByAsset(result.poolSnapshots ?? [], T_ENTRY);
        // Base leg weighted +2; quote leg stays -1.
        expect(atEntry.get("AAA")).to.equal(2);
        expect(atEntry.get("BBB")).to.equal(-1);
        // Round-trip invariant: the exit applies the SAME weight (-2), so the
        // rawScore at the next entry event is exactly its pre-trade value (0).
        const afterRoundTrip = signedVotesByAsset(result.poolSnapshots ?? [], T_AFTER_EXIT);
        expect(afterRoundTrip.get("AAA")).to.equal(0);
        expect(afterRoundTrip.get("BBB")).to.equal(0);
    });

    it("largeBase2x mirrors: doubles the base entry delta when base cap > quote cap", async () => {
        const fixture = capTiltFixture();
        const result = await runOpenScoreUsdReplay(
            () => fromArray(fixture.pairs),
            () => fromArray(fixture.targets),
            {
                horizons: [2],
                capTiltWeight: "largeBase2x",
                lookupMarketCap: (symbol) => (symbol === "AAA•" ? 500 : symbol === "BBB•" ? 100 : null),
                includePoolSnapshots: true,
            },
        );
        const atEntry = signedVotesByAsset(result.poolSnapshots ?? [], T_ENTRY);
        expect(atEntry.get("AAA")).to.equal(2);
        expect(atEntry.get("BBB")).to.equal(-1);
        const afterRoundTrip = signedVotesByAsset(result.poolSnapshots ?? [], T_AFTER_EXIT);
        expect(afterRoundTrip.get("AAA")).to.equal(0);
        expect(afterRoundTrip.get("BBB")).to.equal(0);
    });

    it("similarCap2x balances both legs at the inclusive 3x boundary and freezes their exit weights", async () => {
        for (const [baseCap, quoteCap, weight] of [
            [100, 100, 2], [100, 300, 2], [300, 100, 2],
            [100, 300.01, 1], [300.01, 100, 1],
            [100, null, 1], [null, 100, 1], [0, 100, 1],
        ] as const) {
            const fixture = capTiltFixture();
            const result = await runOpenScoreUsdReplay(
                () => fromArray(fixture.pairs), () => fromArray(fixture.targets),
                {
                    horizons: [2], capTiltWeight: "similarCap2x", includePoolSnapshots: true,
                    lookupMarketCap: (symbol, time) => {
                        // Reverse qualification after entry: exit must undo
                        // the original votes, never look up a new weight.
                        if (symbol === "AAA•") return time === T_ENTRY ? baseCap : weight === 2 ? 10000 : 100;
                        if (symbol === "BBB•") return time === T_ENTRY ? quoteCap : 100;
                        return null;
                    },
                },
            );
            const entry = signedVotesByAsset(result.poolSnapshots ?? [], T_ENTRY);
            expect(entry.get("AAA")).to.equal(weight);
            expect(entry.get("BBB")).to.equal(-weight);
            const afterExit = signedVotesByAsset(result.poolSnapshots ?? [], T_AFTER_EXIT);
            expect(afterExit.get("AAA")).to.equal(0);
            expect(afterExit.get("BBB")).to.equal(0);
            expect(result.reportLines.join("\n")).to.include("capTilt=similarCap2x");
            expect(result.reportLines.join("\n")).to.include("both legs of long pairs x2 (+2/-2) when larger/smaller entry cap <= 3");
            const known = baseCap !== null && quoteCap !== null ? 1 : 0;
            expect(coverageLine(result)).to.equal(`cap tilt coverage | long=2 known=${known} weighted=${weight === 2 ? 1 : 0} unknown=${2 - known}`);
        }
    });

    it("similarCap2x leaves shorts unchanged and retains both votes for open longs in a mixed book", async () => {
        const fixture = capTiltFixture();
        fixture.pairs[0]!.result.trades[0]!.type = "short";
        const result = await runOpenScoreUsdReplay(
            () => fromArray(fixture.pairs), () => fromArray(fixture.targets),
            {
                horizons: [2], capTiltWeight: "similarCap2x", includePoolSnapshots: true,
                lookupMarketCap: () => 100,
            },
        );
        const entry = signedVotesByAsset(result.poolSnapshots ?? [], T_ENTRY);
        expect(entry.get("AAA")).to.equal(-1);
        expect(entry.get("BBB")).to.equal(1);
        const later = signedVotesByAsset(result.poolSnapshots ?? [], T_AFTER_EXIT);
        expect(later.get("AAA")).to.equal(0);
        expect(later.get("BBB")).to.equal(0);
        expect(later.get("CCC")).to.equal(2);
        expect(later.get("DDD")).to.equal(-2);
        expect(coverageLine(result)).to.equal("cap tilt coverage | long=1 known=1 weighted=1 unknown=0");
    });

    it("falls back to weight 1 when either leg's cap is unknown", async () => {
        const fixture = capTiltFixture();
        const lookups = [
            (symbol: string) => (symbol === "AAA•" ? 100 : null), // quote unknown
            (symbol: string) => (symbol === "BBB•" ? 500 : null), // base unknown
        ];
        for (const lookup of lookups) {
            const result = await runOpenScoreUsdReplay(
                () => fromArray(fixture.pairs),
                () => fromArray(fixture.targets),
                { horizons: [2], capTiltWeight: "smallBase2x", lookupMarketCap: lookup, includePoolSnapshots: true },
            );
            const atEntry = signedVotesByAsset(result.poolSnapshots ?? [], T_ENTRY);
            expect(atEntry.get("AAA")).to.equal(1);
            expect(atEntry.get("BBB")).to.equal(-1);
        }
    });

    it("leaves short pairs at ±1 even when the cap tilt would qualify", async () => {
        const fixture = capTiltFixture();
        const shortRoundTrip = makePairWithSymbols("AAA", "BBB", "AAA•", "BBB•", [makeTrade("short", T0 + 1000, T0 + 3000)]);
        const result = await runOpenScoreUsdReplay(
            () => fromArray([shortRoundTrip, fixture.pairs[1]!]),
            () => fromArray(capTiltFixture().targets),
            {
                horizons: [2],
                capTiltWeight: "smallBase2x",
                lookupMarketCap: (symbol) => (symbol === "AAA•" ? 100 : symbol === "BBB•" ? 500 : null),
                includePoolSnapshots: true,
            },
        );
        const atEntry = signedVotesByAsset(result.poolSnapshots ?? [], T_ENTRY);
        expect(atEntry.get("AAA")).to.equal(-1);
        expect(atEntry.get("BBB")).to.equal(1);
        const afterRoundTrip = signedVotesByAsset(result.poolSnapshots ?? [], T_AFTER_EXIT);
        expect(afterRoundTrip.get("AAA")).to.equal(0);
        expect(afterRoundTrip.get("BBB")).to.equal(0);
    });

    it("keeps the quote leg at ±1 and treats equal caps as weight 1", async () => {
        const fixture = capTiltFixture();
        // Equal caps: neither tilt condition matches -> weight 1 everywhere.
        const equal = await runOpenScoreUsdReplay(
            () => fromArray(fixture.pairs),
            () => fromArray(fixture.targets),
            {
                horizons: [2],
                capTiltWeight: "smallBase2x",
                lookupMarketCap: () => 100,
                includePoolSnapshots: true,
            },
        );
        const equalAtEntry = signedVotesByAsset(equal.poolSnapshots ?? [], T_ENTRY);
        expect(equalAtEntry.get("AAA")).to.equal(1);
        expect(equalAtEntry.get("BBB")).to.equal(-1);
        const equalAfter = signedVotesByAsset(equal.poolSnapshots ?? [], T_AFTER_EXIT);
        expect(equalAfter.get("AAA")).to.equal(0);
        expect(equalAfter.get("BBB")).to.equal(0);

        // Qualifying tilt: the quote is still exactly -1 at entry and returns
        // to 0 after the round trip (+1 exit delta).
        const tilted = await runOpenScoreUsdReplay(
            () => fromArray(fixture.pairs),
            () => fromArray(fixture.targets),
            {
                horizons: [2],
                capTiltWeight: "smallBase2x",
                lookupMarketCap: (symbol) => (symbol === "AAA•" ? 100 : 500),
                includePoolSnapshots: true,
            },
        );
        const tiltedAtEntry = signedVotesByAsset(tilted.poolSnapshots ?? [], T_ENTRY);
        expect(tiltedAtEntry.get("AAA")).to.equal(2);
        expect(tiltedAtEntry.get("BBB")).to.equal(-1);
        const tiltedAfter = signedVotesByAsset(tilted.poolSnapshots ?? [], T_AFTER_EXIT);
        expect(tiltedAfter.get("BBB")).to.equal(0);
    });

    it("falls back to the asset name when the artifact carries no leg symbols", async () => {
        const trades = [makeTrade("long", T0 + 1000, null)];
        const pair = makePair("AAA", "BBB", trades); // no baseSymbol/quoteSymbol
        const result = await runOpenScoreUsdReplay(
            () => fromArray([pair]),
            () => fromArray(capTiltFixture().targets),
            {
                horizons: [2],
                capTiltWeight: "smallBase2x",
                lookupMarketCap: (symbol) => (symbol === "AAA" ? 100 : symbol === "BBB" ? 500 : null),
                includePoolSnapshots: true,
            },
        );
        const atEntry = signedVotesByAsset(result.poolSnapshots ?? [], T0 + 1000);
        expect(atEntry.get("AAA")).to.equal(2);
        expect(atEntry.get("BBB")).to.equal(-1);
    });

    it("treats capTiltWeight set without a lookup as off (defensive)", async () => {
        const fixture = capTiltFixture();
        const result = await runOpenScoreUsdReplay(
            () => fromArray(fixture.pairs),
            () => fromArray(fixture.targets),
            { horizons: [2], capTiltWeight: "smallBase2x", includePoolSnapshots: true },
        );
        const atEntry = signedVotesByAsset(result.poolSnapshots ?? [], T_ENTRY);
        expect(atEntry.get("AAA")).to.equal(1);
        expect(atEntry.get("BBB")).to.equal(-1);
        const report = result.reportLines.join("\n");
        expect(report).to.include("capTilt=off");
        expect(report).to.not.include("cap tilt |");
    });

    it("echoes the weighting in the config line and documents the semantics when active", async () => {
        const fixture = capTiltFixture();
        const off = await runOpenScoreUsdReplay(
            () => fromArray(fixture.pairs),
            () => fromArray(fixture.targets),
            { horizons: [2] },
        );
        const offReport = off.reportLines.join("\n");
        expect(offReport).to.include("capTilt=off");
        expect(offReport).to.not.include("cap tilt |");

        const cases = [
            { weight: "smallBase2x", semanticFragment: "base cap < quote cap" },
            { weight: "largeBase2x", semanticFragment: "base cap > quote cap" },
        ] as const;
        for (const { weight, semanticFragment } of cases) {
            const tilted = await runOpenScoreUsdReplay(
                () => fromArray(fixture.pairs),
                () => fromArray(fixture.targets),
                {
                    horizons: [2],
                    capTiltWeight: weight,
                    lookupMarketCap: (symbol) => (symbol === "AAA•" ? 100 : 500),
                },
            );
            const report = tilted.reportLines.join("\n");
            expect(report).to.include(`capTilt=${weight}`);
            expect(report).to.include(`cap tilt | base leg of long pairs x2 when ${semanticFragment} at entry`);
        }
    });

    // Coverage telemetry: the tilt can be ON while silently applying weight 1
    // to most long trades (unknown caps / unmet condition). The report line
    // makes under-covered runs visible; known + unknown = long and
    // weighted <= known. The UI renders reportLines verbatim, so an opaque
    // line is the whole contract.
    const coverageLine = (result: { reportLines: string[] }): string =>
        result.reportLines.find((line) => line.startsWith("cap tilt coverage |")) ?? "";

    it("reports full coverage when every long trade has known caps (weighted per tilt condition)", async () => {
        const fixture = capTiltFixture();
        // AAA/BBB long qualifies (100 < 500); CCC/DDD long has equal caps
        // (500/500) so it counts as known but not weighted.
        const result = await runOpenScoreUsdReplay(
            () => fromArray(fixture.pairs),
            () => fromArray(fixture.targets),
            {
                horizons: [2],
                capTiltWeight: "smallBase2x",
                lookupMarketCap: (symbol) => (symbol === "AAA•" ? 100 : 500),
            },
        );
        expect(coverageLine(result)).to.equal("cap tilt coverage | long=2 known=2 weighted=1 unknown=0");
    });

    it("reports partial coverage when a leg's cap is unknown (weight degraded to 1)", async () => {
        const fixture = capTiltFixture();
        // Only AAA•/BBB• resolve; the CCC/DDD trade has both caps unknown.
        const result = await runOpenScoreUsdReplay(
            () => fromArray(fixture.pairs),
            () => fromArray(fixture.targets),
            {
                horizons: [2],
                capTiltWeight: "smallBase2x",
                lookupMarketCap: (symbol) => (symbol === "AAA•" ? 100 : symbol === "BBB•" ? 500 : null),
            },
        );
        expect(coverageLine(result)).to.equal("cap tilt coverage | long=2 known=1 weighted=1 unknown=1");
    });

    it("separates window entries from old history and unknown carry-in without changing entry weights", async () => {
        const fixture = capTiltFixture();
        fixture.pairs[0]!.result.trades.push(makeTrade("long", T0 + 2000, null));
        fixture.pairs[1]!.result.trades.push(makeTrade("long", T0 + 7000, null));
        const lookupMarketCap = (symbol: string, time: number) =>
            symbol === "AAA•" && time < T0 + 4000 ? null : symbol === "CCC•" ? 100 : 500;
        const options = {
            horizons: [2], capTiltWeight: "smallBase2x" as const,
            lookupMarketCap, includePoolSnapshots: true,
        };
        const full = await runOpenScoreUsdReplay(
            () => fromArray(fixture.pairs), () => fromArray(fixture.targets), options,
        );
        const bounded = await runOpenScoreUsdReplay(
            () => fromArray(fixture.pairs), () => fromArray(fixture.targets),
            { ...options, sampleFromSec: T0 + 5000, sampleToSec: T0 + 5000 },
        );
        expect(coverageLine(bounded)).to.equal("cap tilt coverage | long=4 known=2 weighted=2 unknown=2");
        expect(bounded.reportLines).to.include("cap tilt entries in window | long=1 known=1 weighted=1 unknown=0");
        expect(bounded.reportLines).to.include("cap tilt carried into window | long=1 known=0 weighted=0 unknown=1");
        expect(bounded.reportLines).to.include("cap tilt unknown assets | window entries + carry-in, missing leg counts (a trade can count twice): AAA=1");
        // Looking up the carry-in at window start would wrongly use its now
        // available cap. Restricting report dates must preserve historical votes.
        expect(signedVotesByAsset(bounded.poolSnapshots ?? [], T0 + 5000)).to.deep.equal(
            signedVotesByAsset(full.poolSnapshots ?? [], T0 + 5000),
        );
        expect(signedVotesByAsset(bounded.poolSnapshots ?? [], T0 + 5000).get("AAA")).to.equal(1);
    });

    it("reports zero qualifying trades (short-only universe) without omitting the line", async () => {
        const shortRoundTrip = makePairWithSymbols("AAA", "BBB", "AAA•", "BBB•", [makeTrade("short", T0 + 1000, T0 + 3000)]);
        const laterShort = makePairWithSymbols("CCC", "DDD", "CCC•", "DDD•", [makeTrade("short", T0 + 5000, null)]);
        const result = await runOpenScoreUsdReplay(
            () => fromArray([shortRoundTrip, laterShort]),
            () => fromArray(capTiltFixture().targets),
            {
                horizons: [2],
                capTiltWeight: "smallBase2x",
                lookupMarketCap: () => 100,
            },
        );
        expect(coverageLine(result)).to.equal("cap tilt coverage | long=0 known=0 weighted=0 unknown=0");
    });

    it("reports equal-cap fallback as known but never weighted", async () => {
        const fixture = capTiltFixture();
        const result = await runOpenScoreUsdReplay(
            () => fromArray(fixture.pairs),
            () => fromArray(fixture.targets),
            {
                horizons: [2],
                capTiltWeight: "largeBase2x",
                lookupMarketCap: () => 100,
            },
        );
        expect(coverageLine(result)).to.equal("cap tilt coverage | long=2 known=2 weighted=0 unknown=0");
    });

    it("omits the coverage line when the effective tilt is off (weight without lookup, or not requested)", async () => {
        const fixture = capTiltFixture();
        const weightNoLookup = await runOpenScoreUsdReplay(
            () => fromArray(fixture.pairs),
            () => fromArray(fixture.targets),
            { horizons: [2], capTiltWeight: "smallBase2x" },
        );
        expect(coverageLine(weightNoLookup)).to.equal("");
        const noTilt = await runOpenScoreUsdReplay(
            () => fromArray(fixture.pairs),
            () => fromArray(fixture.targets),
            { horizons: [2] },
        );
        expect(coverageLine(noTilt)).to.equal("");
    });
});

describe("batch-open-score-usd-replay-engine inverted (BOT_*) arms", () => {
    const decision = T0 + 1000;

    // Direct markets whose open votes give each asset a distinct raw score and
    // mean: AAA raw=1/mean=1, BBB raw=2/mean=2/22 (12 longs + 10 shorts),
    // CCC raw=3/mean=1. Min raw and min mean therefore pick different assets.
    const unequalScoresFixture = () => ({
        markets: [
            makeDirectMarket("AAA", [makeTrade("long", decision, null)]),
            makeDirectMarket("BBB", [
                ...Array.from({ length: 12 }, () => makeTrade("long", decision, null)),
                ...Array.from({ length: 10 }, () => makeTrade("short", decision, null)),
            ]),
            makeDirectMarket("CCC", [
                makeTrade("long", decision, null),
                makeTrade("long", decision, null),
                makeTrade("long", decision, null),
            ]),
        ],
        targets: ["AAA", "BBB", "CCC"].map((asset) => makeTarget(asset, 10, () => 100)),
    });

    it("BOT_RAW / BOT_MEAN select the lowest raw / mean from the same pool", async () => {
        const { markets, targets } = unequalScoresFixture();
        const result = await runOpenScoreUsdReplay(
            () => fromArray(markets),
            () => fromArray(targets),
            { horizons: [2], slippageRate: 0, commissionRate: 0, blockCount: 1, includeEventDetails: true },
        );
        const h = result.horizons[0]!;
        // Inverted picks hit the bottom of the ranking; TOP_RAW hits the top.
        expect(h.botRaw.events).to.equal(1);
        expect(h.botRawByAsset).to.have.length(1);
        expect(h.botRawByAsset[0]!.asset).to.equal("AAA");
        expect(h.botMeanByAsset[0]!.asset).to.equal("BBB");
        // Only one eligible event per arm and its dominant asset is the only
        // one selected, so the exclusion comparison has nothing left.
        expect(h.botRawDominantAsset).to.equal("AAA");
        expect(h.botRawExDominant.events).to.equal(0);
        expect(h.botMeanExDominant.events).to.equal(0);
        const detail = result.eventDetails?.find(
            (row) => row.selector === "BOT_RAW" && row.decisionTime === decision,
        );
        expect(detail?.asset).to.equal("AAA");
        expect(detail?.eligibleCandidates).to.equal(3);
        // Latest picks: the same pools, min order.
        const latestBySelector = new Map(
            (result.latestSelections?.selections ?? []).map((selection) => [selection.selector, selection]),
        );
        expect(latestBySelector.get("BOT_RAW")?.asset).to.equal("AAA");
        expect(latestBySelector.get("BOT_MEAN")?.asset).to.equal("BBB");
        const report = result.reportLines.join("\n");
        expect(report).to.include("BOT_RAW selected assets = AAA:n=1");
        expect(report).to.include("BOT_MEAN selected assets = BBB:n=1");
        expect(report).to.include("BOT_RAW_EX_");
        expect(report).to.include("BOT_MEAN_EX_");
        // The removed conditional-split arms must be gone completely.
        for (const removed of ["RAW_FRESH", "RAW_STALE", "RAW_STALE_SHORT", "RAW_STALE_LONG", "RAW_DOMINANT", "RAW_SPREAD", "RAW_HI_PAIRS", "RAW_LO_PAIRS"]) {
            expect(report).to.not.include(removed);
        }
    });

    it("BOT_MEAN_RAW_UNIQUE selects the unique raw minimum of the bottom-mean tied set", async () => {
        // Bottom-mean tied set {AAA, BBB} at mean=1/3 (2L1S -> raw1, 4L2S ->
        // raw2); unique raw minimum is AAA. CCC (3L) sits at mean=1.
        const markets = [
            makeDirectMarket("AAA", [
                makeTrade("long", decision, null),
                makeTrade("long", decision, null),
                makeTrade("short", decision, null),
            ]),
            makeDirectMarket("BBB", [
                ...Array.from({ length: 4 }, () => makeTrade("long", decision, null)),
                ...Array.from({ length: 2 }, () => makeTrade("short", decision, null)),
            ]),
            makeDirectMarket("CCC", [
                makeTrade("long", decision, null),
                makeTrade("long", decision, null),
                makeTrade("long", decision, null),
            ]),
        ];
        const targets = ["AAA", "BBB", "CCC"].map((asset) => makeTarget(asset, 10, () => 100));
        const result = await runOpenScoreUsdReplay(
            () => fromArray(markets),
            () => fromArray(targets),
            { horizons: [2], slippageRate: 0, commissionRate: 0, blockCount: 1, includeEventDetails: true },
        );
        const h = result.horizons[0]!;
        expect(h.botMeanRawUnique.events).to.equal(1);
        expect(h.botMeanRawUniqueByAsset[0]!.asset).to.equal("AAA");
        // Control pool is the bottom-mean tied set (2 members), not all 3.
        const detail = result.eventDetails?.find((row) => row.selector === "BOT_MEAN_RAW_UNIQUE");
        expect(detail?.asset).to.equal("AAA");
        expect(detail?.eligibleCandidates).to.equal(2);
        expect(result.latestSelections?.selections.find(
            (selection) => selection.selector === "BOT_MEAN_RAW_UNIQUE",
        )?.asset).to.equal("AAA");
        const report = result.reportLines.join("\n");
        expect(report).to.include("BOT_MEAN_RAW_UNIQUE selected assets = AAA:n=1");
        expect(report).to.include("BOT_MEAN_RAW_UNIQUE_EX_");
    });

    it("BOT_MEAN_RAW_UNIQUE skips a residual raw tie inside the bottom-mean tied set", async () => {
        // All means equal 1 (open longs only); raw minimum 1 is shared by AAA
        // and BBB, so the inverted unique arm records no selection.
        const markets = [
            makeDirectMarket("AAA", [makeTrade("long", decision, null)]),
            makeDirectMarket("BBB", [makeTrade("long", decision, null)]),
            makeDirectMarket("CCC", [
                makeTrade("long", decision, null),
                makeTrade("long", decision, null),
            ]),
        ];
        const targets = ["AAA", "BBB", "CCC"].map((asset) => makeTarget(asset, 10, () => 100));
        const result = await runOpenScoreUsdReplay(
            () => fromArray(markets),
            () => fromArray(targets),
            { horizons: [2], slippageRate: 0, commissionRate: 0, blockCount: 1, includeEventDetails: true },
        );
        expect(result.horizons[0]!.botMeanRawUnique.events).to.equal(0);
        expect(result.eventDetails?.some((row) => row.selector === "BOT_MEAN_RAW_UNIQUE")).to.equal(false);
    });

    it("BOT causal profit-now arms pick the lowest raw / mean / z of the PROFIT_NOW pool", async () => {
        // Mirror of the TOP_Z fixture: AAA and CCC are profitable-now at the
        // second decision, BBB is not (its vote closed before it).
        const decision1 = T0 + 1000;
        const decision2 = T0 + 5000;
        const markets = [
            makeDirectMarket("AAA", [
                makeTrade("long", T0 + 100, T0 + 200, 10),
                makeTrade("long", decision1, null),
            ]),
            makeDirectMarket("BBB", [
                makeTrade("long", T0 + 100, T0 + 200, 10),
                makeTrade("long", decision1, T0 + 2000, 5),
            ]),
            makeDirectMarket("CCC", [
                makeTrade("long", T0 + 300, T0 + 400, 10),
                makeTrade("long", decision2, null),
                makeTrade("long", decision2, null),
                makeTrade("long", decision2, null),
                makeTrade("short", decision2, null),
            ]),
        ];
        const targets = ["AAA", "BBB", "CCC"].map((asset) => makeTarget(asset, 12, () => 100));
        const result = await runOpenScoreUsdReplay(
            () => fromArray(markets),
            () => fromArray(targets),
            { horizons: [2], slippageRate: 0, commissionRate: 0, blockCount: 1, includeEventDetails: true },
        );
        // At decision2 the causal pool is AAA (raw=1, mean=1, z=0) and
        // CCC (raw=2, mean=0.5, z=2): min raw and min z -> AAA, min mean -> CCC.
        const detail2 = (selector: string) =>
            result.eventDetails?.find((row) => row.selector === selector && row.decisionTime === decision2);
        expect(detail2("BOT_RAW_PROFIT_NOW")?.asset).to.equal("AAA");
        expect(detail2("BOT_MEAN_PROFIT_NOW")?.asset).to.equal("CCC");
        expect(detail2("BOT_Z")?.asset).to.equal("AAA");
        expect(detail2("TOP_Z")?.asset).to.equal("CCC");
        const h = result.horizons[0]!;
        // Both decision events carry a >= 2 causal pool (AAA+BBB at decision1,
        // AAA+CCC at decision2), so each inverted causal arm fires twice; the
        // decision1 picks are raw/mean/z ties resolved by digest and are only
        // asserted through the deterministic decision2 details above.
        expect(h.botRawProfitNow.events).to.equal(2);
        expect(h.botMeanProfitNow.events).to.equal(2);
        // CCC is never the min-z pick (z=2 vs AAA's 0); AAA always is at decision2.
        expect(h.botZByAsset.some((row) => row.asset === "AAA")).to.equal(true);
        expect(h.botZByAsset.some((row) => row.asset === "CCC")).to.equal(false);
        expect(result.latestSelections?.selections.find(
            (selection) => selection.selector === "BOT_Z",
        )?.asset).to.equal("AAA");
        const report = result.reportLines.join("\n");
        expect(report).to.include("BOT_RAW_PROFIT_NOW selected assets = ");
        expect(report).to.include("BOT_MEAN_PROFIT_NOW selected assets = ");
        expect(report).to.include("BOT_RAW_PROFIT_NOW_EX_");
        expect(report).to.include("BOT_MEAN_PROFIT_NOW_EX_");
        expect(report).to.include("BOT_Z_EX_");
    });
});

describe("runOpenScoreUsdReplay shared outcome cache (annual-reload finding)", () => {
    // Annual windows are time slices of the first pass's window, so their
    // per-event request sets are strict subsets. Outcomes are pure functions
    // of (dataset, decision time, horizon) — the shared cache must therefore
    // serve every later pass with ZERO additional dataset loads and produce
    // results identical to a cold run of the same window.
    const cacheMarkets = (decision1: number, decision2: number) => [
        makeDirectMarket("AAA", [
            makeTrade("long", T0 + 100, T0 + 200, 10),
            makeTrade("long", decision1, null),
            makeTrade("long", decision2, null),
        ]),
        makeDirectMarket("BBB", [
            makeTrade("long", T0 + 100, T0 + 200, 10),
            makeTrade("long", decision1, null),
            makeTrade("long", decision2, null),
        ]),
    ];
    const cacheTargets = new Map([
        ["AAA", makeTarget("AAA", 12, () => 100).data],
        ["BBB", makeTarget("BBB", 12, (i) => 100 + i).data],
    ]);
    const cacheLoaderOptions = {
        horizons: [2],
        slippageRate: 0,
        commissionRate: 0,
        blockCount: 1,
        includeEventDetails: true,
        loadTargetDataset: async (asset: string): Promise<OHLCVData[] | null> => cacheTargets.get(asset) ?? null,
    };
    type SharedCacheSpec = import("../lib/batch-backtest/batch-open-score-usd-replay-engine").OpenScoreUsdSharedTargetCacheEntry;

    it("serves annual passes from the cache with zero loads and identical results", async () => {
        const decision1 = T0 + 1000;
        const decision2 = T0 + 5000;
        const sharedTargetCache = new Map<string, SharedCacheSpec>();
        let loads = 0;
        const countingLoader = async (asset: string): Promise<OHLCVData[] | null> => {
            loads += 1;
            return cacheLoaderOptions.loadTargetDataset(asset);
        };
        const run = (sampleFromSec: number) => runOpenScoreUsdReplay(
            () => fromArray(cacheMarkets(decision1, decision2)),
            undefined,
            {
                ...cacheLoaderOptions,
                loadTargetDataset: countingLoader,
                prefetchTargetDatasets: () => undefined,
                sharedTargetCache,
                sampleFromSec,
            },
        );

        const fullPass = await run(T0);
        const loadsAfterFullPass = loads;
        expect(loadsAfterFullPass).to.equal(2, "each target dataset loads exactly once");

        const annualPass = await run(decision2);
        expect(loads).to.equal(loadsAfterFullPass, "the annual pass must load zero additional datasets");

        const coldAnnual = await runOpenScoreUsdReplay(
            () => fromArray(cacheMarkets(decision1, decision2)),
            undefined,
            { ...cacheLoaderOptions, sampleFromSec: decision2 },
        );
        expect(coldAnnual.horizons).to.deep.equal(annualPass.horizons);
        expect(coldAnnual.eventDetails).to.deep.equal(annualPass.eventDetails);
        expect(coldAnnual.eligibleEvents).to.equal(annualPass.eligibleEvents);

        const coldFull = await runOpenScoreUsdReplay(
            () => fromArray(cacheMarkets(decision1, decision2)),
            undefined,
            { ...cacheLoaderOptions, sampleFromSec: T0 },
        );
        expect(coldFull.horizons).to.deep.equal(fullPass.horizons);
        expect(coldFull.eventDetails).to.deep.equal(fullPass.eventDetails);
    });

    it("preserves cooldown boundaries on cache hits, resets annual passes, and keeps zero at legacy parity", async () => {
        const decision1 = T0 + 1000;
        const decision2 = T0 + 5000;
        const sharedTargetCache = new Map<string, SharedCacheSpec>();
        let loads = 0;
        const countingLoader = async (asset: string): Promise<OHLCVData[] | null> => {
            loads += 1;
            return cacheLoaderOptions.loadTargetDataset(asset);
        };
        const runWithCache = (sampleFromSec: number) => runOpenScoreUsdReplay(
            () => fromArray(cacheMarkets(decision1, decision2)),
            undefined,
            {
                ...cacheLoaderOptions,
                selectionCooldownBars: 10,
                loadTargetDataset: countingLoader,
                prefetchTargetDatasets: () => undefined,
                sharedTargetCache,
                sampleFromSec,
            },
        );

        const full = await runWithCache(T0);
        expect(loads).to.equal(2);
        expect(sharedTargetCache.get("AAA")?.boundaryIndexByEventTimeSec?.get(decision1)).to.equal(1);
        expect(sharedTargetCache.get("AAA")?.boundaryIndexByEventTimeSec?.get(decision2)).to.equal(5);
        const topMeanDetails = full.eventDetails?.filter((row) => row.selector === "TOP_MEAN" && row.horizonBars === 2) ?? [];
        expect(topMeanDetails.map((row) => row.decisionTime)).to.deep.equal([T0 + 100]);
        expect(full.horizons[0]!.topMean.events).to.equal(1, "the fallback singleton is selected but has no paired comparison");

        const annual = await runWithCache(decision2);
        expect(loads).to.equal(2, "cached target outcomes and candle boundaries avoid annual reloads");
        const coldAnnual = await runOpenScoreUsdReplay(
            () => fromArray(cacheMarkets(decision1, decision2)),
            undefined,
            { ...cacheLoaderOptions, selectionCooldownBars: 10, sampleFromSec: decision2 },
        );
        expect(annual.horizons).to.deep.equal(coldAnnual.horizons);
        expect(annual.eventDetails).to.deep.equal(coldAnnual.eventDetails);
        expect(annual.latestSelections).to.deep.equal(coldAnnual.latestSelections);

        const implicitOff = await runOpenScoreUsdReplay(
            () => fromArray(cacheMarkets(decision1, decision2)),
            undefined,
            { ...cacheLoaderOptions },
        );
        const explicitOff = await runOpenScoreUsdReplay(
            () => fromArray(cacheMarkets(decision1, decision2)),
            undefined,
            { ...cacheLoaderOptions, selectionCooldownBars: 0 },
        );
        expect(explicitOff.horizons).to.deep.equal(implicitOff.horizons);
        expect(explicitOff.eventDetails).to.deep.equal(implicitOff.eventDetails);
        expect(explicitOff.latestSelections).to.deep.equal(implicitOff.latestSelections);
    });

    it("noData markers are cached so later passes never reload the dataset", async () => {
        // decision2 is beyond the dataset end: entry resolution fails for it.
        // The null marker must be cached, not re-discovered by a reload.
        const decision1 = T0 + 1000;
        const decision2 = T0 + 900_000; // last bar is T0 + 11_000
        const shortDatasets = new Map([
            ["AAA", makeTarget("AAA", 12, () => 100).data],
            ["BBB", makeTarget("BBB", 12, () => 50).data],
        ]);
        const sharedTargetCache = new Map<string, SharedCacheSpec>();
        let loads = 0;
        const run = (sampleFromSec: number) => runOpenScoreUsdReplay(
            () => fromArray(cacheMarkets(decision1, decision2)),
            undefined,
            {
                ...cacheLoaderOptions,
                loadTargetDataset: async (asset: string): Promise<OHLCVData[] | null> => {
                    loads += 1;
                    return shortDatasets.get(asset) ?? null;
                },
                prefetchTargetDatasets: () => undefined,
                sharedTargetCache,
                sampleFromSec,
            },
        );

        const fullPass = await run(T0);
        const annualPass = await run(decision2);
        expect(loads).to.equal(2, "noData events must not trigger dataset reloads");
        const coldAnnual = await runOpenScoreUsdReplay(
            () => fromArray(cacheMarkets(decision1, decision2)),
            undefined,
            {
                ...cacheLoaderOptions,
                loadTargetDataset: async (asset: string): Promise<OHLCVData[] | null> => shortDatasets.get(asset) ?? null,
                sampleFromSec: decision2,
            },
        );
        expect(coldAnnual.horizons).to.deep.equal(annualPass.horizons);
        expect(coldAnnual.eventDetails).to.deep.equal(annualPass.eventDetails);
        expect(coldAnnual.warnings.filter((w) => w.includes("no target bar"))).to.deep.equal(
            annualPass.warnings.filter((w) => w.includes("no target bar")),
        );
        expect(fullPass.warnings.some((w) => w.includes("no target bar"))).to.equal(true);
    });

    it("cached gap intervals reproduce per-window data-gap exclusions", async () => {
        // BBB carries a 41-day candle hole strictly after window1 but before
        // decision2: excluded from the full-window and window2 pools, usable
        // in window1. CCC keeps every event above the two-usable-candidates
        // floor so eligibleCounts differ per window. Cached passes must agree
        // with cold runs while each dataset loads exactly once (plus BBB's
        // one fallback reload for window1, where its gap does not apply).
        const day = 86_400;
        // Day-scale bars so both decision timestamps resolve entry bars.
        const dayBars = (price: (i: number) => number): OHLCVData[] =>
            Array.from({ length: 80 }, (_, i) => {
                const p = price(i);
                return { time: (T0 + i * day) as Time, open: p, high: p, low: p, close: p, volume: 1 };
            });
        const bbbData: OHLCVData[] = [
            ...Array.from({ length: 16 }, (_, i) => {
                const p = 100;
                return { time: (T0 + i * day) as Time, open: p, high: p, low: p, close: p, volume: 1 };
            }),
            ...Array.from({ length: 15 }, (_, i) => {
                const p = 110;
                return { time: (T0 + (56 + i) * day) as Time, open: p, high: p, low: p, close: p, volume: 1 };
            }),
        ];
        const gappedDatasets = new Map([
            ["AAA", dayBars((i) => 100 + i)],
            ["BBB", bbbData],
            ["CCC", dayBars((i) => 90 - i)],
        ]);
        const gappedMarkets = (decision1: number, decision2: number) => [
            ...cacheMarkets(decision1, decision2),
            makeDirectMarket("CCC", [
                makeTrade("long", T0 + 100, T0 + 200, 10),
                makeTrade("long", decision1, null),
                makeTrade("long", decision2, null),
            ]),
        ];
        const decision1 = T0 + 5 * day;
        const decision2 = T0 + 30 * day;
        const window1From = T0;
        const window1To = T0 + 10 * day;
        const window2From = T0 + 20 * day;
        const sharedTargetCache = new Map<string, SharedCacheSpec>();
        let loads = 0;
        const run = (sampleFromSec: number, sampleToSec?: number) => runOpenScoreUsdReplay(
            () => fromArray(gappedMarkets(decision1, decision2)),
            undefined,
            {
                ...cacheLoaderOptions,
                loadTargetDataset: async (asset: string): Promise<OHLCVData[] | null> => {
                    loads += 1;
                    return gappedDatasets.get(asset) ?? null;
                },
                prefetchTargetDatasets: () => undefined,
                sharedTargetCache,
                sampleFromSec,
                ...(sampleToSec !== undefined ? { sampleToSec } : {}),
            },
        );

        const fullPass = await run(T0);
        const window1Pass = await run(window1From, window1To);
        const window2Pass = await run(window2From);
        // BBB is gap-excluded in the full pass, so its decision1 outcome was
        // never computed: window1 (where the gap does not apply) reloads BBB
        // exactly once and caches the outcomes.
        expect(loads).to.equal(4, "gap-skipped assets reload once for windows where the gap does not apply");

        const detailWith = (result: Awaited<ReturnType<typeof run>>, decision: number) =>
            result.eventDetails?.find((row) => row.selector === "TOP_RAW" && row.decisionTime === decision);
        // Full window: the gap overlaps it -> BBB excluded from the decision2 pool.
        expect(detailWith(fullPass, decision2)?.eligibleCandidates).to.equal(2);
        // Window1: the hole starts after window1To -> BBB stays usable.
        expect(detailWith(window1Pass, decision1)?.eligibleCandidates).to.equal(3);
        // Window2: the hole overlaps it -> BBB excluded again.
        expect(detailWith(window2Pass, decision2)?.eligibleCandidates).to.equal(2);

        const coldWindow1 = await runOpenScoreUsdReplay(
            () => fromArray(gappedMarkets(decision1, decision2)),
            undefined,
            {
                ...cacheLoaderOptions,
                loadTargetDataset: async (asset: string): Promise<OHLCVData[] | null> => gappedDatasets.get(asset) ?? null,
                sampleFromSec: window1From,
                sampleToSec: window1To,
            },
        );
        expect(coldWindow1.horizons).to.deep.equal(window1Pass.horizons);
        expect(coldWindow1.eventDetails).to.deep.equal(window1Pass.eventDetails);
    });

    it("requires a target source: neither loader nor lazy dataset source throws", async () => {
        let thrown: Error | null = null;
        try {
            await runOpenScoreUsdReplay(() => fromArray(cacheMarkets(T0 + 1000, T0 + 5000)), undefined, {
                horizons: [2],
            });
        } catch (error) {
            thrown = error as Error;
        }
        expect(thrown?.message ?? "").to.match(/targetLoader or loadTargetDataset/);
    });
});


describe("runOpenScoreUsdReplay pool evaluation baselines (top-mean coordinator optimization plan, phase 1)", () => {
    // Parity baselines for the shared pool evaluation refactor: the four
    // causal appender calls over one profitNowPositives pool must gate
    // together (any non-finite member return omits the completed event from
    // all four at that horizon), a candidate censored at a longer horizon
    // must not invalidate a shorter horizon, a censored pick must stay
    // visible as an ongoing row while its completed comparison is omitted,
    // and the full-window profit / confidence pools must keep their own
    // gates. These fixtures were captured against the pre-refactor engine;
    // every value below is part of the locked output.
    const decision = T0 + 1000;
    // Entry bar = first bar strictly after the decision timestamp (index 2).
    // BBB ends at index 2, so horizon 2 is right-censored for BBB only.
    const baselineTargets = [
        makeTarget("AAA", 12, (i) => 100 + i),
        makeTarget("BBB", 3, (i) => 100 + i),
        makeTarget("CCC", 12, (i) => 100 + 2 * i),
    ];
    const baselineOptions = {
        horizons: [1, 2],
        slippageRate: 0,
        commissionRate: 0,
        blockCount: 1,
        includeEventDetails: true,
    };
    // Realized pnl before the decision gives each asset a causal vote; open
    // longs at the decision supply the raw signal votes. BBB's second open
    // long makes it the deterministic raw/z pick (highest open-vote raw) and
    // the asset censored at horizon 2.
    const baselineMarkets = [
        makeDirectMarket("AAA", [
            makeTrade("long", T0 + 100, T0 + 200, 10),
            makeTrade("long", decision, null),
        ]),
        makeDirectMarket("BBB", [
            makeTrade("long", T0 + 100, T0 + 200, 40),
            makeTrade("long", decision, null),
            makeTrade("long", decision, null),
        ]),
        makeDirectMarket("CCC", [
            makeTrade("long", T0 + 100, T0 + 200, 10),
            makeTrade("long", decision, null),
        ]),
    ];
    const causalRows = (result: Awaited<ReturnType<typeof runOpenScoreUsdReplay>>, horizonIndex: number) => {
        const h = result.horizons[horizonIndex]!;
        return {
            topRawProfitNow: h.topRawProfitNow.events,
            topMeanProfitNow: h.topMeanProfitNow.events,
            topZ: h.topZ.events,
            topRawProfitNowConf: h.topRawProfitNowConf.events,
            botRawProfitNow: h.botRawProfitNow.events,
            botMeanProfitNow: h.botMeanProfitNow.events,
            botZ: h.botZ.events,
        };
    };

    it("gates all four causal appender calls together per horizon and keeps censored picks ongoing", async () => {
        const result = await runOpenScoreUsdReplay(
            () => fromArray(baselineMarkets),
            () => fromArray(baselineTargets),
            baselineOptions,
        );
        // Horizon 1 (all returns finite): every causal arm counts the event.
        expect(causalRows(result, 0)).to.deep.equal({
            topRawProfitNow: 1,
            topMeanProfitNow: 1,
            topZ: 1,
            topRawProfitNowConf: 1,
            botRawProfitNow: 1,
            botMeanProfitNow: 1,
            botZ: 1,
        });
        // Horizon 2: BBB's return is right-censored, so the shared causal
        // pool is invalid and every causal arm omits the completed event —
        // the confidence pool gates on the same members and omits too.
        expect(causalRows(result, 1)).to.deep.equal({
            topRawProfitNow: 0,
            topMeanProfitNow: 0,
            topZ: 0,
            topRawProfitNowConf: 0,
            botRawProfitNow: 0,
            botMeanProfitNow: 0,
            botZ: 0,
        });
        // Horizon-1 completed detail for the BBB pick reports the full pool
        // and the flat-price control value ((60 - 0) / 2 - 0 with zero costs
        // and flat prices → all returns 0).
        const detailAtH1 = result.eventDetails?.find(
            (row) => row.selector === "TOP_RAW_PROFIT_NOW" && row.horizonBars === 1,
        );
        expect(detailAtH1?.asset).to.equal("BBB");
        expect(detailAtH1?.eligibleCandidates).to.equal(3);
        expect(detailAtH1?.selectedReturn).to.equal(0);
        expect(detailAtH1?.controlReturn).to.equal(0);
        // BBB is right-censored at horizon 2: its ongoing rows survive the
        // omitted completed event with the mark-to-market fallback.
        const ongoingAtH2 = result.ongoingEventDetails?.filter(
            (row) => row.decisionTime === decision && row.horizonBars === 2,
        ) ?? [];
        expect(ongoingAtH2.find((row) => row.selector === "TOP_RAW_PROFIT_NOW")?.asset).to.equal("BBB");
        expect(ongoingAtH2.find((row) => row.selector === "TOP_Z")?.asset).to.equal("BBB");
        expect(ongoingAtH2.find((row) => row.selector === "TOP_RAW_PROFIT_NOW")?.unrealizedReturn).to.equal(0);
    });

    it("keeps a next-open bridge candle out of a replay horizon that has not closed", async () => {
        const decision = T0 + 1000;
        const markets = ["AAA", "BBB", "CCC"].map((asset) =>
            makeDirectMarket(asset, [makeTrade("long", decision, null)]),
        );
        const incoming = [
            makeTarget("AAA", 4, (i) => 100 + i),
            makeTarget("BBB", 4, (i) => 100 + i),
            makeTarget("CCC", 4, (i) => 100 + i),
        ];
        const cutoff = T0 + 3000;
        const closedByAsset = new Map(incoming.map(({ asset, data }) => [
            asset,
            selectClosedCandleWindow(data, "1000s", cutoff, 1)!.candles,
        ]));
        const executionData = selectExecutionAwareClosedCandles(
            incoming[0]!.data,
            "1000s",
            { executionModel: "next_open" } as any,
            { nowSec: cutoff, minClosedCandles: 1 },
        );
        expect(executionData).to.have.length(4, "execution may use the next bar's open as an entry bridge");
        expect(closedByAsset.get("AAA")).to.have.length(3, "replay sees only candles closed at the frozen cutoff");

        const result = await runOpenScoreUsdReplay(
            () => fromArray(markets),
            () => fromArray(incoming.map(({ asset, symbol }) => ({
                asset,
                symbol,
                data: closedByAsset.get(asset)!,
            }))),
            {
                horizons: [2],
                interval: "1000s",
                blockCount: 1,
                includeCandidateOutcomes: true,
            },
        );

        expect(result.horizons[0]!.topRaw.events).to.equal(0, "the event is omitted while every horizon outcome is censored");
        expect(result.candidateOutcomes?.every((row) => row.status === "right_censored" && row.return === null)).to.equal(true);
    });

    it("keeps full-window profit pool gates independent of the causal pool gates", async () => {
        // BBB is causal-positive (realized +40) but its pair netProfit is 0,
        // so the look-ahead profit pool excludes it: {CCC, DDD}. At horizon 2
        // the causal pool omits (BBB censored) while the profit pool still
        // counts the event — the two pools evaluate independently.
        const markets = [
            makeDirectMarket("AAA", [
                makeTrade("long", T0 + 100, T0 + 200, 10),
                makeTrade("long", decision, null),
            ]),
            makeDirectMarket("BBB", [
                makeTrade("long", T0 + 100, T0 + 200, 40),
                makeTrade("long", decision, null),
                makeTrade("long", decision, null),
            ]),
            makeDirectMarket("CCC", [
                makeTrade("long", T0 + 100, T0 + 200, 10),
                makeTrade("long", decision, null),
            ]),
            makeDirectMarket("DDD", [
                makeTrade("long", T0 + 100, T0 + 200, -5), // losing: no causal vote
                makeTrade("long", decision, null),
            ]),
        ].map((market, index) => ({ ...market, result: { ...market.result, netProfit: index === 1 || index === 0 ? 0 : 100 } }));
        const targets = [...baselineTargets, makeTarget("DDD", 12, (i) => 100 + i)];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(markets),
            () => fromArray(targets),
            baselineOptions,
        );
        const h1 = result.horizons[0]!;
        const h2 = result.horizons[1]!;
        expect(h1.topRawProfitNow.events).to.equal(1);
        expect(h1.topRawProfit.events).to.equal(2, "profit pool fires at both entry events (T0+100 and decision)");
        expect(h2.topRawProfitNow.events).to.equal(0, "causal pool omits: BBB censored at horizon 2");
        expect(h2.topRawProfit.events).to.equal(2, "profit pool {CCC, DDD} has no censored member and still counts");
    });

    it("gates the profit-only loop through the shared profit pool evaluation", async () => {
        // AAA carries one profitable open long (+1 profit score) canceled by
        // an open short (-1): raw 0, profit pool score +1. BBB carries two
        // profitable open longs and one open short: raw +2 (in ordinary
        // positives, but alone — fewer than two), profit score +2. The event
        // is profit-only: TOP_RAW does not fire; the profit arms share one
        // pool evaluation and omit together at horizon 2 (BBB censored).
        // Pair streams let one asset hold a profit-masked (+1) and an
        // unmasked (-1) open vote at the same time. AAA ends at raw 0 with
        // profit score +1; BBB ends at raw +2 (the single ordinary positive)
        // with profit score +2. The decision event is profit-only.
        const profitOnlyMarkets = [
            makePair("AAA", "Q1", [makeTrade("long", decision, null)], 100),
            makePair("AAA", "Q2", [makeTrade("short", decision, null)], -50),
            makePair("BBB", "Q3", [
                makeTrade("long", decision, null),
                makeTrade("long", decision, null),
                makeTrade("long", decision, null),
                makeTrade("short", decision, null),
            ], 100),
        ];
        const targets = [baselineTargets[0]!, baselineTargets[1]!];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(profitOnlyMarkets),
            () => fromArray(targets),
            baselineOptions,
        );
        const h1 = result.horizons[0]!;
        const h2 = result.horizons[1]!;
        expect(h1.topRaw.events).to.equal(0, "only one ordinary positive: no ordinary arm fires");
        expect(h1.topRawProfit.events).to.equal(1);
        expect(h1.topMeanProfit.events).to.equal(1);
        expect(h1.topRawProfitNow.events).to.equal(0, "nothing realized before the decision: causal pools empty");
        // Horizon 2: BBB (the deterministic raw-profit pick) is censored, so
        // the shared profit pool evaluation invalidates the completed event.
        expect(h2.topRawProfit.events).to.equal(0);
        const ongoingAtH2 = result.ongoingEventDetails?.filter((row) => row.horizonBars === 2) ?? [];
        expect(ongoingAtH2.find((row) => row.selector === "TOP_RAW_PROFIT")?.asset).to.equal("BBB");
        const report = result.reportLines.join("\n");
        expect(report).to.include("TOP_RAW_PROFIT selected assets = BBB");
    });
});

describe("runOpenScoreUsdReplay diagnostic long-outcome reuse (top-mean coordinator optimization plan, idea #1)", () => {
    // The diagnostic pass builds selector outcome records for requested
    // events straight from its resolved entry bars and long results;
    // diagnostics-on (records reused) and diagnostics-off (records computed
    // by the request loop) must produce identical selector output, including
    // the censored pick's ongoing mark-to-market.
    const decision = T0 + 1000;
    const reuseTargets = [
        makeTarget("AAA", 12, (i) => 100 + i),
        makeTarget("BBB", 3, (i) => 100 + i),
        makeTarget("CCC", 12, (i) => 100 + 2 * i),
    ];
    const reuseMarkets = [
        makeDirectMarket("AAA", [
            makeTrade("long", T0 + 100, T0 + 200, 10),
            makeTrade("long", decision, null),
        ]),
        makeDirectMarket("BBB", [
            makeTrade("long", T0 + 100, T0 + 200, 40),
            makeTrade("long", decision, null),
            makeTrade("long", decision, null),
        ]),
        makeDirectMarket("CCC", [
            makeTrade("long", T0 + 100, T0 + 200, 10),
            makeTrade("long", decision, null),
        ]),
    ];
    const reuseOptions = {
        horizons: [1, 2],
        slippageRate: 0.001,
        commissionRate: 0.0005,
        blockCount: 1,
        includeEventDetails: true,
    };

    it("diagnostics-on and diagnostics-off runs produce identical selector output", async () => {
        const withDiagnostics = await runOpenScoreUsdReplay(
            () => fromArray(reuseMarkets),
            () => fromArray(reuseTargets),
            {
                ...reuseOptions,
                includePoolSnapshots: true,
                includeCandidateOutcomes: true,
                catalogAssets: ["AAA", "BBB", "CCC"],
            },
        );
        const withoutDiagnostics = await runOpenScoreUsdReplay(
            () => fromArray(reuseMarkets),
            () => fromArray(reuseTargets),
            reuseOptions,
        );
        expect(withDiagnostics.horizons).to.deep.equal(withoutDiagnostics.horizons);
        expect(withDiagnostics.eventDetails).to.deep.equal(withoutDiagnostics.eventDetails);
        expect(withDiagnostics.ongoingEventDetails).to.deep.equal(withoutDiagnostics.ongoingEventDetails);
        expect(withDiagnostics.eligibleEvents).to.equal(withoutDiagnostics.eligibleEvents);
        expect(withoutDiagnostics.candidateOutcomes).to.equal(undefined);

        // Cross-representation consistency on the reuse path: the archived
        // diagnostic long row for the selected (asset, horizon) carries the
        // same return the selector recorded from the cached record.
        const detail = withDiagnostics.eventDetails?.find(
            (row) => row.selector === "TOP_RAW_PROFIT_NOW" && row.horizonBars === 1,
        );
        expect(detail?.asset).to.equal("BBB");
        const okRow = withDiagnostics.candidateOutcomes?.find(
            (row) => row.asset === "BBB" && row.horizonBars === 1 && row.direction === "long"
                && row.decisionTimeSec === detail?.decisionTime,
        );
        expect(okRow?.status).to.equal("ok");
        expect(okRow?.return).to.equal(detail?.selectedReturn);
        // The censored horizon-2 diagnostic row stays right_censored with a
        // null return, while the selector record carries the NaN long with
        // the mark-to-market fallback visible in the ongoing row.
        const censoredRow = withDiagnostics.candidateOutcomes?.find(
            (row) => row.asset === "BBB" && row.horizonBars === 2 && row.direction === "long"
                && row.decisionTimeSec === detail?.decisionTime,
        );
        expect(censoredRow?.status).to.equal("right_censored");
        expect(censoredRow?.return).to.equal(null);
        const ongoingH2 = withDiagnostics.ongoingEventDetails?.find(
            (row) => row.selector === "TOP_RAW_PROFIT_NOW" && row.horizonBars === 2,
        );
        expect(ongoingH2?.asset).to.equal("BBB");
        expect(ongoingH2?.unrealizedReturn).to.equal(withoutDiagnostics.ongoingEventDetails?.find(
            (row) => row.selector === "TOP_RAW_PROFIT_NOW" && row.horizonBars === 2,
        )?.unrealizedReturn);
    });
});

describe("runOpenScoreUsdReplay event sweep boundaries (event-sweep plan, phase 1)", () => {
    // Parity baselines for the bounded event sweep: a bounded (annual) window
    // must capture events exactly as the unbounded sweep's storage filter
    // does — pre-window positions carry in, the inclusive upper bound is
    // stored, later events are excluded — while cap-tilt coverage keeps
    // counting ALL scanned history. These fixtures were captured against the
    // unbounded-sweep implementation; every value is part of the locked
    // output that the sweep-bound and delta-copy changes must reproduce
    // exactly.
    const boundedFrom = T0 + 5000;
    const boundedTo = T0 + 9000;
    const baselineSweepOptions = {
        horizons: [1],
        slippageRate: 0,
        commissionRate: 0,
        blockCount: 1,
        includeEventDetails: true,
    };
    const assertBoundedWindow = (
        result: Awaited<ReturnType<typeof runOpenScoreUsdReplay>>,
        from: number,
        to: number,
    ): void => {
        for (const row of result.eventDetails ?? []) {
            expect(row.decisionTime).to.be.at.least(from);
            expect(row.decisionTime).to.be.at.most(to);
        }
    };

    it("bounds annual events inclusively while carrying pre-window positions and excluding later trades", async () => {
        // pair1: a pre-window position (entered T0+1000) that exits and
        // re-enters AT the same in-window timestamp (T0+6000) — its causal
        // vote applies because realized pnl (+10) precedes the re-entry.
        // pair2: an event exactly AT the inclusive upper bound (T0+9000).
        // pair3: an event beyond the bound (T0+9500) that must never appear
        // in the bounded run.
        // Long pairs credit their BASE leg +1 and quote leg -1, so the
        // positive candidates are the bases: AAA (pair1's re-entry after its
        // pre-window round trip) and BBB (pair2, whose realized +40 makes its
        // re-entry a causal vote).
        const markets = [
            makePair("AAA", "CCC", [
                makeTrade("long", T0 + 1000, T0 + 6000, 10),
                makeTrade("long", T0 + 6000, null),
            ], 100),
            makePair("BBB", "DDD", [
                makeTrade("long", T0 + 2000, T0 + 3000, 40),
                makeTrade("long", T0 + 6000, null),
                makeTrade("long", boundedTo, null),
            ], 100),
            makePair("EEE", "FFF", [makeTrade("long", T0 + 9500, null)], 100),
        ];
        const targets = [
            makeTarget("AAA", 12, (i) => 100 + i),
            makeTarget("CCC", 12, (i) => 100 + i),
            makeTarget("BBB", 12, (i) => 100 + 2 * i),
            makeTarget("DDD", 12, (i) => 100 + 2 * i),
            makeTarget("EEE", 12, (i) => 100 + 3 * i),
            makeTarget("FFF", 12, (i) => 100 + 3 * i),
        ];
        const bounded = await runOpenScoreUsdReplay(
            () => fromArray(markets),
            () => fromArray(targets),
            { ...baselineSweepOptions, sampleFromSec: boundedFrom, sampleToSec: boundedTo },
        );
        const unbounded = await runOpenScoreUsdReplay(
            () => fromArray(markets),
            () => fromArray(targets),
            baselineSweepOptions,
        );

        assertBoundedWindow(bounded, boundedFrom, boundedTo);
        // The bound is INCLUSIVE: the T0+9000 event is stored.
        const atBound = bounded.eventDetails?.find(
            (row) => row.selector === "TOP_RAW" && row.decisionTime === boundedTo,
        );
        expect(atBound).to.not.equal(undefined);
        expect(atBound?.eligibleCandidates).to.equal(2);
        // Pre-window carry: at T0+6000 the causal pool is AAA+BBB (both
        // re-entries apply their realized-pnl votes) and the causal arm
        // fires.
        const carried = bounded.eventDetails?.find(
            (row) => row.selector === "TOP_RAW" && row.decisionTime === T0 + 6000,
        );
        expect(carried?.eligibleCandidates).to.equal(2);
        // The causal arm fires at both in-window events: AAA's carried vote
        // plus each re-entry's realized-pnl vote.
        expect(bounded.horizons[0]!.topRawProfitNow.events).to.equal(2);
        // The unbounded run additionally stores the pre-window and post-bound
        // events (entries at T0+1000, T0+2000, and T0+9500).
        expect(unbounded.totalEvents).to.equal(5);
        expect(bounded.totalEvents).to.equal(2);
    });

    it("keeps cap-tilt coverage over all scanned history beyond the sweep bound", async () => {
        const markets = [
            makePair("AAA", "CCC", [
                makeTrade("long", T0 + 1000, T0 + 6000, 10),
                makeTrade("long", T0 + 6000, null),
            ], 100),
            makePair("BBB", "DDD", [
                makeTrade("long", T0 + 2000, T0 + 3000, 40),
                makeTrade("long", T0 + 6000, null),
                makeTrade("long", boundedTo, null),
            ], 100),
            makePair("EEE", "FFF", [makeTrade("long", T0 + 9500, null)], 100),
        ];
        const targets = [
            makeTarget("AAA", 12, (i) => 100 + i),
            makeTarget("CCC", 12, (i) => 100 + i),
            makeTarget("BBB", 12, (i) => 100 + 2 * i),
            makeTarget("DDD", 12, (i) => 100 + 2 * i),
            makeTarget("EEE", 12, (i) => 100 + 3 * i),
            makeTarget("FFF", 12, (i) => 100 + 3 * i),
        ];
        const capOptions = {
            horizons: [1],
            slippageRate: 0,
            commissionRate: 0,
            blockCount: 1,
            capTiltWeight: "smallBase2x" as const,
            // CCC/DDD/FFF quotes are larger than their bases (ratio 2 <= 3):
            // every long entry on these pairs is cap-tilt weighted.
            lookupMarketCap: (symbol: string) => (symbol === "CCC" || symbol === "DDD" ? 10 : 5),
        };
        const bounded = await runOpenScoreUsdReplay(
            () => fromArray(markets),
            () => fromArray(targets),
            { ...capOptions, sampleFromSec: boundedFrom, sampleToSec: boundedTo },
        );
        const unbounded = await runOpenScoreUsdReplay(
            () => fromArray(markets),
            () => fromArray(targets),
            capOptions,
        );
        // Six long entries exist across the artifact (two on pair1, three on
        // pair2, one on pair3) — the historical coverage line must count ALL
        // of them in the bounded run too, even the entry beyond the bound.
        const coverageLine = (result: Awaited<ReturnType<typeof runOpenScoreUsdReplay>>) =>
            result.reportLines.find((line) => line.startsWith("cap tilt coverage |"));
                // pair3's equal caps (5/5) deliberately stay weight 1: "larger/smaller
        // entry cap <= 3" weights only the five unequal-cap entries.
        expect(coverageLine(bounded)).to.equal("cap tilt coverage | long=6 known=6 weighted=5 unknown=0");
        expect(coverageLine(bounded)).to.equal(coverageLine(unbounded));
    });

    it("applies exits, re-entries, and exit-only timestamps without creating phantom events", async () => {
        // Direct-market fixture: BBB's exit-only timestamp (T0+7000) updates
        // accumulators but forms no event; AAA exits and re-enters on the
        // same timestamp; the confidence and inverted arms share the gate.
        const decision = T0 + 6000;
        const markets = [
            makeDirectMarket("AAA", [
                makeTrade("long", T0 + 1000, T0 + 6000, 10),
                makeTrade("long", decision, null),
            ]),
            makeDirectMarket("BBB", [
                makeTrade("long", T0 + 2000, T0 + 3000, 40),
                makeTrade("long", decision, null),
                makeTrade("long", T0 + 2500, T0 + 7000, 5), // exits at T0+7000: exit-only timestamp
            ]),
        ];
        const targets = [
            makeTarget("AAA", 12, (i) => 100 + i),
            makeTarget("BBB", 12, (i) => 100 + 2 * i),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(markets),
            () => fromArray(targets),
            { ...baselineSweepOptions, sampleFromSec: boundedFrom, sampleToSec: boundedTo },
        );
        expect(result.totalEvents).to.equal(1, "only the T0+6000 entry event is in window");
        expect(result.eventDetails?.some((row) => row.decisionTime === T0 + 7000)).to.equal(false);
        expect(result.eventDetails?.some((row) => row.decisionTime === decision)).to.equal(true);
        expect(result.horizons[0]!.topRawProfitNow.events).to.equal(1);
        expect(result.horizons[0]!.topZ.events).to.equal(1);
        expect(result.horizons[0]!.topRawProfitNowConf.events).to.equal(1);
        expect(result.horizons[0]!.botZ.events).to.equal(1);
    });
});


describe("replay efficiency plan (finder_arm replay lifetimes)", () => {
    // 3-asset deterministic fixture; helpers reused from this spec file.
    const buildReplay = (gapAsset: string | null) => {
        const pairs = [
            makePair("AAA", "X1", [
                makeTrade("long", T0 + 500, T0 + 800, 0.02),
                makeTrade("long", T0 + 3500, T0 + 3800, 0.03),
            ], 0.05),
            makePair("BBB", "X1", [
                makeTrade("long", T0 + 500, T0 + 800, 0.01),
                makeTrade("long", T0 + 3500, T0 + 3800, 0.015),
            ], 0.025),
            makePair("CCC", "X1", [
                makeTrade("long", T0 + 1500, T0 + 1800, 0.04),
            ], 0.04),
        ];
        const targets = ["AAA", "BBB", "CCC"].map((asset) => {
            const target = makeTarget(asset, 60, (i) => 100 + i * (asset === "AAA" ? 1 : asset === "BBB" ? 0.5 : 0.25));
            if (gapAsset === asset) {
                target.data = target.data.filter((bar) => Number(bar.time) < T0 + 2000 || Number(bar.time) > T0 + 2600);
            }
            return target;
        });
        return { pairs, targets };
    };
    const opts = (extra: Record<string, unknown> = {}) => ({
        horizons: [2], slippageRate: 0, commissionRate: 0, blockCount: 1, ...extra,
    });

    it("phase 1: diagnostics on/off produce identical arm metrics (early event release)", async () => {
        const { pairs, targets } = buildReplay(null);
        const plain = await runOpenScoreUsdReplay(() => fromArray(pairs), () => fromArray(targets), opts());
        const diag = await runOpenScoreUsdReplay(() => fromArray(pairs), () => fromArray(targets), opts({
            includePoolSnapshots: true,
            includeCandidateOutcomes: true,
            catalogAssets: ["AAA", "BBB", "CCC"],
        }));
        // The no-diagnostics run takes the phase-1 early release; the
        // diagnostics run retains events until the existing late release.
        // Every arm metric, count, and selection must be identical anyway.
        for (let i = 0; i < plain.horizons.length; i += 1) {
            expect(diag.horizons[i]).to.deep.equal(plain.horizons[i]);
        }
        expect(diag.totalEvents).to.equal(plain.totalEvents);
        expect(diag.candidateEvents).to.equal(plain.candidateEvents);
        expect(diag.eligibleEvents).to.equal(plain.eligibleEvents);
        expect(diag.poolSnapshots?.length ?? 0).to.be.greaterThan(0);
        expect(diag.candidateOutcomes?.length ?? 0).to.be.greaterThan(0);
        expect(plain).to.not.have.property("poolSnapshots");
        expect(plain).to.not.have.property("candidateOutcomes");
    });

    it("phase 2: an irrelevant data gap re-ranks to identical winners", async () => {
        // CCC never has >= 2 candidates and never wins, so gapping it forces
        // the slow re-ranking path (dataGapAssets non-empty) without changing
        // any usable pool. Output must equal the clean (fast-path) run.
        const clean = buildReplay(null);
        const gapped = buildReplay("CCC");
        const a = await runOpenScoreUsdReplay(() => fromArray(clean.pairs), () => fromArray(clean.targets), opts());
        const b = await runOpenScoreUsdReplay(() => fromArray(gapped.pairs), () => fromArray(gapped.targets), opts());
        expect(b.horizons).to.deep.equal(a.horizons);
        expect(b.totalEvents).to.equal(a.totalEvents);
        expect(b.eligibleEvents).to.equal(a.eligibleEvents);
    });
});
