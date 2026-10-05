/**
 * Owner of the Finder result inventories: the full per-scope inventories
 * retained for post-run re-sort, the display limits, the run-time ordering
 * snapshot, and the Arm run/apply context. Browser-only.
 *
 * The store derives display views from retained inventories and never
 * renders, fetches, or touches localStorage — persistence happens through
 * the `persistTerminalResults` callback the manager wires to the snapshot
 * writer. Arm Performance may persist rate-limited bounded previews while a
 * server run is active. Local display changes use a debounced checkpoint;
 * terminal adoption cancels it and persists immediately.
 */
import {
	FINDER_SORT_OPTIONS,
	METRIC_FULL_LABELS,
	STRATEGY_QUALITY_METRIC_FULL_LABELS,
	STRATEGY_QUALITY_SORT_OPTIONS,
	UNIVERSE_METRIC_FULL_LABELS,
} from "../constants";
import { sortFinderResults } from "../finder-engine";
import {
	deduplicateAssetOpportunityResultsBySymbol,
	sortAssetOpportunityResults,
	sortAssetOpportunityResultsByMetric,
	getAssetOpportunityResortMetrics,
	FRESH_SIGNAL_LIBRARIES_METRIC,
	FRESH_SIGNAL_LIBRARIES_BY_TRADES_METRIC,
	TOP_RAW_SUPPORT_METRIC,
	TOTAL_TRADES_CAPPED_METRIC,
	TOTAL_TRADES_SATURATION_PERCENTILE,
	MEDIAN_BARS_TO_TP_METRIC,
	PRIOR_TUPLE_RECURRENCE_METRIC,
	STRATEGY_COVERAGE_GATE_METRIC,
	BARRIER_EXIT_SHARE_METRIC,
	TRADE_GAP_UNIFORMITY_METRIC,
	TOP_DECILE_PROFIT_SHARE_METRIC,
	WINNER_LOSER_HOLD_GAP_BARS_METRIC,
	EQUITY_PATH_LINEARITY_METRIC,
	INVERTED_NET_PROFIT_METRIC,
	INVERTED_EXPECTANCY_METRIC,
	INVERTED_AVERAGE_GAIN_METRIC,
	INVERTED_WIN_RATE_METRIC,
	INVERTED_SHARPE_RATIO_METRIC,
	INVERTED_PROFIT_FACTOR_METRIC,
	INVERTED_MAX_DRAWDOWN_METRIC,
	type FinderAssetOpportunityResortMetric,
} from "../finder-asset-opportunity-metrics";
import { sortFinderUniverseCandidates } from "../finder-universe-metrics";
import { sortStrategyQualityResultsByMetric } from "../finder-strategy-quality";
import {
	FINDER_ARM_PERFORMANCE_REPLAY_FIELDS,
	sortFinderArmPerformanceResults,
	type FinderArmPerformanceDisplayFilter,
	type FinderArmPerformanceArm,
} from "../finder-arm-performance-metrics";
import { DEFAULT_FINDER_UI_STATE, UNIVERSE_SORT_OPTIONS } from "./finder-settings";
import { debounce } from "../../debounce";
import type {
	FinderArmPerformanceCandidate,
	FinderArmPerformanceRunContext,
	FinderAssetOpportunityResult,
	FinderLatestResults,
	FinderMetric,
	FinderStrategyQualityMetric,
	FinderUniverseCandidate,
	FinderUniverseMetric,
} from "../../types/finder";

