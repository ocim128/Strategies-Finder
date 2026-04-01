import {
    BacktestResult,
    BacktestSettings,
    OHLCVData,
    Strategy,
    StrategyParams,
    precomputeIndicators,
    runBacktestCompact,
    runFixedParamWalkForward,
    applySignalPolarity,
} from "../strategies/index";
import { debugLogger, robustAuditSink } from "../debug-logger";
import { trimToClosedCandles } from "../closed-candle-utils";
import {
    computeFinderCompositeEdgeRatio,
    finderSortRequiresCompositeEdgeRatio,
    resolveFinderRiskOverrides,
} from "./finder-runner-core";
import {
    buildFinderResult,
    deriveStrategySeed,
    normalizeResultSharpe,
    normalizeSeed,
    runStrategyBacktest,
    type StrategyPlan,
} from "./finder-runner-shared";
import type { FinderDataset } from "./finder-timeframe-loader";
import type { CapitalSettings } from "../types/backtest";
import type { FinderResult } from "../types/finder";
import type { FinderRunCallbacks, FinderRunInput, FinderRunOutput } from "./finder-runner";

type RobustRandomRunParams = {
    input: FinderRunInput;
    callbacks: FinderRunCallbacks;
    strategyPlans: StrategyPlan[];
    runTimeframes: string[];
};

type RobustCellCandidate = {
    params: StrategyParams;
    stageAScore: number;
};

type RobustWfCandidate = {
    params: StrategyParams;
    stageAWfScore: number;
    wfResult: Awaited<ReturnType<typeof runFixedParamWalkForward>>;
    medianOOSExpectancy: number;
    medianOOSExpectancyEdge: number;
    medianProfitableFoldRatio: number;
    foldStabilityPenalty: number;
    ddBreachRate: number;
};

type RobustWfMetrics = Pick<RobustWfCandidate, "medianOOSExpectancy" | "medianOOSExpectancyEdge" | "medianProfitableFoldRatio" | "foldStabilityPenalty" | "ddBreachRate">;

type RobustCellEvaluation = {
    result: FinderResult | null;
    diagnostics: {
        strategyKey: string;
        strategyName: string;
        timeframe: string;
        seed: number;
        cellSeed: number;
        sampledParams: number;
        stageASurvivors: number;
        stageBSurvivors: number;
        stageCSurvivors: number;
        passRate: number;
        topDecileMedianOOSExpectancy: number;
        topDecileMedianProfitableFoldRatio: number;
        medianFoldStabilityPenalty: number;
        topDecileMedianDDBreachRate: number;
        robustScore: number;
        decision: "PASS" | "FAIL";
        decisionReason: string;
        rejectionReasons: Record<string, number>;
    };
};

const ROBUST_WF_DEFAULTS = {
    minCommissionPercent: 0.02,
    minSlippageBps: 1,
    minRunsPerCell: 40,
    maxRunsPerCell: 240,
    topDecileFraction: 0.10,
    stageA: {
        minTrades: 8,
        minExpectancy: 0,
        maxDrawdownPercent: 35,
    },
    stageB: {
        targetWindows: 3,
        minTotalTrades: 10,
        minMedianExpectancy: 0,
        minProfitableFoldRatio: 0.50,
        maxDDBreachRate: 0.34,
        maxCombinedDrawdownPercent: 35,
        maxFoldStabilityPenalty: 2.5,
        maxWindowDrawdownPercent: 30,
    },
    stageC: {
        targetWindows: 6,
        minTotalTrades: 20,
        minMedianExpectancy: 0,
        minProfitableFoldRatio: 0.60,
        maxDDBreachRate: 0.20,
        maxCombinedDrawdownPercent: 30,
        maxFoldStabilityPenalty: 1.8,
        maxWindowDrawdownPercent: 25,
    },
    cellGates: {
        minStageCSurvivors: 2,
        minPassRate: 0.01,
        maxTopDecileMedianDDBreachRate: 0.20,
        maxTopDecileMedianFoldStabilityPenalty: 1.8,
    },
    scoreWeights: {
        passRate: 0.60,
        foldRatio: 0.20,
        stability: 0.10,
        expectancyEdge: 0.10,
    },
} as const;

