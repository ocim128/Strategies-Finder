import { StrategyParams, type OHLCVData } from "./strategies/index";
import { strategyRegistry, getStrategyList, loadBuiltInStrategyByKey, ensureStrategyKeysLoaded } from "../strategyRegistry";
import { state } from "./state";
import { backtestService } from "./backtest-service";
import { uiManager } from "./ui-manager";
import { setVisible } from "./dom-utils";
import { dataManager } from "./data-manager";
import { settingsManager } from "./settings-manager";
import { getLocalDailyAssets } from "./local-daily-datasets";
import { cloneJsonCompatible, parseJsonPreservingNonFinite } from "./json-utils";
import { debounce } from "./debounce";

import {
	FINDER_SORT_OPTIONS,
	METRIC_FULL_LABELS,
	UNIVERSE_METRIC_FULL_LABELS,
} from "./finder/constants";
import { formatCapturedConfiguration } from "./finder/finder-config-capture";
import {
	buildFinderOptions,
	buildFinderUniverseOptions,
	normalizeFinderDataSlice,
	normalizeFinderDateInput,
} from "./finder/finder-manager-logic";
import type { FinderSelectedStrategy } from "./finder/finder-runner";
import { FinderParamSpace } from "./finder/finder-param-space";
import { FinderUI } from "./finder/finder-ui";
import {
} from "./finder/finder-strategy-quality";
import {
	ASSET_OPPORTUNITY_ALL_SORTS,
	deduplicateAssetOpportunityResultsBySymbol,
	sortAssetOpportunityResults,
} from "./finder/finder-asset-opportunity-metrics";
import { debugLogger } from "./debug-logger";
import { parseInputNumber } from "./dom-input-readers";
import { setCurrentInterval } from "./state-actions";
import { createTaskYielder } from "./task-yield";
import {
	createFinderManagerDom,
	type FinderManagerDom,
} from "./finder/finder-manager-dom";
import {
	normalizeFinderAssetEvalLastBars,
	normalizeFinderAssetEvalWindowMode,
	normalizeFinderAssetOosHorizonBasis,
	normalizeFinderAssetOosBatchHoldoutRange,
	normalizeFinderAssetOosMeasurementMode,
	normalizeFinderAssetOosHorizons,
	normalizeFinderAssetOosIgnoreLastBars,
} from "./finder/finder-asset-opportunity-oos";
import {
	DEFAULT_FINDER_UI_STATE,
	emptyFinderLatestResults,
	isAdvancedOptionalSortMetric,
	isTimingSortMetric,
	normalizeAdvancedSortOrder,
	normalizeFinderMetric,
	normalizeFinderMode,
	normalizeFinderScope,
	normalizeFinderUiState,
	normalizeFinderUniverseMetric,
	UNIVERSE_SORT_OPTIONS,
	type FinderPersistedUiState,
} from "./finder/browser/finder-settings";
import {
	clearFinderLatestResultsSnapshot,
	readFinderActiveServerRun,
	readFinderLatestResultsSnapshot,
	readFinderUiState,
	writeFinderLatestResultsSnapshot,
	writeFinderUiState,
	type FinderPersistedActiveServerRun,
} from "./finder/browser/finder-persistence";
import { FinderResultStore } from "./finder/browser/finder-result-store";
import { FinderStrategySelection } from "./finder/browser/finder-strategy-selection";
import { FinderResultActions } from "./finder/browser/finder-result-actions";
import { FinderServerSession, createFinderStatusRequestSignal, type FinderSessionHost } from "./finder/browser/finder-server-session";
import { runCurrentChartFinder } from "./finder/browser/workflows/current-chart";
import { runUniverseFinder } from "./finder/browser/workflows/symbol-universe";
import {
	runAssetOpportunityFinder,
	runAssetOpportunityBatchFinder,
	runAssetOpportunityBatchFinderServer,
	type BatchHoldoutRange,
} from "./finder/browser/workflows/asset-opportunity";
import { runArmPerformanceFinder } from "./finder/browser/workflows/arm-performance";
import { runStrategyQualityFinder } from "./finder/browser/workflows/strategy-quality";
import type { FinderRunHost } from "./finder/browser/workflows/finder-run-host";
import {
	buildArmPerformanceDiagnosticsPayload,
	buildArmPerformanceRunConfigurationPayload,
	buildAssetOpportunityDiagnosticsPayload,
	buildCompactFinderDiagnosticsPayload,
	buildFinderRunConfigurationPayload,
	buildFinderTopResultsPayload,
	copyTextToClipboard,
} from "./finder/browser/finder-export";
import {
	buildFailureDiagnostics,
} from "./finder/browser/finder-run-diagnostics";
import type {
    FinderArmPerformanceCandidate,
    FinderArmPerformanceRunContext,
	FinderLatestResults,
	FinderDiagnostics,
	FinderMetric,
	FinderMode,
	FinderOptions,
	FinderScope,
	FinderResult,
	FinderAssetOpportunityResult,
	FinderStrategyQualityResult,
	FinderUniverseCandidate,
} from './types/finder';
import type { FinderArmPerformanceArm } from "./finder/finder-arm-performance-metrics";

const MAJOR_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "ADAUSDT"] as const;
const FINDER_FOLLOW_STRATEGY_KEYS = [
	"decay_momentum_alignment",
	"volatility_regime_median_alignment",
	"initiative_pressure_acceleration_follow",
	"volatility_breakout_follow",
	"accumulation_persistence_streak_gate",
] as const;
const FINDER_REVERSION_STRATEGY_KEYS = [
	"decay_pressure_percentile_reversion",
	"cumulative_return_zscore_reversion",
	"cumulative_return_percentile_reversion",
	"acceptance_deviation_median_reversion",
	"negative_autocorrelation_median_reversion",
	"range_expansion_exhaustion_reversion",
	"probability_boundary_eigen_shift",
] as const;

import type { FinderRunStatusSnapshot } from "./finder/server/finder-stream-types";


export class FinderManager {
	private isRunning = false;
	private runStartupInFlight = false;
	private isCancelled = false;
	private finderRunAbortController: AbortController | null = null;
	/** Owns every result inventory, display limit, and the run-sort baseline. */
	private readonly resultStore = new FinderResultStore(
		(results) => this.saveLatestResultsSnapshot(results),
	);
	/** Owns the per-scope strategy selection sets and their checkbox DOM. */
	private readonly selection = new FinderStrategySelection({
		getDom: () => this.getDom(),
		getUiState: () => this.uiState,
		isUniverseSelectionScope: () => this.usesUniverseStrategySelection(),
		persist: () => this.saveUiState(),
	});
	/** Owns server run ownership, scoped Stop, and reattach/recovery polling. */
	private readonly session = new FinderServerSession();
	/** Owns candidate Apply flows and the apply-in-flight guard. */
	private readonly resultActions = new FinderResultActions({
		getResultStore: () => this.resultStore,
		getLastRunBacktestSettings: () => this.lastFinderRunBacktestSettings,
		getLastFinderOptions: () => this.lastFinderOptions,
		getLastFinderEvaluationData: () => this.lastFinderEvaluationData,
	});
	private latestDiagnostics: FinderDiagnostics | null = null;
	private latestAssetOpportunityDiagnostics: FinderDiagnostics['assetOpportunity'] | null = null;
	private lastFinderRunBacktestSettings: ReturnType<typeof settingsManager.getBacktestSettings> | null = null;
	private lastFinderOptions: FinderOptions | null = null;
	private lastFinderEvaluationData: { interval: string; data: OHLCVData[] } | null = null;
	private uiState: FinderPersistedUiState = normalizeFinderUiState(null);
	private readonly ui = new FinderUI();
	private readonly persistUiStateDebounced = debounce(() => this.saveUiState(), 300);
	private finderPersistenceLifecycleBound = false;
	private readonly paramSpace = new FinderParamSpace();
	private readonly taskYielder = createTaskYielder();
	private dom: FinderManagerDom | null = null;
	private getDom(): FinderManagerDom {
		return this.dom ??= createFinderManagerDom();
	}

	public async invalidateLocalDataCaches(): Promise<boolean> {
		// Universe synthetic leg/pair caches now live in the Vite server. Keep
		// the existing invalidation contract used by IBKR/Crypto data sync so a
		// subsequent Finder run cannot reuse an in-memory series built before the
		// local files changed. Disk entries remain fingerprint-validated.
		try {
			const response = await fetch('/api/finder/invalidate-cache', { method: 'POST' });
			if (!response.ok) {
				throw new Error(`Finder cache invalidation failed (${response.status}).`);
			}
			const payload = await response.json() as { ok?: unknown };
			if (payload.ok !== true) {
				throw new Error('Finder cache invalidation was not accepted by the server.');
			}
			return true;
		} catch (error) {
			debugLogger.warn('finder.server.dataset_cache_invalidation_failed', {
				error: error instanceof Error ? error.message : String(error),
			});
			return false;
		}
	}

	private getScope(): FinderScope {
		return this.uiState.scope;
	}

	private isUniverseScope(): boolean {
		return this.getScope() === "symbol_universe";
	}

	private isAssetOpportunityScope(): boolean {
		return this.getScope() === "asset_opportunity";
	}

	private isStrategyQualityScope(): boolean {
		return this.getScope() === "strategy_quality";
	}

	private isArmPerformanceScope(): boolean {
		return this.getScope() === "arm_performance";
	}

	private usesUniverseStrategySelection(): boolean {
		return this.isUniverseScope() || this.isStrategyQualityScope() || this.isArmPerformanceScope();
	}

	private loadUiState(): void {
		this.uiState = readFinderUiState();
	}

	private saveUiState(): void {
		writeFinderUiState(this.uiState);
	}

	private loadPersistedLatestResults(): void {
		const snapshot = readFinderLatestResultsSnapshot();
		if (!snapshot) return;

		const restoredResults = snapshot.results.scope === 'asset_opportunity'
			? {
				scope: 'asset_opportunity' as const,
				results: deduplicateAssetOpportunityResultsBySymbol(snapshot.results.results),
			}
			: snapshot.results;
		this.resultStore.latestResults = restoredResults;
		if (restoredResults.scope === 'asset_opportunity') {
			this.resultStore.assetOpportunityRunResults = [...restoredResults.results];
			this.resultStore.assetOpportunityDefaultResults = [...restoredResults.results];
		} else if (restoredResults.scope === 'arm_performance') {
			this.resultStore.armPerformanceRunResults = [...restoredResults.results];
			this.resultStore.armPerformanceDefaultResults = [...restoredResults.results];
			this.resultStore.armPerformanceRunContext = restoredResults.runContext;
			this.resultStore.armPerformanceInventoryComplete = restoredResults.inventoryComplete;
			this.resultStore.armPerformanceDisplayLimit = Math.max(1, this.uiState.topN);
			this.getDom().finderCopyDiagnostics.disabled = !restoredResults.runContext && restoredResults.results.length === 0;
		}
		debugLogger.event("finder.latest_results_restored", {
			scope: restoredResults.scope,
			count: restoredResults.results.length,
			symbol: snapshot.symbol,
			interval: snapshot.interval,
			savedAt: snapshot.savedAt,
		});
	}

	private saveLatestResultsSnapshot(results: FinderLatestResults): void {
		writeFinderLatestResultsSnapshot({
			symbol: state.currentSymbol,
			interval: state.currentInterval,
			results,
		});
	}

