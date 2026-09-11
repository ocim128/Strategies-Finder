import { expect } from "chai";
import { describe, it } from "node:test";
import {
    buildMonthlyCheckpointSchedule,
    buildMonthlyRankReplayIdentityKey,
    compareMetricScores,
    computeWindowReturnPercent,
    isMonthlyRankReplayMetricAvailable,
    MonthlyRankReplayWinnerAccumulator,
    MONTHLY_RANK_REPLAY_EXCLUDED_SORTS,
    resolveBarCloseTimeSec,
    resolveMonthlyRankReplaySortCoverage,
    summarizeMonthlyRankReplaySort,
    validateMonthlyRankReplayOptions,
} from "../lib/finder/finder-monthly-rank-replay";
import {
    buildFinderUniverseCandidate,
    computeRobustUniverseScore,
    isAscendingUniverseMetric,
} from "../lib/finder/finder-universe-metrics";
import { computeReplayRobustUniverseScore } from "../lib/finder/finder-monthly-rank-replay";
import { UNIVERSE_SORT_OPTIONS, UNIVERSE_METRIC_FULL_LABELS } from "../lib/finder/constants";
import type { FinderUniverseMetric, FinderUniverseSymbolMetrics, FinderUniverseSymbolResult } from "../lib/types/finder";
import { serializeJsonPreservingNonFinite, parseJsonPreservingNonFinite } from "../lib/json-utils";
import {
    formatMonthlyRankReplayReportText,
    formatMonthlyRankReplaySelectionLine,
} from "../lib/finder/finder-monthly-rank-replay-format";
import type { Time } from "../lib/types/strategies";

function makeSymbolMetrics(overrides: Partial<FinderUniverseSymbolMetrics> = {}): FinderUniverseSymbolMetrics {
    return {
        netProfit: 0,
        netProfitPercent: 0,
        expectancy: 0,
        avgTrade: 0,
        winRate: 0,
        profitFactor: 1,
        maxDrawdownPercent: 0,
        totalTrades: 20,
        winningTrades: 10,
        losingTrades: 10,
        avgWin: 1,
        avgLoss: -1,
        sharpeRatio: 0,
        ...overrides,
    };
}

function makeSymbol(
    symbol: string,
    metrics?: Partial<FinderUniverseSymbolMetrics> & { status?: FinderUniverseSymbolResult["status"] },
): FinderUniverseSymbolResult {
    const { status, ...metricOverrides } = metrics ?? {};
    const hasMetrics = metrics !== undefined && Object.keys(metricOverrides).length > 0;
    const resolvedStatus = status ?? (hasMetrics ? (metricOverrides.totalTrades ?? 20) > 0 ? "profitable" : "no_trades" : "no_trades");
    return {
        symbol,
        status: resolvedStatus,
        barCount: 500,
        firstTime: 1600000000 as Time,
        lastTime: 1700000000 as Time,
        ...(hasMetrics ? { result: makeSymbolMetrics(metricOverrides) } : {}),
    };
}

function makeCandidate(
    symbols: FinderUniverseSymbolResult[],
    overrides: { strategyKey?: string; strategyName?: string; params?: Record<string, number>; exitStrategyKey?: string } = {},
) {
    return buildFinderUniverseCandidate({
        strategyKey: overrides.strategyKey ?? "demo",
        strategyName: overrides.strategyName ?? "Demo",
        params: overrides.params ?? { period: 10 },
        symbols,
        ...(overrides.exitStrategyKey ? { exitStrategyKey: overrides.exitStrategyKey, exitStrategyName: overrides.exitStrategyKey, exitStrategyParams: {} } : {}),
    });
}

