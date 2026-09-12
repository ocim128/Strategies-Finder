import { expect } from "chai";
import { describe, it } from "node:test";
import {
    runFinderMonthlyRankReplay,
    type FinderMonthlyRankReplayRunInput,
} from "../lib/finder/finder-monthly-rank-replay-runner";
import type { CapitalSettings } from "../lib/types/backtest";
import { MAX_OPEN_TRADES_UNLIMITED } from "../lib/types/backtest";
import type { FinderOptions } from "../lib/types/finder";
import type { BacktestSettings, OHLCVData, Strategy, Time } from "../lib/types/strategies";
import { buildSyntheticPairDataset, aggregateSyntheticBars } from "../scripts/lib/synthetic-pair";
import { buildFinderPairNeutralMetrics } from "../lib/finder/finder-pair-neutral";
import { runBacktest } from "../lib/strategies/backtest/backtest-engine";
import { serializeJsonPreservingNonFinite, parseJsonPreservingNonFinite } from "../lib/json-utils";

// ---------------------------------------------------------------------------
// Deterministic universe: two daily symbols across the 2023-01..03 checkpoints.
// UP trends up, DOWN trends down. Bars are UTC-midnight aligned so each month
// boundary closes exactly at a bar close.
// ---------------------------------------------------------------------------

const BASE_TIME = Date.UTC(2022, 10, 1) / 1000; // 2022-11-01
const DAY = 86400;
const BAR_COUNT = 132; // through 2023-03-12 (closes 2023-03-13)
const L = 20;
const H = 10;

function symbolCloses(kind: "UP" | "DOWN"): number[] {
    return Array.from({ length: BAR_COUNT }, (_, i) => (kind === "UP" ? 100 + i : 200 - i * 0.5));
}

function buildData(kind: "UP" | "DOWN"): OHLCVData[] {
    return symbolCloses(kind).map((close, i) => ({
        time: (BASE_TIME + i * DAY) as Time,
        open: close,
        high: close + 0.5,
        low: close - 0.5,
        close,
        volume: 1000,
    }));
}

// Checkpoint boundary -> index of the last bar CLOSED at or before it.
// 2023-01-01, 2023-02-01, 2023-03-01 UTC.
const CHECKPOINTS = [
    { label: "2023-01", timeSec: Date.UTC(2023, 0, 1) / 1000 },
    { label: "2023-02", timeSec: Date.UTC(2023, 1, 1) / 1000 },
    { label: "2023-03", timeSec: Date.UTC(2023, 2, 1) / 1000 },
];
const HIST_END = CHECKPOINTS.map((checkpoint) => (checkpoint.timeSec - BASE_TIME) / DAY - 1);

const replayStrategy: Strategy = {
    name: "Replay Fixture",
    description: "Deterministic entry cadence for replay-runner tests.",
    defaultParams: { period: 5 },
    paramLabels: { period: "Period" },
    normalizeParams: (params) => ({ period: Math.max(1, Math.round(Number(params.period ?? 5))) }),
    execute(data, params) {
        const period = Math.max(1, Math.round(Number(params.period ?? 5)));
        const signals = [];
        for (let i = 0; i < data.length; i += 1) {
            if (i % period === 0) {
                signals.push({ barIndex: i, time: data[i]!.time, type: "buy" as const, price: data[i]!.close });
            }
        }
        return signals;
    },
};

const settings: BacktestSettings = {
    executionModel: "signal_close",
    tradeDirection: "long",
    maxOpenTrades: MAX_OPEN_TRADES_UNLIMITED,
    slippageBps: 0,
    marketMode: "all",
};

const capitalSettings: CapitalSettings = {
    initialCapital: 10_000,
    positionSize: 100,
    commission: 0,
    sizingMode: "fixed",
    fixedTradeAmount: 1_000,
};

function buildOptions(
    overrides: Partial<FinderOptions["monthlyRankReplay"]> = {},
    symbols: string[] = ["UP", "DOWN"],
): FinderOptions {
    return {
        scope: "symbol_universe",
        mode: "random",
        sortPriority: ["expectancy"],
        useAdvancedSort: false,
        topN: 5,
        steps: 1,
        rangePercent: 0,
        maxRuns: 2,
        randomSeed: 42,
        tradeFilterEnabled: false,
        minTrades: 0,
        maxTrades: Number.POSITIVE_INFINITY,
        monthlyRankReplay: { fromYear: 2023, evalWindowBars: L, forwardBars: H, ...overrides },
        universe: {
            symbols,
            minActiveSymbols: 1,
            minTotalTrades: 0,
            minProfitableActiveRatio: 0,
            sortPriority: ["medianExpectancy"],
        },
    };
}

function delayedRows(startIdx: number, count: number): OHLCVData[] {
    return Array.from({ length: count }, (_, j) => {
        const close = 100 + (startIdx + j);
        return {
            time: (BASE_TIME + (startIdx + j) * DAY) as Time,
            open: close,
            high: close + 0.5,
            low: close - 0.5,
            close,
            volume: 1000,
        };
    });
}

function buildInput(args?: {
    datasets?: Map<string, OHLCVData[]>;
    options?: FinderOptions;
    failingSymbol?: string;
    strategy?: Strategy;
    paramSets?: Array<Record<string, number>>;
}): FinderMonthlyRankReplayRunInput {
    const datasets = args?.datasets ?? new Map<string, OHLCVData[]>([
        ["UP", buildData("UP")],
        ["DOWN", buildData("DOWN")],
    ]);
    const failingSymbol = args?.failingSymbol;
    return {
        runId: "replay-test",
        interval: "1d",
        options: args?.options ?? buildOptions(),
        settings,
        capitalSettings,
        selectedStrategies: [{
            key: "replay_fixture",
            name: "Replay Fixture",
            strategy: args?.strategy ?? replayStrategy,
        }],
        loadDataset: async (symbol) => {
            if (symbol === failingSymbol) throw new Error("load failed for fixture");
            const data = datasets.get(symbol);
            if (!data) throw new Error(`unexpected symbol ${symbol}`);
            return data;
        },
        generateParamSets: () => args?.paramSets ?? [{ period: 5 }, { period: 20 }],
    };
}

function run(input: FinderMonthlyRankReplayRunInput, cancelledAfter = -1) {
    let calls = 0;
    return runFinderMonthlyRankReplay(input, {
        setProgress: () => {},
        setStatus: () => {},
        yieldControl: async () => {},
        isCancelled: () => {
            calls += 1;
            return cancelledAfter >= 0 && calls > cancelledAfter;
        },
    });
}

// ---------------------------------------------------------------------------
// Independent expectation model (no lib code): entries are the multiples of
// `period` inside the scored window; every position exits at the scored end
// close. Fixed sizing: each trade pnls 1000 * (exit/entry - 1) against
// initialCapital 10000.
// ---------------------------------------------------------------------------