export async function runRobustRandomWalkForward(params: RobustRandomRunParams): Promise<FinderRunOutput> {
    const { input, callbacks, strategyPlans, runTimeframes } = params;
    const closedData = trimToClosedCandles(input.ohlcvData, input.interval);
    if (closedData.length === 0) {
        callbacks.setStatus("No closed candles available for robust finder run.");
        return { results: [] };
    }
    if (!Number.isFinite(input.options.robustSeed)) {
        callbacks.setStatus("robust_random_wf requires a finite seed.");
        debugLogger.warn("[Finder][robust_random_wf] Missing/invalid seed.");
        return { results: [] };
    }
    const runSeed = normalizeSeed(Number(input.options.robustSeed));

    robustAuditSink.startRun(`robust-${input.symbol}-${input.interval}-${runSeed}-${Date.now()}`);

    const robustSettings: BacktestSettings = {
        ...input.settings,
        executionModel: "next_open",
        allowSameBarExit: false,
        slippageBps: Math.max(ROBUST_WF_DEFAULTS.minSlippageBps, input.settings.slippageBps ?? 0),
    };
    const robustCommission = Math.max(ROBUST_WF_DEFAULTS.minCommissionPercent, input.capitalSettings.commission);
    debugLogger.info("[Finder][robust_random_wf] Hard gates enforced", {
        seed: runSeed,
        executionModel: robustSettings.executionModel,
        allowSameBarExit: robustSettings.allowSameBarExit,
        slippageBps: robustSettings.slippageBps,
        commissionPercent: robustCommission,
    });
    debugLogger.info("[Finder][robust_random_wf] robustScore = passRate*0.60 + profitableFoldRatio*0.20 + stabilityScore*0.10 + expectancyEdgeScore*0.10");

    let datasets: FinderDataset[] = [];
    if (input.options.multiTimeframeEnabled) {
        callbacks.setProgress(6, `Loading ${runTimeframes.length} timeframe datasets...`);
        datasets = await input.loadMultiTimeframeDatasets(input.symbol, runTimeframes);
    } else {
        datasets = [{ interval: input.interval, data: closedData }];
    }

    const activeDatasets = datasets
        .map((dataset) => ({ ...dataset, data: trimToClosedCandles(dataset.data, dataset.interval) }))
        .filter((dataset) => dataset.data.length > 0);

    if (activeDatasets.length === 0) {
        callbacks.setStatus("No data available for robust finder run.");
        return { results: [] };
    }

    const totalCells = strategyPlans.length * activeDatasets.length;
    let cellIndex = 0;
    const results: FinderResult[] = [];
    const diagnostics: RobustCellEvaluation["diagnostics"][] = [];
    callbacks.setProgress(10, `Running robust scan on ${totalCells} cells...`);

    for (const plan of strategyPlans) {
        for (const dataset of activeDatasets) {
            cellIndex += 1;
            const cellLabel = `${plan.key} @ ${dataset.interval}`;
            callbacks.setStatus(`robust_random_wf: evaluating ${cellLabel} (${cellIndex}/${totalCells})`);

            const sampleBudget = Math.min(
                ROBUST_WF_DEFAULTS.maxRunsPerCell,
                Math.max(ROBUST_WF_DEFAULTS.minRunsPerCell, input.options.maxRuns)
            );
            const cellParamSets = plan.paramSets.slice(0, sampleBudget);

            const evaluation = await evaluateRobustCell({
                strategyPlan: plan,
                dataset,
                input,
                runSeed,
                paramSets: cellParamSets,
                robustSettings,
                robustCommission,
                callbacks,
            });
            diagnostics.push(evaluation.diagnostics);
            if (evaluation.result) {
                results.push(evaluation.result);
            }

            const progress = 10 + (cellIndex / Math.max(1, totalCells)) * 88;
            callbacks.setProgress(progress, `Cells ${cellIndex}/${totalCells}`);
            await callbacks.yieldControl();
        }
    }

    emitRobustClusterReport(diagnostics);

    const sorted = results
        .sort((a, b) => (b.robustMetrics?.robustScore ?? 0) - (a.robustMetrics?.robustScore ?? 0))
        .slice(0, Math.max(1, input.options.topN));

    const passedCells = diagnostics.filter((cell) => cell.decision === "PASS").length;
    callbacks.setProgress(100, "robust_random_wf complete");
    callbacks.setStatus(`Complete. ${passedCells}/${diagnostics.length} cells passed, ${sorted.length} shown.`);
    return { results: sorted };
}