describe("Monthly Rank Replay sort coverage", () => {
    it("replays every existing historical Universe sort and preserves its direction", () => {
        const { replayed } = resolveMonthlyRankReplaySortCoverage();
        const expectedReplayed = UNIVERSE_SORT_OPTIONS.filter(
            (key) => !MONTHLY_RANK_REPLAY_EXCLUDED_SORTS.includes(key),
        );
        expect(replayed.map((sort) => sort.key)).to.deep.equal([...expectedReplayed]);
        for (const sort of replayed) {
            expect(sort.label).to.equal(UNIVERSE_METRIC_FULL_LABELS[sort.key]);
            expect(sort.ascending).to.equal(isAscendingUniverseMetric(sort.key));
            expect(sort.direction).to.equal(isAscendingUniverseMetric(sort.key) ? "ascending" : "descending");
        }
        // The two drawdown sorts select minima; every other replayed sort selects maxima.
        const ascendingKeys = replayed.filter((sort) => sort.ascending).map((sort) => sort.key);
        expect(ascendingKeys).to.deep.equal(["worstMaxDrawdownPercent", "medianMaxDrawdownPercent"]);
        expect(replayed.length).to.equal(UNIVERSE_SORT_OPTIONS.length - 1);
    });

    it("excludes the OOS-dependent Window Stability Score with a reason", () => {
        const coverage = resolveMonthlyRankReplaySortCoverage();
        expect(coverage.excluded.map((entry) => entry.key)).to.deep.equal(["windowStabilityScore"]);
        expect(coverage.excluded[0]!.reason.length).to.be.greaterThan(0);
    });
});

describe("Monthly Rank Replay metric availability", () => {
    it("keeps an actual finite zero Sharpe available but marks missing Sharpe unavailable", () => {
        const zeroSharpe = makeCandidate([
            makeSymbol("A", { sharpeRatio: 0, sharpeRatioAvailable: true }),
        ]);
        expect(isMonthlyRankReplayMetricAvailable(zeroSharpe, "medianSharpe")).to.equal(true);
        expect(zeroSharpe.medianSharpe).to.equal(0);

        const unavailableSharpe = makeCandidate([
            makeSymbol("A", { totalTrades: 20 }),
        ]);
        expect(isMonthlyRankReplayMetricAvailable(unavailableSharpe, "medianSharpe")).to.equal(false);
    });

    it("requires an active symbol for median aggregates and positive-infinite PF stays available", () => {
        const allNoTrade = makeCandidate([makeSymbol("A")]);
        expect(isMonthlyRankReplayMetricAvailable(allNoTrade, "medianProfitFactor")).to.equal(false);
        expect(isMonthlyRankReplayMetricAvailable(allNoTrade, "medianExpectancy")).to.equal(false);
        expect(isMonthlyRankReplayMetricAvailable(allNoTrade, "profitableActiveRatio")).to.equal(false);

        const infinitePf = makeCandidate([
            makeSymbol("A", { profitFactor: Number.POSITIVE_INFINITY }),
        ]);
        expect(infinitePf.medianProfitFactor).to.equal(Number.POSITIVE_INFINITY);
        expect(isMonthlyRankReplayMetricAvailable(infinitePf, "medianProfitFactor")).to.equal(true);
    });

    it("marks optional edge/drawdown sorts unavailable without observations instead of ranking a fabricated zero", () => {
        const withoutEdge = makeCandidate([makeSymbol("A", {})]);
        // Symbol has trades but no compositeEdgeRatio / exitAlpha / drawdown computed.
        expect(isMonthlyRankReplayMetricAvailable(withoutEdge, "medianCompositeEdgeRatio")).to.equal(false);
        expect(isMonthlyRankReplayMetricAvailable(withoutEdge, "medianExitAlpha")).to.equal(false);
        expect(isMonthlyRankReplayMetricAvailable(withoutEdge, "worstMaxDrawdownPercent")).to.equal(false);

        const withEdge = makeCandidate([
            makeSymbol("A", { compositeEdgeRatio: 1.5, exitAlpha: 0.4, drawdownAvailable: true, maxDrawdownPercent: 3 }),
        ]);
        expect(isMonthlyRankReplayMetricAvailable(withEdge, "medianCompositeEdgeRatio")).to.equal(true);
        expect(isMonthlyRankReplayMetricAvailable(withEdge, "medianExitAlpha")).to.equal(true);
        expect(isMonthlyRankReplayMetricAvailable(withEdge, "medianMaxDrawdownPercent")).to.equal(true);
    });

    it("counts and weighted-trade sorts stay always available", () => {
        const candidate = makeCandidate([makeSymbol("A"), makeSymbol("B")]);
        expect(isMonthlyRankReplayMetricAvailable(candidate, "totalTrades")).to.equal(true);
        expect(isMonthlyRankReplayMetricAvailable(candidate, "activeSymbols")).to.equal(true);
        expect(isMonthlyRankReplayMetricAvailable(candidate, "robustUniverseScore")).to.equal(true);
    });
});

