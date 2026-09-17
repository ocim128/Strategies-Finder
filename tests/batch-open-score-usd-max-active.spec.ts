import { expect } from "chai";
import { describe, it } from "node:test";
import {
    runOpenScoreUsdReplay,
    type OpenScoreUsdTarget,
} from "../lib/batch-backtest/batch-open-score-usd-replay-engine";
import type { BatchSyntheticPairArtifact } from "../lib/batch-backtest/batch-synthetic-artifact";
import type { BacktestResult, OHLCVData, Time, Trade } from "../lib/types/strategies";

const T0 = 1_700_000_000;

function emptyResult(): BacktestResult {
    return {
        trades: [], netProfit: 0, netProfitPercent: 0, winRate: 0, expectancy: 0,
        avgTrade: 0, profitFactor: 0, maxDrawdown: 0, maxDrawdownPercent: 0,
        totalTrades: 0, winningTrades: 0, losingTrades: 0, avgWin: 0, avgLoss: 0,
        sharpeRatio: 0, equityCurve: [],
    };
}

let tradeId = 0;
function makeTrade(type: "long" | "short", entrySec: number, exitSec: number | null): Trade {
    return {
        id: tradeId += 1,
        type,
        entryTime: entrySec as Time,
        entryPrice: 1,
        exitTime: (exitSec ?? entrySec) as Time,
        exitPrice: 1,
        pnl: 0,
        pnlPercent: 0,
        size: 1,
        exitReason: exitSec === null ? "end_of_data" : "signal",
    };
}

function makePair(base: string, quote: string, trades: Trade[]): BatchSyntheticPairArtifact {
    return {
        symbol: `${base}+${quote}`,
        baseAsset: base,
        quoteAsset: quote,
        data: [],
        signals: [],
        result: { ...emptyResult(), totalTrades: trades.length, trades },
    };
}

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