async function evaluateRobustCell(args: {
    strategyPlan: StrategyPlan;
    dataset: FinderDataset;
    input: FinderRunInput;
    runSeed: number;
    paramSets: StrategyParams[];
    robustSettings: BacktestSettings;
    robustCommission: number;
    callbacks: FinderRunCallbacks;
}): Promise<RobustCellEvaluation> {
    const { strategyPlan, dataset, input, runSeed, paramSets, robustSettings, robustCommission, callbacks } = args;
    const robustCapitalSettings: CapitalSettings = {
        ...input.capitalSettings,
        commission: robustCommission,
    };
    const cellSeed = deriveCellSeed(runSeed, strategyPlan.key, dataset.interval);
    const holdoutData = selectRobustHoldoutData(dataset.data);
    const holdoutPrecomputed = holdoutData.length > 0
        ? precomputeIndicators(holdoutData, robustSettings)
        : undefined;
    const holdoutPreparedFinderData = holdoutData.length > 0
        ? strategyPlan.strategy.prepareFinderData?.(holdoutData, robustSettings)
        : undefined;
    const stageRejectionReasons: Record<"A" | "B" | "C", Record<string, number>> = { A: {}, B: {}, C: {} };
    const stageRejectSamples: Record<"A" | "B" | "C", Map<string, StrategyParams[]>> = {
        A: new Map(),
        B: new Map(),
        C: new Map(),
    };

    const recordReject = (reason: string, stage: "A" | "B" | "C", params: StrategyParams) => {
        stageRejectionReasons[stage][reason] = (stageRejectionReasons[stage][reason] ?? 0) + 1;
        const samples = stageRejectSamples[stage].get(reason);
        if (!samples) {
            stageRejectSamples[stage].set(reason, [{ ...params }]);
        } else if (samples.length < 3) {
            samples.push({ ...params });
        }
    };

    const flushRejectLogs = (stage: "A" | "B" | "C") => {
        const samples = stageRejectSamples[stage];
        const reasons = stageRejectionReasons[stage];
        if (samples.size === 0) return;
        for (const [reason, sampleParams] of samples) {
            debugLogger.info(`[Finder][robust_random_wf][reject][${stage}] ${strategyPlan.key}@${dataset.interval}: ${reason} (count: ${reasons[reason] ?? 0})`, {
                sampleParams: sampleParams.map(summarizeParams),
            });
        }
        samples.clear();
    };

    const mergeRejectionReasons = (): Record<string, number> => {
        const merged: Record<string, number> = {};
        for (const stage of ["A", "B", "C"] as const) {
            for (const [reason, count] of Object.entries(stageRejectionReasons[stage])) {
                merged[reason] = (merged[reason] ?? 0) + count;
            }
        }
        return merged;
    };

    const stageACandidates: RobustCellCandidate[] = [];
    for (let i = 0; i < paramSets.length; i++) {
        const params = paramSets[i];
        const backtestSettings = resolveFinderRiskOverrides(robustSettings, robustSettings, params, input.options).backtestSettings;
        try {
            const holdoutResult = runRobustHoldoutEvaluation(
                holdoutData,
                strategyPlan.strategy,
                holdoutPreparedFinderData,
                params,
                robustCapitalSettings,
                backtestSettings,
                holdoutPrecomputed
            );
            const stageAReason = getStageARejectReason(holdoutResult);
            if (stageAReason) {
                recordReject(stageAReason, "A", params);
            } else {
                stageACandidates.push({
                    params,
                    stageAScore: scoreStageAHoldout(holdoutResult),
                });
            }
        } catch (_error) {
            recordReject("stage_a_error", "A", params);
        }

        if ((i + 1) % 12 === 0) {
            await callbacks.yieldControl();
        }
    }

    flushRejectLogs("A");
    const stageASurvivors = stageACandidates;

    const stageBCandidates: RobustWfCandidate[] = [];
    for (let i = 0; i < stageASurvivors.length; i++) {
        const candidate = stageASurvivors[i];
        const backtestSettings = resolveFinderRiskOverrides(robustSettings, robustSettings, candidate.params, input.options).backtestSettings;
        try {
            const wfResult = await runRobustFixedParamWalkForward(
                dataset.data,
                strategyPlan.strategy,
                candidate.params,
                ROBUST_WF_DEFAULTS.stageB.targetWindows,
                robustCapitalSettings,
                backtestSettings
            );
            const metrics = buildRobustWfCandidateMetrics(wfResult, ROBUST_WF_DEFAULTS.stageB.maxWindowDrawdownPercent);
            const stageBReason = getStageBRejectReason(metrics, wfResult);
            if (stageBReason) {
                recordReject(stageBReason, "B", candidate.params);
            } else {
                stageBCandidates.push({
                    params: candidate.params,
                    stageAWfScore: candidate.stageAScore,
                    wfResult,
                    ...metrics,
                });
            }
        } catch (_error) {
            recordReject("stage_b_error", "B", candidate.params);
        }

        if ((i + 1) % 4 === 0) {
            await callbacks.yieldControl();
        }
    }

    flushRejectLogs("B");
    const stageBSurvivors = stageBCandidates;

    const stageCCandidates: RobustWfCandidate[] = [];
    for (let i = 0; i < stageBSurvivors.length; i++) {
        const candidate = stageBSurvivors[i];
        const backtestSettings = resolveFinderRiskOverrides(robustSettings, robustSettings, candidate.params, input.options).backtestSettings;
        try {
            const wfResult = await runRobustFixedParamWalkForward(
                dataset.data,
                strategyPlan.strategy,
                candidate.params,
                ROBUST_WF_DEFAULTS.stageC.targetWindows,
                robustCapitalSettings,
                backtestSettings
            );
            const metrics = buildRobustWfCandidateMetrics(wfResult, ROBUST_WF_DEFAULTS.stageC.maxWindowDrawdownPercent);
            const stageCReason = getStageCRejectReason(metrics, wfResult);
            if (stageCReason) {
                recordReject(stageCReason, "C", candidate.params);
            } else {
                stageCCandidates.push({
                    params: candidate.params,
                    stageAWfScore: candidate.stageAWfScore,
                    wfResult,
                    ...metrics,
                });
            }
        } catch (_error) {
            recordReject("stage_c_error", "C", candidate.params);
        }

        if ((i + 1) % 3 === 0) {
            await callbacks.yieldControl();
        }
    }

    flushRejectLogs("C");
    stageCCandidates.sort((a, b) => compareRobustCandidates(b, a));
    const passRate = paramSets.length > 0 ? stageCCandidates.length / paramSets.length : 0;
    const topDecileCount = Math.max(1, Math.ceil(Math.max(1, stageCCandidates.length) * ROBUST_WF_DEFAULTS.topDecileFraction));
    const topDecile = stageCCandidates.slice(0, topDecileCount);
    const topDecileMedianOOSExpectancy = median(topDecile.map((candidate) => candidate.medianOOSExpectancy));
    const topDecileMedianProfitableFoldRatio = median(topDecile.map((candidate) => candidate.medianProfitableFoldRatio));
    const medianFoldStabilityPenalty = median(topDecile.map((candidate) => candidate.foldStabilityPenalty));
    const topDecileMedianExpectancyEdge = median(topDecile.map((candidate) => candidate.medianOOSExpectancyEdge));
    const topDecileMedianDDBreachRate = median(topDecile.map((candidate) => candidate.ddBreachRate));
    const robustScore = computeRobustScore(
        passRate,
        topDecileMedianProfitableFoldRatio,
        medianFoldStabilityPenalty,
        topDecileMedianExpectancyEdge
    );

    let decision: "PASS" | "FAIL" = "PASS";
    let decisionReason = "cell_pass";
    if (stageCCandidates.length < ROBUST_WF_DEFAULTS.cellGates.minStageCSurvivors) {
        decision = "FAIL";
        decisionReason = "cell_low_stage_c_survivors";
    } else if (passRate < ROBUST_WF_DEFAULTS.cellGates.minPassRate) {
        decision = "FAIL";
        decisionReason = "cell_low_pass_rate";
    } else if (topDecileMedianDDBreachRate > ROBUST_WF_DEFAULTS.cellGates.maxTopDecileMedianDDBreachRate) {
        decision = "FAIL";
        decisionReason = "cell_high_dd_breach_rate";
    } else if (medianFoldStabilityPenalty > ROBUST_WF_DEFAULTS.cellGates.maxTopDecileMedianFoldStabilityPenalty) {
        decision = "FAIL";
        decisionReason = "cell_high_fold_variance";
    }

    const rejectionReasons = mergeRejectionReasons();
    const auditPayload = {
        mode: "robust_random_wf" as const,
        strategyKey: strategyPlan.key,
        strategyName: strategyPlan.name,
        symbol: input.symbol,
        tradeFilterMode: robustSettings.tradeFilterMode ?? "none",
        tradeDirection: robustSettings.tradeDirection ?? "short",
        timeframe: dataset.interval,
        seed: runSeed,
        cellSeed,
        sampledParams: paramSets.length,
        stageASurvivors: stageASurvivors.length,
        stageBSurvivors: stageBSurvivors.length,
        stageCSurvivors: stageCCandidates.length,
        passRate,
        topDecileMedianOOSExpectancy,
        topDecileMedianProfitableFoldRatio,
        medianFoldStabilityPenalty,
        topDecileMedianDDBreachRate,
        robustScore,
        decision,
        decisionReason,
        rejectionReasons,
    };
    debugLogger.event("[Finder][robust_random_wf][cell_audit]", auditPayload);
    robustAuditSink.log("[Finder][robust_random_wf][cell_audit]", auditPayload);

    const diagnostics: RobustCellEvaluation["diagnostics"] = {
        strategyKey: strategyPlan.key,
        strategyName: strategyPlan.name,
        timeframe: dataset.interval,
        seed: runSeed,
        cellSeed,
        sampledParams: paramSets.length,
        stageASurvivors: stageASurvivors.length,
        stageBSurvivors: stageBSurvivors.length,
        stageCSurvivors: stageCCandidates.length,
        passRate,
        topDecileMedianOOSExpectancy,
        topDecileMedianProfitableFoldRatio,
        medianFoldStabilityPenalty,
        topDecileMedianDDBreachRate,
        robustScore,
        decision,
        decisionReason,
        rejectionReasons,
    };

    if (decision !== "PASS" || stageCCandidates.length === 0) {
        return { result: null, diagnostics };
    }

    const best = stageCCandidates[0];
    const robustResult = normalizeResultSharpe(best.wfResult.combinedOOSTrades, input.capitalSettings.initialCapital);
    const result: FinderResult = buildFinderResult({
        key: strategyPlan.key,
        name: `${strategyPlan.name} (${dataset.interval})`,
        comboMode: Boolean(input.comboPrimarySignals),
        comboPrimaryConfigName: input.options.comboPrimaryConfigName,
        timeframes: [dataset.interval],
        params: best.params,
        result: robustResult,
        selectionResult: robustResult,
        compositeEdgeRatio: finderSortRequiresCompositeEdgeRatio(input.options.sortPriority)
            ? computeFinderCompositeEdgeRatio(robustResult, dataset.data)
            : undefined,
        endpointAdjusted: false,
        endpointRemovedTrades: 0,
        robustMetrics: {
            mode: "robust_random_wf",
            seed: runSeed,
            cellSeed,
            symbol: input.symbol,
            tradeFilterMode: robustSettings.tradeFilterMode ?? "none",
            tradeDirection: robustSettings.tradeDirection ?? "short",
            decision,
            decisionReason,
            timeframe: dataset.interval,
            sampledParams: paramSets.length,
            stageASurvivors: stageASurvivors.length,
            stageBSurvivors: stageBSurvivors.length,
            stageCSurvivors: stageCCandidates.length,
            passRate,
            topDecileMedianOOSExpectancy,
            topDecileMedianProfitableFoldRatio,
            medianFoldStabilityPenalty,
            topDecileMedianDDBreachRate,
            robustScore,
            rejectionReasons,
        },
    });

    return { result, diagnostics };
}