function entryIndexes(period: number, start: number, end: number): number[] {
    const entries: number[] = [];
    for (let i = start; i <= end; i += 1) {
        if (i % period === 0) entries.push(i);
    }
    return entries;
}

function symbolScoredPnls(closes: number[], period: number, histEnd: number): number[] {
    const exit = closes[histEnd]!;
    return entryIndexes(period, histEnd - L + 1, histEnd).map((entry) => 1000 * (exit / closes[entry]! - 1));
}

function expectancy(pnls: number[]): number {
    const wins = pnls.filter((pnl) => pnl > 0.0001);
    const losses = pnls.filter((pnl) => pnl <= 0.0001);
    const winRate = pnls.length > 0 ? wins.length / pnls.length : 0;
    const avgWin = wins.length > 0 ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + Math.abs(b), 0) / losses.length : 0;
    return winRate * avgWin - (1 - winRate) * avgLoss;
}

describe("Monthly Rank Replay runner", () => {
    it("selects winners per sort from the complete pool with independently verified scores", async () => {
        const { report, cancelled } = await run(buildInput());
        expect(cancelled).to.equal(false);
        expect(report.kind).to.equal("monthly_rank_replay");
        expect(report.experiment.engine).to.equal("typescript");
        // All 15 historical sorts replayed; the OOS-dependent sort excluded.
        expect(report.sortSummaries.length).to.equal(15);
        expect(report.sortSummaries.map((sort) => sort.sortKey)).to.not.include("windowStabilityScore");

        const jan = CHECKPOINTS[0]!.label;
        const janSelections = report.selections.filter((selection) => selection.checkpointLabel === jan);
        expect(janSelections.length).to.equal(15);

        const select = (sortKey: string, label: string) =>
            report.selections.find((selection) => selection.checkpointLabel === label && selection.sortKey === sortKey)!;

        // Total Trades (descending): period 5 opens 4 trades per symbol inside
        // every 20-bar window (period 20 opens 1); 8 total across the 2 symbols.
        for (const checkpoint of CHECKPOINTS) {
            const selection = select("totalTrades", checkpoint.label);
            expect(selection.score).to.equal(8);
            expect((selection.params as { period: number }).period).to.equal(5);
        }

        // Worst Net Profit: period 5's staggered entries lose on DOWN; the
        // period-20 single entry at the window end breaks even -> 0 wins.
        const janWorst = select("worstNetProfit", jan);
        expect(janWorst.score).to.be.closeTo(0, 1e-6);
        expect((janWorst.params as { period: number }).period).to.equal(20);

        // Median Expectancy, hand-computed for January: the cadence-5
        // candidate wins January.
        const up = symbolCloses("UP");
        const down = symbolCloses("DOWN");
        const janExp5 = (expectancy(symbolScoredPnls(up, 5, HIST_END[0]!)) + expectancy(symbolScoredPnls(down, 5, HIST_END[0]!))) / 2;
        const selection = select("medianExpectancy", jan);
        expect((selection.params as { period: number }).period).to.equal(5);
        expect(selection.score).to.be.closeTo(janExp5, 1e-6);

        // ... and the cadence-20 candidate wins February (its single later
        // entry avoids DOWN's early losses). The changing identity merges
        // into the same summary row.
        const feb = CHECKPOINTS[1]!.label;
        const febExp20 = (expectancy(symbolScoredPnls(up, 20, HIST_END[1]!)) + expectancy(symbolScoredPnls(down, 20, HIST_END[1]!))) / 2;
        const febExp5 = (expectancy(symbolScoredPnls(up, 5, HIST_END[1]!)) + expectancy(symbolScoredPnls(down, 5, HIST_END[1]!))) / 2;
        expect(febExp20).to.be.greaterThan(febExp5);
        const febSelection = select("medianExpectancy", feb);
        expect((febSelection.params as { period: number }).period).to.equal(20);
        expect(febSelection.score).to.be.closeTo(febExp20, 1e-6);

        // Drawdown sorts select minima: the single-trade candidate's shallower
        // drawdown beats the four staggered losers on DOWN.
        const janDrawdown = select("worstMaxDrawdownPercent", jan);
        expect(janDrawdown.direction).to.equal("ascending");
        expect((janDrawdown.params as { period: number }).period).to.equal(20);
        const janMedianDrawdown = select("medianMaxDrawdownPercent", jan);
        expect((janMedianDrawdown.params as { period: number }).period).to.equal(20);

        // Weighted sort inherits the underlying metric's availability and
        // multiplies the existing formula: median PF x total trades is
        // +Infinity for the cadence-5 candidate (lossless UP symbol).
        const janWeightedPf = select("medianProfitFactorWeightedTrades", jan);
        expect(janWeightedPf.score).to.equal(Number.POSITIVE_INFINITY);
        expect((janWeightedPf.params as { period: number }).period).to.equal(5);

        // Median PF: period 20 scores a real 0 on both symbols; period 5's
        // lossless UP symbol gives +Infinity, which must WIN and stay Infinity.
        const janPf = select("medianProfitFactor", jan);
        expect(janPf.score).to.equal(Number.POSITIVE_INFINITY);
        expect((janPf.params as { period: number }).period).to.equal(5);
        // Infinity survives a transport round-trip.
        const roundTripped = parseJsonPreservingNonFinite(serializeJsonPreservingNonFinite({ score: janPf.score })) as { score: number };
        expect(roundTripped.score).to.equal(Number.POSITIVE_INFINITY);
    });

    it("forwards each distinct winner once per checkpoint and hand-verifies the H-bar window return", async () => {
        const { report } = await run(buildInput());
        const jan = CHECKPOINTS[0]!.label;
        const janSelections = report.selections.filter((selection) => selection.checkpointLabel === jan);
        const measured = janSelections.filter((selection) => selection.status === "measured");

        // Deduplicated forward evaluation: one outcome per distinct identity.
        const identities = new Set(measured.map((selection) => selection.identityKey));
        const janOutcomes = report.forwardOutcomes.filter((outcome) => outcome.checkpointLabel === jan);
        expect(janOutcomes.length).to.equal(identities.size);
        for (const selection of measured) {
            const outcome = report.forwardOutcomes[selection.forwardOutcomeIndex!]!;
            expect(outcome.identityKey).to.equal(selection.identityKey);
        }

        // Hand-compute the forward window for the cadence-5 outcome: scored
        // bars [histEnd+1, histEnd+H], entries at multiples of 5, terminal
        // exit at the final forward close, equal-weight mean over symbols.
        const histEnd = HIST_END[0]!;
        const forwardEnd = histEnd + H;
        const up = symbolCloses("UP");
        const down = symbolCloses("DOWN");
        const windowReturn = (closes: number[], period: number): number => {
            const exit = closes[forwardEnd]!;
            const pnls = entryIndexes(period, histEnd + 1, forwardEnd).map((entry) => 1000 * (exit / closes[entry]! - 1));
            return (pnls.reduce((a, b) => a + b, 0) / 10_000) * 100;
        };
        const cadence5Outcome = janOutcomes.find(
            (outcome) => JSON.parse(JSON.stringify(outcome.params)).period === 5,
        );
        expect(cadence5Outcome).to.exist;
        const expected = (windowReturn(up, 5) + windowReturn(down, 5)) / 2;
        expect(cadence5Outcome!.windowReturnPercent).to.be.closeTo(expected, 1e-6);

        // Baseline accounting: the random mean for a sort whose pool contains
        // the pair combines the PAIR-NEUTRAL outcome with ordinary outcomes —
        // pair-neutral transform inside the pool mean, no second charge.
        const expectancySelection = report.selections.find(
            (selection) => selection.checkpointLabel === jan && selection.sortKey === "medianExpectancy",
        )!;
        expect(expectancySelection.comparison!.status).to.equal("measured");
        expect(expectancySelection.comparison!.eligibleConfigurations).to.equal(2);
        // Independent: mean over BOTH configurations of the 2-symbol window
        // returns (this fixture has no pair symbol; the pair-neutral case is
        // covered in the synthetic-pair test which asserts the transform's
        // output value feeds windowReturnPercent verbatim).
        const expectedRandom = (windowReturn(up, 5) + windowReturn(down, 5)
            + windowReturn(up, 20) + windowReturn(down, 20)) / 4;
        // Pool = {5, 20} for medianExpectancy? Only if both are available —
        // the fixture asserts the exact mean over the pool below.
        expect(expectancySelection.comparison!.randomExpectedReturnPercent)
            .to.be.closeTo(expectedRandom, 1e-6);
        expect(cadence5Outcome!.symbols.length).to.equal(2);
        expect(cadence5Outcome!.forwardStartSec).to.equal(BASE_TIME + (histEnd + 1) * DAY);
        expect(cadence5Outcome!.forwardEndSec).to.equal(BASE_TIME + forwardEnd * DAY);
    });

    it("keeps a losing forward window and counts zero-trade windows in the denominator", async () => {
        const { report } = await run(buildInput());
        // DOWN loses over the forward region; negative per-symbol outcomes
        // must stay in the report (window means can still be positive since
        // symbols are equally weighted, not netted against each other).
        const negativeSymbols = report.forwardOutcomes.flatMap((outcome) => outcome.symbols)
            .filter((symbol) => symbol.returnPercent < 0);
        expect(negativeSymbols.length).to.be.greaterThan(0);
        for (const outcome of report.forwardOutcomes) {
            expect(outcome.status).to.equal("measured");
            expect(outcome.windowReturnPercent).to.not.be.null;
        }
        for (const summary of report.sortSummaries) {
            expect(summary.scheduledCheckpoints).to.equal(CHECKPOINTS.length);
            expect(summary.coverage).to.equal(`${summary.validCheckpoints}/${summary.scheduledCheckpoints}`);
            expect(summary.zeroTradeWindows).to.be.at.most(summary.validCheckpoints);
        }
    });

    it("is deterministic across identical runs", async () => {
        const first = await run(buildInput());
        const second = await run(buildInput());
        expect(serializeJsonPreservingNonFinite(first.report)).to.equal(
            serializeJsonPreservingNonFinite(second.report),
        );
    });

    it("mutating data after a checkpoint cannot alter that checkpoint's winners or scores", async () => {
        const before = await run(buildInput());
        // Mutate every bar after January's scored end (indices >= 61): the
        // January historical views end at index 60 and must be untouched.
        const mutated = new Map<string, OHLCVData[]>([
            ["UP", buildData("UP")],
            ["DOWN", buildData("DOWN")],
        ]);
        for (const data of mutated.values()) {
            for (let i = HIST_END[0]! + 1; i < data.length; i += 1) {
                data[i] = { ...data[i]!, close: data[i]!.close * 3, open: data[i]!.open * 3, high: data[i]!.high * 3, low: data[i]!.low * 3 };
            }
        }
        const after = await run(buildInput({ datasets: mutated }));

        const jan = CHECKPOINTS[0]!.label;
        const pick = (report: Awaited<ReturnType<typeof run>>["report"]) =>
            report.selections
                .filter((selection) => selection.checkpointLabel === jan)
                .map((selection) => ({
                    sortKey: selection.sortKey,
                    score: selection.score,
                    identityKey: selection.identityKey,
                    retainedSymbols: report.checkpoints.find(
                        (checkpoint) => checkpoint.label === jan,
                    )!.retainedSymbols,
                    eligibleConfigurations: selection.comparison!.eligibleConfigurations,
                }));
        expect(pick(after.report)).to.deep.equal(pick(before.report));
    });

    it("keeps historical ranking when forward horizons are incomplete and invalidates only measurements", async () => {
        // H=25: March's forward end (119+25=144) exceeds the 132 loaded bars.
        // Membership is CHECKPOINT-TIME information: both symbols still rank
        // historically in March (missing future bars must not change the
        // historical winner); forward outcomes and comparisons are the parts
        // marked incomplete/unavailable.
        const { report } = await run(buildInput({ options: buildOptions({ forwardBars: 25 }) }));
        const march = report.checkpoints.find((checkpoint) => checkpoint.label === "2023-03")!;
        expect(march.status).to.equal("measured");
        expect(march.retainedSymbols).to.equal(2);

        const january = report.checkpoints.find((checkpoint) => checkpoint.label === "2023-01")!;
        expect(january.status).to.equal("measured");

        const marchSelections = report.selections.filter((selection) => selection.checkpointLabel === "2023-03");
        expect(marchSelections.length).to.equal(15);
        for (const selection of marchSelections) {
            // Top 1 outcomes preserved separately, labelled incomplete — not
            // deleted, not replaced, not turned into zeros.
            expect(selection.status).to.equal("incomplete_horizon");
            expect(selection.forwardReturnPercent).to.equal(null);
            // Comparisons unavailable WITHOUT shrinking the pool.
            expect(selection.comparison!.status).to.equal("unavailable");
            expect(selection.comparison!.eligibleConfigurations).to.equal(2);
            expect(selection.comparison!.reason).to.contain("forward evaluation unavailable");
        }

        const expectancySummary = report.sortSummaries.find((summary) => summary.sortKey === "medianExpectancy")!;
        expect(expectancySummary.coverage).to.equal("2/3");
        expect(expectancySummary.comparisonCoverage).to.equal("2/3");
        // Paired top-1 mean exposed since comparison months (2) differ from
        // the full historical window set.
        expect(expectancySummary.pairedTop1MeanForwardReturnPercent).to.not.equal(null);
        expect(expectancySummary.excludedCounts.some((entry) => entry.reason.includes("incomplete forward horizon"))).to.equal(true);
    });

    it("excludes a failed-load symbol from every checkpoint and runs on the rest", async () => {
        const { report } = await run(buildInput({ failingSymbol: "DOWN" }));
        // DOWN's load error is disclosed on its coverage row and on every
        // checkpoint record; the run measures with the retained set (UP).
        const downCoverage = report.symbolCoverage.find((symbol) => symbol.symbol === "DOWN")!;
        expect(downCoverage.error).to.contain("load failed");
        expect(report.checkpoints.length).to.equal(CHECKPOINTS.length);
        for (const checkpoint of report.checkpoints) {
            expect(checkpoint.retainedSymbols).to.equal(1);
            expect(checkpoint.excludedSymbols).to.have.length(1);
            expect(checkpoint.excludedSymbols![0]!.symbol).to.equal("DOWN");
            expect(checkpoint.excludedSymbols![0]!.reason).to.contain("load failed");
        }
        const janExpectancy = report.selections.find(
            (selection) => selection.checkpointLabel === "2023-01" && selection.sortKey === "medianExpectancy",
        )!;
        expect(janExpectancy.status).to.equal("measured");
        const outcome = report.forwardOutcomes[janExpectancy.forwardOutcomeIndex!]!;
        expect(outcome.symbols.map((symbol) => symbol.symbol)).to.deep.equal(["UP"]);
        for (const summary of report.sortSummaries) {
            expect(summary.coverage).to.equal("3/3");
        }
    });

    it("reports a cancelled run as incomplete, never successful", async () => {
        const { report, cancelled } = await run(buildInput(), 0);
        expect(cancelled).to.equal(true);
        expect(report.stoppedEarly?.reason).to.equal("cancelled");
    });

    it("rejects unsupported configurations explicitly before search", async () => {
        const expectRejection = async (input: FinderMonthlyRankReplayRunInput, pattern: RegExp): Promise<void> => {
            let message = "";
            try {
                await run(input);
            } catch (error) {
                message = error instanceof Error ? error.message : String(error);
            }
            expect(message).to.match(pattern);
        };

        const percentSizing = { ...capitalSettings, sizingMode: "percent" as const };
        await expectRejection(
            { ...buildInput(), capitalSettings: percentSizing },
            /fixed-dollar sizing/,
        );

        const combined = { ...settings, tradeDirection: "combined" as const };
        await expectRejection({ ...buildInput(), settings: combined }, /combined/);

        const crossSymbolStrategy: Strategy = {
            ...replayStrategy,
            crossSymbolConfig: { enabled: true, secondarySymbol: "OTHER", secondaryInterval: "1d", defaultSymbol: "OTHER" },
        } as Strategy;
        await expectRejection(
            {
                ...buildInput(),
                selectedStrategies: [{ key: "replay_fixture", name: "Replay Fixture", strategy: crossSymbolStrategy }],
            },
            /cross-symbol/,
        );
    });
});


    it("exercises a synthetic pair end-to-end through the forward path and matches an independent prefix backtest", async () => {
        // Third symbol: a synthetic pair token. Its series trends so the
        // forward window trades; the report's pair return must equal a
        // directly computed pair-neutral transform of an independent
        // runBacktest over the same prefix (bypassing the runner entirely).
        const pairCloses = Array.from({ length: BAR_COUNT }, (_, i) => 50 + i * 0.25);
        const pairData: OHLCVData[] = pairCloses.map((close, i) => ({
            time: (BASE_TIME + i * DAY) as Time,
            open: close,
            high: close + 0.25,
            low: close - 0.25,
            close,
            volume: 1000,
        }));
        const datasets = new Map<string, OHLCVData[]>([
            ["UP", buildData("UP")],
            ["DOWN", buildData("DOWN")],
            ["UP+DOWN", pairData],
        ]);
        const symbols = ["UP", "DOWN", "UP+DOWN"];
        const { report } = await run(buildInput({
            datasets,
            options: buildOptions({}, symbols),
        }));

        const jan = CHECKPOINTS[0]!.label;
        const janOutcome = report.forwardOutcomes.find(
            (outcome) => outcome.checkpointLabel === jan
                && JSON.parse(JSON.stringify(outcome.params)).period === 5,
        );
        expect(janOutcome).to.exist;
        const pairOutcome = janOutcome!.symbols.find((symbol) => symbol.symbol === "UP+DOWN");
        expect(pairOutcome).to.exist;
        expect(pairOutcome!.measurementBasis).to.equal("pair_neutral_log");
        expect(pairOutcome!.totalTrades).to.be.greaterThan(0);

        // Independent prefix backtest: same causal view (slice(0, histEnd+H+1)),
        // same scored range, same settings — no runner involved.
        const histEnd = HIST_END[0]!;
        const view = pairData.slice(0, histEnd + H + 1);
        const independent = runBacktest(
            view,
            replayStrategy.execute(view, { period: 5 }),
            capitalSettings.initialCapital,
            100,
            0,
            { ...settings } as Parameters<typeof runBacktest>[5],
            { mode: "fixed", fixedTradeAmount: capitalSettings.fixedTradeAmount },
            undefined,
            {
                scoredRange: { startBarTime: view[histEnd + 1]!.time, endBarTime: view[histEnd + H]!.time },
                requireTradeHistory: true,
            },
        );
        const neutral = buildFinderPairNeutralMetrics(independent, capitalSettings);
        expect(neutral).to.not.equal(null);
        expect(pairOutcome!.returnPercent).to.be.closeTo(neutral!.netProfitPercent, 1e-9);
    });

    it("excludes a candidate whose symbol evaluation fails mid-run from every sort while others still rank", async () => {
        // The cadence-20 candidate fails on DOWN at every checkpoint; the
        // completeness gate must exclude it from ALL sorts (never rank a
        // partial candidate), while cadence-5 keeps ranking normally.
        const throwingStrategy: Strategy = {
            ...replayStrategy,
            execute(data, params) {
                if (data[0]!.close > 150 && Math.round(Number(params.period)) === 20) {
                    throw new Error("fixture per-symbol run failure");
                }
                return replayStrategy.execute(data, params);
            },
        };
        const { report } = await run(buildInput({ strategy: throwingStrategy }));

        for (const checkpoint of CHECKPOINTS) {
            const measured = report.selections.filter(
                (selection) => selection.checkpointLabel === checkpoint.label && selection.status === "measured",
            );
            expect(measured.length).to.be.greaterThan(0);
            for (const selection of measured) {
                expect((selection.params as { period: number }).period).to.equal(5);
            }
        }
        const expectancySummary = report.sortSummaries.find((summary) => summary.sortKey === "medianExpectancy")!;
        expect(expectancySummary.coverage).to.equal("3/3");
    });

    it("keeps a valid forward no-trade window at exactly zero with its trades counted", async () => {
        // Period 30 trades once inside January's scored history (bar 60) but
        // has no signal multiple in the forward window (61..70): the window is
        // a successfully evaluated no-trade and must contribute exactly 0.
        const { report } = await run(buildInput({ paramSets: [{ period: 30 }] }));
        const jan = CHECKPOINTS[0]!.label;
        const selection = report.selections.find(
            (candidate) => candidate.checkpointLabel === jan && candidate.sortKey === "medianExpectancy",
        )!;
        expect(selection.status).to.equal("measured");
        const outcome = report.forwardOutcomes[selection.forwardOutcomeIndex!]!;
        expect(outcome.totalTrades).to.equal(0);
        expect(outcome.status).to.equal("measured");
        expect(outcome.windowReturnPercent).to.equal(0);
        for (const symbol of outcome.symbols) {
            expect(symbol.measurementBasis).to.equal("no_trades");
            expect(symbol.returnPercent).to.equal(0);
        }
        const expectancySummary = report.sortSummaries.find((summary) => summary.sortKey === "medianExpectancy")!;
        expect(expectancySummary.zeroTradeWindows).to.be.at.least(1);
    });

    it("marks a forward execution failure as forward_failed while preserving the selected winner", async () => {
        // The strategy throws only on the January FORWARD view length (71);
        // historical views (61/92/120) and later forward views (103/130) run.
        const forwardThrowingStrategy: Strategy = {
            ...replayStrategy,
            execute(data, params) {
                if (data.length === 71) throw new Error("fixture forward failure");
                return replayStrategy.execute(data, params);
            },
        };
        const { report } = await run(buildInput({
            strategy: forwardThrowingStrategy,
            paramSets: [{ period: 5 }],
        }));

        const jan = CHECKPOINTS[0]!.label;
        const janSelections = report.selections.filter((selection) => selection.checkpointLabel === jan);
        expect(janSelections.length).to.equal(15);
        for (const selection of janSelections) {
            expect(selection.status).to.equal("forward_failed");
            // The selected winner's identity is preserved, never replaced.
            expect(selection.strategyKey).to.equal("replay_fixture");
            expect(selection.forwardReturnPercent).to.equal(null);
        }
        for (const outcome of report.forwardOutcomes.filter((outcome) => outcome.checkpointLabel === jan)) {
            expect(outcome.status).to.equal("failed");
            expect(outcome.windowReturnPercent).to.equal(null);
        }
        const febExpectancy = report.selections.find(
            (selection) => selection.checkpointLabel === "2023-02" && selection.sortKey === "medianExpectancy",
        )!;
        expect(febExpectancy.status).to.equal("measured");
        const expectancySummary = report.sortSummaries.find((summary) => summary.sortKey === "medianExpectancy")!;
        expect(expectancySummary.coverage).to.equal("2/3");
        expect(expectancySummary.excludedCounts.some((entry) => entry.reason.includes("forward"))).to.equal(true);
    });

    it("returns the coverage report without search when the From year precedes all loaded data", async () => {
        const { report } = await run(buildInput({ options: buildOptions({ fromYear: 2030 }) }));
        expect(report.forwardOutcomes).to.deep.equal([]);
        expect(report.selections).to.deep.equal([]);
        expect(report.checkpoints.length).to.equal(1);
        expect(report.checkpoints[0]!.status).to.equal("unavailable");
        expect(report.checkpoints[0]!.reason).to.contain("January of the From year");
        for (const summary of report.sortSummaries) {
            expect(summary.validCheckpoints).to.equal(0);
        }
    });

    it("uses point-in-time membership: late listings join once they have enough bars, short symbols never block", async () => {
        // LATE starts at common index 50 (82 bars): excluded at January
        // (insufficient scored history) but feasible from February onward.
        // SHORT has 15 bars total (< L+H): never feasible, never blocks.
        const delayedData = (startIdx: number, count: number): OHLCVData[] =>
            Array.from({ length: count }, (_, j) => {
                const close = 100 + (startIdx + j);
                return {
                    time: (BASE_TIME + (startIdx + j) * DAY) as Time,
                    open: close,
                    high: close + 0.5,
                    low: close - 0.5,
                    close,
                    volume: 1000,
                };
            });
        const datasets = new Map<string, OHLCVData[]>([
            ["UP", buildData("UP")],
            ["DOWN", buildData("DOWN")],
            ["LATE", delayedData(50, BAR_COUNT - 50)],
            ["SHORT", delayedData(100, 15)],
        ]);
        const symbols = ["UP", "DOWN", "LATE", "SHORT"];
        const { report } = await run(buildInput({
            datasets,
            options: buildOptions({}, symbols),
        }));

        const janCheckpoint = report.checkpoints.find((checkpoint) => checkpoint.label === "2023-01")!;
        expect(janCheckpoint.status).to.equal("measured");
        expect(janCheckpoint.retainedSymbols).to.equal(2);
        expect(janCheckpoint.excludedSymbols!.map((entry) => entry.symbol).sort()).to.deep.equal(["LATE", "SHORT"]);
        // With a 2-candidate pool, at most 2 distinct configurations can be
        // rank #1 regardless of how many of the 15 sorts selected a winner.
        expect(janCheckpoint.distinctWinners).to.be.at.most(2);
        expect(janCheckpoint.distinctWinners).to.be.at.least(1);

        const marCheckpoint = report.checkpoints.find((checkpoint) => checkpoint.label === "2023-03")!;
        expect(marCheckpoint.status).to.equal("measured");
        expect(marCheckpoint.retainedSymbols).to.equal(3);
        expect(marCheckpoint.excludedSymbols!.map((entry) => entry.symbol)).to.deep.equal(["SHORT"]);

        // Window composition follows the retained set: January's forward
        // outcome evaluates 2 symbols, March's 3 (LATE included), and SHORT
        // appears in no outcome at all.
        const janExpectancy = report.selections.find(
            (selection) => selection.checkpointLabel === "2023-01" && selection.sortKey === "medianExpectancy",
        )!;
        expect(janExpectancy.status).to.equal("measured");
        expect(report.forwardOutcomes[janExpectancy.forwardOutcomeIndex!]!.symbols.map((symbol) => symbol.symbol))
            .to.deep.equal(["UP", "DOWN"]);
        const marExpectancy = report.selections.find(
            (selection) => selection.checkpointLabel === "2023-03" && selection.sortKey === "medianExpectancy",
        )!;
        expect(marExpectancy.status).to.equal("measured");
        expect(report.forwardOutcomes[marExpectancy.forwardOutcomeIndex!]!.symbols.map((symbol) => symbol.symbol))
            .to.deep.equal(["UP", "DOWN", "LATE"]);
        expect(report.forwardOutcomes.some((outcome) => outcome.symbols.some((symbol) => symbol.symbol === "SHORT")))
            .to.equal(false);

        for (const summary of report.sortSummaries) {
            expect(summary.coverage).to.equal("3/3");
        }
    });


    it("computes hand-calculated random means and paired excess returns with uniform weighting", async () => {
        const { report } = await run(buildInput());
        const jan = CHECKPOINTS[0]!.label;
        const histEnd = HIST_END[0]!;
        const forwardEnd = histEnd + H;
        const up = symbolCloses("UP");
        const down = symbolCloses("DOWN");
        const windowReturn = (closes: number[], period: number): number => {
            const exit = closes[forwardEnd]!;
            const pnls = entryIndexes(period, histEnd + 1, forwardEnd).map((entry) => 1000 * (exit / closes[entry]! - 1));
            return (pnls.reduce((a, b) => a + b, 0) / 10_000) * 100;
        };
        // Independent expected forward returns for both pool configurations.
        const expected: Record<number, number> = {
            5: (windowReturn(up, 5) + windowReturn(down, 5)) / 2,
            20: (windowReturn(up, 20) + windowReturn(down, 20)) / 2,
        };

        const selection = report.selections.find(
            (candidate) => candidate.checkpointLabel === jan && candidate.sortKey === "medianExpectancy",
        )!;
        expect(selection.status).to.equal("measured");
        // Pool = both historically eligible configurations, winner included,
        // equal weight per unique configuration.
        expect(selection.comparison!.status).to.equal("measured");
        expect(selection.comparison!.eligibleConfigurations).to.equal(2);
        const winnerPeriod = (selection.params as { period: number }).period;
        expect(selection.comparison!.randomExpectedReturnPercent)
            .to.be.closeTo((expected[5]! + expected[20]!) / 2, 1e-9);
        expect(selection.comparison!.excessReturnPercent)
            .to.be.closeTo(expected[winnerPeriod as 5 | 20]! - (expected[5]! + expected[20]!) / 2, 1e-9);
    });

    it("gives different sorts different eligible pools and keeps zero-trade pool members at exactly zero", async () => {
        // The default fixture has minActiveSymbols 1, so a never-trading
        // candidate (activeSymbols 0) fails the filters and every pool has
        // exactly the two trading configurations.
        const { report } = await run(buildInput());
        expect(report.selections.every((selection) => selection.comparison!.eligibleConfigurations === 2))
            .to.equal(true);

        // minActiveSymbols 0 admits the no-trade candidate. totalTrades is
        // available for every candidate, so its pool grows to 3 — with the
        // zero-trade member contributing EXACTLY 0 to the random mean.
        // medianExpectancy requires active symbols, so its pool stays at 2:
        // different sorts legitimately have different pools.
        const relaxed = await run(buildInput({
            options: {
                ...buildOptions(),
                universe: {
                    symbols: ["UP", "DOWN"],
                    minActiveSymbols: 0,
                    minTotalTrades: 0,
                    minProfitableActiveRatio: 0,
                    sortPriority: ["medianExpectancy"],
                },
            },
            paramSets: [{ period: 5 }, { period: 20 }, { period: 10_000 }],
        }));
        const jan = "2023-01";
        const totalTrades = relaxed.report.selections.find(
            (selection) => selection.checkpointLabel === jan && selection.sortKey === "totalTrades",
        )!;
        expect(totalTrades.comparison!.status).to.equal("measured");
        expect(totalTrades.comparison!.eligibleConfigurations).to.equal(3);
        expect((totalTrades.params as { period: number }).period).to.equal(5);
        const up = symbolCloses("UP");
        const down = symbolCloses("DOWN");
        const histEnd = HIST_END[0]!;
        const forwardEnd = histEnd + H;
        const windowReturn = (closes: number[], period: number): number => {
            const exit = closes[forwardEnd]!;
            const pnls = entryIndexes(period, histEnd + 1, forwardEnd).map((entry) => 1000 * (exit / closes[entry]! - 1));
            return (pnls.reduce((a, b) => a + b, 0) / 10_000) * 100;
        };
        const expected5 = (windowReturn(up, 5) + windowReturn(down, 5)) / 2;
        expect(totalTrades.comparison!.randomExpectedReturnPercent)
            .to.be.closeTo((expected5 + 0 + 0) / 3, 1e-9);

        const expectancy = relaxed.report.selections.find(
            (selection) => selection.checkpointLabel === jan && selection.sortKey === "medianExpectancy",
        )!;
        expect(expectancy.comparison!.status).to.equal("measured");
        expect(expectancy.comparison!.eligibleConfigurations).to.equal(2);
    });

    it("labels one-candidate comparisons uninformative", async () => {
        const { report } = await run(buildInput({ paramSets: [{ period: 30 }] }));
        const measured = report.selections.filter(
            (selection) => selection.status === "measured" || selection.status === "incomplete_horizon",
        );
        expect(measured.length).to.be.greaterThan(0);
        // Sort-level no_selection rows have no chosen configuration, so no
        // comparison applies to them; every selected configuration row does.
        for (const selection of measured) {
            expect(selection.comparison!.status).to.equal("uninformative");
            expect(selection.comparison!.eligibleConfigurations).to.equal(1);
            expect(selection.comparison!.reason).to.contain("fewer than two");
            expect(selection.comparison!.randomExpectedReturnPercent).to.equal(undefined);
            expect(selection.comparison!.excessReturnPercent).to.equal(undefined);
        }
    });

    it("invalidates a comparison when a pool member fails forward, preserving the top-1 outcome", async () => {
        // Cadence-20 forward evaluation fails at January only (forward view
        // length 71); its historical evaluations succeed, so it stays in the
        // pool. The medianExpectancy winner (cadence-5) keeps its measured
        // forward outcome; the comparison is unavailable because a REQUIRED
        // pool member's outcome is missing — the pool is NOT shrunk to the
        // successful survivor and the winner is not replaced.
        const forwardThrowingStrategy: Strategy = {
            ...replayStrategy,
            execute(data, params) {
                if (data.length === 71 && Math.round(Number(params.period)) === 20) {
                    throw new Error("fixture forward failure");
                }
                return replayStrategy.execute(data, params);
            },
        };
        const { report } = await run(buildInput({
            strategy: forwardThrowingStrategy,
            paramSets: [{ period: 5 }, { period: 20 }],
        }));
        const janExpectancy = report.selections.find(
            (selection) => selection.checkpointLabel === "2023-01" && selection.sortKey === "medianExpectancy",
        )!;
        expect(janExpectancy.status).to.equal("measured");
        expect(janExpectancy.forwardReturnPercent).to.not.equal(null);
        expect(janExpectancy.comparison!.status).to.equal("unavailable");
        expect(janExpectancy.comparison!.eligibleConfigurations).to.equal(2);
        expect(janExpectancy.comparison!.reason).to.contain("1 of 2");
        expect(janExpectancy.comparison!.randomExpectedReturnPercent).to.equal(undefined);
    });

    it("summarizes paired excess statistics with explicit comparison coverage", async () => {
        const { report } = await run(buildInput());
        const up = symbolCloses("UP");
        const down = symbolCloses("DOWN");
        const windowReturn = (closes: number[], histEnd: number, period: number): number => {
            const exit = closes[histEnd + H]!;
            const pnls = entryIndexes(period, histEnd + 1, histEnd + H).map((entry) => 1000 * (exit / closes[entry]! - 1));
            return (pnls.reduce((a, b) => a + b, 0) / 10_000) * 100;
        };
        // Independent per-checkpoint expected returns for both pool members;
        // the winner comes from the report, the arithmetic does not.
        const winnerPeriod = CHECKPOINTS.map((checkpoint) =>
            report.selections.find(
                (selection) => selection.checkpointLabel === checkpoint.label && selection.sortKey === "medianExpectancy",
            )!.params as unknown as { period: number },
        ).map((params) => params.period);
        const randomMeans: number[] = [];
        const excesses: number[] = [];
        const top1s: number[] = [];
        CHECKPOINTS.forEach((_, index) => {
            const r5 = (windowReturn(up, HIST_END[index]!, 5) + windowReturn(down, HIST_END[index]!, 5)) / 2;
            const r20 = (windowReturn(up, HIST_END[index]!, 20) + windowReturn(down, HIST_END[index]!, 20)) / 2;
            const randomMean = (r5 + r20) / 2;
            const win = winnerPeriod[index] === 5 ? r5 : r20;
            randomMeans.push(randomMean);
            excesses.push(win - randomMean);
            top1s.push(win);
        });
        const summary = report.sortSummaries.find((summary) => summary.sortKey === "medianExpectancy")!;
        expect(summary.comparisonCheckpoints).to.equal(3);
        expect(summary.comparisonCoverage).to.equal("3/3");
        expect(summary.randomMeanForwardReturnPercent)
            .to.be.closeTo(randomMeans.reduce((a, b) => a + b, 0) / 3, 1e-9);
        expect(summary.meanExcessReturnPercent)
            .to.be.closeTo(excesses.reduce((a, b) => a + b, 0) / 3, 1e-9);
        expect(summary.positiveExcessWindows)
            .to.equal(excesses.filter((excess) => excess > 0).length);
        // Comparison coverage matches Top 1 coverage here, so the paired
        // top-1 mean equals the ordinary mean.
        expect(summary.pairedTop1MeanForwardReturnPercent)
            .to.be.closeTo(top1s.reduce((a, b) => a + b, 0) / 3, 1e-9);
    });

    it("keeps historical membership, selection, and pools stable when future data is appended", async () => {
        // TRUNC ranks at March on 30 closed bars but lacks the 10-bar forward
        // horizon in run A. Run B appends bars AFTER the March checkpoint.
        // Membership, winners, scores, and pool sizes must be identical in
        // both runs (checkpoint-time information only); only comparison
        // availability flips.
        const runWith = (count: number) => run(buildInput({
            datasets: new Map<string, OHLCVData[]>([
                ["UP", buildData("UP")],
                ["DOWN", buildData("DOWN")],
                ["TRUNC", delayedRows(90, count)],
            ]),
            options: buildOptions({}, ["UP", "DOWN", "TRUNC"]),
            paramSets: [{ period: 5 }, { period: 20 }],
        }));
        const withoutFuture = await runWith(32); // TRUNC last bar = common idx 121
        const withFuture = await runWith(42); // horizon completes at March

        const marchSelections = (report: Awaited<ReturnType<typeof run>>["report"]) =>
            report.selections.filter((selection) => selection.checkpointLabel === "2023-03");
        const marchCheckpoint = (report: Awaited<ReturnType<typeof run>>["report"]) =>
            report.checkpoints.find((checkpoint) => checkpoint.label === "2023-03")!;

        const aCheckpoint = marchCheckpoint(withoutFuture.report);
        const bCheckpoint = marchCheckpoint(withFuture.report);
        expect(aCheckpoint.status).to.equal("measured");
        expect(bCheckpoint.status).to.equal("measured");
        // Historical membership identical in both runs: appended future data
        // did not change March's historical answer.
        expect(aCheckpoint.retainedSymbols).to.equal(3);
        expect(bCheckpoint.retainedSymbols).to.equal(3);

        const strip = (selections: ReturnType<typeof marchSelections>) =>
            selections.map((selection) => ({
                sortKey: selection.sortKey,
                score: selection.score,
                identityKey: selection.identityKey,
                eligibleConfigurations: selection.comparison!.eligibleConfigurations,
            }));
        expect(strip(marchSelections(withoutFuture.report)))
            .to.deep.equal(strip(marchSelections(withFuture.report)));

        // Only measurement availability differs.
        const aCmp = marchSelections(withoutFuture.report).map((selection) => selection.comparison!.status);
        const bCmp = marchSelections(withFuture.report).map((selection) => selection.comparison!.status);
        expect(aCmp.every((status) => status === "unavailable")).to.equal(true);
        expect(bCmp.every((status) => status === "measured")).to.equal(true);
    });

    it("shares forward execution across sorts and ships only winner outcomes", async () => {
        const { report } = await run(buildInput());
        for (const checkpoint of report.checkpoints) {
            const winnerOutcomes = report.forwardOutcomes.filter(
                (outcome) => outcome.checkpointLabel === checkpoint.label,
            );
            // Report ships ONLY the distinct winner outcomes; nonwinner pool
            // outcomes stay server-side transient scalars.
            expect(winnerOutcomes.length).to.equal(checkpoint.distinctWinners);
            // 15 sort selections share the pool's <=2 distinct outcomes:
            // sorting never re-executes a configuration already measured.
            const sortSelections = report.selections.filter(
                (selection) => selection.checkpointIndex === checkpoint.index,
            );
            expect(sortSelections.length).to.equal(15);
            expect(winnerOutcomes.length).to.be.lessThan(sortSelections.length);
            expect(checkpoint.distinctWinners).to.be.at.most(2);
        }
    });

    it("does not crash when a retained symbol's data ends exactly at the checkpoint", async () => {
        // EDGE has exactly L bars closed by March (its last bar closes at the
        // checkpoint) and ZERO forward bars: it ranks historically, its
        // forward outcome is missing (not zero), comparisons are unavailable,
        // and the run must complete without a fatal.
        const datasets = new Map<string, OHLCVData[]>([
            ["UP", buildData("UP")],
            ["DOWN", buildData("DOWN")],
            ["EDGE", delayedRows(100, 20)],
        ]);
        const symbols = ["UP", "DOWN", "EDGE"];
        const { report } = await run(buildInput({
            datasets,
            options: buildOptions({}, symbols),
            paramSets: [{ period: 5 }, { period: 20 }],
        }));

        // EDGE lacks history at Jan/Feb, is retained at March.
        const janCheckpoint = report.checkpoints.find((checkpoint) => checkpoint.label === "2023-01")!;
        expect(janCheckpoint.retainedSymbols).to.equal(2);
        expect(janCheckpoint.excludedSymbols!.some((entry) => entry.symbol === "EDGE")).to.equal(true);
        const marCheckpoint = report.checkpoints.find((checkpoint) => checkpoint.label === "2023-03")!;
        expect(marCheckpoint.status).to.equal("measured");
        expect(marCheckpoint.retainedSymbols).to.equal(3);

        const marchSelections = report.selections.filter((selection) => selection.checkpointLabel === "2023-03");
        expect(marchSelections.length).to.equal(15);
        for (const selection of marchSelections) {
            expect(selection.status).to.equal("incomplete_horizon");
            expect(selection.forwardReturnPercent).to.equal(null);
            expect(selection.comparison!.status).to.equal("unavailable");
            expect(selection.comparison!.eligibleConfigurations).to.equal(2);
        }
        // The EDGE missing outcome is recorded as an error row, not a zero.
        const edgeRows = report.forwardOutcomes
            .flatMap((outcome) => outcome.symbols)
            .filter((symbol) => symbol.symbol === "EDGE");
        expect(edgeRows.length).to.be.greaterThan(0);
        for (const row of edgeRows) {
            expect(row.error).to.contain("incomplete forward horizon");
            expect(row.returnPercent).to.be.NaN;
        }
        // Jan/Feb comparisons remain fully measured.
        const janExpectancy = report.selections.find(
            (selection) => selection.checkpointLabel === "2023-01" && selection.sortKey === "medianExpectancy",
        )!;
        expect(janExpectancy.status).to.equal("measured");
        expect(janExpectancy.comparison!.status).to.equal("measured");
    });

    it("surfaces the reason as an unavailable checkpoint when zero candidates are generated", async () => {
        const { report } = await run(buildInput({ paramSets: [] }));
        expect(report.experiment.candidatePool.actualCandidates).to.equal(0);
        expect(report.forwardOutcomes).to.deep.equal([]);
        expect(report.selections).to.deep.equal([]);
        // The reason must be visible on a checkpoint record (the coverage-only
        // report has no scheduled checkpoints of its own).
        expect(report.checkpoints.length).to.equal(1);
        expect(report.checkpoints[0]!.status).to.equal("unavailable");
        expect(report.checkpoints[0]!.reason).to.contain("No candidate configurations were generated");
        for (const summary of report.sortSummaries) {
            expect(summary.validCheckpoints).to.equal(0);
            expect(summary.excludedCounts.some((entry) => entry.reason === "no candidate configurations")).to.equal(true);
        }
    });

    it("attaches the fatal-flagged partial report when the run dies mid-loop", async () => {
        let checkpointSeen = false;
        let thrown: (Error & { replayReport?: import("../lib/finder/finder-monthly-rank-replay").MonthlyRankReplayReport }) | null = null;
        try {
            await runFinderMonthlyRankReplay(buildInput(), {
                setProgress: () => {},
                setStatus: () => {},
                yieldControl: async () => {},
                isCancelled: () => {
                    if (checkpointSeen) throw new Error("fixture fatal");
                    return false;
                },
                onCheckpoint: () => {
                    checkpointSeen = true;
                },
            });
        } catch (error) {
            thrown = error as typeof thrown;
        }
        expect(thrown).to.exist;
        expect(thrown!.message).to.equal("fixture fatal");
        // Job-level failures retain partial results labelled incomplete.
        const partial = thrown!.replayReport!;
        expect(partial).to.exist;
        expect(partial.fatal).to.equal("fixture fatal");
        expect(partial.stoppedEarly).to.deep.equal({ reason: "fatal", completedCheckpoints: 1 });
        expect(partial.checkpoints.length).to.equal(1);
        expect(partial.sortSummaries.length).to.equal(15);
    });

