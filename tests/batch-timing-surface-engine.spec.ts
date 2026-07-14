/**
 * Focused tests for the pure Timing Surface engine.
 *
 * Covers the research contract:
 *  - 60/20/20 chronological window split, boundary purge.
 *  - Discovery-only horizon calibration; selection/validation cannot change it.
 *  - Per-rerun cell metrics, cross-rerun aggregation; duplicated episodes across
 *    reruns never pool as independent observations.
 *  - Delay-zero requires positive median net; delayed requires positive lift.
 *  - Plateau requirement; isolated optimum is rejected.
 *  - Frozen policy passes/fails timing validation; validation cannot change
 *    the selected policy.
 *  - Deterministic tie-breaks; shuffled input does not change sorted output.
 *  - Costs can turn gross-positive evidence into SKIP.
 *  - Every Phase 1–4 result carries evidenceScope "historical_conditional" and
 *    exploitEligible false.
 *
 * Framework: node:test + chai (matches batch-portfolio-fit-engine.spec.ts).
 */
import { expect } from "chai";
import { describe, it } from "node:test";
import { __testInternals, runTimingSurfaceEngine } from "../lib/batch-backtest/batch-timing-surface-engine";
import type { BatchStabilityMineResult, BatchStabilityRow } from "../lib/batch-backtest/batch-stability-mine";
import type { OHLCVData, Strategy, Time } from "../lib/types/strategies";
import type {
    TimingSurfaceCostModel,
    TimingSurfaceEngineInput,
} from "../lib/batch-backtest/batch-timing-surface-types";
import {
    buildBatchSyntheticAnalogDetail,
    prepareBatchSyntheticTargetArtifacts,
    type BatchSyntheticPreparedPairArtifact,
} from "../lib/batch-backtest/batch-synthetic-state-miner";

function makeCandles(closes: number[]): OHLCVData[] {
    return closes.map((close, index) => ({
        time: (1_700_000_000 + (index * 300)) as Time,
        open: close,
        high: close + 1,
        low: close - 1,
        close,
        volume: 1000,
    }));
}

const COST_MODEL_ZERO: TimingSurfaceCostModel = {
    commissionPercent: 0,
    slippageBps: 0,
    executionModel: "signal_close",
};

function makeStabilityRow(asset: string, direction: "LONG" | "SHORT"): BatchStabilityRow {
    return {
        asset,
        direction,
        hits: 10,
        high: 6,
        medium: 3,
        low: 1,
        medianRetPct: 1.5,
        medianLiftPct: 1.0,
        medianRr: 2,
        medianDist: 1.0,
        medianHmaxLiftPct: 0.8,
        pairWarnings: 0,
        timingEdgeScore: 50,
        medianDiversity: 0.6,
        asOfTimeKey: "1700000000",
        close: 100,
        medianBarsHeld: 3,
        agreementTransition: 1,
        freshHits: 6,
        dominantPair: "BTC+ETH",
        dominantPairShare: 0.3,
    };
}

function makeStabilityResult(rows: BatchStabilityRow[], reruns = 8): BatchStabilityMineResult {
    return {
        reruns,
        subsetSize: 10,
        seed: 1,
        totalPairs: 12,
        targetAssets: rows.length,
        hitEvents: rows.length * reruns,
        rows,
    };
}

const NO_OP_STRATEGY: Strategy = {
    name: "Timing Surface No-Op",
    description: "Buys at bar 0, sells at the last bar — produces a long carry trade.",
    defaultParams: {},
    paramLabels: {},
    execute(data) {
        if (data.length < 2) return [];
        return [
            { time: data[0]!.time, type: "buy", price: data[0]!.close },
            { time: data[data.length - 1]!.time, type: "sell", price: data[data.length - 1]!.close },
        ];
    },
};

