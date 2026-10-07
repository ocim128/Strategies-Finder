import { removeRetiredCausalArms } from "../open-score-replay/retired-arm-compat";
/**
 * Browser storage for the Batch Backtest UI: persisted-JSON reads/writes for
 * run settings, active-run markers, and compact result snapshots.
 *
 * This module wraps the existing persisted-JSON helpers and owns the storage
 * keys/versions/migrations; it does not define new schemas. DOM application of
 * restored data stays with the service/controllers.
 */
import { readPersistedJson, writePersistedJson } from "../../persisted-json";
import { debugLogger } from "../../debug-logger";
import { LEGACY_REPLAY_ARM_FIELDS } from "../open-score-replay/arm-contract";
import {
    compactBatchBacktestResultsSnapshot,
    normalizeBatchBacktestResultsSnapshot,
    BATCH_RESULT_SNAPSHOT_TRUNCATED_LIMIT,
    type BatchBacktestResultsSnapshot,
} from "../batch-backtest-snapshot";
import type { BatchBacktestSymbolResult } from "../batch-backtest-runner";
import type { TopMeanResultSummary } from "../sp500-top-mean-coordinator-engine";
import type { ReplayMode } from "../open-score-replay/types";

export const BATCH_RESULTS_STORAGE = {
    key: "playground_batch_backtest_latest_results",
    schema: "batch_backtest.latest_results",
    version: 1,
} as const;

export const BATCH_ACTIVE_SERVER_RUN_STORAGE = {
    key: "playground_batch_backtest_active_server_run",
    schema: "batch_backtest.active_server_run",
    version: 1,
} as const;

export type BatchPersistedActiveServerRun = {
    runId: string;
    startedAt: number;
};

// Audit Finding 6: the TOP_MEAN active-run marker was written via 11 inline
// `writePersistedJson({ key, schema, version, data })` copies (start, done
// interrupted, done success, fatal, reattach terminal, reattach give-up, ...).
// A shared storage constant + helpers make it impossible to clear the marker
// in 5/6 paths and miss the 6th (the documented footgun).
export const TOP_MEAN_ACTIVE_RUN_STORAGE = {
    key: "sp500_top_mean_active_run_id",
    schema: "sp500_top_mean_active_run_id.v1",
    version: 1,
} as const;

export const TOP_MEAN_LATEST_RESULT_STORAGE = {
    key: "playground_sp500_top_mean_latest_result",
    schema: "sp500_top_mean.latest_result",
    version: 1,
} as const;

export const TOP_MEAN_REPLAY_MODE_STORAGE = {
    key: "playground_sp500_top_mean_replay_mode",
    schema: "sp500_top_mean.replay_mode",
    version: 1,
} as const;

export function readTopMeanReplayMode(): ReplayMode {
    return readPersistedJson<ReplayMode>({
        ...TOP_MEAN_REPLAY_MODE_STORAGE,
        fallback: "horizon",
        migrate: ({ data }) => data === "asset_switch" ? "asset_switch" : "horizon",
    });
}

export function persistTopMeanReplayMode(mode: ReplayMode): void {
    writePersistedJson({
        ...TOP_MEAN_REPLAY_MODE_STORAGE,
        data: mode,
        onError: (error) => debugLogger.warn("sp500_top_mean.replay_mode_save_failed", {
            error: error instanceof Error ? error.message : String(error),
        }),
    });
}

const TOP_MEAN_SWITCH_RESULT_STORAGE_LIMIT_PER_ARM = 20;
function compactTopMeanSwitchSection(
    section: NonNullable<TopMeanResultSummary["assetSwitch"]>,
    retainTradePreview: boolean,
) {
    const trades = section.trades;
    let boundedTrades: typeof trades;
    if (retainTradePreview && trades) {
        const retainedByArm = new Map<string, number>();
        const selected: NonNullable<typeof trades> = [];
        for (let index = trades.length - 1; index >= 0; index -= 1) {
            const row = trades[index]!;
            const retained = retainedByArm.get(row.arm) ?? 0;
            if (retained >= TOP_MEAN_SWITCH_RESULT_STORAGE_LIMIT_PER_ARM) continue;
            retainedByArm.set(row.arm, retained + 1);
            selected.push(row);
        }
        selected.reverse();
        boundedTrades = selected;
    }
    return {
        ...section,
        trades: boundedTrades,
        tradeCount: section.tradeCount ?? section.trades?.length ?? 0,
    };
}

export type TopMeanPersistedActiveRun = { runId: string };

/** Persist the active TOP_MEAN run id so a reload can reattach. */
export function persistTopMeanActiveRun(runId: string): void {
    writePersistedJson({
        ...TOP_MEAN_ACTIVE_RUN_STORAGE,
        data: { runId },
        onError: (error) => debugLogger.warn("sp500_top_mean.active_run_save_failed", {
            error: error instanceof Error ? error.message : String(error),
        }),
    });
}