function selectRobustHoldoutData(data: OHLCVData[]): OHLCVData[] {
    const holdoutBars = Math.max(40, Math.floor(data.length * 0.30));
    return data.slice(Math.max(0, data.length - holdoutBars));
}

function runRobustHoldoutEvaluation(
    holdoutData: OHLCVData[],
    strategy: Strategy,
    preparedFinderData: unknown,
    params: StrategyParams,
    capitalSettings: CapitalSettings,
    settings: BacktestSettings,
    precomputed?: ReturnType<typeof precomputeIndicators>
): BacktestResult {
    if (holdoutData.length === 0) {
        return createEmptyBacktestResult();
    }
    const { initialCapital } = capitalSettings;
    const rawSignals = strategy.executePrepared
        ? strategy.executePrepared(preparedFinderData, params, holdoutData)
        : strategy.execute(holdoutData, params);
    const signals = applySignalPolarity(rawSignals, settings);
    const result = runStrategyBacktest({
        strategy,
        data: holdoutData,
        signals,
        params,
        capitalSettings,
        backtestSettings: settings,
        backtestFn: runBacktestCompact,
        precomputed,
    });
    return normalizeResultSharpe(result, initialCapital);
}

async function runRobustFixedParamWalkForward(
    data: OHLCVData[],
    strategy: Strategy,
    params: StrategyParams,
    targetWindows: number,
    capitalSettings: CapitalSettings,
    settings: BacktestSettings
): Promise<Awaited<ReturnType<typeof runFixedParamWalkForward>>> {
    const { initialCapital, positionSize, commission, sizingMode, fixedTradeAmount, advancedSizing } = capitalSettings;
    const testWindow = Math.max(20, Math.floor(data.length / Math.max(2, targetWindows)));
    const stepSize = testWindow;
    return runFixedParamWalkForward(
        data,
        strategy,
        {
            testWindow,
            stepSize,
            fixedParams: params,
            minTrades: 1,
        },
        initialCapital,
        positionSize,
        commission,
        settings,
        { mode: sizingMode, fixedTradeAmount, advancedSizing }
    );
}