export class FinderResultStore {
	latestResults: FinderLatestResults = { scope: "current_chart", results: [] };
	/** Full scalar Symbol Universe survivors for post-run re-sort. */
	symbolUniverseRunResults: FinderUniverseCandidate[] = [];
	/** Display limit captured from the completed Symbol Universe run. */
	symbolUniverseDisplayLimit = DEFAULT_FINDER_UI_STATE.topN;
	/**
	 * Full scalar Asset Opportunity rows for the current run, in the WORKING
	 * order produced by the last ordinary re-sort chain. This order is
	 * observable: pairwise metric comparators tie same-symbol rows (the
	 * capped-trades comparator never consults expectancy; the generic
	 * cascade ends at symbol), so the stable sort keeps the working order and
	 * the deduplicated display keeps its first same-symbol row as the
	 * representative. Deriving every view from the default pool would change
	 * winners after an ordinary → ordinary re-sort sequence, so a working
	 * pool plus the default baseline below is the MINIMUM ordering state.
	 * Deleting either array is deferred until ranking policy itself defines
	 * a canonical tie order (which would change observable winners).
	 */
	private assetOpportunityRunResults: FinderAssetOpportunityResult[] = [];
	/** Default-order full rows used when the re-sort control is reset. */
	private assetOpportunityDefaultResults: FinderAssetOpportunityResult[] = [];
	/** Full compact Arm Performance inventory for every post-run arm sort. */
	armPerformanceRunResults: FinderArmPerformanceCandidate[] = [];
	armPerformanceRunContext: FinderArmPerformanceRunContext | null = null;
	armPerformanceApplyContext: Pick<FinderArmPerformanceRunContext, "interval" | "uiBacktestSettings" | "capitalSettings"> | null = null;
	armPerformanceDisplayLimit = DEFAULT_FINDER_UI_STATE.topN;
	armPerformanceInventoryComplete = true;
	armPerformanceDisplayFilter: FinderArmPerformanceDisplayFilter = {};
	/**
	 * Snapshot of the run-time sorted results before any post-run re-sort was
	 * applied. Used to restore the original ordering when the re-sort dropdown
	 * is reset to "Run Sort". Set on every run completion and cleared on start.
	 */
	originalLatestResults: FinderLatestResults | null = null;
	private lastArmDisplayUpdate: {
		inventory: readonly FinderArmPerformanceCandidate[];
		results: FinderLatestResults;
		key: string;
	} | null = null;
	private readonly persistDisplayResultsDebounced = debounce((results: FinderLatestResults) => {
		// A terminal adoption or streamed update may have superseded this view.
		if (this.latestResults === results) this.persistTerminalResults(results);
	}, 300);

	constructor(private readonly persistTerminalResults: (results: FinderLatestResults) => void) {}

	/**
	 * Adopt a result set for the UI. `persist` controls whether the snapshot
	 * is written: provisional render callbacks (streamed candidates, mid-run
	 * current-chart updates) should pass `false` so serialization and
	 * synchronous writes don't run on every render frame. Persistence is used
	 * for semantic checkpoints, including terminal adoption and bounded,
	 * rate-limited Arm Performance previews during a long server run.
	 */
	setLatestResults(results: FinderLatestResults, persist = true): void {
		this.lastArmDisplayUpdate = null;
		this.latestResults = results;
		if (persist) {
			this.persistDisplayResultsDebounced.cancel();
			this.persistTerminalResults(results);
		}
	}

	/** Keep displayed and copied Asset Opportunity rows unique by pair symbol. */
	setAssetOpportunityLatestResults(
		results: readonly FinderAssetOpportunityResult[],
		persist = true,
		limit = DEFAULT_FINDER_UI_STATE.topN,
	): void {
		this.setLatestResults({
			scope: 'asset_opportunity',
			results: deduplicateAssetOpportunityResultsBySymbol(results)
				.slice(0, Math.max(1, limit)),
		}, persist);
	}

	/**
	 * Adopt a terminal Asset Opportunity inventory (normal stream done,
	 * status recovery, terminal reattach, latest batch iteration): retain
	 * the full run-order rows for post-run re-sort, keep the Run Sort
	 * default copy, and display the deduplicated top-N. `persist` and
	 * `limit` are explicit — call sites must not rely on differing defaults.
	 */
	adoptAssetOpportunityResults(
		results: readonly FinderAssetOpportunityResult[],
		persist: boolean,
		limit: number,
	): void {
		this.assetOpportunityRunResults = sortAssetOpportunityResults([...results]);
		this.assetOpportunityDefaultResults = [...this.assetOpportunityRunResults];
		this.setAssetOpportunityLatestResults(this.assetOpportunityRunResults, persist, limit);
	}