describe("Monthly Rank Replay winner accumulator", () => {
    const ALL_SORTS = resolveMonthlyRankReplaySortCoverage().replayed.map((sort) => sort.key);

    function candidateWith(values: Partial<Record<FinderUniverseMetric, number>>, symbols: FinderUniverseSymbolResult[], name = "Demo"): ReturnType<typeof makeCandidate> {
        const candidate = makeCandidate(symbols, { strategyName: name });
        // Directly drive per-metric scores through the symbol rows where possible.
        if (values.medianSharpe !== undefined) {
            candidate.medianSharpe = values.medianSharpe;
            candidate.medianSharpeAvailable = true;
        }
        if (values.medianProfitFactor !== undefined) {
            candidate.medianProfitFactor = values.medianProfitFactor;
        }
        if (values.medianExpectancy !== undefined) {
            candidate.medianExpectancy = values.medianExpectancy;
        }
        if (values.worstMaxDrawdownPercent !== undefined) {
            candidate.worstMaxDrawdownPercent = values.worstMaxDrawdownPercent;
            candidate.medianMaxDrawdownPercent = values.medianMaxDrawdownPercent ?? values.worstMaxDrawdownPercent;
            candidate.drawdownMetricsAvailable = true;
        }
        if (values.totalTrades !== undefined) {
            candidate.totalTrades = values.totalTrades;
        }
        if (values.medianCompositeEdgeRatio !== undefined) {
            candidate.medianCompositeEdgeRatio = values.medianCompositeEdgeRatio;
        }
        if (values.medianExitAlpha !== undefined) {
            candidate.medianExitAlpha = values.medianExitAlpha;
        }
        return candidate;
    }

    it("selects a winner per sort from the complete pool, honoring drawdown minima", () => {
        const accumulator = new MonthlyRankReplayWinnerAccumulator(ALL_SORTS);
        const highSharpeBadDrawdown = candidateWith(
            { medianSharpe: 2.0, worstMaxDrawdownPercent: 40 },
            [makeSymbol("A", { sharpeRatio: 2.0, sharpeRatioAvailable: true, drawdownAvailable: true, maxDrawdownPercent: 40 })],
            "HighSharpe",
        );
        const lowSharpeGoodDrawdown = candidateWith(
            { medianSharpe: 1.0, worstMaxDrawdownPercent: 5 },
            [makeSymbol("A", { sharpeRatio: 1.0, sharpeRatioAvailable: true, drawdownAvailable: true, maxDrawdownPercent: 5 })],
            "LowDrawdown",
        );

        accumulator.offer(highSharpeBadDrawdown, buildMonthlyRankReplayIdentityKey({ strategyKey: "demo", strategyName: "HighSharpe", params: { period: 1 } }), 0);
        accumulator.offer(lowSharpeGoodDrawdown, buildMonthlyRankReplayIdentityKey({ strategyKey: "demo", strategyName: "LowDrawdown", params: { period: 2 } }), 1);

        const winners = accumulator.winners();
        expect(winners.get("medianSharpe")!.candidate.strategyName).to.equal("HighSharpe");
        expect(winners.get("worstMaxDrawdownPercent")!.candidate.strategyName).to.equal("LowDrawdown");
        expect(winners.get("medianMaxDrawdownPercent")!.candidate.strategyName).to.equal("LowDrawdown");
        expect(winners.get("medianSharpe")!.score).to.equal(2.0);
        expect(winners.get("worstMaxDrawdownPercent")!.score).to.equal(5);
    });

    it("finds a PF winner outside the Sharpe winner using each sort's own formula", () => {
        const accumulator = new MonthlyRankReplayWinnerAccumulator(["medianSharpe", "medianProfitFactor"]);
        const a = candidateWith(
            { medianSharpe: 2, medianProfitFactor: 1.1 },
            [makeSymbol("A", { sharpeRatio: 2, sharpeRatioAvailable: true, profitFactor: 1.1 })],
            "A",
        );
        const b = candidateWith(
            { medianSharpe: 1, medianProfitFactor: 3 },
            [makeSymbol("A", { sharpeRatio: 1, sharpeRatioAvailable: true, profitFactor: 3 })],
            "B",
        );
        accumulator.offer(a, "a", 0);
        accumulator.offer(b, "b", 1);
        expect(accumulator.winners().get("medianSharpe")!.candidate.strategyName).to.equal("A");
        expect(accumulator.winners().get("medianProfitFactor")!.candidate.strategyName).to.equal("B");
    });

    it("breaks metric ties by canonical identity, then ordinal — not by ordinary name/param order", () => {
        const accumulator = new MonthlyRankReplayWinnerAccumulator(["totalTrades"]);
        // Identical metric values; "zzz" appears FIRST so name order must not win.
        const first = candidateWith({ totalTrades: 100 }, [makeSymbol("A")], "zzz");
        const second = candidateWith({ totalTrades: 100 }, [makeSymbol("A")], "aaa");
        const keyFirst = buildMonthlyRankReplayIdentityKey({ strategyKey: "demo", strategyName: "zzz", params: { b: 2, a: 1 } });
        const keySecond = buildMonthlyRankReplayIdentityKey({ strategyKey: "demo", strategyName: "aaa", params: { a: 1, b: 2 } });
        // Key order independence: stable serialization sorts keys.
        expect(buildMonthlyRankReplayIdentityKey({ strategyKey: "demo", strategyName: "zzz", params: { a: 1, b: 2 } })).to.equal(keyFirst);

        accumulator.offer(first, keyFirst, 0);
        accumulator.offer(second, keySecond, 1);
        // keyFirst < keySecond lexicographically, so the first candidate wins the tie.
        expect(accumulator.winners().get("totalTrades")!.identityKey).to.equal(keyFirst);

        // Same identity: the earlier ordinal (stable generation order) wins.
        const accumulator2 = new MonthlyRankReplayWinnerAccumulator(["totalTrades"]);
        accumulator2.offer(second, keySecond, 1);
        accumulator2.offer(first, keyFirst, 1);
        expect(accumulator2.winners().get("totalTrades")!.candidate.strategyName).to.equal("aaa");
    });

    it("never substitutes a fabricated zero for an unavailable metric", () => {
        const accumulator = new MonthlyRankReplayWinnerAccumulator(["medianSharpe", "medianExitAlpha"]);
        const noSharpe = makeCandidate([makeSymbol("A", {})]);
        accumulator.offer(noSharpe, "nosharpe", 0);
        expect(accumulator.winners().has("medianSharpe")).to.equal(false);
        expect(accumulator.winners().has("medianExitAlpha")).to.equal(false);

        const withSharpe = candidateWith(
            { medianSharpe: 0 },
            [makeSymbol("A", { sharpeRatio: 0, sharpeRatioAvailable: true })],
        );
        accumulator.offer(withSharpe, "zerosharpe", 1);
        // A real 0.00 Sharpe wins over "no observation".
        expect(accumulator.winners().get("medianSharpe")!.score).to.equal(0);
        expect(accumulator.winners().has("medianExitAlpha")).to.equal(false);
    });

    it("ranks the robust row by the ordinary PF fallback even when CER observations exist for the edge row", () => {
        // Candidate A: strong PF, weak CER. Candidate B: weaker PF, max CER.
        // With CER observations present (replay always computes them for the
        // edge sort), the stored robust score follows the CER-weighted branch
        // and B outranks A. The replay robust row must instead rank A, using
        // the ordinary robust sort's single-sort dependency (PF fallback).
        const buildPair = (profitFactor: number, edgeRatio: number) => ([
            makeSymbol("A", { totalTrades: 20, expectancy: 2, netProfit: 10, profitFactor, compositeEdgeRatio: edgeRatio }),
            makeSymbol("B", { totalTrades: 20, expectancy: 2, netProfit: 10, profitFactor, compositeEdgeRatio: edgeRatio }),
        ]);
        const strongPf = makeCandidate(buildPair(3.0, 1.0), { strategyName: "StrongPf" });
        const strongCer = makeCandidate(buildPair(2.5, 3.0), { strategyName: "StrongCer" });
        expect(strongPf.medianProfitFactor).to.equal(3.0);
        expect(strongCer.medianProfitFactor).to.equal(2.5);

        // The stored (CER-influenced) score genuinely diverges from the
        // PF-fallback score — this is the divergence the replay must not leak
        // into the robust row.
        expect(strongCer.robustUniverseScore).to.be.greaterThan(strongPf.robustUniverseScore);
        const strongPfFallback = computeRobustUniverseScore({ ...strongPf, medianCompositeEdgeRatio: 0 });
        const strongCerFallback = computeRobustUniverseScore({ ...strongCer, medianCompositeEdgeRatio: 0 });
        expect(strongPfFallback).to.be.greaterThan(strongCerFallback);

        // The replay helper restores the fallback ordering for BOTH rows.
        expect(computeReplayRobustUniverseScore(strongPf)).to.equal(strongPfFallback);
        expect(computeReplayRobustUniverseScore(strongCer)).to.equal(strongCerFallback);
        expect(computeReplayRobustUniverseScore(strongPf)).to.be.greaterThan(
            computeReplayRobustUniverseScore(strongCer),
        );
    });

    it("handles +Infinity versus finite scores without subtracting infinities", () => {
        expect(compareMetricScores(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, false)).to.equal(0);
        expect(compareMetricScores(Number.POSITIVE_INFINITY, 3, false)).to.be.lessThan(0);
        expect(compareMetricScores(3, Number.POSITIVE_INFINITY, false)).to.be.greaterThan(0);
        // Ascending sorts prefer the smaller finite value.
        expect(compareMetricScores(2, 5, true)).to.be.lessThan(0);
        expect(compareMetricScores(5, 2, true)).to.be.greaterThan(0);
    });
});