function buildRobustWfCandidateMetrics(
    wfResult: Awaited<ReturnType<typeof runFixedParamWalkForward>>,
    maxWindowDrawdownPercent: number
): RobustWfMetrics {
    const oosWindows = wfResult.windows.map((window) => window.outOfSampleResult);
    const expectancies = oosWindows.map((window) => window.expectancy);
    const profitableFoldRatio = oosWindows.length > 0
        ? oosWindows.filter((window) => window.expectancy > 0 && window.netProfit > 0).length / oosWindows.length
        : 0;
    const ddBreachRate = oosWindows.length > 0
        ? oosWindows.filter((window) => window.maxDrawdownPercent > maxWindowDrawdownPercent).length / oosWindows.length
        : 1;
    const medianOOSExpectancy = median(expectancies);
    const foldStabilityPenalty = stdDev(expectancies) / (Math.abs(medianOOSExpectancy) + 1);
    const denom = Math.max(1, Math.abs(wfResult.combinedOOSTrades.avgLoss || wfResult.combinedOOSTrades.avgTrade || 0));
    const expectancyEdge = wfResult.combinedOOSTrades.expectancy / denom;
    return {
        medianOOSExpectancy,
        medianOOSExpectancyEdge: expectancyEdge,
        medianProfitableFoldRatio: profitableFoldRatio,
        foldStabilityPenalty,
        ddBreachRate,
    };
}

