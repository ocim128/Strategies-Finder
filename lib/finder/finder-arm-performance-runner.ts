import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type {
    FinderArmPerformanceCandidate,
    FinderOptions,
} from "../types/finder";
import type { BacktestSettings, StrategyParams } from "../types/strategies";
import { resolveBacktestSettingsFromRaw } from "../backtest-settings-resolver";
import { sanitizeBacktestSettingsForRust } from "../rust-settings-sanitizer";
import {
    buildFinderCandidatePlans,
    type FinderCandidatePlan,
    type FinderCandidateStrategy,
} from "./finder-candidate-plans";
import { FinderParamSpace } from "./finder-param-space";
import { resolveFinderRiskOverrides } from "./finder-runner-core";
import { splitExitStrategyParams } from "./exit-strategy-param-prefix";
import {
    buildFinderArmPerformanceMetricsFromArms,
    FINDER_ARM_PERFORMANCE_REPLAY_FIELDS,
} from "./finder-arm-performance-metrics";
import {
    getArtifactsRootDir,
    getRunDir,
    isValidRunId,
} from "../batch-backtest/sp500-top-mean-artifact-store";
import {
    TopMeanCoordinatorEngine,
    type TopMeanCoordinatorEngineDeps,
    type TopMeanCoordinatorRunRequest,
    type TopMeanResultSummary,
    type TopMeanStatusResponse,
} from "../batch-backtest/sp500-top-mean-coordinator-engine";
import type { TopMeanPairFailure } from "../batch-backtest/sp500-top-mean-worker-pool";
import type { EnumerationResult } from "../batch-backtest/sp500-pair-enumerator";
import type { CapitalSettings } from "../types/backtest";

export interface FinderArmPerformanceCandidatePlan extends FinderCandidatePlan {
    strategyKey: string;
    strategyName: string;
    candidateOrdinal: number;
}

export interface FinderArmPerformanceProgress {
    candidateId: string;
    candidateOrdinal: number;
    totalCandidates: number;
    strategyKey: string;
    strategyName: string;
    childPhase: string;
    percent: number;
    text: string;
}

export interface FinderArmPerformanceCoordinator {
    readonly request: TopMeanCoordinatorRunRequest;
    run(emit: (event: unknown) => void): Promise<void>;
    stop(): void;
    waitForTeardown(): Promise<void>;
    getStatus(): TopMeanStatusResponse;
    getFailedPairDetails?(): TopMeanPairFailure[];
}

export interface FinderArmPerformanceRunnerInput {
    runId: string;
    interval: string;
    options: FinderOptions;
    settings: BacktestSettings;
    capitalSettings: CapitalSettings;
    useRustEnginePreference: boolean;
    evaluationCutoffSec: number;
    sampleFromSec?: number;
    sampleToSec?: number;
    enumeration: EnumerationResult;
    selectedStrategies: readonly FinderCandidateStrategy[];
    exitStrategyCandidates: readonly FinderCandidateStrategy[];
    baseDir: string;
    signal: AbortSignal;
    isCancelled(): boolean;
    plans?: readonly FinderArmPerformanceCandidatePlan[];
}

export interface FinderArmPerformanceRunnerCallbacks {
    onProgress(progress: FinderArmPerformanceProgress): void;
    onCandidate(
        candidate: FinderArmPerformanceCandidate,
        diagnostics: { targetDataBoundary?: TopMeanResultSummary["targetDataBoundary"]; actualEngineMode: string },
    ): void;
    onPairFailures?(failures: readonly TopMeanPairFailure[]): void;
    setActiveCoordinator(coordinator: FinderArmPerformanceCoordinator | null, childRunId: string | null): void;
}

export interface FinderArmPerformanceRunnerDeps {
    createCoordinator?: (
        request: TopMeanCoordinatorRunRequest,
        baseDir: string,
        deps: TopMeanCoordinatorEngineDeps,
    ) => FinderArmPerformanceCoordinator;
    removeChildArtifacts?: (childRunId: string, baseDir: string) => Promise<void>;
    generatePlans?: typeof buildFinderCandidatePlans;
}

export class FinderArmPerformanceChildError extends Error {
    constructor(
        message: string,
        readonly candidateId: string,
        readonly childRunId: string,
        readonly status: TopMeanStatusResponse | null,
    ) {
        super(message);
        this.name = "FinderArmPerformanceChildError";
    }
}