	/**
	 * Provisional streamed rows: refresh the working inventory and display
	 * without persisting or touching the terminal Run Sort baseline.
	 */
	setAssetOpportunityProvisionalResults(
		results: readonly FinderAssetOpportunityResult[],
		limit: number,
	): void {
		this.assetOpportunityRunResults = sortAssetOpportunityResults([...results]);
		this.setAssetOpportunityLatestResults(this.assetOpportunityRunResults, false, limit);
	}

	/**
	 * Restore persisted Asset Opportunity rows after a reload. The saved rows
	 * are already the bounded, deduplicated saved display view (possibly a
	 * re-sorted metric view): keep their saved order — never grade-sort a
	 * saved view — and do not persist the snapshot back over itself.
	 */
	restoreAssetOpportunityResults(results: readonly FinderAssetOpportunityResult[]): void {
		const restored = deduplicateAssetOpportunityResultsBySymbol(results);
		this.assetOpportunityRunResults = [...restored];
		this.assetOpportunityDefaultResults = [...restored];
		this.latestResults = { scope: 'asset_opportunity', results: [...restored] };
	}

	/** Retain the full terminal Universe run while rendering only the display topN. */
	adoptSymbolUniverseResults(
		results: readonly FinderUniverseCandidate[],
		persist = true,
		limit = this.symbolUniverseDisplayLimit,
	): void {
		this.symbolUniverseRunResults = [...results];
		this.setLatestResults({
			scope: 'symbol_universe',
			results: this.symbolUniverseRunResults.slice(0, Math.max(1, limit)),
		}, persist);
	}

	setArmPerformanceLatestResults(
		results: readonly FinderArmPerformanceCandidate[],
		persist = true,
		limit = this.armPerformanceDisplayLimit,
		inventoryComplete = this.armPerformanceInventoryComplete,
	): void {
		this.setLatestResults({
			scope: 'arm_performance',
			results: [...results].slice(0, Math.max(1, limit)),
			runContext: this.armPerformanceRunContext,
			inventoryComplete,
		}, persist);
	}

	adoptArmPerformanceResults(
		results: readonly FinderArmPerformanceCandidate[],
		context: FinderArmPerformanceRunContext | null,
		complete: boolean,
		persist = true,
	): void {
		this.armPerformanceRunResults = [...results];
		this.armPerformanceRunContext = context;
		this.armPerformanceInventoryComplete = complete;
		// The run context is provenance. Display preferences may have changed
		// while its stream was running, so only derive a display default when no
		// current preference has been initialized (for example, snapshot restore).
		if (Object.keys(this.armPerformanceDisplayFilter).length === 0) {
			const armOptions = context?.searchOptions?.armPerformance;
			this.armPerformanceDisplayFilter = {
				measurement: armOptions?.measurement ?? "return",
				rankingSort: armOptions?.rankingSort ?? "overall_ordering",
				rankingHorizon: armOptions?.replayMode === "asset_switch" ? armOptions?.rankingHorizon : armOptions?.horizon,
				basis: armOptions?.scoringBasis ?? "raw",
				eventFilterEnabled: armOptions?.eventFilterEnabled ?? false,
				minEvents: armOptions?.minEvents ?? 1,
				maxEvents: armOptions?.maxEvents ?? null,
			};
		}
		this.setArmPerformanceLatestResults(
			sortFinderArmPerformanceResults(
				this.armPerformanceRunResults,
				'TOP_RAW_PROFIT_NOW',
				this.armPerformanceDisplayFilter,
			),
			persist,
			this.armPerformanceDisplayLimit,
			complete,
		);
	}

