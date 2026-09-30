/**
 * Finder storage operations: the version-1 persisted envelopes for UI state,
 * the latest-results snapshot, and the active server-run record. Browser-only.
 * Every function serializes state it is given; none retains an inventory of
 * its own. Callers keep ownership of adoption, write timing, and DOM effects.
 */
import { debugLogger } from "../../debug-logger";
import { readPersistedJson, writePersistedJson } from "../../persisted-json";
import { compactFinderLatestResults, normalizeFinderLatestResultsSnapshot } from "../finder-result-snapshot";
import { DEFAULT_FINDER_UI_STATE, normalizeFinderUiState, type FinderPersistedUiState } from "./finder-settings";
import type { FinderLatestResults } from "../../types/finder";

export const FINDER_UI_STORAGE = {
	key: "playground_finder_ui",
	schema: "finder.ui",
	version: 1,
} as const;
export const FINDER_RESULTS_STORAGE = {
	key: "playground_finder_latest_results",
	schema: "finder.latest_results",
	version: 1,
} as const;
/**
 * Persisted active server-run id for server-owned Finder scopes. Written
 * BEFORE the run request so a tab reload can identify the same job and poll
 * `/api/finder/status?runId=...` for progress + final results. Cleared only
 * after a matching terminal response, explicit Stop, or a confirmed missing
 * server job.
 *
 * Schema version 1: just the run id + the scope that initiated it (so a
 * current-chart reload cannot adopt a universe server snapshot).
 */
export const FINDER_ACTIVE_SERVER_RUN_STORAGE = {
	key: "playground_finder_active_server_run",
	schema: "finder.active_server_run",
	version: 1,
} as const;

export type FinderPersistedResultsState = {
	savedAt: number;
	symbol: string;
	interval: string;
	results: FinderLatestResults;
};

export type FinderServerRunScope = 'symbol_universe' | 'asset_opportunity' | 'asset_opportunity_batch' | 'arm_performance';

export type FinderPersistedActiveServerRun = {
	runId: string;
	scope: FinderServerRunScope;
	startedAt: number;
};

export function readFinderUiState(): FinderPersistedUiState {
	return readPersistedJson<FinderPersistedUiState>({
		...FINDER_UI_STORAGE,
		fallback: { ...DEFAULT_FINDER_UI_STATE },
		migrate: ({ data }) => normalizeFinderUiState(data),
		onError: (error) => {
			debugLogger.error("finder.ui_state_load_failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		},
	});
}

export function writeFinderUiState(uiState: FinderPersistedUiState): void {
	writePersistedJson({
		...FINDER_UI_STORAGE,
		data: uiState,
		onError: (error) => {
			debugLogger.error("finder.ui_state_save_failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		},
	});
}

export function readFinderLatestResultsSnapshot(): FinderPersistedResultsState | null {
	return readPersistedJson<FinderPersistedResultsState | null>({
		...FINDER_RESULTS_STORAGE,
		fallback: null,
		migrate: ({ data }) => {
			if (!data || typeof data !== "object" || Array.isArray(data)) {
				return null;
			}
			const source = data as Partial<FinderPersistedResultsState>;
			const results = normalizeFinderLatestResultsSnapshot(source.results);
			if (!results || (results.results.length === 0 && results.scope !== 'arm_performance')) {
				return null;
			}
			return {
				savedAt: typeof source.savedAt === "number" ? source.savedAt : 0,
				symbol: typeof source.symbol === "string" ? source.symbol : "",
				interval: typeof source.interval === "string" ? source.interval : "",
				results,
			};
		},
		onError: (error) => {
			debugLogger.error("finder.latest_results_load_failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		},
	});
}

/** Persist bounded snapshots/checkpoints; empty non-Arm inventories are never written. */
export function writeFinderLatestResultsSnapshot(args: {
	symbol: string;
	interval: string;
	results: FinderLatestResults;
}): void {
	const { symbol, interval, results } = args;
	if (results.results.length === 0 && results.scope !== 'arm_performance') {
		return;
	}
	const snapshot: FinderPersistedResultsState = {
		savedAt: Date.now(),
		symbol,
		interval,
		results: compactFinderLatestResults(results),
	};
	writePersistedJson({
		...FINDER_RESULTS_STORAGE,
		data: snapshot,
		onError: (error) => {
			debugLogger.error("finder.latest_results_save_failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		},
	});
}

export function clearFinderLatestResultsSnapshot(): void {
	writePersistedJson({
		...FINDER_RESULTS_STORAGE,
		data: null,
		onError: (error) => {
			debugLogger.error("finder.latest_results_clear_failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		},
	});
}

/** Persist the active run id BEFORE fetch so a reload can reattach. */
export function writeFinderActiveServerRun(args: {
	runId: string;
	scope: FinderServerRunScope;
	startedAt: number;
}): void {
	writePersistedJson({
		...FINDER_ACTIVE_SERVER_RUN_STORAGE,
		data: { runId: args.runId, scope: args.scope, startedAt: args.startedAt },
		onError: (error) => {
			debugLogger.warn("finder.active_server_run_save_failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		},
	});
}

/** Clear the persisted active-run record (terminal / stop / missing). */
export function clearFinderActiveServerRun(): void {
	writePersistedJson({
		...FINDER_ACTIVE_SERVER_RUN_STORAGE,
		data: null,
		onError: (error) => {
			debugLogger.warn("finder.active_server_run_clear_failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		},
	});
}

/** Read the persisted active-run record (or null). */
export function readFinderActiveServerRun(): FinderPersistedActiveServerRun | null {
	return readPersistedJson<FinderPersistedActiveServerRun | null>({
		...FINDER_ACTIVE_SERVER_RUN_STORAGE,
		fallback: null,
		migrate: ({ data }) => {
			if (!data || typeof data !== "object" || Array.isArray(data)) return null;
			const source = data as Partial<FinderPersistedActiveServerRun>;
			if (typeof source.runId !== "string" || !source.runId) return null;
			if (
				source.scope !== "symbol_universe"
				&& source.scope !== "asset_opportunity"
				&& source.scope !== "asset_opportunity_batch"
				&& source.scope !== "arm_performance"
			) return null;
			return {
				runId: source.runId,
				scope: source.scope,
				startedAt: typeof source.startedAt === "number" ? source.startedAt : Date.now(),
			};
		},
		onError: () => {
			// Persisted-json read failures are non-fatal for reattach; just
			// skip reattachment. Don't spam the console on a missing key.
		},
	});
}