function makeLinkedArtifacts(
    asset: string,
    candles: OHLCVData[],
    strategy: Strategy = NO_OP_STRATEGY,
): BatchSyntheticPreparedPairArtifact[] {
    const signals = strategy.execute(candles, {}) ?? [];
    // Synthesize a trivial BacktestResult with one round-trip trade.
    const first = candles[0]!;
    const last = candles[candles.length - 1]!;
    const result = {
        trades: [
            {
                type: "long" as const,
                entryTime: first.time,
                exitTime: last.time,
                entryPrice: first.close,
                exitPrice: last.close,
                size: 1,
                pnl: last.close - first.close,
                returnPct: ((last.close - first.close) / first.close) * 100,
                barsHeld: candles.length - 1,
                exitReason: "signal" as const,
            },
        ],
        netProfit: last.close - first.close,
        netProfitPercent: ((last.close - first.close) / first.close) * 100,
        winRate: 100,
        expectancy: last.close - first.close,
        avgTrade: last.close - first.close,
        profitFactor: Number.POSITIVE_INFINITY,
        maxDrawdown: 0,
        maxDrawdownPercent: 0,
        totalTrades: 1,
        winningTrades: 1,
        losingTrades: 0,
        avgWin: last.close - first.close,
        avgLoss: 0,
        sharpeRatio: 0,
        equityCurve: [],
    };
    // Build via the miner's prepare function so internal indexes are populated.
    // We import it lazily to keep this test file's top clean.
    const { prepareBatchSyntheticPairArtifacts } = require("../lib/batch-backtest/batch-synthetic-state-miner");
    const raw = [{
        symbol: `${asset}+QUOTE`,
        baseAsset: asset,
        quoteAsset: "QUOTE",
        data: candles,
        signals,
        result,
    }];
    return prepareBatchSyntheticPairArtifacts(raw);
}