	/** Clear retained inventories between runs; display limits are set separately. */
	resetForNewRun(): void {
		this.persistDisplayResultsDebounced.cancel();
		this.lastArmDisplayUpdate = null;
		this.originalLatestResults = null;
		this.symbolUniverseRunResults = [];
		this.assetOpportunityRunResults = [];
		this.assetOpportunityDefaultResults = [];
		this.armPerformanceRunResults = [];
		this.armPerformanceRunContext = null;
		this.armPerformanceApplyContext = null;
		this.armPerformanceInventoryComplete = true;
		this.armPerformanceDisplayFilter = {};
	}

	/** Capture both scope display limits from the run's topN. */
	setRunDisplayLimits(topN: number): void {
		this.symbolUniverseDisplayLimit = Math.max(1, topN);
		this.armPerformanceDisplayLimit = Math.max(1, topN);
	}

	/** Initialize display settings from the submitted options before streaming. */
	initializeArmPerformanceDisplayFilter(filter: FinderArmPerformanceDisplayFilter): void {
		this.armPerformanceDisplayFilter = { ...filter };
	}

	/** Return false when duplicate control events describe the already rendered view. */
	setArmPerformanceDisplayFilter(filter: FinderArmPerformanceDisplayFilter, arm?: FinderArmPerformanceArm): boolean {
		const selectedArm = arm ?? "TOP_RAW_PROFIT_NOW";
		const key = JSON.stringify([
			selectedArm, this.armPerformanceDisplayLimit, filter.measurement, filter.rankingSort,
			filter.rankingHorizon, filter.basis, filter.eventFilterEnabled, filter.minEvents, filter.maxEvents,
		]);
		if (this.lastArmDisplayUpdate?.inventory === this.armPerformanceRunResults
			&& this.lastArmDisplayUpdate.results === this.latestResults
			&& this.lastArmDisplayUpdate.key === key) return false;
		this.armPerformanceDisplayFilter = { ...filter };
		// Sort only the arm the user selected; the default view is derived on
		// demand by restoreRunSort.
		this.setArmPerformanceLatestResults(sortFinderArmPerformanceResults(
			this.armPerformanceRunResults,
			selectedArm,
			this.armPerformanceDisplayFilter,
		), false);
		this.lastArmDisplayUpdate = { inventory: this.armPerformanceRunResults, results: this.latestResults, key };
		this.persistDisplayResultsDebounced(this.latestResults);
		return true;
	}

	/** Flush the last display preference checkpoint before the page is hidden. */
	flushPendingDisplayPersistence(): void {
		this.persistDisplayResultsDebounced.flush();
	}

	/**
	 * Reset the re-sort baseline: the current results become the run-time
	 * ordering restored by "Run Sort". The dropdown reset stays in the UI
	 * layer.
	 */
	stashRunSortBaseline(): void {
		this.originalLatestResults = this.latestResults;
	}

	/**
	 * "Run Sort" — restore original run-time ordering. Never reached for Arm
	 * Performance: `FinderManager.applyResort` routes that scope through
	 * `applyArmPerformanceDisplaySettings`, whose Run Sort re-applies the
	 * current display filter to the selected (or default) arm.
	 */
	restoreRunSort(): void {
		const scope = this.latestResults.scope;
		if (scope === 'asset_opportunity' && this.assetOpportunityDefaultResults.length > 0) {
			this.assetOpportunityRunResults = [...this.assetOpportunityDefaultResults];
			this.setAssetOpportunityLatestResults(this.assetOpportunityRunResults);
		} else if (scope === 'symbol_universe' && this.symbolUniverseRunResults.length > 0) {
			this.setLatestResults({
				scope: 'symbol_universe',
				results: this.symbolUniverseRunResults.slice(0, Math.max(1, this.symbolUniverseDisplayLimit)),
			});
		} else if (this.originalLatestResults && this.originalLatestResults.scope === scope) {
			this.setLatestResults(this.originalLatestResults);
		}
	}

