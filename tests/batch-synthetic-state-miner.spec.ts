import { expect } from "chai";
import { describe, it } from "node:test";
import {
    resolveBatchSyntheticTargetSymbol,
    runBatchSyntheticStateMiner,
    type BatchSyntheticPairArtifact,
    type BatchSyntheticTargetArtifact,
} from "../lib/batch-backtest/batch-synthetic-state-miner";
import type { BacktestResult, OHLCVData, Signal, Time, Trade } from "../lib/types/strategies";

function makeCandles(length: number, priceAt: (index: number) => number): OHLCVData[] {
    return Array.from({ length }, (_, index) => {
        const close = priceAt(index);
        return {
            time: (1_700_000_000 + (index * 300)) as Time,
            open: close,
            high: close + 0.5,
            low: close - 0.5,
            close,
            volume: 1000,
        };
    });
}

function makeResult(): BacktestResult {
    return {
        trades: [],
        netProfit: 0,
        netProfitPercent: 0,
        winRate: 0,
        expectancy: 0,
        avgTrade: 0,
        profitFactor: 0,
        maxDrawdown: 0,
        maxDrawdownPercent: 0,
        totalTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        avgWin: 0,
        avgLoss: 0,
        sharpeRatio: 0,
        equityCurve: [],
    };
}

function makeSignals(data: OHLCVData[], indexes: number[], type: Signal["type"] = "buy"): Signal[] {
    return indexes.map((index) => ({
        time: data[index]!.time,
        type,
        price: data[index]!.close,
        barIndex: index,
    }));
}

function makeEventLiftCandles(length: number, signalIndexes: number[]): OHLCVData[] {
    return makeCandles(length, (index) => {
        for (const signalIndex of signalIndexes) {
            const offset = index - signalIndex;
            if (offset === 0) {
                return 100;
            }
            if (offset === 1 || offset === 2) {
                return 104;
            }
        }
        return 99;
    });
}

function makePair(symbol: string, baseAsset: string, quoteAsset: string, signals: Signal[]): BatchSyntheticPairArtifact {
    const data = makeCandles(100, (index) => 100 + index * 0.2);
    return {
        symbol,
        baseAsset,
        quoteAsset,
        data,
        signals: signals.map((signal) => ({
            ...signal,
            time: data[signal.barIndex ?? 0]!.time,
            price: data[signal.barIndex ?? 0]!.close,
        })),
        result: makeResult(),
    };
}

