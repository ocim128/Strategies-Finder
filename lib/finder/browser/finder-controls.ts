/**
 * Finder controls: owner of the editable UI state (`uiState`), the form
 * binding/capture cycle, `readOptions` (the run-boundary input capture),
 * scope visibility, sorting controls, reset, and the persistence lifecycle
 * wiring. Browser-only.
 *
 * Capture happens at the existing boundaries (input events with a debounced
 * write, `captureFinderUiState()` at run start, and Copy Configuration);
 * nothing else samples the controls mid-await.
 */
import { setVisible } from "../../dom-utils";
import { state } from "../../state";
import { uiManager } from "../../ui-manager";
import { dataManager } from "../../data-manager";
import { setCurrentInterval } from "../../state-actions";
import { parseInputNumber } from "../../dom-input-readers";
import { getLocalDailyAssets } from "../../local-daily-datasets";
import { debugLogger } from "../../debug-logger";
import { debounce } from "../../debounce";
import {
	buildFinderOptions,
	buildFinderUniverseOptions,
	normalizeFinderDataSlice,
	normalizeFinderDateInput,
} from "../finder-manager-logic";
import {
	normalizeFinderAssetEvalLastBars,
	normalizeFinderAssetEvalWindowMode,
	normalizeFinderAssetOosHorizonBasis,
	normalizeFinderAssetOosBatchHoldoutRange,
	normalizeFinderAssetOosMeasurementMode,
	normalizeFinderAssetOosHorizons,
	normalizeFinderAssetOosIgnoreLastBars,
} from "../finder-asset-opportunity-oos";
import {
	DEFAULT_FINDER_UI_STATE,
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
} from "./finder-settings";
import { readFinderUiState, writeFinderUiState } from "./finder-persistence";
import {
	FINDER_SORT_OPTIONS,
	METRIC_FULL_LABELS,
	UNIVERSE_METRIC_FULL_LABELS,
} from "../constants";
import type {
	FinderMetric,
	FinderMode,
	FinderOptions,
	FinderScope as FinderScopeLike,
} from "../../types/finder";
import type { ReplayMode } from "../../batch-backtest/open-score-replay/types";
import { settingsManager } from "../../settings-manager";
import type { FinderManagerDom } from "../finder-manager-dom";
import type { FinderStrategySelection } from "./finder-strategy-selection";
import type { BatchHoldoutRange } from "./workflows/asset-opportunity";

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

export interface FinderControlsDeps {
	getDom(): FinderManagerDom;
	setStatus(text: string): void;
	renderLatestResults(): void;
	populateResortOptions(): void;
	applyResort(): void;
	/** Run-button click (Run/Stop orchestration lives in the controller). */
	requestRun(): void;
	/** Completed result provenance; null means the live mode controls own the labels. */
	getArmPerformanceReplayMode?(): ReplayMode | null;
	renderRandomBenchmark(mode: FinderOptions["mode"], payload?: unknown): void;
	selection: FinderStrategySelection;
}

export class FinderControls {
	uiState: FinderPersistedUiState = normalizeFinderUiState(null);
	private readonly persistUiStateDebounced = debounce(() => this.saveUiState(), 300);
	private finderPersistenceLifecycleBound = false;

	constructor(private readonly deps: FinderControlsDeps) {}