	private clearLatestResultsSnapshot(): void {
		clearFinderLatestResultsSnapshot();
	}

	private loadPersistedActiveServerRun(): FinderPersistedActiveServerRun | null {
		return readFinderActiveServerRun();
	}

	/** Cancel any in-flight reattach poll loop immediately. */
	private stopReattachPoll(): void {
		this.session.stopReattachPoll();
	}

	private async stopActiveServerRun(runId: string): Promise<void> {
		await this.session.stopServerRun(runId, { setStatus: (text) => this.setStatus(text) });
	}

	private parseUniverseSymbols(rawText = this.getDom().finderUniverseSymbols.value): string[] {
		const unique = new Set<string>();
		for (const token of rawText.split(/[\s,]+/)) {
			const normalized = token.trim().toUpperCase();
			if (normalized) {
				unique.add(normalized);
			}
		}
		return [...unique];
	}

	private updateUniverseSummary(): void {
		const dom = this.getDom();
		if (this.isArmPerformanceScope()) {
			const pairs = dom.finderUniverseSymbols.value.split(/[\r\n,]+/).map((value) => value.trim()).filter(Boolean);
			dom.finderUniverseSummary.textContent = `${pairs.length} pair${pairs.length === 1 ? "" : "s"}`;
			return;
		}
		const symbols = this.parseUniverseSymbols(dom.finderUniverseSymbols.value);
		dom.finderUniverseSummary.textContent = `${symbols.length} symbol${symbols.length === 1 ? "" : "s"}`;
	}


