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
import { debugLogger } from "../debug-logger";
import { resolveFinderRiskOverrides } from "./finder-runner-core";
import { splitExitStrategyParams } from "./exit-strategy-param-prefix";
import {
    buildFinderArmPerformanceMetricsFromArms,
    compactFinderArmComparison,
    FINDER_ARM_PERFORMANCE_REPLAY_FIELDS,
} from "./finder-arm-performance-metrics";
import {
    getArtifactsRootDir,
    getRunDir,
    isValidRunId,
    evictRunParsedShardCache,
} from "../batch-backtest/sp500-top-mean-artifact-store";
import {
    TopMeanCoordinatorEngine,
    type TopMeanCoordinatorEngineDeps,
    type TopMeanCoordinatorRunRequest,
    type TopMeanResultSummary,
    type TopMeanStatusResponse,
} from "../batch-backtest/sp500-top-mean-coordinator-engine";
import type { ReplayComparison } from "../batch-backtest/batch-open-score-usd-replay-engine";
import type { AssetSwitchArmSummary, ReplayArmField } from "../batch-backtest/open-score-replay/types";
import { TopMeanWorkerPool, type TopMeanPairFailure } from "../batch-backtest/sp500-top-mean-worker-pool";
import type { EnumerationResult } from "../batch-backtest/sp500-pair-enumerator";
import type { CapitalSettings } from "../types/backtest";
import {
    buildFinderArmPerformanceCandidateDiagnostic,
    type FinderArmPerformanceCandidateDiagnostic,
} from "./finder-arm-performance-diagnostics";

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
    /**
     * Sweep-scoped worker reuse: when true, one pool serves every sequential
     * candidate (startup amortized; the per-candidate cache reset handshake
     * still runs). Phase 1 of the worker-reuse plan measured 10-21% faster
     * multi-candidate sweeps with identical deterministic results, so the
     * production server caller enables it; other callers and tests opt in
     * explicitly. Unset = one pool per candidate.
     */
    enableWorkerReuse?: boolean;
    /**
     * Optional worker-count cap threaded to every child coordinator request
     * (benchmark seam; the harness pins it so pool-reuse comparisons hold
     * worker count fixed). Unset keeps the auto policy (memory-ceiling
     * derived) unchanged.
     */
    workerCount?: number;
}

