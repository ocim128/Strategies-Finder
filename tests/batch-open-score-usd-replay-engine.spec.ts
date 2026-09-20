import { expect } from "chai";
import { describe, it } from "node:test";
import {
    computeProfitNowConfidenceWeight,
    runOpenScoreUsdReplay,
    type OpenScoreUsdTarget,
    type PoolSnapshotRecord,
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
        expect(result.ongoingEventDetails).to.have.length(1);
        expect(result.ongoingEventDetails![0]!.decisionTime).to.equal(T0 + 1000);
        expect(result.ongoingEventDetails![0]!.entryTime).to.equal(T0 + 2000);
        expect(result.ongoingEventDetails![0]!.horizonBars).to.equal(5);
        expect(["AAA", "BBB"]).to.include(result.ongoingEventDetails![0]!.asset);
        expect(result.ongoingEventDetails![0]!.eligibleCandidates).to.equal(2);
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