function createChildRunId(parentRunId: string, ordinal: number): string {
    const parentFingerprint = Buffer.from(parentRunId).toString("base64url").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 10);
    const runId = `finder_arm_${parentFingerprint}_${ordinal.toString(36)}_${randomBytes(4).toString("hex")}`;
    if (!isValidRunId(runId)) throw new Error("Generated an invalid TOP_MEAN child run id.");
    return runId;
}

export function buildFinderArmPerformanceCandidatePlans(input: {
    selectedStrategies: readonly FinderCandidateStrategy[];
    exitStrategyCandidates: readonly FinderCandidateStrategy[];
    settings: BacktestSettings;
    options: FinderOptions;
    generateParamSets?: FinderArmPerformanceRunnerDeps["generatePlans"];
}): FinderArmPerformanceCandidatePlan[] {
    const generatePlans = input.generateParamSets ?? buildFinderCandidatePlans;
    const paramSpace = new FinderParamSpace();
    const plans: FinderArmPerformanceCandidatePlan[] = [];
    for (const selectedStrategy of input.selectedStrategies) {
        const strategyPlans = generatePlans({
            selectedStrategy,
            exitStrategyCandidates: input.options.exitStrategyOverrideEnabled
                ? input.exitStrategyCandidates
                : [],
            settings: input.settings,
            options: input.options,
            generateParamSets: (defaults, options) => paramSpace.generateParamSets(defaults, options),
        });
        for (const plan of strategyPlans) {
            plans.push({
                ...plan,
                strategyKey: selectedStrategy.key,
                strategyName: selectedStrategy.name,
                candidateOrdinal: plans.length,
            });
        }
    }
    return plans;
}

function resolveCandidateSettings(
    plan: FinderArmPerformanceCandidatePlan,
    input: FinderArmPerformanceRunnerInput,
): { params: StrategyParams; backtestSettings: BacktestSettings } {
    const { entryParams } = plan.exitStrategyKey
        ? splitExitStrategyParams(plan.params)
        : { entryParams: plan.params };
    const rustSettings = sanitizeBacktestSettingsForRust(input.settings);
    const risk = resolveFinderRiskOverrides(input.settings, rustSettings, plan.params, input.options);
    const candidateSettings: BacktestSettings = plan.exitStrategyKey
        ? {
            ...risk.backtestSettings,
            disableSignalExits: true,
            exitStrategyOverrideEnabled: true,
            exitStrategyKey: plan.exitStrategyKey,
            exitStrategyParams: { ...(plan.exitStrategyParams ?? {}) },
        }
        : {
            ...risk.backtestSettings,
            exitStrategyOverrideEnabled: false,
            exitStrategyKey: "",
            exitStrategyParams: {},
        };
    return {
        params: { ...entryParams },
        backtestSettings: resolveBacktestSettingsFromRaw(
            { ...(candidateSettings as Record<string, unknown>), interval: input.interval } as BacktestSettings,
            { coerceWithoutUiToggles: true },
        ),
    };
}