export interface FinderArmPerformanceRunnerCallbacks {
    onProgress(progress: FinderArmPerformanceProgress): void;
    onCandidate(
        candidate: FinderArmPerformanceCandidate,
        diagnostics: { targetDataBoundary?: TopMeanResultSummary["targetDataBoundary"]; actualEngineMode: string },
    ): void;
    onPairFailures?(failures: readonly TopMeanPairFailure[]): void;
    /** Server-only compact measurements emitted once, before child artifact cleanup. */
    onCandidateDiagnostic?(diagnostic: FinderArmPerformanceCandidateDiagnostic): void | Promise<void>;
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
    /** Test seam: provide the sweep-scoped worker pool instead of constructing it. */
    createWorkerPool?: () => TopMeanWorkerPool;
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
    const replayMode = input.options.armPerformance?.replayMode ?? "horizon";
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
    const pairCoverage = {
        requestedPairs: pairCount,
        completedPairs,
        failedPairs,
        replayTargetLoadFailures: replayFailures,
        noTradePairs: result.noTradePairs ?? 0,
    };
    if (replayMode === "asset_switch") {
        if (result.replayMode !== "asset_switch" || !result.assetSwitch) {
            throw new Error("TOP_MEAN child completed without the required asset-switch result section.");
        }
        const switchMetrics = {} as Record<keyof typeof FINDER_ARM_PERFORMANCE_REPLAY_FIELDS, AssetSwitchArmSummary>;
        for (const [arm, field] of Object.entries(FINDER_ARM_PERFORMANCE_REPLAY_FIELDS) as Array<[
            keyof typeof FINDER_ARM_PERFORMANCE_REPLAY_FIELDS,
            ReplayArmField,
        ]>) {
            const metric = result.assetSwitch.arms[field];
            if (!metric) throw new Error(`TOP_MEAN child omitted switch arm ${arm}.`);
            switchMetrics[arm] = metric;
        }
        return {
            candidateId,
            candidateOrdinal: plan.candidateOrdinal,
            strategyKey: plan.strategyKey,
            strategyName: plan.strategyName,
            replayMode,
            params: resolved.params,
            backtestSettings: resolved.backtestSettings,
            ...(plan.exitStrategyKey ? { exitStrategyKey: plan.exitStrategyKey } : {}),
            ...(plan.exitStrategyName ? { exitStrategyName: plan.exitStrategyName } : {}),
            ...(plan.exitStrategyParams ? { exitStrategyParams: { ...plan.exitStrategyParams } } : {}),
            pairCoverage,
            assetSwitchMetrics: switchMetrics,
            requestedEngineMode: input.useRustEnginePreference ? "rust" : "typescript",
            actualEngineMode: status.actualEngineMode,
        };
    }
    const horizon = result.horizons.find((item) => item.horizon === input.options.armPerformance?.horizon);
    const emptyComparison: ReplayComparison = {
        events: 0,
        topMean: null,
        randomMean: null,
        delta: null,
        topMedian: null,
        blockMeans: [],
        ciLower: null,
        ciUpper: null,
        positiveBlocks: 0,
        totalBlocks: 0,
    };
    const armComparisons = horizon?.armComparisons ?? (
        result.completed && result.horizons.length === 0
            ? Object.fromEntries(
                Object.keys(FINDER_ARM_PERFORMANCE_REPLAY_FIELDS).map((arm) => [arm, emptyComparison]),
            ) as Record<keyof typeof FINDER_ARM_PERFORMANCE_REPLAY_FIELDS, ReplayComparison>
            : undefined
    );
    const adjustedArmMetrics = horizon?.armComparisonsExTopContributor
        ? Object.fromEntries(
            (Object.keys(FINDER_ARM_PERFORMANCE_REPLAY_FIELDS) as Array<keyof typeof FINDER_ARM_PERFORMANCE_REPLAY_FIELDS>)
                .filter((arm) => horizon.armComparisonsExTopContributor?.[arm])
                .map((arm) => [arm, compactFinderArmComparison(horizon.armComparisonsExTopContributor![arm]!)]),
        ) as FinderArmPerformanceCandidate["metricsExTopContributor"]
        : undefined;
    const contributorExclusions = horizon?.armTopContributors
        ? Object.fromEntries(
            Object.entries(horizon.armTopContributors).map(([arm, summary]) => [arm, {
                asset: summary?.asset ?? null,
                events: Math.max(0, Math.floor(summary?.events ?? 0)),
            }]),
        ) as FinderArmPerformanceCandidate["contributorExclusions"]
        : undefined;
    const missingArms = (Object.keys(FINDER_ARM_PERFORMANCE_REPLAY_FIELDS) as Array<keyof typeof FINDER_ARM_PERFORMANCE_REPLAY_FIELDS>)
        .filter((arm) => !armComparisons?.[arm]);
    if (missingArms.length > 0) {
        const returnedHorizons = result.horizons.map((item) => item.horizon).join(", ") || "none";
        throw new Error(
            "TOP_MEAN child omitted arm comparison(s) [" + missingArms.join(", ")
            + "] for horizon " + input.options.armPerformance?.horizon
            + "; returned horizons [" + returnedHorizons + "].",
        );
    }
    return {
        candidateId,
        candidateOrdinal: plan.candidateOrdinal,
        strategyKey: plan.strategyKey,
        strategyName: plan.strategyName,
        replayMode: "horizon",
        horizon: input.options.armPerformance!.horizon!,
        params: resolved.params,
        backtestSettings: resolved.backtestSettings,
        ...(plan.exitStrategyKey ? { exitStrategyKey: plan.exitStrategyKey } : {}),
        ...(plan.exitStrategyName ? { exitStrategyName: plan.exitStrategyName } : {}),
        ...(plan.exitStrategyParams ? { exitStrategyParams: { ...plan.exitStrategyParams } } : {}),
        pairCoverage,
        metrics: buildFinderArmPerformanceMetricsFromArms(armComparisons as never),
        ...(adjustedArmMetrics ? { metricsExTopContributor: adjustedArmMetrics } : {}),
        ...(contributorExclusions ? { contributorExclusions } : {}),
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
    evictRunParsedShardCache(childRunId, baseDir);
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
    const replayMode = input.options.armPerformance?.replayMode ?? "horizon";
    const horizon = input.options.armPerformance?.horizon;
    if (replayMode === "horizon" && !horizon) throw new Error("Arm Performance horizon is missing.");
    if (plans.length === 0) throw new Error("Finder produced no candidate configurations for this search.");

    // Sweep-scoped worker pool (phase 3): one construction serves every
    // sequential child, amortizing worker startup and retaining each worker's
    // bounded parsed-seed cache across candidates. execute() intentionally
    // leaves workers alive on success; the finally below disposes the pool on
    // every sweep exit — success, child failure, Stop, and fatal — so no
    // worker thread outlives the sweep or the plugin's owner-release path.
    const pool = input.enableWorkerReuse
        ? (deps.createWorkerPool?.() ?? new TopMeanWorkerPool())
        : null;
    const sweepState = { poolUsable: true };
    const cancelSweepPool = (): void => {
        if (!pool) return;
        pool.cancel();
        sweepState.poolUsable = false;
    };
    // Audit (P2): a Stop landing in the artifact-cleanup gap reaches no
    // active coordinator (the runner already detached it), so forward the
    // runner abort signal to the borrowed pool immediately.
    if (pool) {
        if (input.signal.aborted) cancelSweepPool();
        else input.signal.addEventListener("abort", cancelSweepPool, { once: true });
    }
    try {
        return await runFinderArmPerformanceCandidates(
            input,
            callbacks,
            deps,
            plans,
            pool,
            sweepState,
        );
    } finally {
        input.signal.removeEventListener("abort", cancelSweepPool);
        // The runner owns final termination (phase 3): dispose (cancel +
        // drain) runs on EVERY sweep exit — success, child failure, Stop,
        // and fatal — before control returns to the plugin's owner-release
        // path, so no worker thread outlives the sweep.
        sweepState.poolUsable = false;
        await pool?.dispose();
    }
}

/**
 * Sequential candidate sweep (phase 3): each child coordinator is lent the
 * sweep-scoped worker pool and never tears it down; a child failure or Stop
 * latches `sweepState.poolUsable` false so no later child borrows it again.
 * Moved verbatim from runFinderArmPerformance — behavior unchanged apart
 * from the pool lending and the sweep-state latch.
 */
async function runFinderArmPerformanceCandidates(
    input: FinderArmPerformanceRunnerInput,
    callbacks: FinderArmPerformanceRunnerCallbacks,
    deps: FinderArmPerformanceRunnerDeps,
    plans: readonly FinderArmPerformanceCandidatePlan[],
    pool: TopMeanWorkerPool | null,
    sweepState: { poolUsable: boolean },
): Promise<FinderArmPerformanceCandidate[]> {
    // Validated by the outer entrypoint; re-read here because the helper is
    // also the only place request construction needs it.
    const replayMode = input.options.armPerformance?.replayMode ?? "horizon";
    const horizon = input.options.armPerformance?.horizon;
    if (replayMode === "horizon" && !horizon) throw new Error("Arm Performance horizon is missing.");
    const candidates: FinderArmPerformanceCandidate[] = [];
    const createCoordinator = deps.createCoordinator
        ?? ((request, baseDir, context) => new TopMeanCoordinatorEngine(request, baseDir, context));
    const removeArtifacts = deps.removeChildArtifacts ?? removeOwnedChildArtifacts;
    const cancelSweepPool = (): void => {
        if (!pool) return;
        pool.cancel();
        sweepState.poolUsable = false;
    };
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
            replayMode,
            ...(replayMode === "horizon" ? { horizons: [horizon!] } : {}),
            pairListText: input.enumeration.canonicalPairs.join("\n"),
            resume: false,
            saveArchiveLog: false,
            useRustEnginePreference: input.useRustEnginePreference,
            selectionCooldownBars: replayMode === "horizon" && input.options.armPerformance?.selectionCooldownEnabled
                ? input.options.armPerformance.selectionCooldownBars ?? 5
                : 0,
            ...(input.workerCount !== undefined ? { workerCount: input.workerCount } : {}),
            ...(input.sampleFromSec !== undefined ? { sampleFromSec: input.sampleFromSec } : {}),
            ...(input.sampleToSec !== undefined ? { sampleToSec: input.sampleToSec } : {}),
        };
        const coordinator = createCoordinator(request, input.baseDir, {
            enumeration: input.enumeration,
            evaluationNowSec: input.evaluationCutoffSec,
            // Trusted-runner profile: children skip annual replays, the
            // current snapshot, per-row details, and result.json — the
            // compact candidate result reads only scalar mode-specific arm summaries.
            executionProfile: "finder_arm",
            // Sweep-scoped pool (enableWorkerReuse): executed (but never torn
            // down) by the child; final termination stays with this runner's
            // finally. The production server caller opts in via
            // enableWorkerReuse; other callers and tests choose explicitly.
            ...(pool && sweepState.poolUsable ? { pool } : {}),
        });
        type ChildTerminal =
            | { type: "done"; result: TopMeanResultSummary }
            | { type: "fatal"; error: string }
            | { type: "interrupted" };
        const terminalEvent: { value: ChildTerminal | null } = { value: null };
        let childStatus: TopMeanStatusResponse | null = null;
        let stagedCandidate: FinderArmPerformanceCandidate | null = null;
        let childError: Error | null = null;
        // Audit (P0): TopMeanCoordinatorEngine keeps run()/waitForTeardown()/
        // getStatus() on its PROTOTYPE, so an object spread silently drops
        // them and the child run would throw at runtime. Bind every member
        // explicitly; only stop() is wrapped.
        const coordinatorWithSweepStop: FinderArmPerformanceCoordinator = {
            request: coordinator.request,
            run: (...args) => coordinator.run(...args),
            // Parent Stop (Batch or TOP_MEAN child Stop delegating to Finder)
            // must reach the BORROWED pool even between children: cancel
            // latches it, and the finally below drains + refuses to reuse it.
            stop() {
                cancelSweepPool();
                coordinator.stop();
            },
            waitForTeardown: () => coordinator.waitForTeardown(),
            getStatus: () => coordinator.getStatus(),
            ...(typeof coordinator.getFailedPairDetails === "function"
                ? { getFailedPairDetails: () => coordinator.getFailedPairDetails!() }
                : {}),
        };
        callbacks.setActiveCoordinator(coordinatorWithSweepStop, childRunId);

        try {
            await coordinatorWithSweepStop.run((eventRaw) => {
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

        childStatus ??= coordinator.getStatus();
        try {
            await callbacks.onCandidateDiagnostic?.(buildFinderArmPerformanceCandidateDiagnostic({
                candidateId,
                childRunId,
                candidateOrdinal: plan.candidateOrdinal,
                strategyKey: plan.strategyKey,
                outcome: childError
                    ? (input.isCancelled() || input.signal.aborted ? "cancelled" : "failed")
                    : "completed",
                ...(childError ? { error: childError.message } : {}),
            }, childStatus));
        } catch (error) {
            debugLogger.warn("finder.arm_performance.diagnostic_failed", {
                runId: input.runId, candidateId,
                error: error instanceof Error ? error.message : String(error),
            });
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
            // Stop/fatal errors cancel and drain the whole pool; a failed
            // pool is never handed to another candidate. dispose() in the
            // finally below performs the final termination.
            if (pool) sweepState.poolUsable = false;
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