function getStageARejectReason(result: BacktestResult): string | null {
    if (result.totalTrades < ROBUST_WF_DEFAULTS.stageA.minTrades) return "stage_a_low_trades";
    if (result.expectancy <= ROBUST_WF_DEFAULTS.stageA.minExpectancy) return "stage_a_non_positive_expectancy";
    if (result.maxDrawdownPercent > ROBUST_WF_DEFAULTS.stageA.maxDrawdownPercent) return "stage_a_high_drawdown";
    return null;
}

function getStageBRejectReason(
    candidate: RobustWfMetrics,
    wfResult: Awaited<ReturnType<typeof runFixedParamWalkForward>>
): string | null {
    const totalTrades = wfResult.combinedOOSTrades.totalTrades;
    const maxDrawdownPercent = wfResult.combinedOOSTrades.maxDrawdownPercent;
    if (totalTrades < ROBUST_WF_DEFAULTS.stageB.minTotalTrades) return "stage_b_low_oos_trades";
    if (candidate.medianOOSExpectancy <= ROBUST_WF_DEFAULTS.stageB.minMedianExpectancy) return "stage_b_non_positive_expectancy";
    if (candidate.medianProfitableFoldRatio < ROBUST_WF_DEFAULTS.stageB.minProfitableFoldRatio) return "stage_b_low_profitable_fold_ratio";
    if (candidate.ddBreachRate > ROBUST_WF_DEFAULTS.stageB.maxDDBreachRate) return "stage_b_high_window_dd_breach_rate";
    if (maxDrawdownPercent > ROBUST_WF_DEFAULTS.stageB.maxCombinedDrawdownPercent) return "stage_b_high_combined_drawdown";
    if (candidate.foldStabilityPenalty > ROBUST_WF_DEFAULTS.stageB.maxFoldStabilityPenalty) return "stage_b_unstable_fold_expectancy";
    return null;
}