	private async populateUniverseWithLocalDailySeeds(): Promise<void> {
		const dom = this.getDom();
		dom.finderUniverseUseLocalSp500.disabled = true;

		try {
			const assets = (await getLocalDailyAssets()).filter((asset) => asset.provider !== "ibkr-local");
			const symbols = assets
				.map((asset) => asset.symbol.trim().toUpperCase())
				.filter(Boolean);

			if (symbols.length === 0) {
				this.setStatus("Local seed catalogs are unavailable.");
				uiManager.showToast("Local seed catalogs are unavailable.", "warning");
				return;
			}

			for (const asset of assets) {
				dataManager.setProviderOverride(asset.symbol, asset.provider);
			}
			if (state.currentInterval !== "1d") {
				setCurrentInterval("1d");
			}
			dom.finderUniverseSymbols.value = symbols.join("\n");
			this.uiState.universeSymbolsText = dom.finderUniverseSymbols.value;
			this.updateUniverseSummary();
			this.saveUiState();
			this.setStatus(`Loaded ${symbols.length} local daily seed symbols for Symbol Universe mode on 1d.`);
		} catch (error) {
			debugLogger.error("finder.local_daily_universe_load_failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			this.setStatus("Unable to load local seed catalogs.");
			uiManager.showToast("Unable to load local seed catalogs.", "error");
		} finally {
			dom.finderUniverseUseLocalSp500.disabled = false;
		}
	}

	private readFinderNumberInput(input: HTMLInputElement, fallback: number, min?: number): number {
		const value = parseInputNumber(input.value);
		if (value === null) return fallback;
		return min === undefined ? value : Math.max(min, value);
	}

	private applyPersistedUiStateToDom(): void {
		const dom = this.getDom();
		dom.finderScope.value = this.uiState.scope;
		dom.finderSort.value = this.uiState.sortPrimary;
		dom.finderSortSecondary.value = this.uiState.sortSecondary;
		dom.finderAdvancedToggle.checked = this.uiState.useAdvancedSort;
		setVisible(dom.finderSimpleSort, !this.uiState.useAdvancedSort);
		setVisible(dom.finderSortList, this.uiState.useAdvancedSort);
		this.applyAdvancedSortStateToDom();
		dom.finderMode.value = this.uiState.mode;
		dom.finderDataSlice.value = this.uiState.dataSlice;
		dom.finderDataRangeFrom.value = this.uiState.dataRangeFrom;
		dom.finderDataRangeTo.value = this.uiState.dataRangeTo;
		dom.finderTopN.value = String(this.uiState.topN);
		dom.finderMaxRuns.value = String(this.uiState.maxRuns);
		dom.finderRange.value = String(this.uiState.rangePercent);
		dom.finderSteps.value = String(this.uiState.steps);
		dom.finderFreezeRiskManagementToggle.checked = this.uiState.freezeRiskManagement;
		dom.finderRandomizePathExitToggle.checked = this.uiState.randomizePathExitParams;
		dom.finderExitStrategyOverrideToggle.checked = this.uiState.exitStrategyOverrideEnabled;
		dom.finderTradesToggle.checked = this.uiState.tradeFilterEnabled;
		dom.finderTradesMin.value = String(this.uiState.minTrades);
		dom.finderTradesMax.value = this.uiState.maxTradesText;
		dom.finderOosValidationToggle.checked = this.uiState.oosValidationEnabled;
		dom.finderArmPerformanceHorizon.value = String(this.uiState.armPerformanceHorizon);
		dom.finderUniverseSymbols.value = this.uiState.universeSymbolsText;
		dom.finderUniverseMinActiveSymbols.value = String(this.uiState.universeMinActiveSymbols);
		dom.finderUniverseMinTotalTrades.value = String(this.uiState.universeMinTotalTrades);
		dom.finderUniverseMinProfitableActiveRatio.value = String(this.uiState.universeMinProfitableActiveRatio);
		dom.finderAssetCandidatePoolSize.value = String(this.uiState.assetOpportunityCandidatePoolSize);
		dom.finderAssetMinFreshSupport.value = String(this.uiState.assetOpportunityMinFreshSupport);
		dom.finderAssetIncludeOpenPositions.checked = this.uiState.assetOpportunityIncludeOpenPositions;
		dom.finderAssetOosMeasurementMode.value = this.uiState.assetOpportunityOosMeasurementMode;
		dom.finderAssetOosHorizonBasis.value = this.uiState.assetOpportunityOosHorizonBasis;
		dom.finderAssetOosIgnoreLastBars.value = String(this.uiState.assetOpportunityOosIgnoreLastBars);
		dom.finderAssetOosHorizons.value = this.uiState.assetOpportunityOosHorizons;
		dom.finderAssetEvalWindowMode.value = this.uiState.assetOpportunityEvalWindowMode;
		dom.finderAssetEvalWindowBars.value = String(this.uiState.assetOpportunityEvalWindowBars);
		dom.finderAssetOosBatchToggle.checked = this.uiState.assetOpportunityOosBatchEnabled;
		dom.finderAssetOosBatchStart.value = String(this.uiState.assetOpportunityOosBatchStartBars);
		dom.finderAssetOosBatchEnd.value = String(this.uiState.assetOpportunityOosBatchEndBars);
		this.syncAssetOosBatchControls();
		this.updateUniverseSummary();
	}

	public init() {
		this.loadUiState();
		const dom = this.getDom();
		if (!this.finderPersistenceLifecycleBound && typeof window !== "undefined") {
			window.addEventListener("pagehide", () => this.persistUiStateDebounced.flush());
			this.finderPersistenceLifecycleBound = true;
		}
		dom.runFinder.addEventListener('click', () => {
			void this.runFinder();
		});

		dom.stopFinder.addEventListener('click', () => {
			this.isCancelled = true;
			this.finderRunAbortController?.abort();
			// Cancel any in-flight reattach poll immediately so Stop changes UI
			// ownership before the next poll iteration.
			this.stopReattachPoll();
			// Server-owned Finder Universe: the job lives in the dev server, so
			// `this.isCancelled` alone does NOT stop it — the server checks
			// ownership loss + abort via POST /api/finder/stop with the active
			// run id (Stop is scoped by run id so a stale tab cannot cancel a
			// newer run). Fire-and-forget; only POST when a run is in flight
			// AND the active run id is known.
			const activeRunId = this.session.activeRunId;
			if (this.isRunning && activeRunId) {
				// Drop local ownership immediately so late stream callbacks cannot
				// mutate the stopped view. Keep the persisted marker until the server
				// confirms Stop; on a network failure a reload can still reattach.
				this.session.activeRunId = null;
				void this.stopActiveServerRun(activeRunId);
			}
		});

		dom.resetFinderSettings.addEventListener('click', () => {
			this.resetFinderSettings();
		});

		const copyTopButton = dom.finderCopyTopResults;
		copyTopButton.disabled = true;
		copyTopButton.addEventListener('click', () => {
			void this.copyTopResultsMetadata();
		});
		dom.finderCopyDiagnostics.disabled = true;
		dom.finderCopyDiagnostics.addEventListener('click', () => {
			void this.copyFinderDiagnostics();
		});

		dom.finderCopyConfiguration.addEventListener('click', () => {
			void this.copyRunConfiguration();
		});

		dom.finderList.addEventListener('click', (event) => {
			const target = event.target as HTMLElement | null;
			const button = target?.closest<HTMLButtonElement>('.finder-apply');
			if (!button) return;
			const index = Number(button.dataset.index);
			if (this.resultStore.latestResults.scope === "current_chart") {
				const result = this.resultStore.latestResults.results[index];
				if (result) {
					void this.resultActions.runFinderApply(() => this.resultActions.applyCurrentChartResult(result));
				}
				return;
			}
			if (this.resultStore.latestResults.scope === "asset_opportunity") {
				const assetResult = this.resultStore.latestResults.results[index];
				if (assetResult) {
					void this.resultActions.runFinderApply(() => this.resultActions.applyAssetOpportunityResult(assetResult));
				}
				return;
			}
			if (this.resultStore.latestResults.scope === "arm_performance") {
				const candidate = this.resultStore.latestResults.results[index];
				if (candidate) {
					void this.resultActions.runFinderApply(() => this.resultActions.applyArmPerformanceCandidate(candidate));
				}
				return;
			}
			if (this.resultStore.latestResults.scope === "strategy_quality") {
				return;
			}
			const candidate = this.resultStore.latestResults.results[index];
			if (candidate) {
				void this.resultActions.runFinderApply(() => this.resultActions.applyUniverseCandidate(candidate));
			}
		});

		this.selection.renderStrategySelection();
		this.initStrategySelectionUI();

		this.initSortingUI();
		this.applyPersistedUiStateToDom();
		this.initUniverseUI();
		this.initTradeFilterUI();
		this.initFinderSettingsPersistenceUI();
		this.initOosValidationUI();
		this.getDom().finderResort.addEventListener("change", () => this.applyResort());
		this.applyScopeUi();
		this.loadPersistedLatestResults();
		this.populateResortOptions();
		this.renderLatestResults();
		// Reattach to an in-flight or terminal server-owned Universe job after
		// a tab reload. Finder is lazy-loaded, so this runs on first Finder
		// activation (not global startup). No-op when there is no persisted
		// active run id.
		void this.reattachToActiveServerRun();
	}

	private initOosValidationUI(): void {
		const dom = this.getDom();
		const refresh = () => {
			this.syncOosValidationControlState();
			this.syncDataRangeControlState();
		};
		dom.finderDataSlice.addEventListener('change', refresh);
		refresh();
	}

	/**
	 * The From/To date inputs only apply when Data Window is "Date range";
	 * keep the row visibility in step so an inert pair of date fields is never
	 * shown for the other window modes.
	 */
	private syncDataRangeControlState(): void {
		const dom = this.getDom();
		const dateRangeActive = normalizeFinderDataSlice(dom.finderDataSlice.value) === 'date_range';
		dom.finderDataRangeRow.style.display = dateRangeActive ? "" : "none";
	}

	private initSortingUI(): void {
		// Populate Dropdowns
		const {
			finderSort: sortPrimary,
			finderSortSecondary: sortSecondary,
			finderAdvancedToggle: toggle,
			finderSimpleSort: simpleSection,
			finderSortList: advancedSection,
			finderUniverseSort,
			finderUniverseSortSecondary,
		} = this.getDom();

		const optionsHtml = FINDER_SORT_OPTIONS.map(key =>
			`<option value="${key}">${METRIC_FULL_LABELS[key]}</option>`
		).join('');
		const universeOptionsHtml = UNIVERSE_SORT_OPTIONS.map((key) =>
			`<option value="${key}">${UNIVERSE_METRIC_FULL_LABELS[key]}</option>`
		).join("");

		sortPrimary.innerHTML = optionsHtml;
		sortSecondary.innerHTML = optionsHtml;
		finderUniverseSort.innerHTML = universeOptionsHtml;
		finderUniverseSortSecondary.innerHTML = universeOptionsHtml;

		// Set defaults
		sortPrimary.value = 'expectancy';
		sortSecondary.value = 'profitFactor';
		finderUniverseSort.value = this.uiState.universeSort;
		finderUniverseSortSecondary.value = this.uiState.universeSortSecondary;
		this.updateTimingSortControlState();

		// Advanced Toggle Logic
		toggle.addEventListener('change', () => {
			setVisible(simpleSection, !toggle.checked);
			setVisible(advancedSection, toggle.checked);
		});
		sortPrimary.addEventListener('change', () => this.updateTimingSortControlState());
		sortSecondary.addEventListener('change', () => this.updateTimingSortControlState());
		this.getDom().finderMode.addEventListener('change', () => this.updateTimingSortControlState());

		// Initialize Advanced List
		this.initSortList();
		this.updateTimingSortControlState();
	}

	private initSortList(): void {
		const { finderSortList: list } = this.getDom();

		// Event delegation for move buttons
		list.addEventListener('click', (e) => {
			const target = e.target as HTMLElement;
			const btn = target.closest('.finder-sort-btn');
			if (!btn) return;

			const item = btn.closest('.finder-sort-item');
			if (!item) return;

			if (btn.classList.contains('sort-up')) {
				if (item.previousElementSibling) {
					item.parentElement?.insertBefore(item, item.previousElementSibling);
				}
			} else if (btn.classList.contains('sort-down')) {
				if (item.nextElementSibling) {
					item.parentElement?.insertBefore(item.nextElementSibling, item);
				}
			}
			this.captureFinderUiState();
		});

		list.addEventListener('change', (event) => {
			if ((event.target as HTMLElement | null)?.classList.contains("finder-sort-enabled")) {
				this.captureFinderUiState();
			}
		});

		this.renderSortList();
	}

	private renderSortList(): void {
		const { finderSortList: container } = this.getDom();
		container.innerHTML = '';

		this.uiState.advancedSortOrder.forEach(metric => {
			const isOptionalMetric = isAdvancedOptionalSortMetric(metric);
			const div = document.createElement('div');
			div.className = isOptionalMetric ? 'finder-sort-item finder-sort-item--optional' : 'finder-sort-item';
			div.dataset.value = metric;
			div.innerHTML = `
				<label class="finder-sort-label">
					${isOptionalMetric ? `<input type="checkbox" class="finder-sort-enabled" aria-label="Enable ${METRIC_FULL_LABELS[metric]}">` : ''}
					<span class="sort-label">${METRIC_FULL_LABELS[metric]}</span>
				</label>
				<div class="finder-sort-actions">
					<button class="finder-sort-btn sort-up" title="Move Up">▲</button>
					<button class="finder-sort-btn sort-down" title="Move Down">▼</button>
				</div>
			`;
			container.appendChild(div);
		});
		this.applyAdvancedSortStateToDom();
	}

	private applyAdvancedSortStateToDom(): void {
		const { finderSortList: container } = this.getDom();
		const enabledTimingMetrics = new Set(this.uiState.advancedTimingSortEnabled);
		const enabledOptionalMetrics = new Set(this.uiState.advancedOptionalSortEnabled);
		for (const item of Array.from(container.querySelectorAll<HTMLElement>(".finder-sort-item"))) {
			const metric = item.dataset.value as FinderMetric | undefined;
			if (!metric || !isAdvancedOptionalSortMetric(metric)) {
				continue;
			}
			const checkbox = item.querySelector<HTMLInputElement>(".finder-sort-enabled");
			if (checkbox) {
				checkbox.checked = isTimingSortMetric(metric)
					? enabledTimingMetrics.has(metric)
					: enabledOptionalMetrics.has(metric);
			}
		}
	}

	private initStrategySelectionUI(): void {
		const dom = this.getDom();

		dom.finderStrategyList.addEventListener('click', (event) => {
			const target = event.target as HTMLElement | null;
			const checkbox = target?.closest<HTMLInputElement>('input[type="checkbox"][data-strategy-key]');
			const strategyKey = checkbox?.dataset.strategyKey;
			if (!checkbox || !strategyKey || !dom.finderStrategyList.contains(checkbox)) {
				return;
			}
			this.selection.handleStrategyToggleClick(strategyKey, event as MouseEvent);
		});

		dom.finderStrategyList.addEventListener('change', (event) => {
			const target = event.target as HTMLElement | null;
			const checkbox = target?.closest<HTMLInputElement>('input[type="checkbox"][data-strategy-key]');
			const strategyKey = checkbox?.dataset.strategyKey;
			if (!checkbox || !strategyKey || !dom.finderStrategyList.contains(checkbox)) {
				return;
			}
			this.selection.handleStrategyToggleChange(strategyKey);
		});

		dom.finderStrategiesToggleAll.addEventListener('change', (event) => {
			this.selection.setStrategySelection(this.selection.strategyOrder, (event.target as HTMLInputElement).checked);
		});

		dom.finderStrategySearch.addEventListener('input', () => {
			this.selection.applyStrategyFilter();
		});

		dom.finderStrategySelectAll.addEventListener('click', () => {
			this.selection.setStrategySelection(this.selection.strategyOrder, true);
		});

		dom.finderStrategySelectNone.addEventListener('click', () => {
			this.selection.setStrategySelection(this.selection.strategyOrder, false);
		});

		dom.finderStrategyInvertVisible.addEventListener('click', () => {
			this.selection.invertStrategySelection(this.selection.getVisibleStrategyKeys());
		});

		dom.finderStrategySelectVisible.addEventListener('click', () => {
			this.selection.setStrategySelection(this.selection.getVisibleStrategyKeys(), true);
		});

		dom.finderStrategySelectFollow.addEventListener('click', () => {
			this.selection.replaceStrategySelection(FINDER_FOLLOW_STRATEGY_KEYS);
		});

		dom.finderStrategySelectReversion.addEventListener('click', () => {
			this.selection.replaceStrategySelection(FINDER_REVERSION_STRATEGY_KEYS);
		});
	}

	private initUniverseUI(): void {
		const dom = this.getDom();

		dom.finderScope.addEventListener("change", () => {
			this.uiState.scope = normalizeFinderScope(dom.finderScope.value);
			this.applyScopeUi();
			this.selection.syncStrategyToggleInputsFromState();
			this.selection.syncStrategySelectionUi();
			this.ui.renderRandomBenchmark("grid");
			this.renderLatestResults();
			this.saveUiState();
		});

		dom.finderUniverseUseCurrent.addEventListener("click", () => {
			dom.finderUniverseSymbols.value = state.currentSymbol;
			this.uiState.universeSymbolsText = dom.finderUniverseSymbols.value;
			this.updateUniverseSummary();
			this.saveUiState();
		});

		dom.finderUniverseUseCurrentMajors.addEventListener("click", () => {
			dom.finderUniverseSymbols.value = Array.from(new Set<string>([state.currentSymbol, ...MAJOR_SYMBOLS])).join("\n");
			this.uiState.universeSymbolsText = dom.finderUniverseSymbols.value;
			this.updateUniverseSummary();
			this.saveUiState();
		});

		dom.finderUniverseUseLocalSp500.addEventListener("click", () => {
			void this.populateUniverseWithLocalDailySeeds();
		});

		dom.finderUniverseClear.addEventListener("click", () => {
			dom.finderUniverseSymbols.value = "";
			this.uiState.universeSymbolsText = "";
			this.updateUniverseSummary();
			this.saveUiState();
		});

		[
			dom.finderUniverseSymbols,
			dom.finderUniverseMinActiveSymbols,
			dom.finderUniverseMinTotalTrades,
			dom.finderUniverseMinProfitableActiveRatio,
			dom.finderUniverseSort,
			dom.finderUniverseSortSecondary,
		].forEach((element) => {
			element.addEventListener("input", () => {
				this.captureUniverseUiState(false);
				this.persistUiStateDebounced();
			});
			element.addEventListener("change", () => {
				this.captureUniverseUiState(false);
				this.persistUiStateDebounced();
			});
		});
	}

	private captureUniverseUiState(persist = true): void {
		const dom = this.getDom();
		this.uiState.universeSymbolsText = dom.finderUniverseSymbols.value;
		this.uiState.universeMinActiveSymbols = Math.max(1, Math.round(this.readFinderNumberInput(dom.finderUniverseMinActiveSymbols, DEFAULT_FINDER_UI_STATE.universeMinActiveSymbols, 1)));
		this.uiState.universeMinTotalTrades = Math.max(0, Math.round(this.readFinderNumberInput(dom.finderUniverseMinTotalTrades, DEFAULT_FINDER_UI_STATE.universeMinTotalTrades, 0)));
		this.uiState.universeMinProfitableActiveRatio = Math.max(
			0,
			Math.min(1, this.readFinderNumberInput(dom.finderUniverseMinProfitableActiveRatio, DEFAULT_FINDER_UI_STATE.universeMinProfitableActiveRatio, 0))
		);
		this.uiState.universeSort = normalizeFinderUniverseMetric(dom.finderUniverseSort.value, DEFAULT_FINDER_UI_STATE.universeSort);
		this.uiState.universeSortSecondary = normalizeFinderUniverseMetric(dom.finderUniverseSortSecondary.value, DEFAULT_FINDER_UI_STATE.universeSortSecondary);
		this.updateUniverseSummary();
		if (persist) {
			this.saveUiState();
		}
	}

	private applyScopeUi(): void {
		const dom = this.getDom();
		const universeScope = this.isUniverseScope();
		const assetOpportunityScope = this.isAssetOpportunityScope();
		const qualityScope = this.isStrategyQualityScope();
		const armPerformanceScope = this.isArmPerformanceScope();
		const multiAssetScope = universeScope || assetOpportunityScope || qualityScope || armPerformanceScope;
		const modeLockedScope = universeScope || assetOpportunityScope || qualityScope;
		const modeInput = dom.finderMode;

		dom.finderChartSortSection.style.display = multiAssetScope ? "none" : "";
		dom.finderUniverseSortSection.style.display = universeScope ? "" : "none";
		dom.finderUniverseSectionHeader.style.display = multiAssetScope ? "" : "none";
		dom.finderUniverseSection.style.display = multiAssetScope ? "" : "none";
		dom.finderUniverseFilters.style.display = universeScope ? "" : "none";
		dom.finderAssetOpportunitySettings.style.display = assetOpportunityScope ? "" : "none";
		dom.finderQualitySettings.style.display = qualityScope ? "" : "none";
		dom.finderArmPerformanceSettings.style.display = armPerformanceScope ? "" : "none";
		dom.finderTradeFilterSection.style.display = universeScope || qualityScope || armPerformanceScope ? "none" : "";
		dom.finderModeRow.classList.toggle("is-disabled", modeLockedScope);
		dom.finderStepsRow.style.display = modeLockedScope ? "none" : "";
		dom.finderDataSliceRow.style.display = "";
		dom.finderUniverseSectionTitle.textContent = armPerformanceScope ? "Synthetic Pair Universe" : "Symbol Universe";
		dom.finderUniverseSymbolsLabel.textContent = armPerformanceScope ? "Synthetic Pairs" : "Symbols";
		dom.finderUniverseSymbols.placeholder = armPerformanceScope ? "BTC+ETH\nNVDA•+AAPL•" : "AAPL\nMSFT\nNVDA\nBTCUSDT";
		dom.finderUniverseInputHint.textContent = armPerformanceScope
			? "One BASE+QUOTE pair per line or comma-separated. Up to 5,000 pairs; every configuration uses the same ordered pair list and current interval."
			: "One symbol per line or comma-separated. Multi-asset scopes reuse the current interval and settings. Local Seeds switches to 1d.";
		dom.finderUniverseActions.style.display = armPerformanceScope ? "none" : "";
		for (const option of Array.from(dom.finderDataSlice.options)) {
			option.disabled = armPerformanceScope && option.value !== "all" && option.value !== "date_range";
		}
		if (armPerformanceScope && dom.finderDataSlice.value !== "all" && dom.finderDataSlice.value !== "date_range") {
			dom.finderDataSlice.value = "all";
			this.uiState.dataSlice = "all";
		}
		dom.finderStrategyActions.classList.remove("is-disabled");
		dom.finderStrategiesToggleAll.disabled = false;
		dom.finderStrategySelectAll.disabled = false;
		dom.finderStrategySelectNone.disabled = false;
		dom.finderStrategyInvertVisible.disabled = this.selection.getVisibleStrategyKeys().length === 0;
		dom.finderStrategySelectVisible.disabled = this.selection.getVisibleStrategyKeys().length === 0;
		modeInput.disabled = modeLockedScope;
		const geneticOption = Array.from(modeInput.options).find((option) => option.value === "genetic");
		if (geneticOption) geneticOption.disabled = armPerformanceScope;
		if (modeLockedScope) {
			modeInput.value = "random";
		} else if (armPerformanceScope && modeInput.value === "genetic") {
			modeInput.value = "random";
			this.setStatus("Arm Performance supports Grid Sweep and Random Search; Genetic Search was reset to Random Search.");
		}
		setVisible("finderBlockBadge", !multiAssetScope && Boolean(state.blockRange));
		this.setTradeFilterControlsEnabled(this.isTradeFilterControlsEnabled());
		this.updateTimingSortControlState();
		this.syncOosValidationControlState();
		this.syncDataRangeControlState();
		this.populateResortOptions();
	}

	/**
	 * Keeps the OOS Validation toggle visually + functionally in step with the
	 * conditions it depends on. OOS applies to half data windows and to the
	 * date-range window (its complement is every bar after the range end), and
	 * is not applicable, so the toggle is disabled otherwise to
	 * make the silent-ignore obvious (the prior behavior silently dropped the
	 * flag, which made it impossible to tell whether OOS was active).
	 */
	private syncOosValidationControlState(): void {
		const dom = this.getDom();
		if (this.isArmPerformanceScope()) {
			dom.finderOosValidationToggle.disabled = true;
			dom.finderOosValidationRow.classList.add('is-disabled');
			dom.finderOosValidationRow.style.display = 'none';
			return;
		}
		dom.finderOosValidationRow.style.display = '';
		const dataSlice = normalizeFinderDataSlice(dom.finderDataSlice.value);
		const oosCapableWindow = dataSlice === 'half_oldest'
			|| dataSlice === 'half_newest'
			|| dataSlice === 'date_range';
const applicable = oosCapableWindow;
		dom.finderOosValidationToggle.disabled = !applicable;
		dom.finderOosValidationRow.classList.toggle('is-disabled', !applicable);
	}

	private initTradeFilterUI(): void {
		const { finderTradesToggle } = this.getDom();
		finderTradesToggle.addEventListener("change", () => {
			this.setTradeFilterControlsEnabled(this.isTradeFilterControlsEnabled());
		});
		this.setTradeFilterControlsEnabled(this.isTradeFilterControlsEnabled());
	}

	private isTradeFilterControlsEnabled(): boolean {
		const dom = this.getDom();
		return !this.isUniverseScope() && !this.isStrategyQualityScope() && !this.isArmPerformanceScope() && dom.finderTradesToggle.checked;
	}

	private setTradeFilterControlsEnabled(enabled: boolean): void {
		const dom = this.getDom();
		dom.finderTradeFilters.classList.toggle("is-disabled", !enabled);
		dom.finderTradesMin.disabled = !enabled;
		dom.finderTradesMax.disabled = !enabled;
	}

	private initFinderSettingsPersistenceUI(): void {
		const dom = this.getDom();
		const persist = () => {
			this.captureFinderUiState(false);
			this.persistUiStateDebounced();
		};
		[
			dom.finderSort,
			dom.finderSortSecondary,
			dom.finderAdvancedToggle,
			dom.finderMode,
			dom.finderDataSlice,
			dom.finderTopN,
			dom.finderMaxRuns,
			dom.finderRange,
			dom.finderSteps,
			dom.finderFreezeRiskManagementToggle,
			dom.finderRandomizePathExitToggle,
			dom.finderExitStrategyOverrideToggle,
			dom.finderTradesToggle,
			dom.finderTradesMin,
			dom.finderTradesMax,
			dom.finderOosValidationToggle,
			dom.finderArmPerformanceHorizon,
			dom.finderAssetCandidatePoolSize,
			dom.finderAssetMinFreshSupport,
			dom.finderAssetIncludeOpenPositions,
			dom.finderAssetOosMeasurementMode,
			dom.finderAssetOosHorizonBasis,
			dom.finderAssetOosIgnoreLastBars,
			dom.finderAssetOosHorizons,
			dom.finderAssetEvalWindowMode,
			dom.finderAssetEvalWindowBars,
			dom.finderAssetOosBatchToggle,
			dom.finderAssetOosBatchStart,
			dom.finderAssetOosBatchEnd,
		].forEach((element) => {
			element.addEventListener("input", persist);
			element.addEventListener("change", persist);
		});
	}

	private captureFinderUiState(persist = true): void {
		const dom = this.getDom();
		const sortItems = Array.from(dom.finderSortList.querySelectorAll<HTMLElement>(".finder-sort-item"));
		this.uiState.sortPrimary = normalizeFinderMetric(dom.finderSort.value, DEFAULT_FINDER_UI_STATE.sortPrimary);
		this.uiState.sortSecondary = normalizeFinderMetric(dom.finderSortSecondary.value, DEFAULT_FINDER_UI_STATE.sortSecondary);
		this.uiState.useAdvancedSort = dom.finderAdvancedToggle.checked;
		this.uiState.advancedSortOrder = normalizeAdvancedSortOrder(sortItems.map((item) => item.dataset.value));
		this.uiState.advancedTimingSortEnabled = sortItems
			.filter((item) => item.querySelector<HTMLInputElement>(".finder-sort-enabled")?.checked === true)
			.map((item) => item.dataset.value)
			.filter((metric): metric is FinderMetric => isTimingSortMetric(metric));
		this.uiState.advancedOptionalSortEnabled = sortItems
			.filter((item) => item.querySelector<HTMLInputElement>(".finder-sort-enabled")?.checked === true)
			.map((item) => item.dataset.value)
			.filter((metric): metric is FinderMetric => isAdvancedOptionalSortMetric(metric));
		this.uiState.mode = normalizeFinderMode(dom.finderMode.value);
		this.uiState.dataSlice = normalizeFinderDataSlice(dom.finderDataSlice.value);
		this.uiState.dataRangeFrom = normalizeFinderDateInput(dom.finderDataRangeFrom.value) ?? "";
		this.uiState.dataRangeTo = normalizeFinderDateInput(dom.finderDataRangeTo.value) ?? "";
		this.uiState.topN = Math.round(this.readFinderNumberInput(dom.finderTopN, DEFAULT_FINDER_UI_STATE.topN, 1));
		this.uiState.maxRuns = Math.round(this.readFinderNumberInput(dom.finderMaxRuns, DEFAULT_FINDER_UI_STATE.maxRuns, 1));
		this.uiState.rangePercent = this.readFinderNumberInput(dom.finderRange, DEFAULT_FINDER_UI_STATE.rangePercent, 0);
		this.uiState.steps = Math.round(this.readFinderNumberInput(dom.finderSteps, DEFAULT_FINDER_UI_STATE.steps, 2));
		this.uiState.freezeRiskManagement = dom.finderFreezeRiskManagementToggle.checked;
		this.uiState.randomizePathExitParams = dom.finderRandomizePathExitToggle.checked;
		this.uiState.exitStrategyOverrideEnabled = dom.finderExitStrategyOverrideToggle.checked;
		this.uiState.tradeFilterEnabled = dom.finderTradesToggle.checked;
		this.uiState.minTrades = Math.round(this.readFinderNumberInput(dom.finderTradesMin, DEFAULT_FINDER_UI_STATE.minTrades, 0));
		this.uiState.maxTradesText = dom.finderTradesMax.value.trim();
		this.uiState.oosValidationEnabled = dom.finderOosValidationToggle.checked;
		this.uiState.armPerformanceHorizon = Math.max(1, Math.min(1_000, Math.round(this.readFinderNumberInput(
			dom.finderArmPerformanceHorizon,
			DEFAULT_FINDER_UI_STATE.armPerformanceHorizon,
			1,
		))));
		this.uiState.assetOpportunityCandidatePoolSize = Math.max(1, Math.min(50, Math.round(this.readFinderNumberInput(
			dom.finderAssetCandidatePoolSize,
			DEFAULT_FINDER_UI_STATE.assetOpportunityCandidatePoolSize,
			1,
		))));
		this.uiState.assetOpportunityMinFreshSupport = Math.max(1, Math.min(50, Math.round(this.readFinderNumberInput(
			dom.finderAssetMinFreshSupport,
			DEFAULT_FINDER_UI_STATE.assetOpportunityMinFreshSupport,
			1,
		))));
		this.uiState.assetOpportunityIncludeOpenPositions = dom.finderAssetIncludeOpenPositions.checked;
		this.uiState.assetOpportunityOosMeasurementMode = normalizeFinderAssetOosMeasurementMode(
			dom.finderAssetOosMeasurementMode.value,
		);
		this.uiState.assetOpportunityOosHorizonBasis = normalizeFinderAssetOosHorizonBasis(
			dom.finderAssetOosHorizonBasis.value,
		);
		this.uiState.assetOpportunityOosIgnoreLastBars = normalizeFinderAssetOosIgnoreLastBars(
			this.readFinderNumberInput(
				dom.finderAssetOosIgnoreLastBars,
				DEFAULT_FINDER_UI_STATE.assetOpportunityOosIgnoreLastBars,
				0,
			),
		);
		this.uiState.assetOpportunityOosHorizons = normalizeFinderAssetOosHorizons(
			dom.finderAssetOosHorizons.value,
		).join(",");
		this.uiState.assetOpportunityEvalWindowMode = normalizeFinderAssetEvalWindowMode(
			dom.finderAssetEvalWindowMode.value,
		);
		this.uiState.assetOpportunityEvalWindowBars = normalizeFinderAssetEvalLastBars(
			this.readFinderNumberInput(
				dom.finderAssetEvalWindowBars,
				DEFAULT_FINDER_UI_STATE.assetOpportunityEvalWindowBars,
				0,
			),
		);
		this.uiState.assetOpportunityOosBatchEnabled = dom.finderAssetOosBatchToggle.checked;
		const batchRange = normalizeFinderAssetOosBatchHoldoutRange(
			dom.finderAssetOosBatchStart.value,
			dom.finderAssetOosBatchEnd.value,
		);
		if (batchRange.error === null) {
			this.uiState.assetOpportunityOosBatchStartBars = batchRange.start;
			this.uiState.assetOpportunityOosBatchEndBars = batchRange.end;
		}
		this.syncAssetOosBatchControls();
		if (persist) {
			this.saveUiState();
		}
	}

	/**
	 * Keep the single OOS Holdout Bars input and the batch start/end inputs in
	 * step: batch mode hides + disables the single holdout so the two modes
	 * cannot silently disagree about which holdout the next run uses.
	 */
	private syncAssetOosBatchControls(): void {
		const dom = this.getDom();
		const batchEnabled = dom.finderAssetOosBatchToggle.checked;
		const nextExitEnabled = normalizeFinderAssetOosMeasurementMode(
			dom.finderAssetOosMeasurementMode.value,
		) === "next_exit";
		setVisible(dom.finderAssetOosBatchSettings, batchEnabled);
		dom.finderAssetOosIgnoreLastBars.disabled = batchEnabled;
		dom.finderAssetOosIgnoreLastBars.closest(".param-group")?.classList.toggle("is-disabled", batchEnabled);
		dom.finderAssetOosHorizons.disabled = nextExitEnabled;
		dom.finderAssetOosHorizons.closest(".param-group")?.classList.toggle("is-disabled", nextExitEnabled);
		dom.finderAssetOosHorizonBasis.disabled = nextExitEnabled;
		dom.finderAssetOosHorizonBasis.closest(".param-group")?.classList.toggle("is-disabled", nextExitEnabled);
		const holdoutLabel = dom.finderAssetOosIgnoreLastBars.closest(".param-group")?.querySelector("label");
		if (holdoutLabel) holdoutLabel.textContent = nextExitEnabled ? "OOS Max Wait Bars" : "OOS Holdout Bars";
	}

	private resetFinderSettings(): void {
		const {
			currentChartSelectedStrategyKeys,
			universeSelectedStrategyKeys,
		} = this.uiState;
		this.uiState = {
			...DEFAULT_FINDER_UI_STATE,
			currentChartSelectedStrategyKeys: [...currentChartSelectedStrategyKeys],
			universeSelectedStrategyKeys: [...universeSelectedStrategyKeys],
		};
		this.renderSortList();
		this.applyPersistedUiStateToDom();
		this.selection.syncStrategyToggleInputsFromState();
		this.selection.syncStrategySelectionUi();
		this.setTradeFilterControlsEnabled(this.isTradeFilterControlsEnabled());
		this.applyScopeUi();
		this.saveUiState();
		this.setStatus("Finder settings reset.");
	}

	private updateTimingSortControlState(): void {
		const dom = this.getDom();
		const timingSortDisabled = this.isUniverseScope()
			|| this.isStrategyQualityScope()
			|| dom.finderMode.value === "genetic";
		const optionalSortDisabled = this.isUniverseScope()
			|| this.isStrategyQualityScope()
			|| dom.finderMode.value === "genetic";

		for (const select of [dom.finderSort, dom.finderSortSecondary]) {
			for (const option of Array.from(select.options)) {
				if (isTimingSortMetric(option.value)) {
					option.disabled = timingSortDisabled;
				} else if (isAdvancedOptionalSortMetric(option.value)) {
					option.disabled = optionalSortDisabled;
				}
			}
		}

		for (const item of Array.from(dom.finderSortList.querySelectorAll<HTMLElement>(".finder-sort-item"))) {
			const metric = item.dataset.value;
			const isTimingMetric = isTimingSortMetric(metric);
			const isOptionalMetric = isAdvancedOptionalSortMetric(metric);
			if (!isTimingMetric && !isOptionalMetric) continue;
			const disabled = isTimingMetric ? timingSortDisabled : optionalSortDisabled;
			item.classList.toggle("is-disabled", disabled);
			item.querySelectorAll<HTMLInputElement>(".finder-sort-enabled").forEach((checkbox) => {
				checkbox.disabled = disabled;
			});
			item.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
				button.disabled = disabled;
			});
		}
	}

	private async loadSelectedStrategy(strategyKey: string): Promise<FinderSelectedStrategy | null> {
		if (!strategyRegistry.has(strategyKey)) {
			await loadBuiltInStrategyByKey(strategyKey);
		}
		const strategy = strategyRegistry.get(strategyKey);
		return strategy ? { key: strategyKey, name: strategy.name, strategy } : null;
	}

	private async getSelectedStrategies(): Promise<FinderSelectedStrategy[]> {
		const results: FinderSelectedStrategy[] = [];
		for (const key of this.uiState.currentChartSelectedStrategyKeys) {
			const selection = await this.loadSelectedStrategy(key);
			if (selection) {
				results.push(selection);
			}
		}
		return results;
	}

	private async getUniverseSelectedStrategies(): Promise<FinderSelectedStrategy[]> {
		const results: FinderSelectedStrategy[] = [];
		for (const key of this.uiState.universeSelectedStrategyKeys) {
			const selection = await this.loadSelectedStrategy(key);
			if (selection) {
				results.push(selection);
			}
		}
		return results;
	}

	public async runFinder(): Promise<void> {
		if (this.isRunning || this.runStartupInFlight) return;
		this.runStartupInFlight = true;
		// Starting a new run cancels any stale reattach poll before changing
		// UI ownership so late poll updates cannot mutate the new run's state.
		try {
			this.stopReattachPoll();
			this.session.activeRunId = null;
			if (!this.isUniverseScope() && !this.isAssetOpportunityScope() && !this.isStrategyQualityScope() && !this.isArmPerformanceScope() && state.ohlcvData.length === 0) {
				this.setStatus('Data not loaded. Attempting to load...');
				await dataManager.loadData();

				if (state.ohlcvData.length === 0) {
					this.setStatus('Load data before running the finder.');
					return;
				}
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			debugLogger.error('finder.preflight_failed', { error: message });
			this.setStatus(`Finder data load failed. ${message}`);
			uiManager.showToast('Finder data load failed. Check the status panel for details.', 'error');
			return;
		} finally {
			this.runStartupInFlight = false;
		}

		this.finderRunAbortController?.abort();
		this.finderRunAbortController = new AbortController();
		this.isCancelled = false;
		this.isRunning = true;
		const startTime = performance.now();
		this.lastFinderRunBacktestSettings = null;
		this.lastFinderOptions = null;
		this.lastFinderEvaluationData = null;
		this.latestDiagnostics = null;
		this.latestAssetOpportunityDiagnostics = null;
		this.resultStore.resetForNewRun();
		this.clearLatestResultsSnapshot();

		const settingsSnapshot = this.cloneBacktestSettings(settingsManager.getBacktestSettings());
		this.lastFinderRunBacktestSettings = this.cloneBacktestSettings(settingsSnapshot);
		const options = this.readOptions(settingsSnapshot);
		this.lastFinderOptions = this.cloneBacktestSettings(options);
		if (options.scope === 'arm_performance') {
			this.resultStore.armPerformanceInventoryComplete = false;
		}
		this.resultStore.setRunDisplayLimits(options.topN);

		const dom = this.getDom();
		const runButton = dom.runFinder;
		const stopButton = dom.stopFinder;
		dom.finderCopyDiagnostics.disabled = true;
		let progressFinalized = false;
		const setRunningUI = (running: boolean) => {
			runButton.disabled = running;
			runButton.classList.toggle('is-loading', running);
			runButton.setAttribute('aria-busy', running ? 'true' : 'false');
			stopButton.style.display = running ? '' : 'none';
			if (typeof document !== 'undefined') {
				document.body.classList.toggle('finder-running', running);
			}
		};
		const finalizeProgress = (percent: number, text: string) => {
			this.setProgress(false, percent, text);
			progressFinalized = true;
		};

		setRunningUI(true);
		this.setProgress(true, 0, 'Preparing...');
		this.setStatus('Running strategy finder...');
		this.ui.renderRandomBenchmark(options.mode);
		// Run-start clear is a volatile UI reset; the previous snapshot was
		// already cleared explicitly via clearLatestResultsSnapshot().
		if (options.scope === 'arm_performance') {
			this.resultStore.setArmPerformanceLatestResults([], false, options.topN, false);
		} else {
			this.resultStore.setLatestResults(emptyFinderLatestResults(options.scope ?? 'current_chart'), false);
		}
		this.renderLatestResults();

		try {
			const host = this.runHost();
			const strategies = this.strategySource();
			const store = this.resultStore;
			const session = this.session;
			const completed = options.scope === 'symbol_universe'
				? await runUniverseFinder({
					host, store, session, strategies, options, startTime,
					getSelectedStrategies: () => this.getUniverseSelectedStrategies(),
					onDiagnostics: (diagnostics) => { this.latestDiagnostics = diagnostics; },
				})
				: options.scope === 'asset_opportunity'
					? this.isAssetOpportunityBatchMode()
						? await runAssetOpportunityBatchFinder({
							host, store, session, strategies, options, startTime,
							getSelectedStrategies: () => this.getSelectedStrategies(),
							onDiagnostics: (diagnostics, assetDiagnostics) => {
								this.latestDiagnostics = diagnostics;
								this.latestAssetOpportunityDiagnostics = assetDiagnostics;
							},
							range: this.readBatchHoldoutRange(),
						})
						: await runAssetOpportunityFinder({
							host, store, session, strategies, options, startTime,
							getSelectedStrategies: () => this.getSelectedStrategies(),
							onDiagnostics: (diagnostics, assetDiagnostics) => {
								this.latestDiagnostics = diagnostics;
								this.latestAssetOpportunityDiagnostics = assetDiagnostics;
							},
						})
					: options.scope === 'arm_performance'
						? await runArmPerformanceFinder({
							host, store, session, options, startTime,
							getUniverseSelectedStrategies: () => this.getUniverseSelectedStrategies(),
							resolveExitStrategyCandidates: (finderOptions, selected) => this.resolveExitStrategyCandidates(finderOptions, selected),
							getPairListText: () => this.getDom().finderUniverseSymbols.value,
							getSelectedArm: () => this.getDom().finderResort.value as FinderArmPerformanceArm,
							onCancelled: () => { this.isCancelled = true; },
						})
					: options.scope === 'strategy_quality'
						? await runStrategyQualityFinder({
							host, store, options, startTime,
							getUniverseSelectedStrategies: () => this.getUniverseSelectedStrategies(),
							onDiagnostics: (diagnostics) => { this.latestDiagnostics = diagnostics; },
						})
						: await runCurrentChartFinder({
							host, store, strategies, options, startTime,
							getSelectedStrategies: () => this.getSelectedStrategies(),
							generateParamSets: (defaultParams, finderOptions) => this.generateParamSets(defaultParams, finderOptions),
							retainEvaluationData: (data) => { this.lastFinderEvaluationData = data; },
							onDiagnostics: (diagnostics) => { this.latestDiagnostics = diagnostics; },
						});

			if (!completed) {
				finalizeProgress(0, '');
			} else if (this.isCancelled) {
				finalizeProgress(0, '');
				this.setStatus(`Finder stopped by user after ${Math.round(performance.now() - startTime)}ms.`);
			} else {
				finalizeProgress(100, '');
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (this.isCancelled && (message.includes('stopped') || message.includes('cancel'))) {
				this.setStatus('Finder stopped by user.');
				uiManager.showToast('Finder stopped.', 'info');
				} else {
					debugLogger.error('finder.run_failed', {
						scope: options.scope ?? 'current_chart',
						symbol: state.currentSymbol,
						interval: state.currentInterval,
						mode: options.mode,
						error: message,
					});
					this.setStatus(`Finder failed. ${message}`);
					uiManager.showToast('Finder run failed. Check the status panel for details.', 'error');
					// latestDiagnostics stays null on any mid-run failure, which
					// silently disables the Copy Diagnostics button exactly when
					// the user needs it most. Build a minimal diagnostics so the
					// user can copy and share why the run failed. Universe load
					// failures carry a per-symbol loadFailures map (richer detail);
					// any other failure (engine throw, OOS re-load error, etc.)
					// gets a minimal diagnostics with the error reason surfaced as
					// a bottleneck line.
					const loadFailures = (error as Error & { loadFailures?: Map<string, { error?: string }> }).loadFailures;
					if (loadFailures && loadFailures.size > 0) {
						this.latestDiagnostics = buildFailureDiagnostics({
							kind: 'load',
							options,
							elapsedMs: performance.now() - startTime,
							loadFailures,
						});
					} else {
						this.latestDiagnostics = buildFailureDiagnostics({
							kind: 'run',
							options,
							elapsedMs: performance.now() - startTime,
							error: message,
						});
					}
					this.getDom().finderCopyDiagnostics.disabled = !this.latestDiagnostics;
				}
		} finally {
			if (!progressFinalized) {
				finalizeProgress(0, '');
			}
			this.isCancelled = false;
			this.finderRunAbortController?.abort();
			this.finderRunAbortController = null;
			setRunningUI(false);
			this.isRunning = false;
		}
	}

	/**
	 * Reattach to an in-flight or terminal server-owned Finder job after a
	 * tab reload. Called from `init()` (Finder is lazy-loaded, so reattach
	 * begins when Finder initializes — not at global startup). Reads the
	 * persisted active run id; if the server still has a matching job,
	 * restores progress + Stop state, then polls summary-only status at a
	 * bounded interval (Batch's reattach pattern) until terminal. On terminal,
	 * adopts the authoritative candidate slice + diagnostics, renders,
	 * persists through the completed-results snapshot, and clears the
	 * active-run record.
	 *
	 * Reattach only survives a browser reload while the same Vite process
	 * remains alive; a Vite restart loses the in-memory job and the reattach
	 * clears its record.
	 */
	/**
	 * Reattach to an in-flight or terminal server-owned Finder job after a
	 * tab reload (Finder is lazy-loaded, so this runs on first Finder
	 * activation). The session owns the poll loop; the facade supplies the
	 * scope/UI/terminal-interpretation capabilities.
	 */
	private async reattachToActiveServerRun(): Promise<void> {
		if (!this.loadPersistedActiveServerRun()) {
			await this.restoreSavedArmPerformanceInventory();
			return;
		}
		await this.session.reattachToActiveServerRun(this.reattachHost());
	}

	/** Restore the persisted job's scope before any terminal snapshot lands. */
	private restoreServerRunScope(scope: FinderScope): void {
		const dom = this.getDom();
		if (this.uiState.scope !== scope) {
			this.uiState.scope = scope;
			dom.finderScope.value = scope;
			this.applyScopeUi();
			this.saveUiState();
		}
	}

	private resetForServerRunAdoption(): void {
		this.resultStore.resetForNewRun();
		this.resultStore.setRunDisplayLimits(this.uiState.topN);
		this.clearLatestResultsSnapshot();
		// Volatile reattach progress view — the snapshot was cleared above and
		// is only re-persisted at a terminal snapshot.
		this.resultStore.setLatestResults(emptyFinderLatestResults(this.uiState.scope), false);
		this.renderLatestResults();
	}

	private setServerRunRunning(running: boolean): void {
		this.isRunning = running;
		this.isCancelled = false;
		const dom = this.getDom();
		dom.runFinder.disabled = running;
		dom.runFinder.classList.toggle("is-loading", running);
		dom.runFinder.setAttribute("aria-busy", running ? "true" : "false");
		dom.stopFinder.style.display = running ? "" : "none";
	}

	/**
	 * Adopt a terminal reattach snapshot for its scope. Ownership (run id +
	 * terminal) has already been re-checked by the session.
	 */
	private interpretTerminalServerRunSnapshot(
		snapshot: Parameters<FinderSessionHost['interpretTerminal']>[0],
		persistedScope: 'symbol_universe' | 'asset_opportunity' | 'asset_opportunity_batch' | 'arm_performance',
	): void {
		const dom = this.getDom();
		if (persistedScope === 'arm_performance' && snapshot.terminalArmPerformanceResults) {
			this.resultStore.armPerformanceDisplayLimit = Math.max(1, this.uiState.topN);
			this.adoptArmPerformanceResults(
				snapshot.terminalArmPerformanceResults,
				snapshot.armPerformanceRunContext ?? null,
				true,
			);
			this.populateResortOptions();
			this.stashAndResetResort();
			this.renderLatestResults();
		} else if ((persistedScope === 'asset_opportunity' || persistedScope === 'asset_opportunity_batch')
			&& snapshot.terminalAssets) {
			this.resultStore.assetOpportunityRunResults = sortAssetOpportunityResults([...snapshot.terminalAssets]);
			this.resultStore.assetOpportunityDefaultResults = [...this.resultStore.assetOpportunityRunResults];
			this.resultStore.setAssetOpportunityLatestResults(this.resultStore.assetOpportunityRunResults);
			this.stashAndResetResort();
			this.renderLatestResults();
			this.latestDiagnostics = snapshot.diagnostics;
			this.latestAssetOpportunityDiagnostics = snapshot.assetDiagnostics ?? (snapshot.assetTotals
				? {
					totalAssets: snapshot.assetTotals.totalAssets,
					assetsWithFreshEntry: snapshot.assetTotals.assetsWithFreshEntry,
					assetsWithNoFreshEntry: Math.max(0, snapshot.assetTotals.totalAssets - snapshot.assetTotals.assetsWithFreshEntry - snapshot.assetTotals.failedAssets),
					selectGradeAssets: snapshot.assetTotals.selectGradeAssets,
					watchGradeAssets: snapshot.assetTotals.watchGradeAssets,
					rejectGradeAssets: snapshot.assetTotals.rejectGradeAssets,
					failedAssets: [],
					...(snapshot.assetTotals.engineUsage ? { engineUsage: snapshot.assetTotals.engineUsage } : {}),
				}
				: null);
			dom.finderCopyDiagnostics.disabled = !snapshot.diagnostics && !this.latestAssetOpportunityDiagnostics;
		} else if (snapshot.phase === "done" && snapshot.terminalCandidates) {
			// The terminal snapshot is the full scalar run inventory. Keep it
			// for post-run re-sort and display only the persisted topN.
			this.resultStore.adoptSymbolUniverseResults(snapshot.terminalCandidates);
			this.populateResortOptions();
			this.renderLatestResults();
			this.latestDiagnostics = snapshot.diagnostics;
			dom.finderCopyDiagnostics.disabled = !snapshot.diagnostics;
		}
	}

	private reattachHost(): FinderSessionHost {
		return {
			setProgress: (active, percent, text) => this.setProgress(active, percent, text),
			setStatus: (text) => this.setStatus(text),
			restoreScope: (scope) => this.restoreServerRunScope(scope),
			resetForServerRunAdoption: () => this.resetForServerRunAdoption(),
			setRunning: (running) => this.setServerRunRunning(running),
			interpretTerminal: (snapshot, persistedScope) => this.interpretTerminalServerRunSnapshot(snapshot, persistedScope),
		};
	}

	/** Recover the server's retained full inventory when localStorage has only the bounded preview. */
	private async restoreSavedArmPerformanceInventory(): Promise<void> {
		const saved = this.resultStore.latestResults;
		if (saved.scope !== 'arm_performance' || saved.inventoryComplete) return;
		const candidateRunId = saved.results
			.map((candidate) => candidate.candidateId.match(/^(.+):candidate-\d+$/)?.[1])
			.find((runId): runId is string => Boolean(runId));
		const runId = saved.runContext?.runId ?? candidateRunId;
		if (!runId) return;
		const abortController = new AbortController();
		this.session.adoptAbortController(abortController);
		const request = createFinderStatusRequestSignal(abortController.signal);
		try {
			const response = await fetch(`/api/finder/status?runId=${encodeURIComponent(runId)}`, {
				cache: 'no-store',
				signal: request.signal,
			});
			if (!response.ok) return;
			const snapshot = parseJsonPreservingNonFinite(await response.text()) as FinderRunStatusSnapshot;
			if (
				this.session.pollingStopped
				|| this.session.activeRunId !== null
				|| this.resultStore.latestResults !== saved
				|| !snapshot.ok
				|| !snapshot.terminal
				|| snapshot.runId !== runId
				|| snapshot.jobKind !== 'arm_performance'
				|| !snapshot.terminalArmPerformanceResults
			) return;
			this.resultStore.armPerformanceDisplayLimit = Math.max(1, this.uiState.topN);
			this.adoptArmPerformanceResults(
				snapshot.terminalArmPerformanceResults,
				snapshot.armPerformanceRunContext ?? saved.runContext,
				true,
			);
			this.populateResortOptions();
			this.stashAndResetResort();
			this.renderLatestResults();
			this.setStatus(`Restored all ${snapshot.terminalArmPerformanceResults.length} Arm Performance configurations from the server.`);
		} catch {
			// Keep the persisted preview available if the server cannot be reached.
		} finally {
			request.cleanup();
			this.session.releaseAbortController(abortController);
		}
	}

	private isAssetOpportunityBatchMode(): boolean {
		return this.getDom().finderAssetOosBatchToggle.checked;
	}

	/**
	 * Facade seam over the batch server consumer, preserving the original
	 * positional signature for integration tests.
	 */
	/** @internal exposed for facade integration tests */
	async runAssetOpportunityBatchFinderServer(
		options: FinderOptions,
		selectedStrategies: FinderSelectedStrategy[],
		exitStrategyCandidates: FinderSelectedStrategy[] | undefined,
		runId: string,
		startTime: number,
		range: BatchHoldoutRange,
		archiveSort: import("./finder/finder-asset-opportunity-metrics").FinderAssetOpportunityArchiveSort | null = null,
	): Promise<unknown> {
		return runAssetOpportunityBatchFinderServer({
			host: this.runHost(),
			store: this.resultStore,
			session: this.session,
			options,
			selectedStrategies,
			exitStrategyCandidates,
			runId,
			startTime,
			range,
			archiveSort,
		});
	}

	/** Validated batch holdout range straight from the DOM inputs. */
	private readBatchHoldoutRange(): BatchHoldoutRange {
		return normalizeFinderAssetOosBatchHoldoutRange(
			this.getDom().finderAssetOosBatchStart.value,
			this.getDom().finderAssetOosBatchEnd.value,
		);
	}

	/**
	 * Presentation/lifecycle capabilities shared by every scope workflow.
	 * Mutable state stays in the result store and session; this only forwards
	 * to the UI, render dispatch, and the browser-cancellation flag.
	 */
	private runHost(): FinderRunHost {
		return {
			setProgress: (active, percent, text) => this.setProgress(active, percent, text),
			setStatus: (text) => this.setStatus(text),
			isCancelled: () => this.isCancelled,
			getAbortSignal: () => this.finderRunAbortController?.signal,
			yieldControl: () => this.taskYielder.yieldControl(),
			renderRandomBenchmark: (mode, payload) => this.ui.renderRandomBenchmark(mode, payload as never),
			renderLatestResults: () => this.renderLatestResults(),
			stashAndResetResort: () => this.stashAndResetResort(),
			populateResortOptions: () => this.populateResortOptions(),
			showDiagnosticsAvailability: (available) => {
				this.getDom().finderCopyDiagnostics.disabled = !available;
			},
		};
	}

	private strategySource() {
		return {
			getSelectedStrategies: () => this.getSelectedStrategies(),
			getUniverseSelectedStrategies: () => this.getUniverseSelectedStrategies(),
			resolveExitStrategyCandidates: (options: FinderOptions, selectedStrategies: FinderSelectedStrategy[]) =>
				this.resolveExitStrategyCandidates(options, selectedStrategies),
		};
	}

	private readOptions(backtestSettings: Pick<ReturnType<typeof settingsManager.getBacktestSettings>, 'executionModel' | 'disableSignalExits' | 'exitStrategyOverrideEnabled'>): FinderOptions {
		const dom = this.getDom();
		const scope = this.getScope();
		const useAdvancedSort = dom.finderAdvancedToggle.checked;
		const sortItems = dom.finderSortList.querySelectorAll('.finder-sort-item');
		const advancedSortValues = Array.from(sortItems)
			.filter((el) => {
				const item = el as HTMLElement;
				const metric = item.dataset.value as FinderMetric | undefined;
				if (!isAdvancedOptionalSortMetric(metric)) {
					return true;
				}
				return item.querySelector<HTMLInputElement>(".finder-sort-enabled")?.checked === true;
			})
			.map(el => (el as HTMLElement).dataset.value as FinderMetric | undefined);
		const mode = scope === 'current_chart' || scope === 'arm_performance' ? dom.finderMode.value as FinderMode : 'random';
		const dataSlice = normalizeFinderDataSlice(dom.finderDataSlice.value);
		const topN = Math.round(this.readFinderNumberInput(dom.finderTopN, DEFAULT_FINDER_UI_STATE.topN, 1));
		const steps = Math.round(this.readFinderNumberInput(dom.finderSteps, DEFAULT_FINDER_UI_STATE.steps, 2));
		const rangePercent = this.readFinderNumberInput(dom.finderRange, DEFAULT_FINDER_UI_STATE.rangePercent, 0);
		const maxRuns = Math.round(this.readFinderNumberInput(dom.finderMaxRuns, DEFAULT_FINDER_UI_STATE.maxRuns, 1));
		const tradeFilterEnabled = scope !== 'symbol_universe'
			&& scope !== 'strategy_quality'
			&& scope !== 'arm_performance'
			&& dom.finderTradesToggle.checked;
		const minTrades = tradeFilterEnabled ? Math.round(this.readFinderNumberInput(dom.finderTradesMin, DEFAULT_FINDER_UI_STATE.minTrades, 0)) : 0;
		const maxTrades = tradeFilterEnabled
			? Math.round(this.readFinderNumberInput(dom.finderTradesMax, Number.POSITIVE_INFINITY, 0))
			: Number.POSITIVE_INFINITY;
		const freezeRiskManagement = dom.finderFreezeRiskManagementToggle.checked;
		const randomizePathExitParams = dom.finderRandomizePathExitToggle.checked;
		const finderExitStrategyToggleOn = dom.finderExitStrategyOverrideToggle.checked;
		const exitStrategyOverrideEnabled = finderExitStrategyToggleOn
			&& backtestSettings.disableSignalExits === true
			&& backtestSettings.exitStrategyOverrideEnabled === true;
		const options = buildFinderOptions({
			mode,
			dataSlice,
			dataRangeFrom: dom.finderDataRangeFrom.value,
			dataRangeTo: dom.finderDataRangeTo.value,
			useAdvancedSort,
			advancedSortValues,
			primarySort: dom.finderSort.value as FinderMetric,
			secondarySort: dom.finderSortSecondary.value as FinderMetric,
			topN,
			steps,
			rangePercent,
			maxRuns,
			tradeFilterEnabled,
			minTrades,
			maxTrades,
			freezeRiskManagement,
			randomizePathExitParams,
			exitStrategyOverrideEnabled,
		});

		options.scope = scope;
		if (scope === 'arm_performance') {
			const dateMode = dataSlice === 'date_range' ? 'date_range' : 'full';
			options.armPerformance = {
				horizon: Math.max(1, Math.min(1_000, Math.round(this.readFinderNumberInput(
					dom.finderArmPerformanceHorizon,
					DEFAULT_FINDER_UI_STATE.armPerformanceHorizon,
					1,
				)))),
				dateMode,
			};
			options.dataSlice = dateMode === 'date_range' ? 'date_range' : 'all';
			options.oosValidationEnabled = false;
		}
		if (scope !== "current_chart" && scope !== "symbol_universe") {
			options.sortPriority = options.sortPriority.filter((metric) => metric !== "exitAlpha");
		}
		if (scope === 'symbol_universe' || scope === 'strategy_quality') {
			options.universe = buildFinderUniverseOptions({
				symbols: this.parseUniverseSymbols(dom.finderUniverseSymbols.value),
				minActiveSymbols: Math.round(this.readFinderNumberInput(dom.finderUniverseMinActiveSymbols, DEFAULT_FINDER_UI_STATE.universeMinActiveSymbols, 1)),
				minTotalTrades: Math.round(this.readFinderNumberInput(dom.finderUniverseMinTotalTrades, DEFAULT_FINDER_UI_STATE.universeMinTotalTrades, 0)),
				minProfitableActiveRatio: this.readFinderNumberInput(
					dom.finderUniverseMinProfitableActiveRatio,
					DEFAULT_FINDER_UI_STATE.universeMinProfitableActiveRatio,
					0
				),
				primarySort: normalizeFinderUniverseMetric(dom.finderUniverseSort.value, DEFAULT_FINDER_UI_STATE.universeSort),
				secondarySort: normalizeFinderUniverseMetric(dom.finderUniverseSortSecondary.value, DEFAULT_FINDER_UI_STATE.universeSortSecondary),
			});
		} else if (scope === 'asset_opportunity') {
			options.assetOpportunity = {
				symbols: this.parseUniverseSymbols(dom.finderUniverseSymbols.value),
				candidatePoolSize: Math.max(1, Math.min(50, Math.round(this.readFinderNumberInput(
					dom.finderAssetCandidatePoolSize,
					DEFAULT_FINDER_UI_STATE.assetOpportunityCandidatePoolSize,
					1,
				)))),
				minFreshSupport: Math.max(1, Math.min(50, Math.round(this.readFinderNumberInput(
					dom.finderAssetMinFreshSupport,
					DEFAULT_FINDER_UI_STATE.assetOpportunityMinFreshSupport,
					1,
				)))),
				includeOpenPositions: dom.finderAssetIncludeOpenPositions.checked,
				oosMeasurementMode: normalizeFinderAssetOosMeasurementMode(
					dom.finderAssetOosMeasurementMode.value,
				),
				oosHorizonBasis: normalizeFinderAssetOosHorizonBasis(
					dom.finderAssetOosHorizonBasis.value,
				),
				oosIgnoreLastBars: normalizeFinderAssetOosIgnoreLastBars(this.readFinderNumberInput(
					dom.finderAssetOosIgnoreLastBars,
					DEFAULT_FINDER_UI_STATE.assetOpportunityOosIgnoreLastBars,
					0,
				)),
				evalLastBars: normalizeFinderAssetEvalLastBars(this.readFinderNumberInput(
					dom.finderAssetEvalWindowBars,
					DEFAULT_FINDER_UI_STATE.assetOpportunityEvalWindowBars,
					0,
				)),
				evalWindowMode: normalizeFinderAssetEvalWindowMode(
					dom.finderAssetEvalWindowMode.value,
				),
				oosHorizons: normalizeFinderAssetOosHorizons(dom.finderAssetOosHorizons.value),
			};
		}

// OOS gate: half-window and date-range windows.
// Applies to both current_chart and symbol_universe scopes.
		const oosWindowActive = dataSlice === 'half_oldest'
			|| dataSlice === 'half_newest'
			|| dataSlice === 'date_range';
if (oosWindowActive) {
			options.oosValidationEnabled = dom.finderOosValidationToggle.checked;
		}

		return options;
	}

	private generateParamSets(defaultParams: StrategyParams, options: FinderOptions): StrategyParams[] {
		return this.paramSpace.generateParamSets(defaultParams, options);
	}

	private async resolveExitStrategyCandidates(
		options: FinderOptions,
		selectedStrategies: FinderSelectedStrategy[]
	): Promise<FinderSelectedStrategy[] | undefined> {
		if (!options.exitStrategyOverrideEnabled) {
			return undefined;
		}
		if (selectedStrategies.length === 0) {
			options.exitStrategyOverrideEnabled = false;
			return undefined;
		}
		// Exit-side sampling must draw from the FULL strategy library, not just the
		// entry selection. Returning `selectedStrategies` here previously pinned the
		// exit pool to whatever the user ticked as entries, so e.g. a 2-entry run
		// could only ever sample between those same 2 libs on the exit side.
		const library = getStrategyList();
		await ensureStrategyKeysLoaded(library.map((entry) => entry.key));
		const candidates: FinderSelectedStrategy[] = [];
		for (const entry of library) {
			const strategy = strategyRegistry.get(entry.key);
			if (strategy) {
				candidates.push({ key: entry.key, name: strategy.name, strategy });
			}
		}
		return candidates.length > 0 ? candidates : undefined;
	}

	private adoptArmPerformanceResults(
		results: readonly FinderArmPerformanceCandidate[],
		context: FinderArmPerformanceRunContext | null,
		complete: boolean,
		persist = true,
	): void {
		this.resultStore.adoptArmPerformanceResults(results, context, complete, persist);
		this.getDom().finderCopyDiagnostics.disabled = !context && results.length === 0;
	}

	private getCurrentChartResults(): FinderResult[] {
		return this.resultStore.latestResults.scope === 'current_chart' ? this.resultStore.latestResults.results : [];
	}

	private getUniverseResults(): FinderUniverseCandidate[] {
		return this.resultStore.latestResults.scope === 'symbol_universe' ? this.resultStore.latestResults.results : [];
	}

	private getAssetOpportunityResults(): FinderAssetOpportunityResult[] {
		return this.resultStore.latestResults.scope === 'asset_opportunity' ? this.resultStore.latestResults.results : [];
	}

	private getStrategyQualityResults(): FinderStrategyQualityResult[] {
		return this.resultStore.latestResults.scope === 'strategy_quality' ? this.resultStore.latestResults.results : [];
	}

	private getArmPerformanceResults(): FinderArmPerformanceCandidate[] {
		return this.resultStore.latestResults.scope === 'arm_performance' ? this.resultStore.latestResults.results : [];
	}


	/**
	 * Populate the post-run re-sort dropdown options for the current scope.
	 * Metric availability comes from the result store; this only writes the DOM.
	 */
	private populateResortOptions(): void {
		const dom = this.getDom();
		const options = this.resultStore.getResortOptions();
		// Preserve the current selection if it's still valid for this scope.
		const previousValue = dom.finderResort.value;
		dom.finderResort.innerHTML = '<option value="">Run Sort</option>';
		for (const opt of options) {
			const el = document.createElement("option");
			el.value = opt.value;
			el.textContent = opt.label;
			dom.finderResort.appendChild(el);
		}
		// Reset to default on scope change; the previous metric may not apply.
		dom.finderResort.value = "";
		dom.finderResort.disabled = false;
		void previousValue;
	}

	/**
	 * Apply the selected re-sort metric to the retained results and re-render.
	 * When the metric is empty ("Run Sort"), restore the original run-time
	 * ordering from the stashed snapshot.
	 */
	private applyResort(): void {
		const metric = this.getDom().finderResort.value;
		if (!metric) {
			this.resultStore.restoreRunSort();
			this.renderLatestResults();
			return;
		}
		if (this.resultStore.latestResults.scope === 'asset_opportunity' && metric === ASSET_OPPORTUNITY_ALL_SORTS) {
			this.setStatus('All Sorts is for batch archive output; choose a specific metric to re-sort displayed results.');
			return;
		}
		this.resultStore.applyResortMetric(metric);
		this.renderLatestResults();
	}

	/**
	 * Reset the re-sort dropdown to "Run Sort" and stash the current results
	 * as the run-time baseline. Called at run completion.
	 */
	private stashAndResetResort(): void {
		const dom = this.getDom();
		dom.finderResort.value = "";
		this.resultStore.stashRunSortBaseline();
	}

	private renderLatestResults(): void {
		if (this.getScope() === 'symbol_universe') {
			const results = this.resultStore.latestResults.scope === 'symbol_universe' ? this.resultStore.latestResults.results : [];
			this.ui.renderUniverseResults(results);
			return;
		}
		if (this.getScope() === 'asset_opportunity') {
			const results = this.resultStore.latestResults.scope === 'asset_opportunity' ? this.resultStore.latestResults.results : [];
			this.ui.renderAssetOpportunityResults(results);
			return;
		}
		if (this.getScope() === 'strategy_quality') {
			const results = this.resultStore.latestResults.scope === 'strategy_quality' ? this.resultStore.latestResults.results : [];
			this.ui.renderStrategyQualityResults(results);
			return;
		}
		if (this.getScope() === 'arm_performance') {
			const results = this.resultStore.latestResults.scope === 'arm_performance' ? this.resultStore.latestResults.results : [];
			const currentArm = this.getDom().finderResort.value as FinderArmPerformanceArm || 'TOP_RAW_PROFIT_NOW';
			this.ui.renderArmPerformanceResults(
				results,
				this.resultStore.latestResults.scope === 'arm_performance' ? this.resultStore.latestResults.runContext : null,
				currentArm,
				this.resultStore.latestResults.scope === 'arm_performance' && !this.resultStore.latestResults.inventoryComplete,
			);
			return;
		}
		const results = this.resultStore.latestResults.scope === 'current_chart' ? this.resultStore.latestResults.results : [];
		this.ui.renderResults(results);
	}

	private async copyTopResultsMetadata(): Promise<void> {
		const chartResults = this.getCurrentChartResults();
		const universeResults = this.getUniverseResults();
		const assetResults = this.getAssetOpportunityResults();
		const qualityResults = this.getStrategyQualityResults();
		const armResults = this.getArmPerformanceResults();
		if (chartResults.length === 0 && universeResults.length === 0 && assetResults.length === 0 && qualityResults.length === 0 && armResults.length === 0) {
			uiManager.showToast('No results to copy', 'info');
			return;
		}

		const payload = buildFinderTopResultsPayload({
			latestResults: this.resultStore.latestResults,
			armRunContext: this.resultStore.armPerformanceRunContext,
			armInventoryComplete: this.resultStore.armPerformanceInventoryComplete,
			selectedArm: (this.getDom().finderResort.value || 'TOP_RAW_PROFIT_NOW') as FinderArmPerformanceArm,
		});

		try {
			await this.copyTextToClipboard(JSON.stringify(payload, null, 2));
			uiManager.showToast('Top results metadata copied', 'success');
		} catch (error) {
			debugLogger.error('finder.copy_metadata_failed', { error: error instanceof Error ? error.message : String(error) });
			uiManager.showToast('Copy failed - check browser permissions', 'error');
		}
	}

	/**
	 * Clipboard transport seam. The implementation lives in
	 * `finder-export.ts`; keeping the call on `this` lets tests stub the
	 * transport without touching payload assembly.
	 */
	private copyTextToClipboard(text: string): Promise<void> {
		return copyTextToClipboard(text);
	}

	/**
	 * Copy the complete run configuration (Finder UI state + backtest settings) as
	 * JSON. The AO batch archives a config.txt with backtest settings only; the
	 * payload in `finder-export.ts` carries the Finder-side settings so archive
	 * runs are fully reproducible.
	 */
	private async copyRunConfiguration(): Promise<void> {
		if (this.resultStore.latestResults.scope === 'arm_performance') {
			if (!this.resultStore.armPerformanceRunContext) {
				uiManager.showToast('Arm Performance run context is unavailable in this cached preview.', 'error');
				return;
			}
			const payload = buildArmPerformanceRunConfigurationPayload(
				this.resultStore.armPerformanceRunContext,
				this.resultStore.armPerformanceRunResults.length,
				this.resultStore.armPerformanceInventoryComplete,
			);
			try {
				await this.copyTextToClipboard(formatCapturedConfiguration(payload));
				uiManager.showToast('Arm Performance configuration copied', 'success');
			} catch (error) {
				debugLogger.error('finder.copy_configuration_failed', { error: error instanceof Error ? error.message : String(error) });
				uiManager.showToast('Copy failed - check browser permissions', 'error');
			}
			return;
		}
		this.captureFinderUiState();
		const payload = buildFinderRunConfigurationPayload({
			uiState: this.uiState,
			backtestSettings: backtestService.getBacktestSettings(),
			capitalSettings: backtestService.getCapitalSettings(),
		});
		try {
			await this.copyTextToClipboard(formatCapturedConfiguration(payload));
			uiManager.showToast('Finder configuration copied', 'success');
		} catch (error) {
			debugLogger.error('finder.copy_configuration_failed', { error: error instanceof Error ? error.message : String(error) });
			uiManager.showToast('Copy failed - check browser permissions', 'error');
		}
	}

	private async copyFinderDiagnostics(): Promise<void> {
		if (this.resultStore.latestResults.scope === 'arm_performance') {
			try {
				await this.copyTextToClipboard(JSON.stringify(buildArmPerformanceDiagnosticsPayload({
					runContext: this.resultStore.armPerformanceRunContext,
					inventoryComplete: this.resultStore.armPerformanceInventoryComplete,
					results: this.resultStore.armPerformanceRunResults,
				}), null, 2));
				uiManager.showToast('Arm Performance diagnostics copied', 'success');
			} catch (error) {
				debugLogger.error('finder.copy_diagnostics_failed', { error: error instanceof Error ? error.message : String(error) });
				uiManager.showToast('Copy failed - check browser permissions', 'error');
			}
			return;
		}
		if (this.resultStore.latestResults.scope === 'asset_opportunity' && this.latestAssetOpportunityDiagnostics) {
			try {
				await this.copyTextToClipboard(JSON.stringify(
					buildAssetOpportunityDiagnosticsPayload(this.latestAssetOpportunityDiagnostics),
					null,
					2,
				));
				uiManager.showToast('Asset Opportunity diagnostics copied', 'success');
			} catch (error) {
				debugLogger.error('finder.copy_diagnostics_failed', { error: error instanceof Error ? error.message : String(error) });
				uiManager.showToast('Copy failed - check browser permissions', 'error');
			}
			return;
		}

		if (!this.latestDiagnostics) {
			if (!this.latestAssetOpportunityDiagnostics) {
				uiManager.showToast('No Finder diagnostics to copy', 'info');
				return;
			}
			try {
				await this.copyTextToClipboard(JSON.stringify(
					buildAssetOpportunityDiagnosticsPayload(this.latestAssetOpportunityDiagnostics),
					null,
					2,
				));
				uiManager.showToast('Asset Opportunity diagnostics copied', 'success');
			} catch (error) {
				debugLogger.error('finder.copy_diagnostics_failed', { error: error instanceof Error ? error.message : String(error) });
				uiManager.showToast('Copy failed - check browser permissions', 'error');
			}
			return;
		}

		try {
			await this.copyTextToClipboard(JSON.stringify(buildCompactFinderDiagnosticsPayload(this.latestDiagnostics), null, 2));
			uiManager.showToast('Compact Finder diagnostics copied', 'success');
		} catch (error) {
			debugLogger.error('finder.copy_diagnostics_failed', { error: error instanceof Error ? error.message : String(error) });
			uiManager.showToast('Copy failed - check browser permissions', 'error');
		}
	}

	private setProgress(active: boolean, percent: number, text: string): void {
		this.ui.setProgress(active, percent, text);
	}

	private setStatus(text: string): void {
		this.ui.setStatus(text);
	}

	private cloneBacktestSettings<T>(settings: T): T {
		return cloneJsonCompatible(settings);
	}

	public getLatestResults(): FinderLatestResults {
		return this.cloneBacktestSettings(this.resultStore.latestResults);
	}

	public getLatestCandidate(): FinderResult | FinderUniverseCandidate | FinderAssetOpportunityResult | FinderStrategyQualityResult | FinderArmPerformanceCandidate | null {
		if (this.resultStore.latestResults.results.length === 0) return null;
		return this.cloneBacktestSettings(this.resultStore.latestResults.results[0]);
	}

	public getLastRunBacktestSettings(): ReturnType<typeof settingsManager.getBacktestSettings> | null {
		return this.lastFinderRunBacktestSettings
			? this.cloneBacktestSettings(this.lastFinderRunBacktestSettings)
			: null;
	}
}

export const finderManager = new FinderManager();