/** Clear the active TOP_MEAN run marker (terminal / give-up / interrupted). */
export function clearTopMeanActiveRun(): void {
    writePersistedJson({
        ...TOP_MEAN_ACTIVE_RUN_STORAGE,
        data: null,
        onError: (error) => debugLogger.warn("sp500_top_mean.active_run_clear_failed", {
            error: error instanceof Error ? error.message : String(error),
        }),
    });
}

/** Read the active TOP_MEAN run marker; null when no run is tracked. */
export function readTopMeanActiveRun(): TopMeanPersistedActiveRun | null {
    const persisted = readPersistedJson<TopMeanPersistedActiveRun | null>({
        ...TOP_MEAN_ACTIVE_RUN_STORAGE,
        fallback: null,
        migrate: (ctx) => {
            const data = ctx.data;
            if (!data || typeof data !== "object" || Array.isArray(data)) return null;
            const source = data as Partial<TopMeanPersistedActiveRun>;
            if (typeof source.runId !== "string" || !source.runId.trim()) return null;
            return { runId: source.runId.trim() };
        },
    });
    return persisted;
}

export function persistActiveServerRun(runId: string): void {
    writePersistedJson({
        ...BATCH_ACTIVE_SERVER_RUN_STORAGE,
        data: { runId, startedAt: Date.now() },
        onError: (error) => debugLogger.warn("batch.active_server_run_save_failed", {
            error: error instanceof Error ? error.message : String(error),
        }),
    });
}

export function loadPersistedActiveServerRun(): BatchPersistedActiveServerRun | null {
    return readPersistedJson<BatchPersistedActiveServerRun | null>({
        ...BATCH_ACTIVE_SERVER_RUN_STORAGE,
        fallback: null,
        migrate: ({ data }) => {
            if (!data || typeof data !== "object" || Array.isArray(data)) return null;
            const source = data as Partial<BatchPersistedActiveServerRun>;
            if (typeof source.runId !== "string" || !source.runId.trim()) return null;
            return {
                runId: source.runId.trim(),
                startedAt: typeof source.startedAt === "number" ? source.startedAt : Date.now(),
            };
        },
    });
}

export function clearPersistedActiveServerRun(): void {
    writePersistedJson({
        ...BATCH_ACTIVE_SERVER_RUN_STORAGE,
        data: null,
        onError: (error) => debugLogger.warn("batch.active_server_run_clear_failed", {
            error: error instanceof Error ? error.message : String(error),
        }),
    });
}

export function readLatestResultsSnapshot(): BatchBacktestResultsSnapshot | null {
    return readPersistedJson<BatchBacktestResultsSnapshot | null>({
        ...BATCH_RESULTS_STORAGE,
        fallback: null,
        migrate: ({ data }) => normalizeBatchBacktestResultsSnapshot(data),
        onError: (error) => {
            debugLogger.error("batch_backtest.latest_results_load_failed", {
                error: error instanceof Error ? error.message : String(error),
            });
        },
    });
}

/** Latest-results snapshot inputs captured by the run owner. */
export interface LatestResultsSnapshotInput {
    results: readonly BatchBacktestSymbolResult[];
    /** Already resolved by the caller (`lastRunInterval ?? state.currentInterval`). */
    interval: string;
    fingerprint: string | null;
    strategyKey: string | null;
    serverHasArtifacts: boolean;
}

export function saveLatestResultsSnapshot(input: LatestResultsSnapshotInput): void {
    if (input.results.length === 0) {
        return;
    }
    const baseSnapshot = {
        savedAt: Date.now(),
        interval: input.interval,
        fingerprint: input.fingerprint,
        strategyKey: input.strategyKey,
        serverHasArtifacts: input.serverHasArtifacts,
    };
    // Tier 1: try the full compact snapshot.
    const fullSnapshot = compactBatchBacktestResultsSnapshot({
        ...baseSnapshot,
        results: [...input.results],
    });
    const fullOk = writePersistedJson({
        ...BATCH_RESULTS_STORAGE,
        data: fullSnapshot,
        onError: (error) => {
            debugLogger.error("batch_backtest.latest_results_save_failed", {
                error: error instanceof Error ? error.message : String(error),
            });
        },
    });
    if (fullOk) {
        return;
    }
    // Tier 2 (audit Finding 5): the full snapshot exceeded the localStorage
    // quota (typically 1000+ rows). Retry with the most recent rows capped
    // at BATCH_RESULT_SNAPSHOT_TRUNCATED_LIMIT so a reload still restores a
    // useful table instead of silently losing the run. Previously a
    // QuotaExceeded only hit a debug log and the next reload had nothing.
    if (input.results.length <= BATCH_RESULT_SNAPSHOT_TRUNCATED_LIMIT) {
        // Already under the truncated cap — truncation cannot help.
        return;
    }
    const truncatedSnapshot = compactBatchBacktestResultsSnapshot({
        ...baseSnapshot,
        results: input.results.slice(0, BATCH_RESULT_SNAPSHOT_TRUNCATED_LIMIT),
        meta: { truncated: true, totalRows: input.results.length },
    });
    writePersistedJson({
        ...BATCH_RESULTS_STORAGE,
        data: truncatedSnapshot,
        onError: (error) => {
            debugLogger.warn("batch_backtest.latest_results_truncated_save_failed", {
                error: error instanceof Error ? error.message : String(error),
                totalRows: input.results.length,
            });
        },
    });
}