describe("batch-open-score-usd-replay-engine Phase 3 MAX_ACTIVE extensions", () => {
    it("exposes maxRetained (computed from retained artifact degree)", async () => {
        const pairs = [
            makePair("AAA", "X1", [makeTrade("long", T0 + 1000, null)]),
            makePair("AAA", "X2", [makeTrade("long", T0 + 1000, null)]),
            makePair("BBB", "Y1", [makeTrade("long", T0 + 1000, null)]),
            makePair("BBB", "Y2", [makeTrade("long", T0 + 1000, null)]),
        ];
        const targets = [
            makeTarget("AAA", 10, () => 100),
            makeTarget("BBB", 10, () => 50),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], slippageRate: 0, commissionRate: 0, blockCount: 1 },
        );
        const h = result.horizons[0]!;
        expect(h.maxRetained).to.not.equal(undefined);
    });

    it("TOP_MEAN per-asset breakdown surfaces the coverage-adjusted winner", async () => {
        // AAA has 2 long pairs open (raw=2, activePairs=2 -> mean=1.0).
        // BBB has 1 long pair open  (raw=1, activePairs=1 -> mean=1.0).
        // CCC has 1 long pair open  (raw=1, activePairs=1 -> mean=1.0).
        // TOP_MEAN ties BBB=CCC=AAA at 1.0; FNV-1a digest picks one. The test
        // only locks that TOP_MEAN recorded the selection per-asset and that
        // the breakdown shares sum to 1 — the exact winner is digest-dependent
        // and not stable to assert.
        const pairs = [
            makePair("AAA", "X1", [makeTrade("long", T0 + 1000, null)]),
            makePair("AAA", "X2", [makeTrade("long", T0 + 1000, null)]),
            makePair("BBB", "Y1", [makeTrade("long", T0 + 1000, null)]),
            makePair("CCC", "Z1", [makeTrade("long", T0 + 1000, null)]),
        ];
        const targets = [
            makeTarget("AAA", 10, () => 100),
            makeTarget("BBB", 10, () => 100),
            makeTarget("CCC", 10, () => 100),
            makeTarget("X1", 10, () => 100),
            makeTarget("X2", 10, () => 100),
            makeTarget("Y1", 10, () => 100),
            makeTarget("Z1", 10, () => 100),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], slippageRate: 0, commissionRate: 0, blockCount: 1 },
        );
        const h = result.horizons[0]!;
        // Exactly one event -> TOP_MEAN selected one asset; breakdown share=1.
        expect(h.topMeanByAsset).to.have.length(1);
        expect(h.topMeanByAsset[0]!.share).to.equal(1);
        expect(h.topMeanByAsset[0]!.events).to.equal(1);
        // Dominant is the only asset selected; EX_DOM drops it -> 0 events.
        expect(h.topMeanDominantAsset).to.equal(h.topMeanByAsset[0]!.asset);
        expect(h.topMeanExDominant.events).to.equal(0);
        // Report carries both lines.
        const report = result.reportLines.join("\n");
        expect(report).to.include("TOP_MEAN selected assets = ");
        expect(report).to.include(`MEAN_EX_${h.topMeanDominantAsset}`);
    });

    it("TOP_MEAN_RAW_UNIQUE selects a unique raw maximum inside the TOP_MEAN tied set", async () => {
        const pairs = [
            makePair("AAA", "X1", [makeTrade("long", T0 + 1000, null)]),
            makePair("AAA", "X2", [makeTrade("long", T0 + 1000, null)]),
            makePair("BBB", "Y1", [makeTrade("long", T0 + 1000, null)]),
            makePair("CCC", "Z1", [makeTrade("long", T0 + 1000, null)]),
        ];
        const targets = [
            makeTarget("AAA", 10, (i) => i === 3 ? 110 : 100),
            makeTarget("BBB", 10, (i) => i === 3 ? 90 : 100),
            makeTarget("CCC", 10, () => 100),
            makeTarget("X1", 10, () => 100),
            makeTarget("X2", 10, () => 100),
            makeTarget("Y1", 10, () => 100),
            makeTarget("Z1", 10, () => 100),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], slippageRate: 0, commissionRate: 0, blockCount: 1, includeEventDetails: true },
        );
        const h = result.horizons[0]!;
        expect(h.topMeanRawUnique.events).to.equal(1);
        expect(h.topMeanRawUnique.topMean).to.be.closeTo(0.1, 1e-12);
        // The research control is the mean of the TOP_MEAN tied set, including
        // the selected AAA return: (0.1 - 0.1 + 0) / 3 = 0.
        expect(h.topMeanRawUnique.randomMean).to.be.closeTo(0, 1e-12);
        expect(h.topMeanRawUnique.delta).to.be.closeTo(0.1, 1e-12);
        expect(h.topMeanRawUniqueByAsset[0]?.asset).to.equal("AAA");
        expect(h.topMeanRawUniqueExDominant.events).to.equal(0);
        const detail = result.eventDetails?.find((row) => row.selector === "TOP_MEAN_RAW_UNIQUE");
        expect(detail?.asset).to.equal("AAA");
        expect(detail?.eligibleCandidates).to.equal(3);
        expect(detail?.controlReturn).to.be.closeTo(0, 1e-12);
        const latest = result.latestSelections?.selections.find((selection) => selection.selector === "TOP_MEAN_RAW_UNIQUE");
        expect(latest?.asset).to.equal("AAA");
        const report = result.reportLines.join("\n");
        expect(report).to.include("TOP_MEAN_RAW_UNIQUE");
        expect(report).to.include("TOP_MEAN_RAW_UNIQUE selected assets =");
        expect(report).to.include("TOP_MEAN_RAW_UNIQUE_EX_AAA");
    });

    it("TOP_MEAN_RAW_UNIQUE skips residual raw ties", async () => {
        const pairs = [
            makePair("AAA", "X1", [makeTrade("long", T0 + 1000, null)]),
            makePair("BBB", "Y1", [makeTrade("long", T0 + 1000, null)]),
        ];
        const targets = [
            makeTarget("AAA", 10, () => 100),
            makeTarget("BBB", 10, () => 100),
            makeTarget("X1", 10, () => 100),
            makeTarget("Y1", 10, () => 100),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], slippageRate: 0, commissionRate: 0, blockCount: 1 },
        );
        expect(result.horizons[0]!.topMeanRawUnique.events).to.equal(0);
        expect(result.latestSelections?.selections.find((selection) => selection.selector === "TOP_MEAN_RAW_UNIQUE")?.reason).to.equal("tied");
    });

    it("TOP_MEAN_EX_DOM drops the dominant asset's events, mirroring MAX_ACTIVE_EX_DOM", async () => {
        // Two events. At T1: AAA has 3 long pairs (raw=3, mean=1.0); BBB has
        //   1 long pair (raw=1, mean=1.0). TOP_MEAN ties AAA=BBB at 1.0 and
        //   resolves by digest; the test does not assume which wins.
        // At T2: AAA's positions close; CCC opens 1 long pair, DDD opens 1.
        //   Both mean=1.0; TOP_MEAN picks one by digest.
        // Either way, TOP_MEAN fires on 2 events with 2 distinct winners
        // (or 1 winner if both digests agree). The structural invariant:
        // topMeanExDominant.events === topMean.events - topMeanByAsset[0].events.
        const pairs = [
            makePair("AAA", "X1", [makeTrade("long", T0 + 1000, T0 + 2000)]),
            makePair("AAA", "X2", [makeTrade("long", T0 + 1000, T0 + 2000)]),
            makePair("AAA", "X3", [makeTrade("long", T0 + 1000, T0 + 2000)]),
            makePair("BBB", "Y1", [makeTrade("long", T0 + 1000, T0 + 2000)]),
            makePair("CCC", "Z1", [makeTrade("long", T0 + 2000, null)]),
            makePair("DDD", "W1", [makeTrade("long", T0 + 2000, null)]),
        ];
        const targets = [
            makeTarget("AAA", 10, () => 100),
            makeTarget("BBB", 10, () => 100),
            makeTarget("CCC", 10, () => 100),
            makeTarget("DDD", 10, () => 100),
            makeTarget("X1", 10, () => 100),
            makeTarget("X2", 10, () => 100),
            makeTarget("X3", 10, () => 100),
            makeTarget("Y1", 10, () => 100),
            makeTarget("Z1", 10, () => 100),
            makeTarget("W1", 10, () => 100),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], slippageRate: 0, commissionRate: 0, blockCount: 1 },
        );
        const h = result.horizons[0]!;
        // Structural invariant: dominant-asset exclusion drops exactly the
        // dominant asset's event count from the full TOP_MEAN series.
        const dominantEvents = h.topMeanByAsset[0]?.events ?? 0;
        expect(h.topMeanExDominant.events).to.equal(h.topMean.events - dominantEvents);
    });

    it("MEAN_EX_TOPCONTRIB satisfies the structural invariant: events === topMean.events - topContribAsset's events", async () => {
        // Reuse the existing TOP_MEAN_EX_DOM multi-event fixture shape: 2
        // events, digest-dependent winners. The structural invariant holds
        // regardless of which asset is the top contributor.
        const pairs = [
            makePair("AAA", "X1", [makeTrade("long", T0 + 1000, T0 + 2000)]),
            makePair("AAA", "X2", [makeTrade("long", T0 + 1000, T0 + 2000)]),
            makePair("AAA", "X3", [makeTrade("long", T0 + 1000, T0 + 2000)]),
            makePair("BBB", "Y1", [makeTrade("long", T0 + 1000, T0 + 2000)]),
            makePair("CCC", "Z1", [makeTrade("long", T0 + 2000, null)]),
            makePair("DDD", "W1", [makeTrade("long", T0 + 2000, null)]),
        ];
        const targets = [
            makeTarget("AAA", 10, () => 100), makeTarget("BBB", 10, () => 100),
            makeTarget("CCC", 10, () => 100), makeTarget("DDD", 10, () => 100),
            makeTarget("X1", 10, () => 100), makeTarget("X2", 10, () => 100),
            makeTarget("X3", 10, () => 100), makeTarget("Y1", 10, () => 100),
            makeTarget("Z1", 10, () => 100), makeTarget("W1", 10, () => 100),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], slippageRate: 0, commissionRate: 0, blockCount: 1 },
        );
        const h = result.horizons[0]!;
        const topContribAsset = h.topMeanTopContribAsset;
        expect(topContribAsset).to.not.equal(null);
        const topContribEvents = h.topMeanByAsset.find((a) => a.asset === topContribAsset)?.events ?? 0;
        expect(h.topMeanExTopContrib.events).to.equal(h.topMean.events - topContribEvents);
        // Report always carries the line.
        expect(result.reportLines.join("\n")).to.include("MEAN_EX_TOPCONTRIB_");
    });

    it("tie rates are surfaced per selector", async () => {
        // Two positives with equal raw score -> RAW selector has a tie.
        const pairs = [
            makePair("AAA", "QQQ", [makeTrade("long", T0 + 1000, null)]),
            makePair("BBB", "QQQ", [makeTrade("long", T0 + 1000, null)]),
        ];
        // raw: AAA=1, BBB=1, QQQ=-2. Positives: AAA, BBB (tie at raw=1).
        const targets = [
            makeTarget("AAA", 10, () => 100),
            makeTarget("BBB", 10, () => 50),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            {
                horizons: [2],
                slippageRate: 0,
                commissionRate: 0,
                blockCount: 1,
            },
        );
        const h = result.horizons[0]!;
        // RAW selector had a tie (AAA and BBB both raw=1).
        expect(h.tieRates.RAW.events).to.equal(1);
        expect(h.tieRates.RAW.sameSelection).to.equal(1);
        expect(h.tieRates.RAW.rate).to.equal(1);
    });

    it("report includes the control labels (MAX_RETAINED, ACTIVE_VS_RET)", async () => {
        const pairs = [
            makePair("AAA", "X1", [makeTrade("long", T0 + 1000, null)]),
            makePair("BBB", "Y1", [makeTrade("long", T0 + 1000, null)]),
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
        const report = result.reportLines.join("\n");
        expect(report).to.include("MAX_RETAINED");
        expect(report).to.include("ACTIVE_VS_RET");
        expect(report).to.include("ACTIVE_EX_");
        expect(report).to.include("MAX_ACTIVE selected assets =");
        expect(report).to.include("tie rates");
        // TOP_MEAN per-asset breakdown + its dominant-asset exclusion line
        // mirror the TOP_RAW / MAX_ACTIVE patterns, and the MEAN
        // top-contribution exclusion line rides both Copy paths verbatim.
        expect(report).to.include("MEAN_EX_");
        expect(report).to.include("TOP_MEAN selected assets =");
        expect(report).to.include("MEAN_EX_TOPCONTRIB_");
    });

    it("returns null CI when fewer than ten blocks exist (no one-block point CI)", async () => {
        // Phase 0 freeze: a formal CI requires EXACTLY ten nonempty blocks.
        // blockCount: 1 -> only one block -> CI MUST be null.
        const pairs = [
            makePair("AAA", "X1", [makeTrade("long", T0 + 1000, null)]),
            makePair("BBB", "Y1", [makeTrade("long", T0 + 1000, null)]),
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
        const h = result.horizons[0]!;
        expect(h.topRaw.ciLower).to.equal(null);
        expect(h.topRaw.ciUpper).to.equal(null);
        // Block means are still computed (1 block).
        expect(h.topRaw.blockMeans.length).to.equal(1);
    });

    it("computes a CI when >= 10 blocks exist", async () => {
        // Generate 10 events (different timestamps) so the default 10-block
        // split produces 10 nonempty blocks -> CI is finite.
        const pairs: BatchSyntheticPairArtifact[] = [];
        for (let i = 0; i < 10; i += 1) {
            pairs.push(makePair("AAA", `X${i}`, [makeTrade("long", T0 + (i + 1) * 1000, null)]));
            pairs.push(makePair("BBB", `Y${i}`, [makeTrade("long", T0 + (i + 1) * 1000, null)]));
        }
        const targets = [
            makeTarget("AAA", 30, (i) => 100 + i),
            makeTarget("BBB", 30, (i) => 50 + i * 0.5),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], slippageRate: 0, commissionRate: 0 }, // default blockCount=10
        );
        const h = result.horizons[0]!;
        expect(h.topRaw.events).to.equal(10);
        expect(h.topRaw.ciLower).to.not.equal(null);
        expect(h.topRaw.ciUpper).to.not.equal(null);
        expect(h.topRaw.totalBlocks).to.equal(10);
    });

    it("dominant-asset exclusion measures MAX_ACTIVE, not TOP_RAW", async () => {
        // Event 1 (T1): AAA has 3 active pairs (raw=3); BBB has 1 (raw=1).
        //   TOP_RAW -> AAA, MAX_ACTIVE -> AAA. AAA positions close at T2.
        // Event 2 (T2): AAA's positions close (exits applied at T2 before
        //   forming candidates). CCC has 1 active pair (raw=1); DDD has 1.
        //   Positives are CCC and DDD only. MAX_ACTIVE picks by digest.
        //
        // Result: AAA is selected once by MAX_ACTIVE (at T1). The MAX_ACTIVE
        // dominant-asset exclusion drops AAA's event, leaving T2.
        const pairs = [
            // AAA long positions opened at T1, closed at T2.
            makePair("AAA", "X1", [makeTrade("long", T0 + 1000, T0 + 2000)]),
            makePair("AAA", "X2", [makeTrade("long", T0 + 1000, T0 + 2000)]),
            makePair("AAA", "X3", [makeTrade("long", T0 + 1000, T0 + 2000)]),
            makePair("BBB", "Y1", [makeTrade("long", T0 + 1000, T0 + 2000)]),
            // CCC and DDD open at T2 (after AAA closed).
            makePair("CCC", "Z1", [makeTrade("long", T0 + 2000, null)]),
            makePair("DDD", "W1", [makeTrade("long", T0 + 2000, null)]),
        ];
        const targets = [
            makeTarget("AAA", 10, () => 100),
            makeTarget("BBB", 10, () => 50),
            makeTarget("CCC", 10, () => 25),
            makeTarget("DDD", 10, () => 10),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], slippageRate: 0, commissionRate: 0, blockCount: 1 },
        );
        const h = result.horizons[0]!;
        // AAA was selected by MAX_ACTIVE only at T1 (1 event).
        expect(h.maxActiveByAsset.find((x) => x.asset === "AAA")?.events).to.equal(1);
        // MAX_ACTIVE dominant is AAA (1 selection). CCC and DDD each get 1.
        // Tied at 1 — tie-break by digest decides. The dominant is whichever
        // has the smallest digest at its event time.
        expect(h.maxActiveDominantAsset).to.not.equal(null);
        // MAX_ACTIVE events before exclusion = 2; after dropping the dominant
        // asset's events, 1 event remains.
        expect(h.maxActiveExDominant.events).to.equal(1);
    });
});