describe("Monthly Rank Replay option validation", () => {
    it("accepts valid integer options", () => {
        expect(validateMonthlyRankReplayOptions({ fromYear: 2023, evalWindowBars: 720, forwardBars: 240 })).to.deep.equal({
            fromYear: 2023,
            evalWindowBars: 720,
            forwardBars: 240,
        });
    });

    it("rejects malformed explicit options instead of falling back silently", () => {
        expect(() => validateMonthlyRankReplayOptions(null)).to.throw();
        expect(() => validateMonthlyRankReplayOptions({})).to.throw();
        expect(() => validateMonthlyRankReplayOptions({ fromYear: 2023.5, evalWindowBars: 10, forwardBars: 5 })).to.throw();
        expect(() => validateMonthlyRankReplayOptions({ fromYear: 2023, evalWindowBars: 0, forwardBars: 5 })).to.throw();
        expect(() => validateMonthlyRankReplayOptions({ fromYear: 2023, evalWindowBars: 10, forwardBars: -1 })).to.throw();
        expect(() => validateMonthlyRankReplayOptions({ fromYear: "2023", evalWindowBars: 10, forwardBars: 5 })).to.throw();
    });
});

describe("Monthly Rank Replay checkpoint schedule", () => {
    it("starts at January of the from year and never advances it", () => {
        const schedule = buildMonthlyCheckpointSchedule(2023, Date.UTC(2023, 5, 1) / 1000);
        expect(schedule.length).to.equal(6);
        expect(schedule[0]!.label).to.equal("2023-01");
        expect(schedule[0]!.timeSec).to.equal(Date.UTC(2023, 0, 1) / 1000);
        expect(schedule[5]!.label).to.equal("2023-06");
    });

    it("includes boundaries the data cannot support (the runner reports them unavailable)", () => {
        // Last closed time before the from year: schedule still starts at fromYear.
        const schedule = buildMonthlyCheckpointSchedule(2023, Date.UTC(2021, 0, 1) / 1000);
        expect(schedule).to.deep.equal([]);
    });

    it("resolves bar close times with the existing interval helper", () => {
        expect(resolveBarCloseTimeSec(0, "1h")).to.equal(3600);
        expect(resolveBarCloseTimeSec(60, "1m")).to.equal(120);
        expect(resolveBarCloseTimeSec(0, "bogus")).to.equal(null);
    });
});

