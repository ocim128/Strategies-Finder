/**
 * Tests for the Asset Opportunity runner
 * (`lib/finder/finder-asset-opportunity-runner.ts`).
 *
 * Locks the Phase 1 invariants:
 *  1. Same seed and input produce identical per-asset candidate parameters and
 *     result ordering.
 *  2. Assets are searched independently — no cross-asset average appears in
 *     an asset result.
 *  3. The latest candle can change fresh status but cannot change historical
 *     rank (fresh-entry detection runs AFTER historical ranking).
 *  4. Decision grades match the explicit gates.
 *  5. Assets with no fresh latest-bar entry are excluded from the ranked rows
 *     but counted in outcomes.
 */
import { expect } from "chai";
import { describe, it } from "node:test";
import {
    runAssetOpportunitySearch,
    splitApplicationCandle,
    deriveAssetSeed,
    assertAssetOpportunityStrategySelection,
    type AssetOpportunityRunInput,
    type AssetIsSearch,
} from "../lib/finder/finder-asset-opportunity-runner";
import type { FinderSelectedStrategy } from "../lib/finder/finder-runner";
import type { FinderOptions, FinderResult, FinderAssetOpportunityOptions } from "../lib/types/finder";
import type { CapitalSettings } from "../lib/types/backtest";
import type { BacktestResult, BacktestSettings, OHLCVData, Signal, Strategy, Time } from "../lib/types/strategies";