describe("batch-open-score-usd-replay-engine Phase 3 batch-run-contract provenance", () => {
    it("verifyPairListProvenance returns ok for a matching hash", async () => {
        const { verifyPairListProvenance } = await import("../lib/batch-backtest/batch-run-contract");
        const { fnv1a64Hex } = await import("../lib/batch-backtest/max-active-research-contract");
        const pairs = ["BTCUSDT+ETHUSDT", "BTCUSDT+XRPUSDT"];
        const hash = fnv1a64Hex(pairs.join("\n"));
        const prov = {
            schema: "batch.pair_list.v1" as const,
            algorithm: "seeded_round_robin_v1" as const,
            effectiveSeed: 1,
            effectiveMaxPairs: 2,
            canonicalAssetListHash: "x".repeat(16),
            emittedPairListHash: hash,
            assetCount: 3,
            pairCount: 2,
            degree: { min: 1, median: 2, max: 2 },
            orientationImbalanceMax: 0,
        };
        const v = verifyPairListProvenance(prov, pairs, fnv1a64Hex);
        expect(v.ok).to.equal(true);
    });

    it("verifyPairListProvenance returns reason on a hash mismatch", async () => {
        const { verifyPairListProvenance } = await import("../lib/batch-backtest/batch-run-contract");
        const { fnv1a64Hex } = await import("../lib/batch-backtest/max-active-research-contract");
        const prov = {
            schema: "batch.pair_list.v1" as const,
            algorithm: "seeded_round_robin_v1" as const,
            effectiveSeed: 1,
            effectiveMaxPairs: 2,
            canonicalAssetListHash: "x".repeat(16),
            emittedPairListHash: "deadbeefdeadbeef",
            assetCount: 3,
            pairCount: 2,
            degree: { min: 1, median: 2, max: 2 },
            orientationImbalanceMax: 0,
        };
        const v = verifyPairListProvenance(prov, ["BTCUSDT+ETHUSDT"], fnv1a64Hex);
        expect(v.ok).to.equal(false);
        if (!v.ok) expect(v.reason).to.match(/hash mismatch/i);
    });
});