function buildCandidateResult(args: {
    plan: FinderArmPerformanceCandidatePlan;
    candidateId: string;
    status: TopMeanStatusResponse;
    result: TopMeanResultSummary;
    input: FinderArmPerformanceRunnerInput;
    failedPairDetails: readonly TopMeanPairFailure[];
}): FinderArmPerformanceCandidate {
    const { plan, candidateId, status, result, input, failedPairDetails } = args;
    const horizon = result.horizons.find((item) => item.horizon === input.options.armPerformance?.horizon);
    const armComparisons = horizon?.armComparisons;
    if (!armComparisons || Object.keys(FINDER_ARM_PERFORMANCE_REPLAY_FIELDS).some((arm) => !armComparisons[arm as keyof typeof FINDER_ARM_PERFORMANCE_REPLAY_FIELDS])) {
        throw new Error(`TOP_MEAN child did not return every arm comparison for horizon ${input.options.armPerformance?.horizon}.`);
    }
    const resolved = resolveCandidateSettings(plan, input);
    const pairCount = input.enumeration.canonicalPairs.length;
    const failedPairs = status.failedPairs;
    const completedPairs = status.completedPairs;
    const unknownFailureCount = Math.max(0, failedPairs - failedPairDetails.length);
    const nonDataFailures = failedPairDetails.filter((failure) => failure.failureKind !== "missing_data");
    if (unknownFailureCount > 0 || nonDataFailures.length > 0 || completedPairs + failedPairs !== pairCount) {
        throw new Error(`Pair coverage failed (${completedPairs}/${pairCount} completed, ${failedPairs} failed).`);
    }
    const replayFailures = result.replayTargetLoadFailureCount ?? 0;
    if (completedPairs === 0) {
        throw new Error(`Pair coverage failed (0/${pairCount} completed, ${failedPairs} failed); no usable pair data remained.`);
    }
    return {
        candidateId,
        candidateOrdinal: plan.candidateOrdinal,
        strategyKey: plan.strategyKey,
        strategyName: plan.strategyName,
        horizon: input.options.armPerformance!.horizon,
        params: resolved.params,
        backtestSettings: resolved.backtestSettings,
        ...(plan.exitStrategyKey ? { exitStrategyKey: plan.exitStrategyKey } : {}),
        ...(plan.exitStrategyName ? { exitStrategyName: plan.exitStrategyName } : {}),
        ...(plan.exitStrategyParams ? { exitStrategyParams: { ...plan.exitStrategyParams } } : {}),
        pairCoverage: {
            requestedPairs: pairCount,
            completedPairs,
            failedPairs,
            replayTargetLoadFailures: replayFailures,
            noTradePairs: result.noTradePairs ?? 0,
        },
        metrics: buildFinderArmPerformanceMetricsFromArms(armComparisons as never),
        requestedEngineMode: input.useRustEnginePreference ? "rust" : "typescript",
        actualEngineMode: status.actualEngineMode,
    };
}

async function removeOwnedChildArtifacts(childRunId: string, baseDir: string): Promise<void> {
    const artifactsRoot = resolve(getArtifactsRootDir(baseDir));
    const childDir = resolve(getRunDir(childRunId, baseDir));
    if (!childDir.startsWith(`${artifactsRoot}${sep}`)) {
        throw new Error(`Refusing to remove a TOP_MEAN path outside the artifact root: ${childDir}`);
    }
    await rm(childDir, { recursive: true, force: true });
}