describe("batch synthetic state miner", () => {
    it("resolves v1 target symbols as USDT pairs", () => {
        expect(resolveBatchSyntheticTargetSymbol("zec")).to.equal("ZECUSDT");
    });

    it("produces a long verdict from repeated OOS-positive shared-leg analogs", () => {
        const signalIndexes = [10, 20, 30, 40, 50, 60, 70, 80, 90, 99];
        const weakerBaselineIndexes = [15, 25, 35, 45, 55, 65, 75, 85, 95];
        const target: BatchSyntheticTargetArtifact = {
            asset: "ZEC",
            symbol: "ZECUSDT",
            data: makeEventLiftCandles(100, signalIndexes),
        };
        const signalTemplate = makeSignals(target.data, signalIndexes, "buy");
        const weakerBaselineSignals = makeSignals(target.data, weakerBaselineIndexes, "buy");
        const result = runBatchSyntheticStateMiner({
            interval: "5m",
            targets: [target],
            artifacts: [
                makePair("ZEC+APT", "ZEC", "APT", [...signalTemplate, ...weakerBaselineSignals]),
                makePair("ZEC+BTC", "ZEC", "BTC", signalTemplate),
            ],
            options: {
                horizons: [2],
                lagBars: 0,
                minSamples: 2,
                minOosSamples: 1,
                neighborCountMin: 2,
                neighborCountMax: 12,
            },
        });

        const verdict = result.verdicts.find((entry) => entry.asset === "ZEC")!;
        expect(verdict.verdict).to.equal("LONG");
        expect(verdict.direction).to.equal("long");
        expect(verdict.evidence.oosCount).to.be.greaterThanOrEqual(1);
        expect(verdict.evidence.expectedForwardReturnPct ?? 0).to.be.greaterThan(0);
    });

    it("does not turn broad positive drift into an entry verdict without lift", () => {
        const signalIndexes = [10, 25, 40, 62, 82, 88, 98];
        const target: BatchSyntheticTargetArtifact = {
            asset: "ZEC",
            symbol: "ZECUSDT",
            data: makeCandles(100, (index) => 100 + index * 0.3),
        };
        const signalTemplate = makeSignals(target.data, signalIndexes, "buy");
        const result = runBatchSyntheticStateMiner({
            interval: "5m",
            targets: [target],
            artifacts: [
                makePair("ZEC+APT", "ZEC", "APT", signalTemplate),
                makePair("ZEC+BTC", "ZEC", "BTC", signalTemplate),
            ],
            options: {
                horizons: [2],
                lagBars: 2,
                minSamples: 4,
                minOosSamples: 1,
                neighborCountMin: 4,
                neighborCountMax: 12,
            },
        });

        const verdict = result.verdicts.find((entry) => entry.asset === "ZEC")!;
        expect(verdict.verdict).to.equal("WATCH");
        expect(verdict.evidence.expectedForwardReturnPct ?? 0).to.be.greaterThan(0);
        expect(verdict.reasons[0]).to.contain("OOS edge below entry gate");
    });

    it("splits windows by bar position, not sample rank (sparse-signal fix)", () => {
        // Signals clustered at bars 82..98 sit entirely inside the newest 20%
        // of the 100-bar target history (the OOS window under bar-position
        // split). The buggy sample-rank split mislabeled these by sample
        // ordinal, leaking OOS samples into the selection bucket. Post-fix,
        // every sample here is correctly labeled OOS, so selectionCount is 0
        // and oosCount > 0. A second earlier cluster sits in the discovery
        // window to prove selection still receives samples by bar position.
        const target: BatchSyntheticTargetArtifact = {
            asset: "ZEC",
            symbol: "ZECUSDT",
            data: makeEventLiftCandles(100, [5, 10, 82, 84, 86, 88, 90, 92, 94, 96, 98]),
        };
        // Two pairs so direction is unambiguous (long beats short when both
        // agree on long).
        const discoverySignals = makeSignals(target.data, [5, 10], "buy");
        const oosSignals = makeSignals(target.data, [82, 84, 86, 88, 90, 92, 94, 96, 98], "buy");
        const combinedSignals = [...discoverySignals, ...oosSignals];
        const result = runBatchSyntheticStateMiner({
            interval: "5m",
            targets: [target],
            artifacts: [
                makePair("ZEC+APT", "ZEC", "APT", combinedSignals),
                makePair("ZEC+BTC", "ZEC", "BTC", combinedSignals),
            ],
            options: {
                horizons: [2],
                lagBars: 2,
                minSamples: 1,
                minOosSamples: 1,
                neighborCountMin: 1,
                neighborCountMax: 12,
            },
        });

        const verdict = result.verdicts.find((entry) => entry.asset === "ZEC")!;
        // The bar-position split: discovery samples (bars 5,10) land in
        // discovery; OOS samples (bars 82+) land in oos.
        expect(verdict.evidence.oosCount).to.be.greaterThan(0);
        // Sanity: at least one discovery-window sample exists so selection is
        // populated, proving the split is by bar position rather than dropping
        // early samples.
        const discoverySampleCount = (verdict.evidence.candidateCount)
            - verdict.evidence.oosCount;
        expect(discoverySampleCount).to.be.greaterThan(0);
    });

    it("derives auto-horizons from linked synthetic-pair trade hold when not pinned", () => {
        // Build a pair whose open trade spans 40 bars (median hold ~40b).
        // Auto-horizons should yield [20, 40, 80]. The primary (shortest)
        // horizon drives the visible Ret/Lift; the longest drives the gate.
        const length = 200;
        const target: BatchSyntheticTargetArtifact = {
            asset: "ZEC",
            symbol: "ZECUSDT",
            data: makeEventLiftCandles(length, [10, 60, 110, 160]),
        };
        const pairData = makeCandles(length, (index) => 100 + index * 0.1);
        // One long-signed trade from bar 20 -> 60 (hold 40b), another 120 -> 160.
        const trade: Trade = {
            id: 1,
            type: "long",
            entryTime: pairData[20]!.time,
            entryPrice: pairData[20]!.close,
            exitTime: pairData[60]!.time,
            exitPrice: pairData[60]!.close,
            pnl: 1,
            pnlPercent: 1,
            size: 1,
        };
        const trade2: Trade = { ...trade, id: 2, entryTime: pairData[120]!.time, exitTime: pairData[160]!.time };
        const result = runBatchSyntheticStateMiner({
            interval: "1h",
            targets: [target],
            artifacts: [
                {
                    symbol: "ZEC+APT",
                    baseAsset: "ZEC",
                    quoteAsset: "APT",
                    data: pairData,
                    signals: [],
                    result: { ...makeResult(), trades: [trade, trade2] },
                },
            ],
            // No horizons in options -> autoHorizons kicks in.
            options: { minSamples: 1, minOosSamples: 1, neighborCountMin: 1, neighborCountMax: 4 },
        });

        const verdict = result.verdicts.find((entry) => entry.asset === "ZEC")!;
        // Median hold 40 -> [20, 40, 80].
        expect(verdict.evidence.horizonBarsAll).to.deep.equal([20, 40, 80]);
        expect(verdict.evidence.horizonBars).to.equal(20);
        expect(verdict.evidence.longestHorizonBars).to.equal(80);
    });

    it("downgrades to WATCH when the short-horizon edge does not survive to the longest horizon", () => {
        // Construct a target whose first 2 bars after each signal rally
        // (short-horizon edge) but revert by bar 4 (longest horizon kills it).
        const length = 100;
        const signalIndexes = [10, 30, 50, 70, 90];
        const target: BatchSyntheticTargetArtifact = {
            asset: "ZEC",
            symbol: "ZECUSDT",
            data: makeCandles(length, (index) => {
                for (const s of signalIndexes) {
                    if (index === s + 1 || index === s + 2) return 104; // short-horizon lift
                    if (index === s + 3 || index === s + 4) return 99;  // revert by longest
                }
                return 100;
            }),
        };
        const signals = makeSignals(target.data, signalIndexes, "buy");
        const result = runBatchSyntheticStateMiner({
            interval: "5m",
            targets: [target],
            artifacts: [
                makePair("ZEC+APT", "ZEC", "APT", signals),
                makePair("ZEC+BTC", "ZEC", "BTC", signals),
            ],
            options: {
                // Short horizon = 2 (lift), longest = 4 (revert). The edge
                // must NOT pass because the longest-horizon gate fails.
                horizons: [2, 4],
                lagBars: 0,
                minSamples: 2,
                minOosSamples: 1,
                neighborCountMin: 2,
                neighborCountMax: 12,
            },
        });

        const verdict = result.verdicts.find((entry) => entry.asset === "ZEC")!;
        // Either WATCH or SKIP (edge fails), never LONG.
        expect(verdict.verdict).to.not.equal("LONG");
        // When it specifically trips the longest-horizon gate, the reason names it.
        if (verdict.reasons.some((r) => r.includes("does not persist to longest horizon"))) {
            expect(verdict.verdict).to.equal("WATCH");
            expect(verdict.evidence.longestOosForwardReturnPct ?? 0).to.be.lessThanOrEqual(0);
        }
    });

    it("splits windows over the candidate span so OOS stays reachable when the longest horizon is large", () => {
        // Regression guard: with longestHorizon large relative to length,
        // splitting over the FULL history places the OOS band (top 20%) past
        // the last possible candidate bar, starving OOS ("Pre 24, OOS 0").
        // Splitting over the candidate span (length - longestHorizon) keeps
        // OOS reachable. Here length=100, horizon=20 -> candidateSpan=80, so
        // bars 0..79 are candidate bars and the OOS band is bars ~64..79.
        // A signal at bar 98 gives the current bar (99) an active state via
        // lagBars=2 without itself being a candidate (98 > 79).
        const target: BatchSyntheticTargetArtifact = {
            asset: "ZEC",
            symbol: "ZECUSDT",
            data: makeEventLiftCandles(100, [5, 10, 70, 72, 74]),
        };
        const signals = makeSignals(target.data, [5, 10, 70, 72, 74, 98], "buy");
        const result = runBatchSyntheticStateMiner({
            interval: "5m",
            targets: [target],
            artifacts: [
                makePair("ZEC+APT", "ZEC", "APT", signals),
                makePair("ZEC+BTC", "ZEC", "BTC", signals),
            ],
            options: {
                horizons: [20],
                lagBars: 2,
                minSamples: 2,
                minOosSamples: 1,
                neighborCountMin: 1,
                neighborCountMax: 12,
            },
        });

        const verdict = result.verdicts.find((entry) => entry.asset === "ZEC")!;
        // OOS must receive samples (bars 70-74 sit in the OOS band of the
        // candidate span [0,79]: 70/79 ~= 0.88). Under the old full-history
        // split this would have been 0.
        expect(verdict.evidence.oosCount).to.be.greaterThan(0);
        // And discovery still receives the early samples (bars 5,10).
        expect(verdict.evidence.candidateCount - verdict.evidence.oosCount).to.be.greaterThan(0);
    });

    it("clamps auto-horizons to the candidate span and ignores survivor-biased open trades", () => {
        // Closed trade hold = 40b -> raw auto-horizons [20, 40, 80]. With
        // targetLength=100 the longest (80) is allowed (maxLongest=74), so the
        // clamped set is [20, 40, 74]. Critically, an `end_of_data` (still-open
        // at the boundary) trade of 95b must NOT inflate horizons (survivor
        // bias); only closed trades count.
        const length = 100;
        const target: BatchSyntheticTargetArtifact = {
            asset: "ZEC",
            symbol: "ZECUSDT",
            data: makeEventLiftCandles(length, [10, 60]),
        };
        const pairData = makeCandles(length, (index) => 100 + index * 0.1);
        const closed: Trade = {
            id: 1,
            type: "long",
            entryTime: pairData[20]!.time,
            entryPrice: pairData[20]!.close,
            exitTime: pairData[60]!.time,
            exitPrice: pairData[60]!.close,
            pnl: 1,
            pnlPercent: 1,
            size: 1,
        };
        // Survivor-biased: still open at the data boundary, hold ~95b. Must be
        // excluded from horizon calibration.
        const openAtBoundary: Trade = {
            ...closed,
            id: 2,
            entryTime: pairData[5]!.time,
            entryPrice: pairData[5]!.close,
            exitTime: pairData[99]!.time,
            exitPrice: pairData[99]!.close,
            exitReason: "end_of_data",
        };
        const result = runBatchSyntheticStateMiner({
            interval: "1h",
            targets: [target],
            artifacts: [
                {
                    symbol: "ZEC+APT",
                    baseAsset: "ZEC",
                    quoteAsset: "APT",
                    data: pairData,
                    signals: [],
                    result: { ...makeResult(), trades: [closed, openAtBoundary] },
                },
            ],
            options: { minSamples: 1, minOosSamples: 1, neighborCountMin: 1, neighborCountMax: 4 },
        });

        const verdict = result.verdicts.find((entry) => entry.asset === "ZEC")!;
        // Closed hold = 40b -> [20, 40, 80] then clamped to candidate span.
        // maxLongest = floor(100*0.75)-1 = 74, so longest = 74.
        expect(verdict.evidence.horizonBarsAll[0]).to.equal(20);
        expect(verdict.evidence.horizonBarsAll[1]).to.equal(40);
        expect(verdict.evidence.longestHorizonBars).to.equal(74);
    });

    it("inverts quote-leg direction for synthetic pair signals", () => {
        const signalIndexes = [10, 25, 40, 62, 82, 88, 98];
        const target: BatchSyntheticTargetArtifact = {
            asset: "APT",
            symbol: "APTUSDT",
            data: makeCandles(100, (index) => 100 - index * 0.2),
        };
        const pairData = makeCandles(100, (index) => 100 + index * 0.2);
        const signals = makeSignals(pairData, signalIndexes, "buy");
        const result = runBatchSyntheticStateMiner({
            interval: "5m",
            targets: [target],
            artifacts: [
                {
                    symbol: "ZEC+APT",
                    baseAsset: "ZEC",
                    quoteAsset: "APT",
                    data: pairData,
                    signals,
                    result: makeResult(),
                },
            ],
            options: {
                horizons: [2],
                lagBars: 2,
                minSamples: 4,
                minOosSamples: 2,
                neighborCountMin: 8,
                neighborCountMax: 12,
            },
        });

        const verdict = result.verdicts.find((entry) => entry.asset === "APT")!;
        expect(verdict.direction).to.equal("short");
        expect(verdict.currentSnapshot?.oppositionCount).to.equal(0);
    });

    it("does not void a lag-window signal when an intervening bar carries both sides", () => {
        // Regression guard for findLatestSignal: a bar with conflicting
        // buy+sell signals inside the lag window used to return null for the
        // WHOLE window, silently dropping the pair state. The fix is to skip
        // the ambiguous bar and keep searching backward for an unambiguous
        // signal still within lagBars. Here bar 98 (current) has no signal,
        // bar 97 carries both buy+sell (ambiguous), bar 96 carries a clean
        // buy. With lagBars=3 the lookup must find the bar-96 buy and report
        // an active long state, not "No active current synthetic state."
        const target: BatchSyntheticTargetArtifact = {
            asset: "ZEC",
            symbol: "ZECUSDT",
            data: makeEventLiftCandles(100, [96]),
        };
        const data100 = makeCandles(100, (i) => 100 + i * 0.2);
        const cleanBuy = makeSignals(data100, [96], "buy");
        const mixed = [
            ...makeSignals(data100, [97], "buy"),
            ...makeSignals(data100, [97], "sell"),
        ];
        const result = runBatchSyntheticStateMiner({
            interval: "5m",
            targets: [target],
            artifacts: [
                {
                    symbol: "ZEC+APT",
                    baseAsset: "ZEC",
                    quoteAsset: "APT",
                    data: data100,
                    // Place clean buy at bar 96 (data100-aligned time), then a
                    // mixed bar at 97. The pair's times must match the target's
                    // times so the snapshot lookup resolves.
                    signals: cleanBuy.map((s) => ({ ...s, time: target.data[96]!.time }))
                        .concat(mixed.map((s) => ({ ...s, time: target.data[97]!.time }))),
                    result: makeResult(),
                },
            ],
            options: {
                horizons: [2],
                lagBars: 3,
                minSamples: 1,
                minOosSamples: 1,
                neighborCountMin: 1,
                neighborCountMax: 4,
            },
        });

        const verdict = result.verdicts.find((entry) => entry.asset === "ZEC")!;
        // The current bar (99) reaches back through the ambiguous bar 97 to
        // the clean buy at 96, so a state is active. Under the old bug this
        // would have been INCONCLUSIVE with "No active current synthetic state."
        expect(verdict.direction).to.equal("long");
        expect(verdict.currentSnapshot?.activePeerCount ?? 0).to.be.greaterThan(0);
    });
});