describe("Monthly Rank Replay summary arithmetic", () => {
    it("averages window returns equally and reports coverage per sort", () => {
        const summary = summarizeMonthlyRankReplaySort({
            coverage: { key: "medianSharpe", label: "Median Sharpe Ratio", direction: "descending", ascending: false },
            scheduledCheckpoints: 4,
            validReturns: [10, -4, 0, 2],
            zeroTradeValid: 1,
            excludedReasons: ["no selection", "no selection", "incomplete horizon"],
            comparisons: [],
        });
        expect(summary.validCheckpoints).to.equal(4);
        expect(summary.meanForwardReturnPercent).to.equal(2);
        expect(summary.medianForwardReturnPercent).to.equal(1);
        expect(summary.positiveWindows).to.equal(2);
        expect(summary.negativeWindows).to.equal(1);
        expect(summary.zeroTradeWindows).to.equal(1);
        expect(summary.worstWindowReturnPercent).to.equal(-4);
        expect(summary.bestWindowReturnPercent).to.equal(10);
        expect(summary.coverage).to.equal("4/4");
        expect(summary.excludedCounts).to.deep.equal([
            { reason: "no selection", count: 2 },
            { reason: "incomplete horizon", count: 1 },
        ]);
    });

    it("keeps losses and zero windows in the denominator and reports empty samples as unavailable", () => {
        const losing = summarizeMonthlyRankReplaySort({
            coverage: { key: "worstNetProfit", label: "Worst Net Profit", direction: "descending", ascending: false },
            scheduledCheckpoints: 2,
            validReturns: [-3, 0],
            zeroTradeValid: 1,
            excludedReasons: [],
            comparisons: [],
        });
        expect(losing.meanForwardReturnPercent).to.equal(-1.5);
        expect(losing.positiveWindows).to.equal(0);

        const empty = summarizeMonthlyRankReplaySort({
            coverage: { key: "medianExitAlpha", label: "Median Exit Alpha", direction: "descending", ascending: false },
            scheduledCheckpoints: 3,
            validReturns: [],
            zeroTradeValid: 0,
            excludedReasons: ["no selection"],
            comparisons: [],
        });
        expect(empty.meanForwardReturnPercent).to.equal(null);
        expect(empty.medianForwardReturnPercent).to.equal(null);
        expect(empty.coverage).to.equal("0/3");
    });

    it("weights symbols equally inside a window regardless of trade counts", () => {
        expect(computeWindowReturnPercent([6, -2])).to.equal(2);
        expect(computeWindowReturnPercent([])).to.equal(null);
    });
});