	/** Apply a specific re-sort metric to the retained inventories. */
	applyResortMetric(metric: string): void {
		const scope = this.latestResults.scope;
		if (scope === 'current_chart') {
			const results = this.latestResults.results;
			const sorted = sortFinderResults(results, [metric as FinderMetric], {
				useOosValues: metric === "exitAlpha" && results.some((result) => result.oosResult !== undefined),
			});
			this.setLatestResults({ scope: 'current_chart', results: sorted });
		} else if (scope === 'symbol_universe') {
			const source = this.symbolUniverseRunResults.length > 0
				? this.symbolUniverseRunResults
				: this.latestResults.results;
			const sorted = sortFinderUniverseCandidates(source, [metric as FinderUniverseMetric], {
				useOosValues: metric === "medianExitAlpha" && source.some((result) => result.oosAggregate !== undefined),
			});
			this.setLatestResults({
				scope: 'symbol_universe',
				results: sorted.slice(0, Math.max(1, this.symbolUniverseDisplayLimit)),
			});
		} else if (scope === 'asset_opportunity') {
			const isConsensusMetric = metric === FRESH_SIGNAL_LIBRARIES_METRIC
				|| metric === FRESH_SIGNAL_LIBRARIES_BY_TRADES_METRIC
				|| metric === STRATEGY_COVERAGE_GATE_METRIC;
			const results = isConsensusMetric && this.assetOpportunityDefaultResults.length > 0
				? this.assetOpportunityDefaultResults
				: this.assetOpportunityRunResults.length > 0
					? this.assetOpportunityRunResults
					: this.latestResults.results;
			const sorted = sortAssetOpportunityResultsByMetric(
				results,
				metric as FinderAssetOpportunityResortMetric,
			);
			// Grouped modes return one representative row per symbol. Keep the
			// full strategy-level result set intact so another re-sort can still
			// inspect every strategy row.
			if (!isConsensusMetric) {
				this.assetOpportunityRunResults = sorted;
			}
			this.setAssetOpportunityLatestResults(sorted);
		} else if (scope === 'strategy_quality') {
			const results = this.latestResults.results;
			const sorted = sortStrategyQualityResultsByMetric(results, metric as FinderStrategyQualityMetric);
			this.setLatestResults({ scope: 'strategy_quality', results: sorted });
		} else if (scope === 'arm_performance') {
			const sorted = sortFinderArmPerformanceResults(
				this.armPerformanceRunResults,
				metric as FinderArmPerformanceArm,
				this.armPerformanceDisplayFilter,
			);
			this.setArmPerformanceLatestResults(sorted);
		}
	}