function getStageCRejectReason(
    candidate: RobustWfMetrics,
    wfResult: Awaited<ReturnType<typeof runFixedParamWalkForward>>
): string | null {
    const totalTrades = wfResult.combinedOOSTrades.totalTrades;
    const maxDrawdownPercent = wfResult.combinedOOSTrades.maxDrawdownPercent;
    if (totalTrades < ROBUST_WF_DEFAULTS.stageC.minTotalTrades) return "stage_c_low_oos_trades";
    if (candidate.medianOOSExpectancy <= ROBUST_WF_DEFAULTS.stageC.minMedianExpectancy) return "stage_c_non_positive_expectancy";
    if (candidate.medianProfitableFoldRatio < ROBUST_WF_DEFAULTS.stageC.minProfitableFoldRatio) return "stage_c_low_profitable_fold_ratio";
    if (candidate.ddBreachRate > ROBUST_WF_DEFAULTS.stageC.maxDDBreachRate) return "stage_c_high_window_dd_breach_rate";
    if (maxDrawdownPercent > ROBUST_WF_DEFAULTS.stageC.maxCombinedDrawdownPercent) return "stage_c_high_combined_drawdown";
    if (candidate.foldStabilityPenalty > ROBUST_WF_DEFAULTS.stageC.maxFoldStabilityPenalty) return "stage_c_unstable_fold_expectancy";
    return null;
}