describe("Monthly Rank Replay comparison rendering and copying", () => {
    const baseSelection = {
        checkpointIndex: 1,
        checkpointLabel: "2023-01",
        sortKey: "medianSharpe" as const,
        sortLabel: "Median Sharpe Ratio",
        direction: "descending" as const,
        score: 1.5,
        aggregationLabel: "Median Sharpe Ratio",
        historicalActiveSymbols: 2,
        historicalSharpeContributors: 2,
        status: "measured" as const,
        identityKey: "x",
        strategyKey: "demo",
        strategyName: "Demo",
        params: { period: 5 },
        forwardOutcomeIndex: 0,
        forwardReturnPercent: 0.5,
        comparison: {
            status: "measured" as const,
            eligibleConfigurations: 4,
            randomExpectedReturnPercent: 0.3,
            excessReturnPercent: 0.2,
        },
    };

    it("renders comparison values in selection detail and copy output identically", () => {
        const line = formatMonthlyRankReplaySelectionLine(baseSelection, undefined);
        expect(line).to.contain("pool 4");
        expect(line).to.contain("random +0.30%");
        expect(line).to.contain("excess +0.20 pp");

        const report = {
            kind: "monthly_rank_replay" as const,
            runId: "r",
            experiment: {
                fromYear: 2023,
                evalWindowBars: 1,
                forwardBars: 1,
                interval: "1d",
                symbols: ["A"],
                strategyKeys: ["demo"],
                replayedSorts: [],
                excludedSorts: [],
                engine: "typescript" as const,
                sizingMode: "fixed" as const,
                capitalSettings: {},
                candidatePool: { requestedRunsPerStrategy: 1, actualCandidates: 1, seed: 1 },
                conventions: {
                    checkpoint: "c",
                    historicalWindow: "h",
                    forwardWindow: "f",
                    signalPolicy: "s",
                    accounting: "a",
                    baseline: "b",
                },
            },
            checkpoints: [{
                index: 1,
                label: "2023-01",
                timeSec: 1,
                status: "measured" as const,
                distinctWinners: 1,
            }],
            symbolCoverage: [],
            forwardOutcomes: [],
            selections: [baseSelection],
            sortSummaries: [],
        };
        const text = formatMonthlyRankReplayReportText(report);
        expect(text).to.contain("pool 4");
        expect(text).to.contain("random +0.30%");
        expect(text).to.contain("excess +0.20 pp");

        // Unavailable comparisons show status + reason alongside the preserved
        // (incomplete) top-1 outcome.
        const unavailableLine = formatMonthlyRankReplaySelectionLine(
            {
                ...baseSelection,
                status: "incomplete_horizon",
                forwardReturnPercent: null,
                comparison: {
                    status: "unavailable",
                    reason: "forward evaluation unavailable for 2 of 4 pool configurations",
                    eligibleConfigurations: 4,
                },
            },
            undefined,
        );
        expect(unavailableLine).to.contain("comparison unavailable");
        expect(unavailableLine).to.contain("forward evaluation unavailable for 2 of 4");
    });
});