	getScope(): FinderScopeLike {
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

	usesUniverseStrategySelection(): boolean {
		return this.isUniverseScope() || this.isStrategyQualityScope() || this.isArmPerformanceScope();
	}

	/** Pagehide flush for the debounced settings write. Idempotent. */
	bindPersistenceLifecycle(): void {
		if (!this.finderPersistenceLifecycleBound && typeof window !== "undefined") {
			window.addEventListener("pagehide", () => this.persistUiStateDebounced.flush());
			this.finderPersistenceLifecycleBound = true;
		}
	}

	flushPendingPersistence(): void {
		this.persistUiStateDebounced.flush();
	}

	loadUiState(): void {
		this.uiState = readFinderUiState();
	}

	saveUiState(): void {
		writeFinderUiState(this.uiState);
	}

private parseUniverseSymbols(rawText = this.deps.getDom().finderUniverseSymbols.value): string[] {
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
	const dom = this.deps.getDom();
	if (this.isArmPerformanceScope()) {
		const pairs = dom.finderUniverseSymbols.value.split(/[\r\n,]+/).map((value) => value.trim()).filter(Boolean);
		dom.finderUniverseSummary.textContent = `${pairs.length} pair${pairs.length === 1 ? "" : "s"}`;
		return;
	}
	const symbols = this.parseUniverseSymbols(dom.finderUniverseSymbols.value);
	dom.finderUniverseSummary.textContent = `${symbols.length} symbol${symbols.length === 1 ? "" : "s"}`;
}


private async populateUniverseWithLocalDailySeeds(): Promise<void> {
	const dom = this.deps.getDom();
	dom.finderUniverseUseLocalSp500.disabled = true;

	try {
		const assets = (await getLocalDailyAssets()).filter((asset) => asset.provider !== "ibkr-local");
		const symbols = assets
			.map((asset) => asset.symbol.trim().toUpperCase())
			.filter(Boolean);

		if (symbols.length === 0) {
			this.deps.setStatus("Local seed catalogs are unavailable.");
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
		this.deps.setStatus(`Loaded ${symbols.length} local daily seed symbols for Symbol Universe mode on 1d.`);
	} catch (error) {
		debugLogger.error("finder.local_daily_universe_load_failed", {
			error: error instanceof Error ? error.message : String(error),
		});
		this.deps.setStatus("Unable to load local seed catalogs.");
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

applyPersistedUiStateToDom(): void {
	const dom = this.deps.getDom();
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
	dom.finderArmPerformanceReplayMode.value = this.uiState.armPerformanceReplayMode;
	dom.finderArmPerformanceExcludeTopContributor.checked = this.uiState.armPerformanceExcludeTopContributor;
	dom.finderArmPerformanceEventFilterEnabled.checked = this.uiState.armPerformanceEventFilterEnabled;
	dom.finderArmPerformanceMinEvents.value = String(this.uiState.armPerformanceMinEvents);
	dom.finderArmPerformanceMaxEvents.value = this.uiState.armPerformanceMaxEventsText;
	dom.finderArmPerformanceSelectionCooldownEnabled.checked = this.uiState.armPerformanceSelectionCooldownEnabled;
	dom.finderArmPerformanceSelectionCooldownBars.value = String(this.uiState.armPerformanceSelectionCooldownBars);
	this.syncArmPerformanceControls();
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

initOosValidationUI(): void {
	const dom = this.deps.getDom();
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
	const dom = this.deps.getDom();
	const dateRangeActive = normalizeFinderDataSlice(dom.finderDataSlice.value) === 'date_range';
	dom.finderDataRangeRow.style.display = dateRangeActive ? "" : "none";
}

initSortingUI(): void {
	// Populate Dropdowns
	const {
		finderSort: sortPrimary,
		finderSortSecondary: sortSecondary,
		finderAdvancedToggle: toggle,
		finderSimpleSort: simpleSection,
		finderSortList: advancedSection,
		finderUniverseSort,
		finderUniverseSortSecondary,
	} = this.deps.getDom();

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
	this.deps.getDom().finderMode.addEventListener('change', () => this.updateTimingSortControlState());

	// Initialize Advanced List
	this.initSortList();
	this.updateTimingSortControlState();
}

private initSortList(): void {
	const { finderSortList: list } = this.deps.getDom();

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
	const { finderSortList: container } = this.deps.getDom();
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
	const { finderSortList: container } = this.deps.getDom();
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

initStrategySelectionUI(): void {
	const dom = this.deps.getDom();

	dom.finderStrategyList.addEventListener('click', (event) => {
		const target = event.target as HTMLElement | null;
		const checkbox = target?.closest<HTMLInputElement>('input[type="checkbox"][data-strategy-key]');
		const strategyKey = checkbox?.dataset.strategyKey;
		if (!checkbox || !strategyKey || !dom.finderStrategyList.contains(checkbox)) {
			return;
		}
		this.deps.selection.handleStrategyToggleClick(strategyKey, event as MouseEvent);
	});

	dom.finderStrategyList.addEventListener('change', (event) => {
		const target = event.target as HTMLElement | null;
		const checkbox = target?.closest<HTMLInputElement>('input[type="checkbox"][data-strategy-key]');
		const strategyKey = checkbox?.dataset.strategyKey;
		if (!checkbox || !strategyKey || !dom.finderStrategyList.contains(checkbox)) {
			return;
		}
		this.deps.selection.handleStrategyToggleChange(strategyKey);
	});

	dom.finderStrategiesToggleAll.addEventListener('change', (event) => {
		this.deps.selection.setStrategySelection(this.deps.selection.strategyOrder, (event.target as HTMLInputElement).checked);
	});

	dom.finderStrategySearch.addEventListener('input', () => {
		this.deps.selection.applyStrategyFilter();
	});

	dom.finderStrategySelectAll.addEventListener('click', () => {
		this.deps.selection.setStrategySelection(this.deps.selection.strategyOrder, true);
	});

	dom.finderStrategySelectNone.addEventListener('click', () => {
		this.deps.selection.setStrategySelection(this.deps.selection.strategyOrder, false);
	});

	dom.finderStrategyInvertVisible.addEventListener('click', () => {
		this.deps.selection.invertStrategySelection(this.deps.selection.getVisibleStrategyKeys());
	});

	dom.finderStrategySelectVisible.addEventListener('click', () => {
		this.deps.selection.setStrategySelection(this.deps.selection.getVisibleStrategyKeys(), true);
	});

	dom.finderStrategySelectFollow.addEventListener('click', () => {
		this.deps.selection.replaceStrategySelection(FINDER_FOLLOW_STRATEGY_KEYS);
	});

	dom.finderStrategySelectReversion.addEventListener('click', () => {
		this.deps.selection.replaceStrategySelection(FINDER_REVERSION_STRATEGY_KEYS);
	});
}

initUniverseUI(): void {
	const dom = this.deps.getDom();

	dom.finderScope.addEventListener("change", () => {
		this.uiState.scope = normalizeFinderScope(dom.finderScope.value);
		this.applyScopeUi();
		this.deps.selection.syncStrategyToggleInputsFromState();
		this.deps.selection.syncStrategySelectionUi();
		this.deps.renderRandomBenchmark("grid");
		this.deps.renderLatestResults();
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
	const dom = this.deps.getDom();
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

applyScopeUi(): void {
	const dom = this.deps.getDom();
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
	this.syncArmPerformanceControls();
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
	dom.finderStrategyInvertVisible.disabled = this.deps.selection.getVisibleStrategyKeys().length === 0;
	dom.finderStrategySelectVisible.disabled = this.deps.selection.getVisibleStrategyKeys().length === 0;
	modeInput.disabled = modeLockedScope;
	const geneticOption = Array.from(modeInput.options).find((option) => option.value === "genetic");
	if (geneticOption) geneticOption.disabled = armPerformanceScope;
	if (modeLockedScope) {
		modeInput.value = "random";
	} else if (armPerformanceScope && modeInput.value === "genetic") {
		modeInput.value = "random";
		this.deps.setStatus("Arm Performance supports Grid Sweep and Random Search; Genetic Search was reset to Random Search.");
	}
	setVisible("finderBlockBadge", !multiAssetScope && Boolean(state.blockRange));
	this.setTradeFilterControlsEnabled(this.isTradeFilterControlsEnabled());
	this.updateTimingSortControlState();
	this.syncOosValidationControlState();
	this.syncDataRangeControlState();
	this.deps.populateResortOptions();
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
	const dom = this.deps.getDom();
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

private syncArmPerformanceControls(): void {
	const dom = this.deps.getDom();
	const switchMode = dom.finderArmPerformanceReplayMode.value === "asset_switch";
	const completedMode = this.deps.getArmPerformanceReplayMode?.() ?? null;
	const labelMode = completedMode ?? (switchMode ? "asset_switch" : "horizon");
	const filterEnabled = dom.finderArmPerformanceEventFilterEnabled.checked;
	dom.finderArmPerformanceHorizon.disabled = switchMode;
	dom.finderArmPerformanceSelectionCooldownEnabled.disabled = switchMode;
	dom.finderArmPerformanceSelectionCooldownBars.disabled = switchMode || !dom.finderArmPerformanceSelectionCooldownEnabled.checked;
	dom.finderArmPerformanceMinEvents.disabled = !filterEnabled;
	dom.finderArmPerformanceMaxEvents.disabled = !filterEnabled;
	const useTradeCount = labelMode === "asset_switch";
	const eventFilterLabel = document.getElementById("finderArmPerformanceEventFilterLabel");
	const minLabel = document.getElementById("finderArmPerformanceMinEventsLabel");
	const maxLabel = document.getElementById("finderArmPerformanceMaxEventsLabel");
	if (eventFilterLabel) eventFilterLabel.textContent = useTradeCount ? "Completed trade count filter" : "Completed event count filter";
	if (minLabel) minLabel.textContent = useTradeCount ? "Min trades" : "Min events";
	if (maxLabel) maxLabel.textContent = useTradeCount ? "Max trades" : "Max events";
}

initTradeFilterUI(): void {
	const { finderTradesToggle } = this.deps.getDom();
	finderTradesToggle.addEventListener("change", () => {
		this.setTradeFilterControlsEnabled(this.isTradeFilterControlsEnabled());
	});
	this.setTradeFilterControlsEnabled(this.isTradeFilterControlsEnabled());
}

private isTradeFilterControlsEnabled(): boolean {
	const dom = this.deps.getDom();
	return !this.isUniverseScope() && !this.isStrategyQualityScope() && !this.isArmPerformanceScope() && dom.finderTradesToggle.checked;
}

private setTradeFilterControlsEnabled(enabled: boolean): void {
	const dom = this.deps.getDom();
	dom.finderTradeFilters.classList.toggle("is-disabled", !enabled);
	dom.finderTradesMin.disabled = !enabled;
	dom.finderTradesMax.disabled = !enabled;
}

initFinderSettingsPersistenceUI(): void {
	const dom = this.deps.getDom();
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
		dom.finderArmPerformanceReplayMode,
		dom.finderArmPerformanceHorizon,
		dom.finderArmPerformanceExcludeTopContributor,
		dom.finderArmPerformanceEventFilterEnabled,
		dom.finderArmPerformanceMinEvents,
		dom.finderArmPerformanceMaxEvents,
		dom.finderArmPerformanceSelectionCooldownEnabled,
		dom.finderArmPerformanceSelectionCooldownBars,
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
	dom.finderArmPerformanceEventFilterEnabled.addEventListener("change", () => this.syncArmPerformanceControls());
	dom.finderArmPerformanceSelectionCooldownEnabled.addEventListener("change", () => this.syncArmPerformanceControls());
	dom.finderArmPerformanceReplayMode.addEventListener("change", () => this.syncArmPerformanceControls());
}

captureFinderUiState(persist = true): void {
	const dom = this.deps.getDom();
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
	this.uiState.armPerformanceReplayMode = dom.finderArmPerformanceReplayMode.value === "asset_switch" ? "asset_switch" : "horizon";
	this.uiState.armPerformanceExcludeTopContributor = dom.finderArmPerformanceExcludeTopContributor.checked;
	this.uiState.armPerformanceEventFilterEnabled = dom.finderArmPerformanceEventFilterEnabled.checked;
	this.uiState.armPerformanceMinEvents = Math.max(1, Math.min(1_000_000, Math.round(this.readFinderNumberInput(
		dom.finderArmPerformanceMinEvents,
		DEFAULT_FINDER_UI_STATE.armPerformanceMinEvents,
		1,
	))));
	this.uiState.armPerformanceMaxEventsText = dom.finderArmPerformanceMaxEvents.value.trim();
	this.uiState.armPerformanceSelectionCooldownEnabled = dom.finderArmPerformanceSelectionCooldownEnabled.checked;
	this.uiState.armPerformanceSelectionCooldownBars = Math.max(1, Math.min(10_000, Math.round(this.readFinderNumberInput(
		dom.finderArmPerformanceSelectionCooldownBars,
		DEFAULT_FINDER_UI_STATE.armPerformanceSelectionCooldownBars,
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
	const dom = this.deps.getDom();
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

resetFinderSettings(): void {
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
	this.deps.selection.syncStrategyToggleInputsFromState();
	this.deps.selection.syncStrategySelectionUi();
	this.setTradeFilterControlsEnabled(this.isTradeFilterControlsEnabled());
	this.applyScopeUi();
	this.saveUiState();
	this.deps.setStatus("Finder settings reset.");
}

private updateTimingSortControlState(): void {
	const dom = this.deps.getDom();
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

readOptions(backtestSettings: Pick<ReturnType<typeof settingsManager.getBacktestSettings>, 'executionModel' | 'disableSignalExits' | 'exitStrategyOverrideEnabled'>): FinderOptions {
	const dom = this.deps.getDom();
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
		const replayMode = dom.finderArmPerformanceReplayMode.value === "asset_switch" ? "asset_switch" : "horizon";
		options.armPerformance = {
			replayMode,
			...(replayMode === "horizon" ? {
				horizon: Math.max(1, Math.min(1_000, Math.round(this.readFinderNumberInput(
					dom.finderArmPerformanceHorizon,
					DEFAULT_FINDER_UI_STATE.armPerformanceHorizon,
					1,
				)))),
			} : {}),
			dateMode,
			scoringBasis: dom.finderArmPerformanceExcludeTopContributor.checked ? "exclude_top_contributor" : "raw",
			eventFilterEnabled: dom.finderArmPerformanceEventFilterEnabled.checked,
			minEvents: Math.max(1, Math.round(this.readFinderNumberInput(
				dom.finderArmPerformanceMinEvents,
				DEFAULT_FINDER_UI_STATE.armPerformanceMinEvents,
				1,
			))),
			maxEvents: dom.finderArmPerformanceMaxEvents.value.trim() === ""
				? null
				: Math.round(this.readFinderNumberInput(dom.finderArmPerformanceMaxEvents, Number.POSITIVE_INFINITY, 1)),
			selectionCooldownEnabled: replayMode === "horizon" && dom.finderArmPerformanceSelectionCooldownEnabled.checked,
			selectionCooldownBars: Math.max(1, Math.round(this.readFinderNumberInput(
				dom.finderArmPerformanceSelectionCooldownBars,
				DEFAULT_FINDER_UI_STATE.armPerformanceSelectionCooldownBars,
				1,
			))),
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

isAssetOpportunityBatchMode(): boolean {
	return this.deps.getDom().finderAssetOosBatchToggle.checked;
}

/** Validated batch holdout range straight from the DOM inputs. */
readBatchHoldoutRange(): BatchHoldoutRange {
	return normalizeFinderAssetOosBatchHoldoutRange(
		this.deps.getDom().finderAssetOosBatchStart.value,
		this.deps.getDom().finderAssetOosBatchEnd.value,
	);
}

/**
 * Presentation/lifecycle capabilities shared by every scope workflow.
 * Mutable state stays in the result store and session; this only forwards
 * to the UI, render dispatch, and the browser-cancellation flag.
 */}