function scoreStageAHoldout(result: BacktestResult): number {
    return result.expectancy + Math.min(4, result.profitFactor) - (result.maxDrawdownPercent * 0.05);
}

function compareRobustCandidates(a: RobustWfCandidate, b: RobustWfCandidate): number {
    if (Math.abs(a.medianOOSExpectancy - b.medianOOSExpectancy) > 1e-9) {
        return a.medianOOSExpectancy - b.medianOOSExpectancy;
    }
    if (Math.abs(a.medianProfitableFoldRatio - b.medianProfitableFoldRatio) > 1e-9) {
        return a.medianProfitableFoldRatio - b.medianProfitableFoldRatio;
    }
    if (Math.abs(a.foldStabilityPenalty - b.foldStabilityPenalty) > 1e-9) {
        return b.foldStabilityPenalty - a.foldStabilityPenalty;
    }
    return a.stageAWfScore - b.stageAWfScore;
}

function computeRobustScore(
    passRate: number,
    profitableFoldRatio: number,
    foldStabilityPenalty: number,
    expectancyEdge: number
): number {
    const passRatePct = clamp01(passRate) * 100;
    const foldRatioPct = clamp01(profitableFoldRatio) * 100;
    const stabilityScore = Math.max(0, 100 - Math.min(100, foldStabilityPenalty * 100));
    const expectancyEdgeScore = Math.max(0, Math.min(100, expectancyEdge * 100));
    const score = (
        passRatePct * ROBUST_WF_DEFAULTS.scoreWeights.passRate +
        foldRatioPct * ROBUST_WF_DEFAULTS.scoreWeights.foldRatio +
        stabilityScore * ROBUST_WF_DEFAULTS.scoreWeights.stability +
        expectancyEdgeScore * ROBUST_WF_DEFAULTS.scoreWeights.expectancyEdge
    );
    return Math.max(0, Math.min(100, score));
}

function emitRobustClusterReport(cells: RobustCellEvaluation["diagnostics"][]): void {
    const grouped = new Map<string, { total: number; passed: number; passRates: number[] }>();
    for (const cell of cells) {
        const bucket = grouped.get(cell.strategyKey) ?? { total: 0, passed: 0, passRates: [] };
        bucket.total += 1;
        if (cell.decision === "PASS") bucket.passed += 1;
        bucket.passRates.push(cell.passRate);
        grouped.set(cell.strategyKey, bucket);
    }
    grouped.forEach((bucket, strategyKey) => {
        debugLogger.info(`[Finder][robust_random_wf][cluster] ${strategyKey}: ${bucket.passed}/${bucket.total} cells passed`, {
            medianCellPassRate: median(bucket.passRates),
        });
    });
}

function summarizeParams(params: StrategyParams): string {
    return Object.entries(params)
        .slice(0, 10)
        .map(([key, value]) => `${key}=${Number.isInteger(value) ? value : value.toFixed(4)}`)
        .join(", ");
}

function deriveCellSeed(seed: number, strategyKey: string, timeframe: string): number {
    return deriveStrategySeed(seed, `${strategyKey}|${timeframe}`);
}

function clamp01(value: number): number {
    return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function median(values: number[]): number {
    const cleaned = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
    if (cleaned.length === 0) return 0;
    const mid = Math.floor(cleaned.length / 2);
    return cleaned.length % 2 === 0 ? (cleaned[mid - 1] + cleaned[mid]) / 2 : cleaned[mid];
}

function stdDev(values: number[]): number {
    const cleaned = values.filter((value) => Number.isFinite(value));
    if (cleaned.length <= 1) return 0;
    const avg = cleaned.reduce((sum, value) => sum + value, 0) / cleaned.length;
    const variance = cleaned.reduce((sum, value) => sum + Math.pow(value - avg, 2), 0) / cleaned.length;
    return Math.sqrt(Math.max(0, variance));
}

function createEmptyBacktestResult(): BacktestResult {
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