describe("Monthly Rank Replay paired excess arithmetic", () => {
    it("computes random mean, mean excess, and positive windows from paired observations", () => {
        const summary = summarizeMonthlyRankReplaySort({
            coverage: { key: "medianSharpe", label: "Median Sharpe Ratio", direction: "descending", ascending: false },
            scheduledCheckpoints: 4,
            validReturns: [1.0, 0.5, 0.2],
            zeroTradeValid: 0,
            excludedReasons: ["comparison unavailable"],
            // Paired: (top1 - randomMean) per comparison checkpoint.
            comparisons: [
                { top1Return: 1.0, randomExpected: 0.4, excess: 0.6 },
                { top1Return: 0.5, randomExpected: 0.6, excess: -0.1 },
                { top1Return: 0.2, randomExpected: 0.2, excess: 0.0 },
            ],
        });
        // Random mean over comparison checkpoints: (0.4 + 0.6 + 0.2) / 3.
        expect(summary.randomMeanForwardReturnPercent).to.be.closeTo(0.4, 1e-9);
        // Mean excess: (0.6 - 0.1 + 0.0) / 3.
        expect(summary.meanExcessReturnPercent).to.be.closeTo(0.5 / 3, 1e-9);
        expect(summary.positiveExcessWindows).to.equal(1);
        expect(summary.comparisonCheckpoints).to.equal(3);
        expect(summary.comparisonCoverage).to.equal("3/4");
        // Paired top-1 mean over comparison checkpoints only.
        expect(summary.pairedTop1MeanForwardReturnPercent).to.be.closeTo(1.7 / 3, 1e-9);
    });
});

describe("Monthly Rank Replay infinity transport", () => {
    it("round-trips +Infinity PF scores through the existing non-finite-preserving codec", () => {
        const payload = { score: Number.POSITIVE_INFINITY, other: 1 };
        const encoded = serializeJsonPreservingNonFinite(payload);
        // JSON.stringify alone would silently coerce Infinity to null; the
        // transport codec tags it as an explicit non-finite marker instead.
        expect(encoded).to.contain("non-finite-number");
        expect(encoded).not.to.contain("null");
        const decoded = parseJsonPreservingNonFinite(encoded) as typeof payload;
        expect(decoded.score).to.equal(Number.POSITIVE_INFINITY);
    });
});