export async function runFinderArmPerformance(
    input: FinderArmPerformanceRunnerInput,
    callbacks: FinderArmPerformanceRunnerCallbacks,
    deps: FinderArmPerformanceRunnerDeps = {},
): Promise<FinderArmPerformanceCandidate[]> {
    const plans = input.plans ?? buildFinderArmPerformanceCandidatePlans({
        selectedStrategies: input.selectedStrategies,
        exitStrategyCandidates: input.exitStrategyCandidates,
        settings: input.settings,
        options: input.options,
        generateParamSets: deps.generatePlans,
    });
    const candidates: FinderArmPerformanceCandidate[] = [];
    const createCoordinator = deps.createCoordinator
        ?? ((request, baseDir, context) => new TopMeanCoordinatorEngine(request, baseDir, context));
    const removeArtifacts = deps.removeChildArtifacts ?? removeOwnedChildArtifacts;
    const horizon = input.options.armPerformance?.horizon;
    if (!horizon) throw new Error("Arm Performance horizon is missing.");
    if (plans.length === 0) throw new Error("Finder produced no candidate configurations for this search.");

    for (const plan of plans) {
        if (input.isCancelled() || input.signal.aborted) break;
        const candidateId = `${input.runId}:candidate-${plan.candidateOrdinal}`;
        const childRunId = createChildRunId(input.runId, plan.candidateOrdinal);
        const resolved = resolveCandidateSettings(plan, input);
        const request: TopMeanCoordinatorRunRequest = {
            runId: childRunId,
            strategyKey: plan.strategyKey,
            strategyParams: resolved.params,
            backtestSettings: resolved.backtestSettings,
            capitalSettings: input.capitalSettings,
            interval: input.interval,
            horizons: [horizon],
            pairListText: input.enumeration.canonicalPairs.join("\n"),
            resume: false,
            saveArchiveLog: false,
            useRustEnginePreference: input.useRustEnginePreference,
            ...(input.sampleFromSec !== undefined ? { sampleFromSec: input.sampleFromSec } : {}),
            ...(input.sampleToSec !== undefined ? { sampleToSec: input.sampleToSec } : {}),
        };
        const coordinator = createCoordinator(request, input.baseDir, {
            enumeration: input.enumeration,
            evaluationNowSec: input.evaluationCutoffSec,
        });
        callbacks.setActiveCoordinator(coordinator, childRunId);

        type ChildTerminal =
            | { type: "done"; result: TopMeanResultSummary }
            | { type: "fatal"; error: string }
            | { type: "interrupted" };
        const terminalEvent: { value: ChildTerminal | null } = { value: null };
        let childStatus: TopMeanStatusResponse | null = null;
        let stagedCandidate: FinderArmPerformanceCandidate | null = null;
        let childError: Error | null = null;
        try {
            await coordinator.run((eventRaw) => {
                if (!eventRaw || typeof eventRaw !== "object") return;
                const event = eventRaw as Record<string, unknown>;
                if (event.type === "done") {
                    if (event.interrupted === true) {
                        terminalEvent.value = { type: "interrupted" };
                    } else if (event.result && typeof event.result === "object") {
                        const result = event.result as TopMeanResultSummary;
                        if (result.completed === true) terminalEvent.value = { type: "done", result };
                    }
                } else if (event.type === "fatal") {
                    terminalEvent.value = { type: "fatal", error: String(event.error ?? "TOP_MEAN child failed.") };
                }

                if (event.type === "preflight" || event.type === "progress") {
                    const phase = String(event.phase ?? event.type);
                    const localPercent = typeof event.completed === "number" && typeof event.total === "number" && event.total > 0
                        ? Math.max(0, Math.min(100, event.completed / event.total * 100))
                        : 0;
                    callbacks.onProgress({
                        candidateId,
                        candidateOrdinal: plan.candidateOrdinal,
                        totalCandidates: plans.length,
                        strategyKey: plan.strategyKey,
                        strategyName: plan.strategyName,
                        childPhase: phase,
                        percent: plans.length > 0 ? ((plan.candidateOrdinal + localPercent / 100) / plans.length) * 100 : 100,
                        text: String(event.text ?? phase),
                    });
                }
            });
            await coordinator.waitForTeardown();
            childStatus = coordinator.getStatus();
            const failedPairDetails = coordinator.getFailedPairDetails?.() ?? [];
            if (failedPairDetails.length > 0) callbacks.onPairFailures?.(failedPairDetails);
            const terminal = input.isCancelled() || input.signal.aborted
                ? { type: "interrupted" } as const
                : terminalEvent.value;
            if (!terminal) {
                throw new Error("TOP_MEAN child ended without a terminal event.");
            }
            if (terminal.type === "fatal") throw new Error(terminal.error);
            if (terminal.type === "interrupted") throw new Error("TOP_MEAN child was interrupted.");
            if (!terminal || terminal.type !== "done") throw new Error("TOP_MEAN child did not complete.");
            if (childStatus.status !== "completed") {
                throw new Error(`TOP_MEAN child status was ${childStatus.status}.`);
            }
            stagedCandidate = buildCandidateResult({
                plan,
                candidateId,
                status: childStatus,
                result: terminal.result,
                input,
                failedPairDetails,
            });
            if (input.isCancelled() || input.signal.aborted) throw new Error("Arm Performance sweep was stopped.");
            candidates.push(stagedCandidate);
            callbacks.onCandidate(stagedCandidate, {
                targetDataBoundary: terminal.result.targetDataBoundary,
                actualEngineMode: childStatus.actualEngineMode,
            });
        } catch (error) {
            childError = error instanceof Error ? error : new Error(String(error));
        } finally {
            await coordinator.waitForTeardown();
            // Keep the child id attached to the parent reservation through
            // artifact cleanup. A TOP_MEAN Stop received in this gap must
            // still cancel the sweep before it advances to another child.
            callbacks.setActiveCoordinator(null, childRunId);
        }

        try {
            await removeArtifacts(childRunId, input.baseDir);
        } catch (error) {
            callbacks.setActiveCoordinator(null, null);
            const message = error instanceof Error ? error.message : String(error);
            throw new FinderArmPerformanceChildError(
                `Candidate ${candidateId} child artifact cleanup failed at ${getRunDir(childRunId, input.baseDir)}: ${message}`,
                candidateId,
                childRunId,
                childStatus,
            );
        }
        callbacks.setActiveCoordinator(null, null);

        if (childError) {
            throw new FinderArmPerformanceChildError(
                `Candidate ${candidateId} failed: ${childError.message}`,
                candidateId,
                childRunId,
                childStatus,
            );
        }
    }
    return candidates;
}