describe("Synthetic pair scored truncation commutation", () => {
    it("truncating seeds before aggregation equals truncating the built series at complete buckets", () => {
        const seedCount = 8 * 8; // 8 x 30m seeds per 4h bucket
        const base: OHLCVData[] = [];
        const quote: OHLCVData[] = [];
        for (let i = 0; i < seedCount; i += 1) {
            const time = (BASE_TIME + i * 1800) as Time;
            const baseClose = 50 + (i % 7) * 0.75;
            const quoteClose = 10 + (i % 5) * 0.3;
            base.push({ time, open: baseClose, high: baseClose + 1.5, low: baseClose - 1.2, close: baseClose + 0.25, volume: 10 + i });
            quote.push({ time, open: quoteClose, high: quoteClose + 0.5, low: quoteClose - 0.4, close: quoteClose + 0.1, volume: 20 + i });
        }
        const ratio = buildSyntheticPairDataset({ base, quote, interval: "30m", minBars: 4 });
        const full = aggregateSyntheticBars(ratio.bars, "4h");
        expect(full.length).to.equal(8);

        // Cut at a complete 4h bucket boundary (keep 5 of 8 buckets).
        const cutoffSec = (BASE_TIME + 5 * 4 * 3600) - 1;
        const truncatedBase = base.filter((bar) => (bar.time as number) <= cutoffSec);
        const truncatedQuote = quote.filter((bar) => (bar.time as number) <= cutoffSec);
        const truncatedRatio = buildSyntheticPairDataset({ base: truncatedBase, quote: truncatedQuote, interval: "30m", minBars: 4 });
        const truncatedFull = aggregateSyntheticBars(truncatedRatio.bars, "4h");

        const keptFromFull = full.filter((bar) => ((bar.time as number) + 4 * 3600) <= cutoffSec + 1);
        expect(truncatedFull.length).to.equal(keptFromFull.length);
        for (let i = 0; i < keptFromFull.length; i += 1) {
            expect(truncatedFull[i]).to.deep.equal(keptFromFull[i]);
        }
    });
});