export function clearPersistedLatestResults(): void {
    try {
        // Storage acquisition can throw just like removeItem. Cleanup must
        // not interrupt run startup or leave stale result actions enabled.
        const storage = globalThis.localStorage;
        if (storage === undefined) return;
        storage.removeItem(BATCH_RESULTS_STORAGE.key);
    } catch (error) {
        debugLogger.error("batch_backtest.latest_results_clear_failed", {
            error: error instanceof Error ? error.message : String(error),
        });
    }
}

export function persistLatestTopMeanResult(result: TopMeanResultSummary): void {
    result = removeRetiredCausalArms(result);
    const {
        openScoreEventDetails: _openScoreEventDetails,
        annualReports,
        ...persistedResult
    } = result;
    const persistedAnnualReports = annualReports?.map((annual) => {
        const { eventDetails: _eventDetails, ...persistedAnnual } = annual;
        return {
            ...persistedAnnual,
            ...(annual.assetSwitch ? { assetSwitch: compactTopMeanSwitchSection(annual.assetSwitch, false) } : {}),
        };
    });
    writePersistedJson({
        ...TOP_MEAN_LATEST_RESULT_STORAGE,
        data: {
            ...persistedResult,
            ...(result.assetSwitch ? { assetSwitch: compactTopMeanSwitchSection(result.assetSwitch, true) } : {}),
            ...(persistedAnnualReports ? { annualReports: persistedAnnualReports } : {}),
        },
        onError: (error) => debugLogger.warn("sp500_top_mean.latest_result_save_failed", {
            error: error instanceof Error ? error.message : String(error),
        }),
    });
}

export function clearPersistedLatestTopMeanResult(): void {
    writePersistedJson({
        ...TOP_MEAN_LATEST_RESULT_STORAGE,
        data: null,
        onError: (error) => debugLogger.warn("sp500_top_mean.latest_result_clear_failed", {
            error: error instanceof Error ? error.message : String(error),
        }),
    });
}

export function readLatestTopMeanResult(): TopMeanResultSummary | null {
    return readPersistedJson<TopMeanResultSummary | null>({
        ...TOP_MEAN_LATEST_RESULT_STORAGE,
        fallback: null,
        migrate: ({ data }) => {
            if (!data || typeof data !== "object" || Array.isArray(data)) return null;
            const source = data as Partial<TopMeanResultSummary>;
            if (typeof source.runId !== "string" || !source.runId.trim()) return null;
            if (source.completed !== true || !Array.isArray(source.horizons)) return null;
            const replayMode = source.replayMode === undefined ? "horizon" : source.replayMode;
            if (replayMode !== "horizon" && replayMode !== "asset_switch") return null;
            if (replayMode === "asset_switch") {
                const section = source.assetSwitch;
                if (!section || section.semanticsVersion !== "asset_switch.v1" || source.horizons.length !== 0) return null;
                if (!section.arms || !LEGACY_REPLAY_ARM_FIELDS.every((arm) => arm in section.arms)) return null;
            }
            if (!source.horizons.every((horizon) =>
                horizon
                && typeof horizon === "object"
                && Array.isArray(horizon.topAssets)
            )) {
                return null;
            }
            if (source.annualReports !== undefined) {
                if (!Array.isArray(source.annualReports)) return null;
                const annualValid = source.annualReports.every((annual) => {
                    if (!annual || typeof annual !== "object" || Array.isArray(annual)) return false;
                    const annualMode = (annual as { replayMode?: unknown }).replayMode;
                    if (annualMode !== undefined && annualMode !== "horizon" && annualMode !== "asset_switch") return false;
                    if (annualMode !== undefined && annualMode !== replayMode) return false;
                    if (replayMode === "asset_switch") {
                        const switchAnnual = annual as { assetSwitch?: { semanticsVersion?: unknown }; horizons?: unknown[] };
                        return switchAnnual.assetSwitch?.semanticsVersion === "asset_switch.v1"
                            && Array.isArray(switchAnnual.horizons)
                            && switchAnnual.horizons.length === 0;
                    }
                    return true;
                });
                if (!annualValid) return null;
            }
            return removeRetiredCausalArms({ ...source, replayMode } as TopMeanResultSummary);
        },
        onError: (error) => debugLogger.warn("sp500_top_mean.latest_result_restore_failed", {
            error: error instanceof Error ? error.message : String(error),
        }),
    });
}