describe("batch-open-score-usd-replay-engine conditional-split arms", () => {
    // Helper: stretch a single asset's target dataset to N bars at a flat price.
    const flat = (_n: number, p: number) => (i: number) => { void i; return p; };

    it("RAW_FRESH / RAW_STALE splits on whether the TOP_RAW leader changed", async () => {
        // Two events. T1: AAA is leader (5 longs), lastTopRawLeaderIdx=-1 → fresh.
        // T2: AAA is leader again (T1 pairs closed, new AAA pairs opened) → stale.
        const pairs = [
            ...Array.from({ length: 5 }, (_, i) => makePair("AAA", `X${i}`, [makeTrade("long", T0 + 1000, T0 + 2000)])),
            makePair("BBB", "Y1", [makeTrade("long", T0 + 1000, T0 + 2000)]),
            ...Array.from({ length: 5 }, (_, i) => makePair("AAA", `Z${i}`, [makeTrade("long", T0 + 3000, T0 + 4000)])),
            makePair("BBB", "W1", [makeTrade("long", T0 + 3000, T0 + 4000)]),
        ];
        const targets = [
            makeTarget("AAA", 10, flat(10, 100)),
            makeTarget("BBB", 10, flat(10, 100)),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], slippageRate: 0, commissionRate: 0, blockCount: 1 },
        );
        const h = result.horizons[0]!;
        // First view (T1) is always fresh; second view (T2) has the same leader.
        expect(h.topRawFresh.events).to.equal(1);
        expect(h.topRawStale.events).to.equal(1);
    });

    it("RAW_STALE_SHORT / RAW_STALE_LONG splits STALE events at the median streak length", async () => {
        // Six views, all led by AAA, with AAA pairs spanning the whole window
        // (entry T1, exit after T6) plus a fresh BBB pair at each event so the
        // positive-pool gate (>= 2 positives) is satisfied every time.
        //
        // Streak per view: T1=1 (fresh), T2=2, T3=3, T4=4, T5=5, T6=6 (stale).
        // STALE streaks = [2,3,4,5,6], median = 4. STALE_SHORT (streak ∈ [2,4])
        // → T2,T3,T4 = 3 events. STALE_LONG (streak > 4) → T5,T6 = 2 events.
        // The two counts must sum to topRawStale.events (5).
        const pairs = [
            // AAA: 5 longs that stay open across all 6 events (entry T1, exit
            // after T6) so AAA is a positive candidate throughout.
            ...Array.from({ length: 5 }, (_, i) => makePair("AAA", `AL${i}`, [makeTrade("long", T0 + 1000, T0 + 7000)])),
            // One fresh BBB pair per event so positives = {AAA, BBB} each time
            // and AAA (raw 5) is the TOP_RAW leader.
            ...Array.from({ length: 6 }, (_, k) => makePair("BBB", `B${k}`, [makeTrade("long", T0 + 1000 + k * 1000, T0 + 2000 + k * 1000)])),
        ];
        const targets = [
            makeTarget("AAA", 12, flat(12, 100)),
            makeTarget("BBB", 12, flat(12, 100)),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], slippageRate: 0, commissionRate: 0, blockCount: 1 },
        );
        const h = result.horizons[0]!;
        expect(h.topRawStale.events).to.equal(5);
        expect(h.topRawStaleShort.events).to.equal(3);
        expect(h.topRawStaleLong.events).to.equal(2);
        // SHORT + LONG partition STALE.
        expect(h.topRawStaleShort.events + h.topRawStaleLong.events).to.equal(h.topRawStale.events);
        const report = result.reportLines.join("\n");
        expect(report).to.include("RAW_STALE_SHORT");
        expect(report).to.include("RAW_STALE_LONG");
    });

    it("RAW_DOMINANT / RAW_SPREAD splits on cross-sectional HHI of positive scores", async () => {
        // T1: AAA=raw10, BBB=raw1 → shares 10/11, 1/11 → HHI ≈ 0.84 (DOMINANT).
        // T2: AAA=raw5,  BBB=raw4 → shares 5/9, 4/9   → HHI ≈ 0.51 (SPREAD).
        // Median ≈ 0.67; T1 above, T2 at-or-below.
        const pairsT1 = [
            ...Array.from({ length: 10 }, (_, i) => makePair("AAA", `X${i}`, [makeTrade("long", T0 + 1000, T0 + 2000)])),
            makePair("BBB", "Y1", [makeTrade("long", T0 + 1000, T0 + 2000)]),
        ];
        const pairsT2 = [
            ...Array.from({ length: 5 }, (_, i) => makePair("AAA", `P${i}`, [makeTrade("long", T0 + 3000, T0 + 4000)])),
            ...Array.from({ length: 4 }, (_, i) => makePair("BBB", `Q${i}`, [makeTrade("long", T0 + 3000, T0 + 4000)])),
        ];
        const targets = [
            makeTarget("AAA", 10, flat(10, 100)),
            makeTarget("BBB", 10, flat(10, 100)),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray([...pairsT1, ...pairsT2]),
            () => fromArray(targets),
            { horizons: [2], slippageRate: 0, commissionRate: 0, blockCount: 1 },
        );
        const h = result.horizons[0]!;
        expect(h.topRawDominant.events).to.equal(1);
        expect(h.topRawSpread.events).to.equal(1);
    });

    it("RAW_HI_PAIRS / RAW_LO_PAIRS splits on maxActivePairs across positive candidates", async () => {
        // T1 (HI_PAIRS): AAA has 6 long pairs → maxActivePairs=6.
        // T2 (LO_PAIRS): AAA has 2 long pairs → maxActivePairs=2.
        // Median of [6,2]=4 → T1 above, T2 at/below.
        const pairsT1 = [
            ...Array.from({ length: 6 }, (_, i) => makePair("AAA", `X${i}`, [makeTrade("long", T0 + 1000, T0 + 2000)])),
            makePair("BBB", "Y1", [makeTrade("long", T0 + 1000, T0 + 2000)]),
        ];
        const pairsT2 = [
            ...Array.from({ length: 2 }, (_, i) => makePair("AAA", `P${i}`, [makeTrade("long", T0 + 3000, T0 + 4000)])),
            makePair("BBB", "Q1", [makeTrade("long", T0 + 3000, T0 + 4000)]),
        ];
        const targets = [
            makeTarget("AAA", 10, flat(10, 100)),
            makeTarget("BBB", 10, flat(10, 100)),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray([...pairsT1, ...pairsT2]),
            () => fromArray(targets),
            { horizons: [2], slippageRate: 0, commissionRate: 0, blockCount: 1 },
        );
        const h = result.horizons[0]!;
        expect(h.topRawHiPairs.events).to.equal(1);
        expect(h.topRawLoPairs.events).to.equal(1);
    });

    it("conditional-split arms are deterministic across runs", async () => {
        const pairs = [
            ...Array.from({ length: 5 }, (_, i) => makePair("AAA", `X${i}`, [makeTrade("long", T0 + 1000, T0 + 2000)])),
            makePair("BBB", "Y1", [makeTrade("long", T0 + 1000, T0 + 2000)]),
            ...Array.from({ length: 3 }, (_, i) => makePair("AAA", `P${i}`, [makeTrade("long", T0 + 3000, T0 + 4000)])),
            makePair("BBB", "Q1", [makeTrade("long", T0 + 3000, T0 + 4000)]),
        ];
        const targets = [makeTarget("AAA", 10, flat(10, 100)), makeTarget("BBB", 10, flat(10, 100))];
        const opts = { horizons: [2], slippageRate: 0, commissionRate: 0, blockCount: 1 };
        const r1 = await runOpenScoreUsdReplay(() => fromArray(pairs), () => fromArray(targets), opts);
        const r2 = await runOpenScoreUsdReplay(() => fromArray(pairs), () => fromArray(targets), opts);
        expect(r1.reportLines).to.deep.equal(r2.reportLines);
        // Spot-check determinism on each surviving conditional-split arm.
        expect(r1.horizons[0]!.topRawFresh).to.deep.equal(r2.horizons[0]!.topRawFresh);
        expect(r1.horizons[0]!.topRawStaleLong).to.deep.equal(r2.horizons[0]!.topRawStaleLong);
        expect(r1.horizons[0]!.topRawDominant).to.deep.equal(r2.horizons[0]!.topRawDominant);
        expect(r1.horizons[0]!.topRawHiPairs).to.deep.equal(r2.horizons[0]!.topRawHiPairs);
    });
});