	/**
	 * Post-run re-sort dropdown options for the current scope. Each scope
	 * offers the same metrics its pre-run sort offers, minus metrics whose
	 * values the retained inventory cannot supply.
	 */
	getResortOptions(): Array<{ value: string; label: string }> {
		const options: Array<{ value: string; label: string }> = [];
		const scope = this.latestResults.scope;
		if (scope === 'symbol_universe') {
			const results = this.symbolUniverseRunResults.length > 0
				? this.symbolUniverseRunResults
				: this.latestResults.scope === "symbol_universe" ? this.latestResults.results : [];
			const hasMedianExitAlpha = results.some((result) => result.oosAggregate !== undefined
				? Number.isFinite(result.medianOosExitAlpha)
				: Number.isFinite(result.medianExitAlpha));
			for (const metric of UNIVERSE_SORT_OPTIONS) {
				if (metric === "medianExitAlpha" && !hasMedianExitAlpha) continue;
				options.push({ value: metric, label: UNIVERSE_METRIC_FULL_LABELS[metric] });
			}
		} else if (scope === 'asset_opportunity') {
			const invertedLabels: Partial<Record<FinderAssetOpportunityResortMetric, string>> = {
				[INVERTED_NET_PROFIT_METRIC]: "Net Profit (inverted — worst first)",
				[INVERTED_EXPECTANCY_METRIC]: "Expectancy (inverted — worst first)",
				[INVERTED_AVERAGE_GAIN_METRIC]: "Average Gain (inverted — worst first)",
				[INVERTED_WIN_RATE_METRIC]: "Win Rate (inverted — worst first)",
				[INVERTED_SHARPE_RATIO_METRIC]: "Sharpe Ratio (inverted — worst first)",
				[INVERTED_PROFIT_FACTOR_METRIC]: "Profit Factor (inverted — worst first)",
				[INVERTED_MAX_DRAWDOWN_METRIC]: "Max Drawdown % (inverted — worst first)",
			};
			for (const metric of getAssetOpportunityResortMetrics()) {
				options.push({
					value: metric,
					label: invertedLabels[metric]
						?? (metric === FRESH_SIGNAL_LIBRARIES_METRIC
							? "Fresh Signals (Libraries)"
							: metric === FRESH_SIGNAL_LIBRARIES_BY_TRADES_METRIC
								? "Fresh Signals (Libraries, by Trades)"
								: metric === TOP_RAW_SUPPORT_METRIC
									? "Fresh Support (TOP_RAW)"
								: metric === TOTAL_TRADES_CAPPED_METRIC
									? `Total Trades (P${Math.round(TOTAL_TRADES_SATURATION_PERCENTILE * 100)} saturation)`
								: metric === MEDIAN_BARS_TO_TP_METRIC
									? "Median Bars To Take Profit (lower first)"
								: metric === PRIOR_TUPLE_RECURRENCE_METRIC
									? "Prior Fold Tuple Recurrence"
								: metric === STRATEGY_COVERAGE_GATE_METRIC
									? "Strategy Coverage Gate (PF first)"
								: metric === BARRIER_EXIT_SHARE_METRIC
									? "Barrier Exit Dominance Share"
								: metric === TRADE_GAP_UNIFORMITY_METRIC
									? "Trade Gap Uniformity Score"
								: metric === TOP_DECILE_PROFIT_SHARE_METRIC
									? "Top Decile Profit Concentration (lower first)"
								: metric === WINNER_LOSER_HOLD_GAP_BARS_METRIC
									? "Winner Vs Loser Holding Gap (lower first)"
								: metric === EQUITY_PATH_LINEARITY_METRIC
									? "Equity Path Linearity"
								// Safe cast: the inverted labels map above covers every
								// non-FinderMetric member left in the union here.
								: METRIC_FULL_LABELS[metric as FinderMetric]),
				});
			}
		} else if (scope === 'strategy_quality') {
			for (const metric of STRATEGY_QUALITY_SORT_OPTIONS) {
				options.push({ value: metric, label: STRATEGY_QUALITY_METRIC_FULL_LABELS[metric] });
			}
		} else if (scope === 'arm_performance') {
			for (const arm of Object.keys(FINDER_ARM_PERFORMANCE_REPLAY_FIELDS) as FinderArmPerformanceArm[]) {
				const label = arm.replaceAll('_', ' ');
				options.push({
					value: arm,
					label: arm === 'TOP_RAW_PROFIT' || arm === 'TOP_MEAN_PROFIT'
						? `${label} (look-ahead research)`
						: label,
				});
			}
		} else {
			const results = this.latestResults.scope === "current_chart" ? this.latestResults.results : [];
			const hasExitAlpha = results.some((result) => result.oosResult !== undefined
				? Number.isFinite(result.oosExitAlpha)
				: Number.isFinite(result.exitAlpha));
			for (const metric of FINDER_SORT_OPTIONS) {
				if (metric === "exitAlpha" && !hasExitAlpha) continue;
				options.push({ value: metric, label: METRIC_FULL_LABELS[metric] });
			}
		}
		return options;
	}
}