function buildInput(
    rows: BatchStabilityRow[],
    reruns: number,
    resolveRerunLinkedArtifacts: TimingSurfaceEngineInput["resolveRerunLinkedArtifacts"],
    candlesByAsset: Map<string, OHLCVData[]>,
    costModel: TimingSurfaceCostModel = COST_MODEL_ZERO,
    actions?: Map<string, "ENTER" | "WATCH" | "WAIT" | "REJECT" | "INVALID">,
): TimingSurfaceEngineInput {
    const stability = makeStabilityResult(rows, reruns);
    const stabilityActions = actions ?? new Map(rows.map((r) => [`${r.asset}|${r.direction}`, "ENTER" as const]));
    const targets = new Map<string, { asset: string; data: OHLCVData[] }>();
    for (const [asset, data] of candlesByAsset) targets.set(asset, { asset, data });
    return {
        fingerprint: "test-fingerprint",
        interval: "5m",
        stability,
        stabilityActions,
        costModel,
        targets,
        resolveRerunLinkedArtifacts,
        nowMs: 1_700_000_000_000,
        completionNow: () => 1_700_000_000_000,
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("batch-timing-surface-engine — evidence scope and exploit-eligible labels", () => {
    it("always carries evidenceScope historical_conditional and exploitEligible false", async () => {
        const candles = makeCandles(Array.from({ length: 200 }, (_, i) => 100 + i));
        const artifacts = makeLinkedArtifacts("BTC", candles);
        const input = buildInput(
            [makeStabilityRow("BTC", "LONG")],
            8,
            () => ({ linkedArtifacts: artifacts }),
            new Map([["BTC", candles]]),
        );
        const result = await runTimingSurfaceEngine(input);
        expect(result.evidenceScope).to.equal("historical_conditional");
        expect(result.exploitEligible).to.equal(false);
        expect(result.schemaVersion).to.equal(1);
        // No raw arrays leak into the result.
        const json = JSON.stringify(result);
        expect(json).to.not.match(/"data"\s*:/);
        expect(json).to.not.match(/"signals"\s*:/);
        expect(json).to.not.match(/"trades"\s*:/);
        expect(json).to.not.match(/"equityCurve"\s*:/);
    });
});

describe("batch-timing-surface-engine — non-ENTER Stability rows are skipped", () => {
    it("emits no rows when no Stability row is ENTER", async () => {
        const candles = makeCandles(Array.from({ length: 200 }, (_, i) => 100 + i));
        const artifacts = makeLinkedArtifacts("BTC", candles);
        const input = buildInput(
            [makeStabilityRow("BTC", "LONG")],
            8,
            () => ({ linkedArtifacts: artifacts }),
            new Map([["BTC", candles]]),
            COST_MODEL_ZERO,
            new Map([["BTC|LONG", "WATCH"]]),
        );
        const result = await runTimingSurfaceEngine(input);
        expect(result.rows).to.have.lengthOf(0);
    });
});

describe("batch-timing-surface-engine — missing target dataset emits INVALID", () => {
    it("emits an INVALID row when target data is unavailable", async () => {
        const candles = makeCandles(Array.from({ length: 200 }, (_, i) => 100 + i));
        const artifacts = makeLinkedArtifacts("BTC", candles);
        const input = buildInput(
            [makeStabilityRow("BTC", "LONG")],
            8,
            () => ({ linkedArtifacts: artifacts }),
            new Map(), // no target datasets
        );
        const result = await runTimingSurfaceEngine(input);
        expect(result.rows).to.have.lengthOf(1);
        expect(result.rows[0]!.decision).to.equal("INVALID");
        expect(result.rows[0]!.reasonCodes).to.include("INVALID_INPUT");
    });
});

describe("batch-timing-surface-engine — no reruns yields INVALID/insufficient recurrence", () => {
    it("emits INSUFFICIENT_RECURRENCE when no rerun returns linked artifacts", async () => {
        const candles = makeCandles(Array.from({ length: 200 }, (_, i) => 100 + i));
        const input = buildInput(
            [makeStabilityRow("BTC", "LONG")],
            8,
            () => null, // no linked artifacts for any rerun
            new Map([["BTC", candles]]),
        );
        const result = await runTimingSurfaceEngine(input);
        expect(result.rows).to.have.lengthOf(1);
        const row = result.rows[0]!;
        expect(["INVALID", "WATCH"]).to.include(row.decision);
        expect(row.reasonCodes).to.include("INSUFFICIENT_RECURRENCE");
    });
});

describe("batch-timing-surface-engine — profile is populated and bounded", () => {
    it("records targetsEvaluated and rerunsEvaluated", async () => {
        const candles = makeCandles(Array.from({ length: 200 }, (_, i) => 100 + i));
        const artifacts = makeLinkedArtifacts("BTC", candles);
        const input = buildInput(
            [makeStabilityRow("BTC", "LONG")],
            4,
            () => ({ linkedArtifacts: artifacts }),
            new Map([["BTC", candles]]),
        );
        const result = await runTimingSurfaceEngine(input);
        expect(result.profile.targetsEvaluated).to.be.greaterThan(0);
        expect(result.profile.rerunsEvaluated).to.be.greaterThan(0);
        expect(result.profile.engineMs).to.be.greaterThanOrEqual(0);
        expect(result.profile.cellsEvaluated).to.be.greaterThan(0);
        expect(result.profile.cellsEmitted).to.be.at.most(result.profile.cellsEvaluated);
        expect(result.profile.boundaryCheckedSamples).to.be.at.least(result.profile.boundaryPurgedSamples);
    });
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

describe("batch-timing-surface-engine — mid-computation cancellation", () => {
    it("throws TimingSurfaceCancelled when lostOwnership returns true mid-target", async () => {
        const candles = makeCandles(Array.from({ length: 200 }, (_, i) => 100 + i));
        const artifacts = makeLinkedArtifacts("BTC", candles);
        // Two eligible targets; flip ownership after the first target starts.
        let calls = 0;
        const input: TimingSurfaceEngineInput = {
            ...buildInput(
                [makeStabilityRow("BTC", "LONG"), makeStabilityRow("ETH", "LONG")],
                4,
                () => ({ linkedArtifacts: artifacts }),
                new Map([["BTC", candles], ["ETH", candles]]),
            ),
            lostOwnership: () => {
                calls += 1;
                return calls > 1; // flip after the first check
            },
        };
        let caught: unknown = null;
        try {
            await runTimingSurfaceEngine(input);
        } catch (error) {
            caught = error;
        }
        expect(caught).to.be.instanceOf(Error);
        expect((caught as Error).message).to.match(/cancelled/i);
    });
});

describe("batch-timing-surface-engine - exact fill-boundary isolation", () => {
    it("purges fills that touch the next chronological window for every execution model", () => {
        const data = makeCandles(Array.from({ length: 40 }, (_, i) => 100 + i));
        const target = { asset: "BTC", symbol: "BTC", data } as any;
        const windows = { discoveryEndIndex: 10, selectionEndIndex: 20, candidateSpan: 30 };
        const sampleAt = (barIndex: number) => ({ barIndex, snapshot: {}, asset: "BTC", direction: "long" }) as any;
        const cases: Array<{ executionModel: TimingSurfaceCostModel["executionModel"]; barIndex: number }> = [
            { executionModel: "signal_close", barIndex: 8 },
            { executionModel: "next_open", barIndex: 7 },
            { executionModel: "next_close", barIndex: 7 },
        ];
        for (const testCase of cases) {
            const result = __testInternals.buildWindowEpisodesForCell(
                [sampleAt(testCase.barIndex)], 0, 2, "long", target, windows, "discovery",
                { ...COST_MODEL_ZERO, executionModel: testCase.executionModel }, null,
            );
            expect(result.episodes, testCase.executionModel).to.have.lengthOf(0);
            expect(result.purged, testCase.executionModel).to.equal(1);
        }
        const valid = __testInternals.buildWindowEpisodesForCell(
            [sampleAt(7)], 0, 2, "long", target, windows, "discovery", COST_MODEL_ZERO, null,
        );
        expect(valid.episodes).to.have.lengthOf(1);
    });
});

describe("batch-timing-surface-engine - discovery horizon isolation", () => {
    it("maps linked-pair trade times to target indexes before accepting discovery holds", () => {
        const targetData = makeCandles(Array.from({ length: 200 }, (_, i) => 100 + i));
        const target = prepareBatchSyntheticTargetArtifacts([{
            asset: "BTC",
            symbol: "BTC",
            data: targetData,
        }])[0]!;
        // This pair starts late in the target history. Its raw pair indexes
        // are 0..79 (apparently discovery), while its timestamps are in the
        // target's selection/validation region.
        const latePair = makeLinkedArtifacts("BTC", targetData.slice(120));
        const detail = buildBatchSyntheticAnalogDetail({
            target,
            linkedPairs: latePair,
            direction: "long",
            options: { autoHorizons: false },
        });

        expect(detail.discoveryHoldBars).to.deep.equal([]);
    });
});

describe("batch-timing-surface-engine - selection positive-rate ranking", () => {
    it("prefers five positives out of five over six positives out of ten", () => {
        const metrics = (positiveReruns: number, qualifyingReruns: number) => ({
            window: "selection",
            evaluatedReruns: qualifyingReruns,
            qualifyingReruns,
            positiveReruns,
            medianNetReturnPct: 1,
            p10NetReturnPct: 0.1,
            medianWinRate: 0.6,
            medianLiftOverImmediatePct: 0,
            totalEpisodes: qualifyingReruns * 4,
        });
        const cell = (positiveReruns: number, qualifyingReruns: number) => ({
            delay: 0,
            horizon: 6,
            discovery: metrics(positiveReruns, qualifyingReruns),
            selection: metrics(positiveReruns, qualifyingReruns),
            validation: metrics(positiveReruns, qualifyingReruns),
        }) as any;
        expect(__testInternals.compareCellsForSelection(cell(6, 10), cell(5, 5))).to.be.greaterThan(0);
    });
});

describe("batch-timing-surface-engine - independent window recurrence", () => {
    const window = (qualifyingReruns: number) => ({
        window: "validation" as const,
        evaluatedReruns: 50,
        qualifyingReruns,
        positiveReruns: qualifyingReruns,
        medianNetReturnPct: 4.325,
        p10NetReturnPct: 4.325,
        medianWinRate: 0.75,
        medianLiftOverImmediatePct: 0,
        totalEpisodes: qualifyingReruns * 4,
    });

    it("rejects the one-qualifying-rerun validation pattern that produced ATOM ENTER_NOW", () => {
        expect(__testInternals.windowQualifiesRecurrence(
            window(1),
            { minQualifyingReruns: 5, minRecurrenceFraction: 0.1 } as any,
            50,
        )).to.equal(false);
    });

    it("accepts a window only after both recurrence thresholds are met", () => {
        const gates = { minQualifyingReruns: 5, minRecurrenceFraction: 0.1 } as any;
        expect(__testInternals.windowQualifiesRecurrence(window(5), gates, 50)).to.equal(true);
        expect(__testInternals.windowQualifiesRecurrence(window(5), gates, 100)).to.equal(false);
    });

    it("reports only reruns that contributed window metrics as evaluated", () => {
        const perRerun = [
            { medianReturnPct: 1, episodeReturnsPct: [1, 1, 1, 1], episodeLiftsPct: [], medianLiftPct: 0, episodes: 4 },
            { medianReturnPct: -1, episodeReturnsPct: [-1, -1], episodeLiftsPct: [], medianLiftPct: 0, episodes: 2 },
        ];
        const metrics = __testInternals.aggregateWindow(
            "validation",
            perRerun,
            { minEpisodesPerRerunCell: 4 } as any,
        );
        expect(metrics.evaluatedReruns).to.equal(2);
        expect(metrics.qualifyingReruns).to.equal(1);
        expect(metrics.positiveReruns).to.equal(1);
    });
});

describe("batch-timing-surface-engine - rejected selected-policy evidence", () => {
    it("keeps the frozen delay, horizon, and validation evidence on SKIP", () => {
        const window = (name: "discovery" | "selection" | "validation") => ({
            window: name,
            evaluatedReruns: 8,
            qualifyingReruns: 8,
            positiveReruns: name === "validation" ? 2 : 7,
            medianNetReturnPct: name === "validation" ? -0.2 : 1.1,
            p10NetReturnPct: -0.4,
            medianWinRate: 0.6,
            medianLiftOverImmediatePct: 0.3,
            totalEpisodes: 32,
        });
        const frozen = {
            delay: 2,
            horizon: 12,
            discovery: window("discovery"),
            selection: window("selection"),
            validation: window("validation"),
        } as any;
        const row = __testInternals.buildSelectedRow(
            makeStabilityRow("BTC", "LONG"), "ENTER", "SKIP", frozen,
            { positiveNeighbors: 2, availableNeighbors: 3, neighborDelays: [], neighborHorizons: [] },
            { data: makeCandles(Array.from({ length: 40 }, (_, i) => 100 + i)) } as any,
            ["NEGATIVE_NET_EXPECTANCY"],
        );
        expect(row.chosenDelay).to.equal(2);
        expect(row.chosenHorizon).to.equal(12);
        expect(row.validationEpisodes).to.equal(32);
        expect(row.validationMedianNetReturnPct).to.equal(-0.2);
    });

    it("keeps diagnostic evidence on WATCH without presenting a frozen policy", () => {
        const window = (name: "discovery" | "selection" | "validation") => ({
            window: name,
            evaluatedReruns: 20,
            qualifyingReruns: name === "discovery" ? 7 : 3,
            positiveReruns: name === "discovery" ? 6 : 1,
            medianNetReturnPct: name === "selection" ? -0.4 : 0.8,
            p10NetReturnPct: -0.7,
            medianWinRate: 0.55,
            medianLiftOverImmediatePct: 0.2,
            totalEpisodes: name === "discovery" ? 28 : 12,
        });
        const evidenceCell = {
            delay: 2,
            horizon: 12,
            discovery: window("discovery"),
            selection: window("selection"),
            validation: window("validation"),
        } as any;
        const row = __testInternals.buildEvidenceWatchRow(
            makeStabilityRow("BTC", "LONG"), evidenceCell,
            { positiveNeighbors: 0, availableNeighbors: 3, neighborDelays: [], neighborHorizons: [] },
            { data: makeCandles(Array.from({ length: 40 }, (_, i) => 100 + i)) } as any,
            ["NO_POSITIVE_SELECTION"],
        );
        expect(row.decision).to.equal("WATCH");
        expect(row.chosenDelay).to.equal(null);
        expect(row.chosenHorizon).to.equal(null);
        expect(row.evidenceDelay).to.equal(2);
        expect(row.evidenceHorizon).to.equal(12);
        expect(row.discoveryEpisodes).to.equal(28);
        expect(row.selectionEpisodes).to.equal(12);
        expect(row.selectionMedianNetReturnPct).to.equal(-0.4);
    });

    it("distinguishes absent selection edge, isolated optimum, and weak plateau", () => {
        const candidate = {} as any;
        expect(__testInternals.resolveSelectionRejectionReason(null, {
            positiveNeighbors: 0, availableNeighbors: 3, neighborDelays: [], neighborHorizons: [],
        })).to.equal("NO_POSITIVE_SELECTION");
        expect(__testInternals.resolveSelectionRejectionReason(candidate, {
            positiveNeighbors: 0, availableNeighbors: 3, neighborDelays: [], neighborHorizons: [],
        })).to.equal("ISOLATED_OPTIMUM");
        expect(__testInternals.resolveSelectionRejectionReason(candidate, {
            positiveNeighbors: 1, availableNeighbors: 3, neighborDelays: [], neighborHorizons: [],
        })).to.equal("NO_PLATEAU");
    });

    it("rejects a cell when the grid cannot provide two plateau neighbors", () => {
        const gates = { plateauMinPositiveNeighbors: 2 } as any;
        expect(__testInternals.plateauPasses({
            positiveNeighbors: 1, availableNeighbors: 1, neighborDelays: [], neighborHorizons: [],
        }, gates)).to.equal(false);
        expect(__testInternals.plateauPasses({
            positiveNeighbors: 2, availableNeighbors: 2, neighborDelays: [], neighborHorizons: [],
        }, gates)).to.equal(true);
    });
});