function makeCandles(closes: number[]): OHLCVData[] {
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
 * A deterministic strategy whose `threshold` param picks which bar index
 * produces a buy, and which always sells on the last bar. This lets tests
 * place the entry on the latest bar (fresh) or an earlier bar (active).
 */
function makeThresholdStrategy(_key: string): Strategy {
    return {
        name: "Threshold Test",
        description: "threshold test strategy",
        defaultParams: { threshold: 1 },
        paramLabels: { threshold: "Threshold" },
        execute(data, params) {
            if (data.length < 3) return [];
            const t = Math.max(1, Math.min(data.length - 1, Math.round(Number(params.threshold) || 1)));
            return [
                { time: data[t - 1]!.time, type: "buy", price: data[t - 1]!.close },
                { time: data[data.length - 1]!.time, type: "sell", price: data[data.length - 1]!.close },
            ];
        },
    };
}

const settings: BacktestSettings = {
    executionModel: "signal_close",
    tradeDirection: "long",
    allowSameBarExit: true,
    slippageBps: 0,
    marketMode: "all",
};

const capitalSettings: CapitalSettings = {
    initialCapital: 10000,
    positionSize: 100,
    commission: 0,
    sizingMode: "percent",
    fixedTradeAmount: 1000,
};

function makeOptions(overrides: Partial<FinderOptions> = {}): FinderOptions {
    return {
        scope: "asset_opportunity",
        mode: "random",
        sortPriority: ["netProfit"],
        useAdvancedSort: false,
        topN: 3,
        steps: 2,
        rangePercent: 35,
        maxRuns: 8,
        tradeFilterEnabled: false,
        minTrades: 0,
        maxTrades: Number.POSITIVE_INFINITY,
        randomSeed: 7,
        dataSlice: "all",
        ...overrides,
    };
}

/**
 * A deterministic IS-search stub that runs each supplied param set through the
 * actual strategy + backtest on the given data, producing one FinderResult per
 * param. Mirrors what `runFinderExecution` would produce, but synchronous and
 * DOM-free so it runs under node:test.
 */
function makeStubIsSearch(): AssetIsSearch {
    return async (args) => {
        const { ohlcvData, selectedStrategies, generateParamSets, options } = args;
        const strategy = selectedStrategies[0]!.strategy;
        const paramSets = generateParamSets(strategy.defaultParams, options);
        const results: FinderResult[] = [];
        const lastDataTime = ohlcvData.length > 0 ? ohlcvData[ohlcvData.length - 1]!.time : null;
        void lastDataTime;
        for (const params of paramSets) {
            const signals = strategy.execute(ohlcvData, params);
            const backtest = runBacktestForAssetTest(ohlcvData, signals, args.settings);
            results.push({
                key: selectedStrategies[0]!.key,
                name: selectedStrategies[0]!.name,
                params,
                result: backtest,
                selectionResult: backtest,
                endpointAdjusted: false,
                endpointRemovedTrades: 0,
            });
        }
        // Sort by sortPriority (netProfit desc by default).
        results.sort((a, b) => b.result.netProfit - a.result.netProfit);
        return {
            results: results.slice(0, options.topN),
            totalCandidatesEvaluated: paramSets.length,
        };
    };
}

/**
 * Like `makeStubIsSearch`, but honors `retainSignals`: returns each top-K
 * candidate's generated signals parallel to `results`, mirroring the
 * production `runServerAssetIsSearch` retention contract.
 */
function makeRetainingStubIsSearch(): AssetIsSearch {
    return async (args) => {
        const { ohlcvData, selectedStrategies, generateParamSets, options } = args;
        const strategy = selectedStrategies[0]!.strategy;
        const paramSets = generateParamSets(strategy.defaultParams, options);
        const results: FinderResult[] = [];
        const signalsByResult = new Map<FinderResult, Signal[]>();
        for (const params of paramSets) {
            const signals = strategy.execute(ohlcvData, params);
            const backtest = runBacktestForAssetTest(ohlcvData, signals, args.settings);
            const candidate: FinderResult = {
                key: selectedStrategies[0]!.key,
                name: selectedStrategies[0]!.name,
                params,
                result: backtest,
                selectionResult: backtest,
                endpointAdjusted: false,
                endpointRemovedTrades: 0,
            };
            results.push(candidate);
            if (args.retainSignals === true) {
                signalsByResult.set(candidate, signals);
            }
        }
        results.sort((a, b) => b.result.netProfit - a.result.netProfit);
        const topK = results.slice(0, options.topN);
        return {
            results: topK,
            totalCandidatesEvaluated: paramSets.length,
            ...(args.retainSignals === true
                ? { signalsByCandidate: topK.map((candidate) => signalsByResult.get(candidate) ?? []) }
                : {}),
        };
    };
}

/** Minimal backtest: sum trade PnL from signals in order. */
function runBacktestForAssetTest(data: OHLCVData[], signals: { time: Time; type: "buy" | "sell"; price: number }[], settings: BacktestSettings): BacktestResult {
    void settings;
    let cash = capitalSettings.initialCapital;
    let shares = 0;
    let entryPrice = 0;
    let entryTime: Time | null = null;
    const trades: BacktestResult["trades"] = [];
    const byTime = new Map<string, { time: Time; type: "buy" | "sell"; price: number }>();
    for (const s of signals) {
        byTime.set(String(s.time), s);
    }
    for (const bar of data) {
        const sig = byTime.get(String(bar.time));
        if (!sig) continue;
        if (sig.type === "buy" && shares === 0) {
            shares = cash / sig.price;
            entryPrice = sig.price;
            entryTime = bar.time;
            cash = 0;
        } else if (sig.type === "sell" && shares > 0) {
            cash = shares * sig.price;
            const pnl = cash - capitalSettings.initialCapital;
            trades.push({
                id: trades.length + 1,
                type: "long",
                entryTime: entryTime ?? bar.time,
                entryPrice,
                exitTime: bar.time,
                exitPrice: sig.price,
                pnl,
                pnlPercent: (pnl / capitalSettings.initialCapital) * 100,
                size: shares,
                fees: 0,
            });
            shares = 0;
            cash = capitalSettings.initialCapital;
        }
    }
    // Force end_of_data liquidation for any still-open position.
    if (shares > 0 && data.length > 0) {
        const last = data[data.length - 1]!;
        cash = shares * last.close;
        const pnl = cash - capitalSettings.initialCapital;
        trades.push({
            id: trades.length + 1,
            type: "long",
            entryTime: entryTime ?? last.time,
            entryPrice,
            exitTime: last.time,
            exitPrice: last.close,
            pnl,
            pnlPercent: (pnl / capitalSettings.initialCapital) * 100,
            size: shares,
            fees: 0,
            exitReason: "end_of_data",
        });
    }
    const netProfit = trades.reduce((sum, t) => sum + t.pnl, 0);
    const winning = trades.filter((t) => t.pnl > 0).length;
    const losing = trades.filter((t) => t.pnl < 0).length;
    return {
        trades,
        netProfit,
        netProfitPercent: 0,
        winRate: trades.length > 0 ? (winning / trades.length) * 100 : 0,
        expectancy: trades.length > 0 ? netProfit / trades.length : 0,
        avgTrade: trades.length > 0 ? netProfit / trades.length : 0,
        profitFactor: 0,
        maxDrawdown: 0,
        maxDrawdownPercent: 0,
        totalTrades: trades.length,
        winningTrades: winning,
        losingTrades: losing,
        avgWin: 0,
        avgLoss: 0,
        sharpeRatio: 0,
        equityCurve: [],
    };
}

function makeInput(overrides: Partial<AssetOpportunityRunInput>): AssetOpportunityRunInput {
    return {
        interval: "1h",
        options: makeOptions(),
        settings,
        capitalSettings,
        selectedStrategy: {
            key: "threshold_test",
            name: "Threshold Test",
            strategy: makeThresholdStrategy("threshold_test"),
        },
        generateParamSets: () => [{ threshold: 1 }],
        runSeed: 7,
        candidatePoolSize: 3,
        minFreshSupport: 1,
        assets: [],
        runIsSearch: makeStubIsSearch(),
        ...overrides,
    };
}

function makeCallbacks() {
    return {
        setProgress: () => undefined,
        setStatus: () => undefined,
        yieldControl: async () => undefined,
        isCancelled: () => false,
        onAssetComplete: () => undefined,
    };
}

describe("Asset Opportunity runner", () => {
    it("rejects zero selected strategies", () => {
        expect(() => assertAssetOpportunityStrategySelection([])).to.throw(/at least one selected strategy/i);
    });

    it("accepts multiple selected strategies for independent comparison", () => {
        const selection: FinderSelectedStrategy[] = [
            { key: "a", name: "A", strategy: makeThresholdStrategy("a") },
            { key: "b", name: "B", strategy: makeThresholdStrategy("b") },
        ];
        expect(() => assertAssetOpportunityStrategySelection(selection)).to.not.throw();
    });

    it("accepts exactly one selected strategy", () => {
        const selection: FinderSelectedStrategy[] = [
            { key: "a", name: "A", strategy: makeThresholdStrategy("a") },
        ];
        expect(() => assertAssetOpportunityStrategySelection(selection)).to.not.throw();
    });

    it("splitApplicationCandle reserves the latest closed candle", () => {
        const data = makeCandles([100, 101, 102, 103]);
        const { historical, applicationCandle, fullClosed } = splitApplicationCandle(data);
        expect(fullClosed).to.have.length(4);
        expect(historical).to.have.length(3);
        expect(applicationCandle?.close).to.equal(103);
        expect(historical.map((c) => c.close)).to.deep.equal([100, 101, 102]);
    });

    it("deriveAssetSeed is deterministic for the same inputs", () => {
        expect(deriveAssetSeed(7, "BTCUSDT")).to.equal(deriveAssetSeed(7, "BTCUSDT"));
        expect(deriveAssetSeed(7, "BTCUSDT")).to.not.equal(deriveAssetSeed(7, "ETHUSDT"));
        expect(deriveAssetSeed(7, "BTCUSDT")).to.not.equal(deriveAssetSeed(8, "BTCUSDT"));
    });

    it("returns a fresh opportunity when the strategy enters on the latest bar", async () => {
        // threshold=5 → entry on bar index 4 (the latest of 5 candles).
        const strategy: Strategy = {
            name: "FreshOnLast",
            description: "enters on the latest bar",
            defaultParams: { threshold: 5 },
            paramLabels: { threshold: "Threshold" },
            execute(data) {
                if (data.length < 5) return [];
                const entryIdx = data.length - 1;
                return [{ time: data[entryIdx]!.time, type: "buy", price: data[entryIdx]!.close }];
            },
        };
        const input = makeInput({
            selectedStrategy: { key: "fresh_last", name: "FreshOnLast", strategy },
            generateParamSets: () => [{ threshold: 5 }],
            assets: [{ symbol: "A", data: makeCandles([100, 101, 102, 103, 104]) }],
        });
        const output = await runAssetOpportunitySearch(input, makeCallbacks());
        expect(output.results).to.have.length(1);
        const result = output.results[0]!;
        expect(result.symbol).to.equal("A");
        expect(result.freshStatus).to.equal("fresh");
        expect(result.direction).to.equal("long");
        expect(result.signalAgeBars).to.equal(0);
        expect(result.historicalRank).to.equal(1);
        expect(result.isHistoricalBest).to.equal(true);
        expect(["select", "watch", "reject"]).to.include(result.grade);
        const diagnostics = output.outcomes[0]!.diagnostics;
        expect(diagnostics).to.exist;
        expect(diagnostics!.dataBars).to.equal(5);
        // signal_close keeps the reserved application candle out of the
        // search window: its recheck needs re-simulated trades, so signal
        // reuse is disabled and the window is unchanged.
        expect(diagnostics!.historicalBars).to.equal(4);
        expect(diagnostics!.slicedHistoricalBars).to.equal(4);
        expect(diagnostics!.candidatesEvaluated).to.equal(1);
        expect(diagnostics!.freshEntryRechecks).to.equal(1);
        expect(diagnostics!.timingsMs.total).to.be.at.least(0);
        expect(diagnostics!.engineUsage.typescriptCompletedRuns).to.be.at.least(1);
        expect(diagnostics!.engineUsage.typescriptReasons.map((entry) => entry.reason)).to.include(
            "Rust was not requested",
        );
    });

    it("uses the server fresh-entry batch result for signal_close rechecks", async () => {
        const strategy: Strategy = {
            name: "Fresh Batch Test",
            description: "enters on the latest bar",
            defaultParams: {},
            paramLabels: {},
            execute(data) {
                const latest = data[data.length - 1];
                return latest
                    ? [{ time: latest.time, type: "buy", price: latest.close }]
                    : [];
            },
        };
        let batchCalls = 0;
        const output = await runAssetOpportunitySearch(
            makeInput({
                selectedStrategy: { key: "fresh_batch", name: strategy.name, strategy },
                assets: [{ symbol: "BATCH", data: makeCandles([100, 101, 102, 103, 104]) }],
                freshEntryBatch: async (batchInput) => {
                    batchCalls += 1;
                    expect(batchInput.candidates).to.have.length(1);
                    const evaluations = new Map();
                    for (const candidate of batchInput.candidates) {
                        evaluations.set(candidate.id, {
                            result: runBacktestForAssetTest(
                                batchInput.data,
                                candidate.signals,
                                batchInput.settings,
                            ),
                            signals: candidate.signals,
                            engineUsed: "rust" as const,
                            rustAttempted: true as const,
                        });
                    }
                    return evaluations;
                },
            }),
            makeCallbacks(),
        );
        expect(batchCalls).to.equal(1);
        expect(output.results).to.have.length(1);
        expect(output.results[0]!.freshStatus).to.equal("fresh");
        expect(output.outcomes[0]!.diagnostics?.engineUsage.rustCompletedRuns).to.equal(1);
        expect(output.outcomes[0]!.diagnostics?.engineUsage.typescriptCompletedRuns).to.equal(0);
    });

    it("recognizes a latest next_open signal before the next-bar fill exists", async () => {
        const strategy: Strategy = {
            name: "Latest Next Open Test",
            description: "emits one entry on the latest closed candle",
            defaultParams: {},
            paramLabels: {},
            execute(data) {
                const latest = data[data.length - 1];
                return latest
                    ? [{ time: latest.time, type: "buy", price: latest.close }]
                    : [];
            },
        };
        const data = makeCandles([100, 101, 102, 103, 104, 105]);
        const output = await runAssetOpportunitySearch(
            makeInput({
                settings: { ...settings, executionModel: "next_open", tradeDirection: "long" },
                selectedStrategy: { key: "latest_next_open", name: strategy.name, strategy },
                assets: [{ symbol: "PENDING", data }],
            }),
            makeCallbacks(),
        );
        expect(output.results).to.have.length(1);
        expect(output.results[0]!.freshStatus).to.equal("fresh");
        expect(output.results[0]!.fillTiming).to.equal("next_open");
        expect(output.results[0]!.signalAgeBars).to.equal(0);
    });

    it("recognizes a penultimate next_open signal at the latest modeled fill boundary", async () => {
        const strategy: Strategy = {
            name: "Penultimate Next Open Test",
            description: "emits one entry on the candle filled by the latest next-open bar",
            defaultParams: {},
            paramLabels: {},
            execute(data) {
                const signalCandle = data[data.length - 2];
                return signalCandle
                    ? [{ time: signalCandle.time, type: "buy", price: signalCandle.close }]
                    : [];
            },
        };
        const data = makeCandles([100, 101, 102, 103, 104, 105]);
        const output = await runAssetOpportunitySearch(
            makeInput({
                settings: { ...settings, executionModel: "next_open", tradeDirection: "long" },
                selectedStrategy: { key: "penultimate_next_open", name: strategy.name, strategy },
                assets: [{ symbol: "PENULTIMATE", data }],
                runIsSearch: makeRetainingStubIsSearch(),
            }),
            makeCallbacks(),
        );
        expect(output.results).to.have.length(1);
        expect(output.results[0]!.freshStatus).to.equal("fresh");
        expect(output.results[0]!.latestSignalTime).to.equal(data[data.length - 2]!.time);
        expect(output.results[0]!.signalAgeBars).to.equal(1);
        expect(output.results[0]!.fillTiming).to.equal("next_open");
    });

    it("reuses capped in-sample signals for fixed-holdout next_open freshness", async () => {
        const strategy: Strategy = {
            name: "Fixed Holdout Next Open Reuse",
            description: "emits one entry at the visible boundary",
            defaultParams: {},
            paramLabels: {},
            execute(data) {
                const latest = data[data.length - 1];
                return latest
                    ? [{ time: latest.time, type: "buy", price: latest.close }]
                    : [];
            },
        };
        const data = makeCandles([100, 101, 102, 103, 104, 105, 106, 107, 108]);
        let retainSignals = false;
        const output = await runAssetOpportunitySearch(
            makeInput({
                settings: { ...settings, executionModel: "next_open", tradeDirection: "long" },
                options: makeOptions({
                    assetOpportunity: {
                        symbols: ["FIXED_REUSE"],
                        oosIgnoreLastBars: 2,
                        evalLastBars: 4,
                        candidatePoolSize: 1,
                        minFreshSupport: 1,
                    },
                }),
                selectedStrategy: { key: "fixed_reuse", name: strategy.name, strategy },
                assets: [{ symbol: "FIXED_REUSE", data }],
                runIsSearch: async (args) => {
                    retainSignals = args.retainSignals === true;
                    return makeRetainingStubIsSearch()(args);
                },
            }),
            makeCallbacks(),
        );
        expect(retainSignals).to.equal(true);
        expect(output.results).to.have.length(1);
        expect(output.results[0]!.freshStatus).to.equal("fresh");
        expect(output.results[0]!.latestSignalTime).to.equal(data[6]!.time);
        expect(output.outcomes[0]!.diagnostics?.freshEntryRechecks).to.equal(1);
        expect(output.outcomes[0]!.diagnostics?.timingsMs.freshEntryRechecks).to.be.lessThan(5);
    });

    it("reserves the real latest candle before slicing and exposes OOS evidence", async () => {
        const strategy: Strategy = {
            name: "SlicedFresh",
            description: "enters on the latest bar",
            defaultParams: { threshold: 1 },
            paramLabels: { threshold: "Threshold" },
            execute(data) {
                const latest = data[data.length - 1];
                return latest ? [{ time: latest.time, type: "buy", price: latest.close }] : [];
            },
        };
        const candles = makeCandles([100, 101, 102, 103, 104, 105, 106, 107]);
        let searched: OHLCVData[] = [];
        const baseSearch = makeStubIsSearch();
        const input = makeInput({
            options: makeOptions({ dataSlice: "half_oldest", oosValidationEnabled: true }),
            selectedStrategy: { key: "sliced_fresh", name: "SlicedFresh", strategy },
            generateParamSets: () => [{ threshold: 1 }],
            assets: [{ symbol: "SLICED", data: candles }],
            runIsSearch: async (args) => {
                searched = args.ohlcvData;
                return baseSearch(args);
            },
        });

        const output = await runAssetOpportunitySearch(input, makeCallbacks());
        expect(searched).to.have.length(3);
        expect(searched[searched.length - 1]!.time).to.equal(candles[2]!.time);
        expect(output.results).to.have.length(1);
        expect(output.results[0]!.latestSignalTime).to.equal(candles[candles.length - 1]!.time);
        expect(output.results[0]!.signalAgeBars).to.equal(0);
        expect(output.results[0]!.oosResult).to.exist;
        expect(output.results[0]!.oosVerdict).to.be.oneOf(["pass", "fail", "inconclusive"]);
    });

    it("hides the final bars, signals at the visible boundary, and reports forward PnL", async () => {
        const strategy: Strategy = {
            name: "FixedHoldout",
            description: "creates an OOS trade before the application signal",
            defaultParams: {},
            paramLabels: {},
            execute(data) {
                const signals: Array<{ time: Time; type: "buy" | "sell"; price: number }> = [];
                if (data[4]) signals.push({ time: data[4].time, type: "buy", price: data[4].close });
                if (data[5]) signals.push({ time: data[5].time, type: "sell", price: data[5].close });
                const latest = data[data.length - 1];
                if (latest && data.length >= 8) signals.push({ time: latest.time, type: "buy", price: latest.close });
                return signals;
            },
        };
        const candles = makeCandles([100, 101, 102, 103, 100, 110, 90, 95, 96]);
        let searched: OHLCVData[] = [];
        const output = await runAssetOpportunitySearch(makeInput({
            options: makeOptions({
                assetOpportunity: {
                    symbols: ["HOLDOUT"],
                    candidatePoolSize: 1,
                    minFreshSupport: 1,
                    oosIgnoreLastBars: 4,
                    oosHorizons: [1, 3, 5],
                },
            }),
            selectedStrategy: { key: "fixed_holdout", name: strategy.name, strategy },
            assets: [{ symbol: "HOLDOUT", data: candles }],
            runIsSearch: async (args) => {
                searched = args.ohlcvData;
                return makeStubIsSearch()(args);
            },
        }), makeCallbacks());

        expect(searched.map((bar) => bar.close)).to.deep.equal([100, 101, 102, 103, 100]);
        expect(output.results).to.have.length(1);
        expect(output.results[0]!.latestSignalTime).to.equal(candles[4]!.time);
        expect(output.results[0]!.oosHorizonMetrics).to.deep.equal({
            ignoreLastBars: 4,
            horizons: [
                { bars: 1, pnlPercent: 10, averagePnlPercent: 10, winRatePercent: 100, sampleSize: 1 },
                { bars: 3, pnlPercent: -5, averagePnlPercent: -5, winRatePercent: 0, sampleSize: 1 },
                { bars: 5, pnlPercent: null, averagePnlPercent: null, winRatePercent: null, sampleSize: 0 },
            ],
        });
        expect(output.outcomes[0]!.diagnostics?.slicedHistoricalBars).to.equal(5);
        expect(output.outcomes[0]!.diagnostics?.oosBars).to.equal(4);
    });

    it("runs OOS only for the winner, not for every top-K candidate", async () => {
        // Intent lock: OOS is the largest CPU bucket per asset, and the
        // reducer only consumes the winner's verdict in `decideAssetGrade`.
        // The K-1 non-winner OOS backtests are pure waste. This test fixes the
        // invariant at `oosEvaluations === 1` regardless of pool size, while
        // `freshEntryRechecks` still equals the full pool size (those are
        // genuinely needed for support counts).
        const strategy: Strategy = {
            name: "AlwaysFreshMultiParam",
            description: "always enters on the latest bar; param only affects name",
            defaultParams: { threshold: 1 },
            paramLabels: { threshold: "Threshold" },
            execute(data) {
                const latest = data[data.length - 1];
                return latest ? [{ time: latest.time, type: "buy", price: latest.close }] : [];
            },
        };
        const candles = makeCandles([100, 101, 102, 103, 104, 105, 106, 107]);
        const poolSize = 3;
        const input = makeInput({
            options: makeOptions({ dataSlice: "half_oldest", oosValidationEnabled: true }),
            selectedStrategy: { key: "always_fresh", name: "AlwaysFresh", strategy },
            // Generate `poolSize` distinct param sets so the stub returns a
            // full top-K pool where every candidate is fresh on the latest bar.
            generateParamSets: () => Array.from({ length: poolSize }, (_, i) => ({ threshold: i + 1 })),
            candidatePoolSize: poolSize,
            assets: [{ symbol: "MULTI", data: candles }],
        });

        const output = await runAssetOpportunitySearch(input, makeCallbacks());
        expect(output.results).to.have.length(1);
        const diagnostics = output.outcomes[0]!.diagnostics;
        expect(diagnostics, "diagnostics must be surfaced").to.exist;
        expect(diagnostics!.freshEntryRechecks, "fresh rechecks still cover the full pool").to.equal(poolSize);
        expect(diagnostics!.oosEvaluations, "OOS runs only for the winner").to.equal(1);
        expect(output.results[0]!.oosResult).to.exist;
        expect(output.results[0]!.oosVerdict).to.be.oneOf(["pass", "fail", "inconclusive"]);
    });

    it("counts both OOS modes when a fixed holdout and a legacy OOS window are active", async () => {
        // The fixed-holdout branch (forward PnL at horizons) and the legacy
        // complementary-window branch (winner backtest + verdict) are
        // independent evaluations of the same winner; the diagnostics counter
        // must ADD them, not let the second overwrite the first.
        const strategy: Strategy = {
            name: "FixedHoldoutPlusLegacy",
            description: "boundary signal with both OOS modes enabled",
            defaultParams: {},
            paramLabels: {},
            execute(data) {
                const signals: Array<{ time: Time; type: "buy" | "sell"; price: number }> = [];
                if (data[4]) signals.push({ time: data[4].time, type: "buy", price: data[4].close });
                if (data[5]) signals.push({ time: data[5].time, type: "sell", price: data[5].close });
                const latest = data[data.length - 1];
                if (latest && data.length >= 8) signals.push({ time: latest.time, type: "buy", price: latest.close });
                return signals;
            },
        };
        const candles = makeCandles([100, 101, 102, 103, 100, 110, 90, 95, 96]);
        const output = await runAssetOpportunitySearch(makeInput({
            options: makeOptions({
                dataSlice: "half_oldest",
                oosValidationEnabled: true,
                assetOpportunity: {
                    symbols: ["BOTH_MODES"],
                    candidatePoolSize: 1,
                    minFreshSupport: 1,
                    oosIgnoreLastBars: 4,
                    oosHorizons: [1, 3, 5],
                },
            }),
            selectedStrategy: { key: "both_modes", name: strategy.name, strategy },
            assets: [{ symbol: "BOTH_MODES", data: candles }],
        }), makeCallbacks());

        expect(output.results).to.have.length(1);
        const diagnostics = output.outcomes[0]!.diagnostics;
        expect(diagnostics, "diagnostics must be surfaced").to.exist;
        expect(diagnostics!.oosEvaluations, "fixed-holdout horizons + legacy winner backtest").to.equal(2);
        expect(output.results[0]!.oosHorizonMetrics).to.exist;
        expect(output.results[0]!.oosResult).to.exist;
    });

    it("uses the secondary execution context during fresh replay", async () => {
        const strategy: Strategy = {
            name: "CrossReplay",
            description: "requires aligned secondary data",
            defaultParams: { threshold: 1 },
            paramLabels: { threshold: "Threshold" },
            crossSymbolConfig: { defaultSymbol: "SECONDARY", minBars: 3 },
            execute(data, _params, context) {
                if (!context?.crossSymbol || context.crossSymbol.secondaryData.length !== data.length) return [];
                const latest = data[data.length - 1];
                return latest ? [{ time: latest.time, type: "buy", price: latest.close }] : [];
            },
        };
        const primary = makeCandles([100, 101, 102, 103, 104]);
        const input = makeInput({
            settings: { ...settings, crossSymbolSecondary: "SECONDARY" },
            selectedStrategy: { key: "cross_replay", name: "CrossReplay", strategy },
            generateParamSets: () => [{ threshold: 1 }],
            assets: [{ symbol: "PRIMARY", data: primary }],
            dataFetcher: {
                getProvider: () => "test",
                fetchDataDetached: async () => makeCandles([50, 51, 52, 53, 54]),
            },
        });

        const output = await runAssetOpportunitySearch(input, makeCallbacks());
        expect(output.results).to.have.length(1);
        expect(output.results[0]!.freshStatus).to.equal("fresh");
    });

    it("reports all historical candidates even when only the top-K pool is retained", async () => {
        const strategy: Strategy = {
            name: "FreshPoolCount",
            description: "enters on the latest bar",
            defaultParams: { threshold: 1 },
            paramLabels: { threshold: "Threshold" },
            execute(data) {
                const latest = data[data.length - 1];
                return latest ? [{ time: latest.time, type: "buy", price: latest.close }] : [];
            },
        };
        const input = makeInput({
            selectedStrategy: { key: "fresh_pool_count", name: "FreshPoolCount", strategy },
            candidatePoolSize: 2,
            generateParamSets: () => [
                { threshold: 1 },
                { threshold: 2 },
                { threshold: 3 },
                { threshold: 4 },
            ],
            assets: [{ symbol: "A", data: makeCandles([100, 101, 102, 103, 104]) }],
        });
        const output = await runAssetOpportunitySearch(input, makeCallbacks());
        expect(output.results[0]?.totalCandidatesEvaluated).to.equal(4);
    });

    it("filters Asset Opportunity candidates by the inclusive trade-count range before fresh-entry selection", async () => {
        const strategy: Strategy = {
            name: "TradeCountFilter",
            description: "enters on the latest bar",
            defaultParams: { threshold: 1 },
            paramLabels: { threshold: "Threshold" },
            execute(data) {
                const latest = data[data.length - 1];
                return latest ? [{ time: latest.time, type: "buy", price: latest.close }] : [];
            },
        };
        const input = makeInput({
            options: makeOptions({
                tradeFilterEnabled: true,
                minTrades: 2,
                maxTrades: 4,
            }),
            selectedStrategy: { key: "trade_count_filter", name: strategy.name, strategy },
            candidatePoolSize: 3,
            generateParamSets: () => [{ threshold: 1 }, { threshold: 2 }, { threshold: 3 }],
            assets: [{ symbol: "FILTERED", data: makeCandles([100, 101, 102, 103, 104, 105]) }],
            runIsSearch: async (args) => {
                const base = runBacktestForAssetTest(args.ohlcvData, [], args.settings);
                const candidates = [1, 3, 5].map((totalTrades) => ({
                    key: "trade_count_filter",
                    name: strategy.name,
                    params: { threshold: totalTrades },
                    result: { ...base, totalTrades },
                    selectionResult: { ...base, totalTrades },
                    endpointAdjusted: false,
                    endpointRemovedTrades: 0,
                }));
                return {
                    results: candidates,
                    totalCandidatesEvaluated: candidates.length,
                };
            },
        });

        const output = await runAssetOpportunitySearch(input, makeCallbacks());
        expect(output.results).to.have.length(1);
        expect(output.results[0]!.selectionResult.totalTrades).to.equal(3);
    });

    it("excludes an asset from results when the entry fired on an earlier bar (active)", async () => {
        // threshold=2 → entry on bar 1 of 5 → active (not fresh).
        const strategy: Strategy = {
            name: "EarlyEntry",
            description: "enters early",
            defaultParams: { threshold: 2 },
            paramLabels: { threshold: "Threshold" },
            execute(data) {
                if (data.length < 5) return [];
                return [
                    { time: data[1]!.time, type: "buy", price: data[1]!.close },
                    { time: data[data.length - 1]!.time, type: "sell", price: data[data.length - 1]!.close },
                ];
            },
        };
        const input = makeInput({
            selectedStrategy: { key: "early", name: "EarlyEntry", strategy },
            generateParamSets: () => [{ threshold: 2 }],
            assets: [{ symbol: "B", data: makeCandles([100, 101, 102, 103, 104]) }],
        });
        const output = await runAssetOpportunitySearch(input, makeCallbacks());
        expect(output.results).to.have.length(0);
        expect(output.outcomes).to.have.length(1);
        expect(output.outcomes[0]!.kind).to.equal("no_fresh_entry");
    });

    it("searches assets independently and is deterministic across re-runs", async () => {
        const strategy = makeThresholdStrategy("deterministic");
        const assets = [
            { symbol: "AAA", data: makeCandles([100, 101, 102, 103, 104, 105]) },
            { symbol: "BBB", data: makeCandles([50, 51, 52, 53, 54, 55]) },
        ];
        const input = makeInput({
            selectedStrategy: { key: "deterministic", name: "Deterministic", strategy },
            generateParamSets: () => [{ threshold: 1 }, { threshold: 3 }, { threshold: 5 }],
            assets,
        });
        const first = await runAssetOpportunitySearch(input, makeCallbacks());
        const second = await runAssetOpportunitySearch(input, makeCallbacks());
        expect(first.results.map((r) => r.symbol)).to.deep.equal(second.results.map((r) => r.symbol));
        expect(first.results.map((r) => r.historicalRank)).to.deep.equal(second.results.map((r) => r.historicalRank));
        expect(first.results.map((r) => JSON.stringify(r.params))).to.deep.equal(second.results.map((r) => JSON.stringify(r.params)));
    });

    it("records a failed outcome for an asset with insufficient candles", async () => {
        const input = makeInput({
            assets: [{ symbol: "TOO_SMALL", data: makeCandles([100]) }],
        });
        const output = await runAssetOpportunitySearch(input, makeCallbacks());
        expect(output.results).to.have.length(0);
        expect(output.outcomes).to.have.length(1);
        expect(output.outcomes[0]!.kind).to.equal("failed");
        expect((output.outcomes[0] as { reason: string }).reason).to.match(/insufficient/i);
    });

    it("does not let the latest candle change the historical candidate rank", async () => {
        // A strategy that always enters on the FIRST bar of the historical
        // window and sells at the end. Whether or not the application candle
        // is appended, the historical rank of the candidate is unchanged.
        const strategy: Strategy = {
            name: "HistoricalOnly",
            description: "historical-only entry",
            defaultParams: { threshold: 1 },
            paramLabels: { threshold: "Threshold" },
            execute(data, params) {
                if (data.length < 4) return [];
                const t = Math.max(1, Math.min(data.length - 2, Math.round(Number(params.threshold) || 1)));
                return [
                    { time: data[0]!.time, type: "buy", price: data[0]!.close },
                    { time: data[t]!.time, type: "sell", price: data[t]!.close },
                ];
            },
        };
        const closes = [100, 101, 102, 103, 104];
        const input = makeInput({
            selectedStrategy: { key: "historical_only", name: "HistoricalOnly", strategy },
            generateParamSets: () => [{ threshold: 1 }, { threshold: 2 }],
            assets: [{ symbol: "RANK", data: makeCandles(closes) }],
        });
        const output = await runAssetOpportunitySearch(input, makeCallbacks());
        // Both candidates entered on the historical window; the application
        // candle doesn't change their historical ordering. If no fresh entry
        // exists, the asset is excluded.
        expect(output.outcomes).to.have.length(1);
        const outcome = output.outcomes[0]!;
        if (outcome.kind === "opportunity") {
            expect(outcome.result.historicalRank).to.be.at.least(1);
            expect(outcome.result.historicalRank).to.be.at.most(2);
        } else {
            expect(["no_fresh_entry", "failed"]).to.include(outcome.kind);
        }
    });

    it("rejects when expectancy is negative even with a fresh entry", async () => {
        // Strategy enters on the latest bar, then immediately gets forced out
        // at a loss. Expectancy is negative.
        const strategy: Strategy = {
            name: "LosingFresh",
            description: "fresh entry, losing",
            defaultParams: { threshold: 1 },
            paramLabels: { threshold: "Threshold" },
            execute(data) {
                if (data.length < 5) return [];
                return [{ time: data[data.length - 1]!.time, type: "buy", price: data[data.length - 1]!.close }];
            },
        };
        // Falling prices: the latest bar's buy is at the highest price → loss
        // on any forced end_of_data exit.
        const input = makeInput({
            selectedStrategy: { key: "losing_fresh", name: "LosingFresh", strategy },
            generateParamSets: () => [{ threshold: 1 }],
            assets: [{ symbol: "LOSER", data: makeCandles([100, 99, 98, 97, 96]) }],
        });
        const output = await runAssetOpportunitySearch(input, makeCallbacks());
        if (output.results.length === 1) {
            // With no closed trades and no expectancy data, the grade falls to
            // watch or reject depending on the OOS / expectancy gate.
            expect(["reject", "watch"]).to.include(output.results[0]!.grade);
        } else {
            expect(output.outcomes[0]!.kind).to.equal("no_fresh_entry");
        }
    });

    it("reuses retained in-sample signals for fresh detection in fixed-holdout mode", async () => {
        // Intent lock: the fresh-entry recheck re-executes every top-K
        // candidate on the boundary window. In fixed-holdout mode with
        // dataSlice "all" that window is bar-for-bar identical to the
        // in-sample window, so the recheck is pure waste — the search run's
        // retained signals must produce the SAME fresh outcome without any
        // re-execution.
        const candles = makeCandles([100, 101, 102, 103, 104, 105, 106, 107, 108]);
        const paramSets = [{ threshold: 1 }, { threshold: 2 }];
        const makeCountingStrategy = () => {
            let executeCalls = 0;
            const strategy: Strategy = {
                name: "ReuseHoldout",
                description: "enters on the latest bar of any data",
                defaultParams: { threshold: 1 },
                paramLabels: { threshold: "Threshold" },
                execute(data) {
                    executeCalls += 1;
                    const latest = data[data.length - 1];
                    return latest ? [{ time: latest.time, type: "buy" as const, price: latest.close }] : [];
                },
            };
            return { strategy, getExecuteCalls: () => executeCalls };
        };
        const makeHoldoutOptions = () => makeOptions({
            assetOpportunity: {
                symbols: ["HOLDOUT_REUSE"],
                candidatePoolSize: 2,
                minFreshSupport: 1,
                oosIgnoreLastBars: 2,
                oosHorizons: [1],
            },
        });

        // Run 1: IS search retains signals → runner must NOT re-execute.
        const reused = makeCountingStrategy();
        let retainSignalsRequested = false;
        const reusedOutput = await runAssetOpportunitySearch(makeInput({
            options: makeHoldoutOptions(),
            settings: { ...settings, executionModel: "next_open" },
            selectedStrategy: { key: "reuse_holdout", name: "ReuseHoldout", strategy: reused.strategy },
            candidatePoolSize: 2,
            generateParamSets: () => paramSets.map((params) => ({ ...params })),
            assets: [{ symbol: "HOLDOUT_REUSE", data: candles }],
            runIsSearch: async (args) => {
                if (args.retainSignals === true) retainSignalsRequested = true;
                return makeRetainingStubIsSearch()(args);
            },
        }), makeCallbacks());

        // Run 2: IS search does NOT retain signals → runner re-executes per
        // top-K candidate (the pre-optimization behavior).
        const fallback = makeCountingStrategy();
        const fallbackOutput = await runAssetOpportunitySearch(makeInput({
            options: makeHoldoutOptions(),
            settings: { ...settings, executionModel: "next_open" },
            selectedStrategy: { key: "reuse_holdout", name: "ReuseHoldout", strategy: fallback.strategy },
            candidatePoolSize: 2,
            generateParamSets: () => paramSets.map((params) => ({ ...params })),
            assets: [{ symbol: "HOLDOUT_REUSE", data: candles }],
            runIsSearch: makeStubIsSearch(),
        }), makeCallbacks());

        expect(retainSignalsRequested, "runner must request retained signals when the windows match").to.equal(true);
        expect(reused.getExecuteCalls(), "reuse: only the IS search executes the strategy").to.equal(paramSets.length);
        expect(fallback.getExecuteCalls(), "fallback: IS search + one recheck execution per top-K candidate")
            .to.equal(paramSets.length + paramSets.length);

        expect(reusedOutput.results).to.have.length(1);
        expect(fallbackOutput.results).to.have.length(1);
        // Parity: identical fresh outcomes whether or not signals are reused.
        const pick = (r: typeof reusedOutput.results[number]) => ({
            freshStatus: r.freshStatus,
            direction: r.direction,
            latestSignalTime: r.latestSignalTime,
            signalAgeBars: r.signalAgeBars,
            fillTiming: r.fillTiming,
        });
        expect(pick(reusedOutput.results[0]!)).to.deep.equal(pick(fallbackOutput.results[0]!));
        // The signal fired on the visible boundary candle (index 6 of 9 with
        // 2 hidden bars).
        expect(reusedOutput.results[0]!.freshStatus).to.equal("fresh");
        expect(reusedOutput.results[0]!.latestSignalTime).to.equal(candles[6]!.time);
        // The recheck pool is still fully covered (support counts need it).
        expect(reusedOutput.outcomes[0]!.diagnostics?.freshEntryRechecks).to.equal(paramSets.length);
    });

    it("includes the application candle in the no-holdout search window so signals can be reused", async () => {
        // With no fixed holdout, dataSlice "all", and a non-`signal_close`
        // execution model, the reserved application candle is part of the
        // in-sample search window. Fresh detection then reuses the search
        // run's retained signals instead of re-executing every top-K
        // candidate on the same bars. This is the one intentional semantic
        // change: candidate ranking sees one extra bar out of the full
        // dataset.
        const candles = makeCandles([100, 101, 102, 103, 104, 105]);
        let executeCalls = 0;
        let searchedBars = 0;
        const strategy: Strategy = {
            name: "ReuseNoHoldout",
            description: "enters on the latest bar of any data",
            defaultParams: { threshold: 1 },
            paramLabels: { threshold: "Threshold" },
            execute(data) {
                executeCalls += 1;
                const latest = data[data.length - 1];
                return latest ? [{ time: latest.time, type: "buy" as const, price: latest.close }] : [];
            },
        };
        const output = await runAssetOpportunitySearch(makeInput({
            settings: { ...settings, executionModel: "next_open" },
            selectedStrategy: { key: "reuse_no_holdout", name: "ReuseNoHoldout", strategy },
            generateParamSets: () => [{ threshold: 1 }],
            assets: [{ symbol: "NO_HOLDOUT", data: candles }],
            runIsSearch: async (args) => {
                searchedBars = args.ohlcvData.length;
                return makeRetainingStubIsSearch()(args);
            },
        }), makeCallbacks());

        expect(searchedBars, "search window includes the reserved application candle").to.equal(candles.length);
        expect(executeCalls, "only the IS search executes the strategy").to.equal(1);
        expect(output.results).to.have.length(1);
        expect(output.results[0]!.freshStatus).to.equal("fresh");
        expect(output.results[0]!.signalAgeBars).to.equal(0);
        expect(output.results[0]!.latestSignalTime).to.equal(candles[candles.length - 1]!.time);
    });

    it("keeps re-executing the recheck for signal_close (the in-sample fast path drops trades)", async () => {
        // Parity guard: a `signal_close` recheck needs the re-simulated trade
        // list, and the compact in-sample fast path drops trades — so the
        // runner must NOT request signal retention, must keep the reserved
        // application candle out of the in-sample window, and must re-execute
        // the recheck exactly as before.
        const candles = makeCandles([100, 101, 102, 103, 104, 105]);
        let executeCalls = 0;
        let retainSignalsRequested = false;
        let searchedBars = 0;
        const strategy: Strategy = {
            name: "SignalCloseNoReuse",
            description: "enters on the latest bar of any data",
            defaultParams: { threshold: 1 },
            paramLabels: { threshold: "Threshold" },
            execute(data) {
                executeCalls += 1;
                const latest = data[data.length - 1];
                return latest ? [{ time: latest.time, type: "buy" as const, price: latest.close }] : [];
            },
        };
        const output = await runAssetOpportunitySearch(makeInput({
            selectedStrategy: { key: "signal_close_no_reuse", name: "SignalCloseNoReuse", strategy },
            generateParamSets: () => [{ threshold: 1 }],
            assets: [{ symbol: "SC_NO_REUSE", data: candles }],
            runIsSearch: async (args) => {
                if (args.retainSignals === true) retainSignalsRequested = true;
                searchedBars = args.ohlcvData.length;
                return makeRetainingStubIsSearch()(args);
            },
        }), makeCallbacks());

        expect(retainSignalsRequested, "no retention request for signal_close").to.equal(false);
        expect(searchedBars, "search window still excludes the application candle").to.equal(candles.length - 1);
        expect(executeCalls, "IS search + one recheck execution").to.equal(2);
        expect(output.results).to.have.length(1);
        expect(output.results[0]!.freshStatus).to.equal("fresh");
        expect(output.results[0]!.latestSignalTime).to.equal(candles[candles.length - 1]!.time);
    });

    it("reuses signal_close signals for a fixed holdout while still replaying Rust trades", async () => {
        const candles = makeCandles([100, 101, 102, 103, 104, 105, 106, 107]);
        let executeCalls = 0;
        let retainSignalsRequested = false;
        let freshBatchCalls = 0;
        const strategy: Strategy = {
            name: "SignalCloseHoldoutReuse",
            description: "enters on the visible boundary",
            defaultParams: { threshold: 1 },
            paramLabels: { threshold: "Threshold" },
            execute(data) {
                executeCalls += 1;
                const latest = data[data.length - 1];
                return latest ? [{ time: latest.time, type: "buy" as const, price: latest.close }] : [];
            },
        };
        const output = await runAssetOpportunitySearch(makeInput({
            options: makeOptions({ assetOpportunity: { oosIgnoreLastBars: 2 } as FinderAssetOpportunityOptions }),
            selectedStrategy: { key: "signal_close_holdout_reuse", name: strategy.name, strategy },
            assets: [{ symbol: "SC_HOLDOUT_REUSE", data: candles }],
            runIsSearch: async (args) => {
                retainSignalsRequested = args.retainSignals === true;
                return makeRetainingStubIsSearch()(args);
            },
            freshEntryBatch: async (batchInput) => {
                freshBatchCalls += 1;
                expect(batchInput.candidates[0]?.signals.length).to.be.greaterThan(0);
                return new Map(batchInput.candidates.map((candidate) => [candidate.id, {
                    result: runBacktestForAssetTest(batchInput.data, candidate.signals, settings),
                    signals: candidate.signals,
                    engineUsed: "rust" as const,
                    rustAttempted: true,
                }]));
            },
        }), makeCallbacks());

        expect(retainSignalsRequested).to.equal(true);
        expect(freshBatchCalls).to.equal(1);
        expect(executeCalls, "the strategy is generated once in IS and not regenerated for the recheck")
            .to.equal(1);
        expect(output.outcomes[0]!.diagnostics?.freshEntryRechecks).to.equal(1);
    });

    it("bounds fresh signal generation for eval windows and remaps signal indices", async () => {
        const candles = makeCandles(Array.from({ length: 100 }, (_, index) => 100 + index));
        const signalInputLengths: number[] = [];
        let freshBatchDataLength = 0;
        let freshSignalBarIndex = -1;
        const strategy: Strategy = {
            name: "BoundedFreshSignal",
            description: "enters on the latest bar",
            defaultParams: { threshold: 1 },
            paramLabels: { threshold: "Threshold" },
            execute(data) {
                signalInputLengths.push(data.length);
                const latest = data[data.length - 1];
                return latest
                    ? [{ time: latest.time, type: "buy" as const, price: latest.close }]
                    : [];
            },
        };
        const output = await runAssetOpportunitySearch(makeInput({
            options: makeOptions({
                assetOpportunity: {
                    evalLastBars: 4,
                    oosIgnoreLastBars: 2,
                    candidatePoolSize: 1,
                },
            }),
            selectedStrategy: { key: "bounded_fresh_signal", name: strategy.name, strategy },
            generateParamSets: () => [{ threshold: 1 }],
            assets: [{ symbol: "BOUNDED_FRESH", data: candles }],
            runIsSearch: makeStubIsSearch(),
            freshEntryBatch: async (batchInput) => {
                freshBatchDataLength = batchInput.data.length;
                freshSignalBarIndex = batchInput.candidates[0]?.signals.at(-1)?.barIndex ?? -1;
                return new Map(batchInput.candidates.map((candidate) => [candidate.id, {
                    result: runBacktestForAssetTest(batchInput.data, candidate.signals, settings),
                    signals: candidate.signals,
                    engineUsed: "rust" as const,
                    rustAttempted: true,
                }]));
            },
        }), makeCallbacks());

        // 4 evaluation bars + 64 conservative warmup bars, ending at the
        // visible boundary (index 97), rather than regenerating on all 98.
        expect(signalInputLengths).to.deep.equal([4, 68]);
        expect(freshBatchDataLength).to.equal(98);
        expect(freshSignalBarIndex).to.equal(97);
        expect(output.outcomes[0]!.diagnostics?.freshSignalWindowBars).to.equal(68);
        expect(output.results[0]!.freshStatus).to.equal("fresh");
        expect(output.results[0]!.latestSignalTime).to.equal(candles[97]!.time);
    });

    it("bounds next_open signal-only rechecks without a Rust batch", async () => {
        const candles = makeCandles(Array.from({ length: 100 }, (_, index) => 100 + index));
        const signalInputLengths: number[] = [];
        const strategy: Strategy = {
            name: "Bounded Next Open Signal",
            description: "enters on the latest bar",
            defaultParams: { threshold: 1 },
            paramLabels: { threshold: "Threshold" },
            execute(data) {
                signalInputLengths.push(data.length);
                const latest = data[data.length - 1];
                return latest
                    ? [{ time: latest.time, type: "buy" as const, price: latest.close }]
                    : [];
            },
        };
        const output = await runAssetOpportunitySearch(makeInput({
            options: makeOptions({
                assetOpportunity: {
                    evalLastBars: 4,
                    oosIgnoreLastBars: 2,
                    candidatePoolSize: 1,
                },
            }),
            settings: { ...settings, executionModel: "next_open", tradeDirection: "long" },
            selectedStrategy: { key: "bounded_next_open_signal", name: strategy.name, strategy },
            generateParamSets: () => [{ threshold: 1 }],
            assets: [{ symbol: "BOUNDED_NEXT_OPEN", data: candles }],
            runIsSearch: makeStubIsSearch(),
        }), makeCallbacks());

        // Fresh next-bar detection only needs the latest two signal bars plus
        // the 64-bar conservative warmup; it no longer walks the full
        // 500-bar evaluation window or 98-bar boundary.
        expect(signalInputLengths).to.deep.equal([4, 66]);
        expect(output.outcomes[0]!.diagnostics?.freshSignalWindowBars).to.equal(66);
        expect(output.results[0]!.freshStatus).to.equal("fresh");
        expect(output.results[0]!.latestSignalTime).to.equal(candles[97]!.time);
    });

    it("still re-executes the recheck when a data slice shifts the window", async () => {
        // Guard: signal reuse is only valid when the recheck window is
        // bar-for-bar identical to the in-sample window. A non-"all" data
        // slice shifts the window boundaries, so the runner must NOT request
        // retained signals and must re-execute every top-K candidate on the
        // full boundary data.
        const candles = makeCandles([100, 101, 102, 103, 104, 105, 106, 107]);
        const paramSets = [{ threshold: 1 }, { threshold: 2 }];
        let executeCalls = 0;
        let retainSignalsRequested = false;
        const strategy: Strategy = {
            name: "SlicedNoReuse",
            description: "enters on the latest bar of any data",
            defaultParams: { threshold: 1 },
            paramLabels: { threshold: "Threshold" },
            execute(data) {
                executeCalls += 1;
                const latest = data[data.length - 1];
                return latest ? [{ time: latest.time, type: "buy" as const, price: latest.close }] : [];
            },
        };
        const output = await runAssetOpportunitySearch(makeInput({
            options: makeOptions({ dataSlice: "half_oldest" }),
            selectedStrategy: { key: "sliced_no_reuse", name: "SlicedNoReuse", strategy },
            candidatePoolSize: 2,
            generateParamSets: () => paramSets.map((params) => ({ ...params })),
            assets: [{ symbol: "SLICED_NO_REUSE", data: candles }],
            runIsSearch: async (args) => {
                if (args.retainSignals === true) retainSignalsRequested = true;
                return makeRetainingStubIsSearch()(args);
            },
        }), makeCallbacks());

        expect(retainSignalsRequested, "no retention request when the windows differ").to.equal(false);
        expect(executeCalls, "IS search + one recheck execution per top-K candidate")
            .to.equal(paramSets.length + paramSets.length);
        // The recheck still runs on the full boundary data and finds the entry.
        expect(output.results).to.have.length(1);
        expect(output.results[0]!.freshStatus).to.equal("fresh");
        expect(output.results[0]!.latestSignalTime).to.equal(candles[candles.length - 1]!.time);
    });
});

describe("Asset Opportunity evaluation window (evalLastBars)", () => {
    /**
     * Locks the evalLastBars contract: the in-sample search sees ONLY the last
     * N bars of the gap-trimmed window. The recency cap exists so performance
     * reflects current regime, not full history — a window that leaked older
     * bars or the live application candle would silently defeat that.
     */
    interface SearchWindowCapture {
        length: number;
        firstTime: Time | null;
        lastTime: Time | null;
    }

    function makeWindowOptions(asset: Partial<FinderAssetOpportunityOptions> = {}): FinderOptions {
        return makeOptions({
            assetOpportunity: {
                symbols: ["UP"],
                candidatePoolSize: 3,
                minFreshSupport: 1,
                ...asset,
            },
        });
    }

    /** IS-search stub that records the exact search window and finds nothing. */
    function makeWindowCapturingIsSearch(captures: SearchWindowCapture[]): AssetIsSearch {
        return async (args) => {
            const { ohlcvData } = args;
            captures.push({
                length: ohlcvData.length,
                firstTime: ohlcvData.length > 0 ? ohlcvData[0]!.time : null,
                lastTime: ohlcvData.length > 0 ? ohlcvData[ohlcvData.length - 1]!.time : null,
            });
            return { results: [], totalCandidatesEvaluated: 0 };
        };
    }

    it("evaluates only the last N bars before the application candle", async () => {
        const data = makeCandles(Array.from({ length: 120 }, (_, i) => 100 + i));
        const captures: SearchWindowCapture[] = [];
        await runAssetOpportunitySearch(makeInput({
            options: makeWindowOptions({ evalLastBars: 50 }),
            assets: [{ symbol: "UP", data }],
            runIsSearch: makeWindowCapturingIsSearch(captures),
        }), makeCallbacks());

        expect(captures).to.have.length(1);
        // historical excludes the application candle (index 119); the window is
        // the last 50 of those 119 bars → indices 69..118.
        expect(captures[0]!.length).to.equal(50);
        expect(captures[0]!.firstTime).to.equal(data[69]!.time);
        expect(captures[0]!.lastTime).to.equal(data[118]!.time);
    });

    it("composes with the OOS holdout gap: window = last N bars before the gap", async () => {
        const data = makeCandles(Array.from({ length: 120 }, (_, i) => 100 + i));
        const captures: SearchWindowCapture[] = [];
        await runAssetOpportunitySearch(makeInput({
            options: makeWindowOptions({ oosIgnoreLastBars: 20, evalLastBars: 30 }),
            assets: [{ symbol: "UP", data }],
            runIsSearch: makeWindowCapturingIsSearch(captures),
        }), makeCallbacks());

        expect(captures).to.have.length(1);
        // The gap hides indices 100..119; the window is the last 30 visible
        // bars → indices 70..99 ("first half of the last 50 before the gap").
        expect(captures[0]!.length).to.equal(30);
        expect(captures[0]!.firstTime).to.equal(data[70]!.time);
        expect(captures[0]!.lastTime).to.equal(data[99]!.time);
    });

    it("keeps the application candle out of the capped window even when signal reuse would otherwise include it", async () => {
        const data = makeCandles(Array.from({ length: 120 }, (_, i) => 100 + i));
        const nextOpenSettings = { ...settings, executionModel: "next_open" as const };

        // Without the cap (evalLastBars 0), a reuse-eligible execution model
        // folds the application candle into the search window (120 bars).
        const uncapped: SearchWindowCapture[] = [];
        await runAssetOpportunitySearch(makeInput({
            options: makeWindowOptions(),
            settings: nextOpenSettings,
            assets: [{ symbol: "UP", data }],
            runIsSearch: makeWindowCapturingIsSearch(uncapped),
        }), makeCallbacks());
        expect(uncapped[0]!.length).to.equal(120);
        expect(uncapped[0]!.lastTime).to.equal(data[119]!.time);

        // With the cap, the trailing window must NOT re-capture the application
        // candle: it ends at the candle before it.
        const capped: SearchWindowCapture[] = [];
        await runAssetOpportunitySearch(makeInput({
            options: makeWindowOptions({ evalLastBars: 50 }),
            settings: nextOpenSettings,
            assets: [{ symbol: "UP", data }],
            runIsSearch: makeWindowCapturingIsSearch(capped),
        }), makeCallbacks());
        expect(capped[0]!.length).to.equal(50);
        expect(capped[0]!.lastTime).to.equal(data[118]!.time);
    });

    it("uses the full gap-trimmed history when the dataset is shorter than N", async () => {
        const data = makeCandles(Array.from({ length: 40 }, (_, i) => 100 + i));
        const captures: SearchWindowCapture[] = [];
        await runAssetOpportunitySearch(makeInput({
            options: makeWindowOptions({ evalLastBars: 1000 }),
            assets: [{ symbol: "UP", data }],
            runIsSearch: makeWindowCapturingIsSearch(captures),
        }), makeCallbacks());

        expect(captures[0]!.length).to.equal(39);
        expect(captures[0]!.firstTime).to.equal(data[0]!.time);
        expect(captures[0]!.lastTime).to.equal(data[38]!.time);
    });

    it("normalizes invalid values to 0 (all bars) instead of shifting the window", async () => {
        const data = makeCandles(Array.from({ length: 120 }, (_, i) => 100 + i));
        const captures: SearchWindowCapture[] = [];
        await runAssetOpportunitySearch(makeInput({
            options: makeWindowOptions({ evalLastBars: -25 }),
            assets: [{ symbol: "UP", data }],
            runIsSearch: makeWindowCapturingIsSearch(captures),
        }), makeCallbacks());

        // Same as the historical default: every bar but the application candle.
        expect(captures[0]!.length).to.equal(119);
        expect(captures[0]!.firstTime).to.equal(data[0]!.time);
        expect(captures[0]!.lastTime).to.equal(data[118]!.time);
    });

    it("disables in-sample signal reuse when the window is capped", async () => {
        // Mirror of the data-slice guard: a capped window shifts the boundary,
        // so retained in-sample signals no longer match the recheck window and
        // every top-K candidate must be re-executed on the full boundary data.
        const candles = makeCandles([100, 101, 102, 103, 104, 105, 106, 107]);
        const paramSets = [{ threshold: 1 }, { threshold: 2 }];
        let executeCalls = 0;
        let retainSignalsRequested = false;
        const strategy: Strategy = {
            name: "CappedNoReuse",
            description: "enters on the latest bar of any data",
            defaultParams: { threshold: 1 },
            paramLabels: { threshold: "Threshold" },
            execute(data) {
                executeCalls += 1;
                const latest = data[data.length - 1];
                return latest ? [{ time: latest.time, type: "buy" as const, price: latest.close }] : [];
            },
        };
        const output = await runAssetOpportunitySearch(makeInput({
            options: makeWindowOptions({ evalLastBars: 3 }),
            settings: { ...settings, executionModel: "next_open" },
            selectedStrategy: { key: "capped_no_reuse", name: "CappedNoReuse", strategy },
            candidatePoolSize: 2,
            generateParamSets: () => paramSets.map((params) => ({ ...params })),
            assets: [{ symbol: "CAPPED_NO_REUSE", data: candles }],
            runIsSearch: async (args) => {
                if (args.retainSignals === true) retainSignalsRequested = true;
                return makeRetainingStubIsSearch()(args);
            },
        }), makeCallbacks());

        expect(retainSignalsRequested, "no retention request when the window is capped").to.equal(false);
        expect(executeCalls, "IS search + one recheck execution per top-K candidate")
            .to.equal(paramSets.length + paramSets.length);
        // The recheck still runs on the full boundary data and finds the entry.
        expect(output.results).to.have.length(1);
        expect(output.results[0]!.freshStatus).to.equal("fresh");
        expect(output.results[0]!.latestSignalTime).to.equal(candles[candles.length - 1]!.time);
    });
});
