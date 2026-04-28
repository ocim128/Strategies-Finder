import { OHLCVData, StrategyParams } from "./strategies/index";
import { strategyRegistry, getStrategyList, loadBuiltInStrategyByKey } from "../strategyRegistry";
import { state } from "./state";
import { backtestService } from "./backtest-service";
import { paramManager } from "./param-manager";
import { uiManager } from "./ui-manager";
import { setVisible } from "./dom-utils";
import { dataManager } from "./data-manager";
import { settingsManager } from "./settings-manager";
import { readPersistedJson, writePersistedJson } from "./persisted-json";
import { MAJOR_SYMBOLS } from "./portfolioLab/portfolio-lab-types";

import { DEFAULT_SORT_PRIORITY, METRIC_FULL_LABELS, UNIVERSE_METRIC_FULL_LABELS } from "./finder/constants";
import { runFinderExecution, type FinderSelectedStrategy } from "./finder/finder-runner";
import { runFinderUniverseExecution } from "./finder/finder-runner-universe";
import { FinderParamSpace } from "./finder/finder-param-space";
import { FinderUI } from "./finder/finder-ui";
import {
	buildFinderOptions,
	buildFinderUniverseOptions,
	resolveFinderPolymarketExitMode,
} from "./finder/finder-manager-logic";
import { sortFinderResults } from "./finder/finder-engine";
import { mergeFinderRiskParamsIntoBacktestSettings } from "./finder/finder-runner-core";
import { sortFinderUniverseCandidates } from "./finder/finder-universe-metrics";
import { debugLogger } from "./debug-logger";
import { parseInputNumber } from "./dom-input-readers";
import { sliceOhlcvByBlock } from "./block-selector";
import { strategyPanelController } from "./strategy-panel-controller";
import { setCurrentStrategyKey } from "./state-actions";
import { createTaskYielder } from "./task-yield";
import {
	createFinderManagerDom,
	type FinderManagerDom,
} from "./finder/finder-manager-dom";
import type {
	FinderLatestResults,
	FinderMetric,
	FinderMode,
	FinderOptions,
	FinderScope,
	PolymarketFinderRankMode,
	FinderResult,
	FinderUniverseCandidate,
	FinderUniverseMetric,
} from './types/finder';
import { isSmartTradeSizingMode } from "./types/backtest";
import { isSignalExitSameEventMode } from "./polymarket-exit-mode";
import { resolvePolymarketDomSettings } from "./polymarket-dom-reader";

type FinderPersistedUiState = {
	scope: FinderScope;
	currentChartSelectedStrategyKeys: string[];
	universeSelectedStrategyKeys: string[];
	universeSymbolsText: string;
	universeMinActiveSymbols: number;
	universeMinTotalTrades: number;
	universeMinProfitableActiveRatio: number;
	universeSort: FinderUniverseMetric;
	universeSortSecondary: FinderUniverseMetric;
};

const FINDER_UI_STORAGE = {
	key: "playground_finder_ui",
	schema: "finder.ui",
	version: 1,
} as const;

const DEFAULT_FINDER_UI_STATE: FinderPersistedUiState = {
	scope: "current_chart",
	currentChartSelectedStrategyKeys: [],
	universeSelectedStrategyKeys: [],
	universeSymbolsText: "",
	universeMinActiveSymbols: 2,
	universeMinTotalTrades: 40,
	universeMinProfitableActiveRatio: 0.5,
	universeSort: "profitableActiveRatio",
	universeSortSecondary: "medianExpectancy",
};

const UNIVERSE_SORT_OPTIONS: readonly FinderUniverseMetric[] = [
	"profitableActiveRatio",
	"medianExpectancy",
	"worstNetProfit",
	"totalTrades",
	"activeSymbols",
] as const;

function normalizeStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const unique = new Set<string>();
	for (const entry of value) {
		if (typeof entry !== "string") {
			continue;
		}
		const normalized = entry.trim();
		if (normalized) {
			unique.add(normalized);
		}
	}
	return [...unique];
}

function normalizeFinderScope(value: unknown): FinderScope {
	return value === "symbol_universe" ? "symbol_universe" : "current_chart";
}

function normalizeFinderUniverseMetric(
	value: unknown,
	fallback: FinderUniverseMetric
): FinderUniverseMetric {
	return UNIVERSE_SORT_OPTIONS.includes(value as FinderUniverseMetric)
		? value as FinderUniverseMetric
		: fallback;
}

function normalizeFinderUiState(raw: unknown): FinderPersistedUiState {
	const source = raw && typeof raw === "object" && !Array.isArray(raw)
		? raw as Record<string, unknown>
		: {};
	const minActiveSymbols = typeof source.universeMinActiveSymbols === "number"
		? Math.max(1, Math.round(source.universeMinActiveSymbols))
		: DEFAULT_FINDER_UI_STATE.universeMinActiveSymbols;
	const minTotalTrades = typeof source.universeMinTotalTrades === "number"
		? Math.max(0, Math.round(source.universeMinTotalTrades))
		: DEFAULT_FINDER_UI_STATE.universeMinTotalTrades;
	const minProfitableActiveRatio = typeof source.universeMinProfitableActiveRatio === "number"
		? Math.max(0, Math.min(1, source.universeMinProfitableActiveRatio))
		: DEFAULT_FINDER_UI_STATE.universeMinProfitableActiveRatio;

	return {
		scope: normalizeFinderScope(source.scope),
		currentChartSelectedStrategyKeys: normalizeStringArray(source.currentChartSelectedStrategyKeys),
		universeSelectedStrategyKeys: (() => {
			const normalized = normalizeStringArray(source.universeSelectedStrategyKeys);
			if (normalized.length > 0) {
				return normalized;
			}
			if (typeof source.universeSelectedStrategyKey === "string" && source.universeSelectedStrategyKey.trim()) {
				return [source.universeSelectedStrategyKey.trim()];
			}
			return [];
		})(),
		universeSymbolsText: typeof source.universeSymbolsText === "string" ? source.universeSymbolsText : "",
		universeMinActiveSymbols: minActiveSymbols,
		universeMinTotalTrades: minTotalTrades,
		universeMinProfitableActiveRatio: minProfitableActiveRatio,
		universeSort: normalizeFinderUniverseMetric(source.universeSort, DEFAULT_FINDER_UI_STATE.universeSort),
		universeSortSecondary: normalizeFinderUniverseMetric(source.universeSortSecondary, DEFAULT_FINDER_UI_STATE.universeSortSecondary),
	};
}

export class FinderManager {
	private isRunning = false;
	private isCancelled = false;
	private latestResults: FinderLatestResults = { scope: "current_chart", results: [] };
	private lastFinderRunBacktestSettings: ReturnType<typeof settingsManager.getBacktestSettings> | null = null;
	private lastFinderOptions: FinderOptions | null = null;
	private strategyToggles: Map<string, HTMLInputElement> = new Map();
	private strategyItems: Map<string, HTMLDivElement> = new Map();
	private strategyOrder: string[] = [];
	private lastStrategyToggleKey: string | null = null;
	private uiState: FinderPersistedUiState = normalizeFinderUiState(null);
	private readonly ui = new FinderUI();
	private readonly paramSpace = new FinderParamSpace();
	private readonly taskYielder = createTaskYielder();
	private dom: FinderManagerDom | null = null;

	private getDom(): FinderManagerDom {
		return this.dom ??= createFinderManagerDom();
	}

	private getScope(): FinderScope {
		return this.uiState.scope;
	}

	private isUniverseScope(): boolean {
		return this.getScope() === "symbol_universe";
	}

	private loadUiState(): void {
		this.uiState = readPersistedJson<FinderPersistedUiState>({
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

	private saveUiState(): void {
		writePersistedJson({
			...FINDER_UI_STORAGE,
			data: this.uiState,
			onError: (error) => {
				debugLogger.error("finder.ui_state_save_failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			},
		});
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
		const symbols = this.parseUniverseSymbols(dom.finderUniverseSymbols.value);
		dom.finderUniverseSummary.textContent = `${symbols.length} symbol${symbols.length === 1 ? "" : "s"}`;
	}

	private applyPersistedUiStateToDom(): void {
		const dom = this.getDom();
		dom.finderScope.value = this.uiState.scope;
		dom.finderUniverseSymbols.value = this.uiState.universeSymbolsText;
		dom.finderUniverseMinActiveSymbols.value = String(this.uiState.universeMinActiveSymbols);
		dom.finderUniverseMinTotalTrades.value = String(this.uiState.universeMinTotalTrades);
		dom.finderUniverseMinProfitableActiveRatio.value = String(this.uiState.universeMinProfitableActiveRatio);
		this.updateUniverseSummary();
	}

	public init() {
		this.loadUiState();
		const dom = this.getDom();
		this.applyPersistedUiStateToDom();
		dom.runFinder.addEventListener('click', () => {
			void this.runFinder();
		});

		dom.stopFinder.addEventListener('click', () => {
			this.isCancelled = true;
		});

		const copyTopButton = dom.finderCopyTopResults;
		copyTopButton.disabled = true;
		copyTopButton.addEventListener('click', () => {
			void this.copyTopResultsMetadata();
		});

		dom.finderList.addEventListener('click', (event) => {
			const target = event.target as HTMLElement | null;
			const button = target?.closest<HTMLButtonElement>('.finder-apply');
			if (!button) return;
			const index = Number(button.dataset.index);
			if (this.latestResults.scope === "current_chart") {
				const result = this.latestResults.results[index];
				if (result) {
					void this.applyCurrentChartResult(result);
				}
				return;
			}
			const candidate = this.latestResults.results[index];
			if (candidate) {
				void this.applyUniverseCandidate(candidate);
			}
		});

		this.renderStrategySelection();
		this.initStrategySelectionUI();

		this.initSortingUI();
		this.initUniverseUI();
		this.initPolymarketUI();
		this.applyScopeUi();
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

		const optionsHtml = DEFAULT_SORT_PRIORITY.map(key =>
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

		// Advanced Toggle Logic
		toggle.addEventListener('change', () => {
			setVisible(simpleSection, !toggle.checked);
			setVisible(advancedSection, toggle.checked);
		});

		// Initialize Advanced List
		this.initSortList();
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
		});

		this.renderSortList();
	}

	private renderSortList(): void {
		const { finderSortList: container } = this.getDom();
		container.innerHTML = '';

		DEFAULT_SORT_PRIORITY.forEach(metric => {
			const div = document.createElement('div');
			div.className = 'finder-sort-item';
			div.dataset.value = metric;
			div.innerHTML = `
				<span class="sort-label">${METRIC_FULL_LABELS[metric]}</span>
				<div class="finder-sort-actions">
					<button class="finder-sort-btn sort-up" title="Move Up">▲</button>
					<button class="finder-sort-btn sort-down" title="Move Down">▼</button>
				</div>
			`;
			container.appendChild(div);
		});
	}

	private initStrategySelectionUI(): void {
		const dom = this.getDom();

		dom.finderStrategiesToggleAll.addEventListener('change', (event) => {
			this.setStrategySelection(this.strategyOrder, (event.target as HTMLInputElement).checked);
		});

		dom.finderStrategySearch.addEventListener('input', () => {
			this.applyStrategyFilter();
		});

		dom.finderStrategySelectAll.addEventListener('click', () => {
			this.setStrategySelection(this.strategyOrder, true);
		});

		dom.finderStrategySelectNone.addEventListener('click', () => {
			this.setStrategySelection(this.strategyOrder, false);
		});

		dom.finderStrategyInvertVisible.addEventListener('click', () => {
			this.invertStrategySelection(this.getVisibleStrategyKeys());
		});

		dom.finderStrategySelectVisible.addEventListener('click', () => {
			this.setStrategySelection(this.getVisibleStrategyKeys(), true);
		});
	}

	private initUniverseUI(): void {
		const dom = this.getDom();

		dom.finderScope.addEventListener("change", () => {
			this.uiState.scope = dom.finderScope.value === "symbol_universe" ? "symbol_universe" : "current_chart";
			this.applyScopeUi();
			this.syncStrategyToggleInputsFromState();
			this.syncStrategySelectionUi();
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
				this.captureUniverseUiState();
			});
			element.addEventListener("change", () => {
				this.captureUniverseUiState();
			});
		});
	}

	private captureUniverseUiState(): void {
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
		this.saveUiState();
	}

	private applyScopeUi(): void {
		const dom = this.getDom();
		const universeScope = this.isUniverseScope();
		const modeInput = dom.finderMode;

		dom.finderChartSortSection.style.display = universeScope ? "none" : "";
		dom.finderUniverseSortSection.style.display = universeScope ? "" : "none";
		dom.finderUniverseSectionHeader.style.display = universeScope ? "" : "none";
		dom.finderUniverseSection.style.display = universeScope ? "" : "none";
		dom.finderPolymarketSection.style.display = universeScope ? "none" : "";
		dom.finderTradeFilterSection.style.display = universeScope ? "none" : "";
		dom.finderModeRow.classList.toggle("is-disabled", universeScope);
		dom.finderStepsRow.style.display = universeScope ? "none" : "";
		dom.finderStrategyActions.classList.remove("is-disabled");
		dom.finderStrategiesToggleAll.disabled = false;
		dom.finderStrategySelectAll.disabled = false;
		dom.finderStrategySelectNone.disabled = false;
		dom.finderStrategyInvertVisible.disabled = this.getVisibleStrategyKeys().length === 0;
		dom.finderStrategySelectVisible.disabled = this.getVisibleStrategyKeys().length === 0;
		modeInput.disabled = universeScope;
		if (universeScope) {
			modeInput.value = "random";
		}
		setVisible("finderBlockBadge", !universeScope && Boolean(state.blockRange));
	}

	private initPolymarketUI(): void {
		const { finderPolymarketToggle: toggle } = this.getDom();
		const refreshControls = () => {
			this.setPolymarketControlsEnabled(toggle.checked);
		};

		refreshControls();
		toggle.addEventListener('change', refreshControls);
		document.getElementById('polymarketOutcomeInterval')?.addEventListener('change', refreshControls);
		document.getElementById('polymarketExitMode')?.addEventListener('change', refreshControls);
	}

	private setPolymarketControlsEnabled(enabled: boolean): void {
		const dom = this.getDom();
		const polymarketSettings = resolvePolymarketDomSettings();
		const lockOffsetRelevant = polymarketSettings.exitMode !== 'signal_exit_same_event'
			&& polymarketSettings.outcomeInterval === '5m';

		dom.finderPolymarketSettings.classList.toggle('is-disabled', !enabled);
		dom.finderPolymarketRankMode.disabled = !enabled;
		dom.finderPolymarketMinScored.disabled = !enabled;
		dom.finderPolymarketLockOffset.disabled = !enabled || !lockOffsetRelevant;
		dom.finderPolymarketAfterTakeProfitOnly.disabled = !enabled;
	}

	private getCurrentChartSelectedStrategyKeys(): Set<string> {
		return new Set(this.uiState.currentChartSelectedStrategyKeys);
	}

	private getUniverseSelectedStrategyKeys(): Set<string> {
		return new Set(this.uiState.universeSelectedStrategyKeys);
	}

	private syncStrategyToggleInputsFromState(): void {
		this.strategyToggles.forEach((toggle, key) => {
			toggle.checked = this.isStrategySelected(key);
		});
	}

	private isStrategySelected(key: string): boolean {
		return this.isUniverseScope()
			? this.getUniverseSelectedStrategyKeys().has(key)
			: this.getCurrentChartSelectedStrategyKeys().has(key);
	}

	private renderStrategySelection(): void {
		const container = this.getDom().finderStrategyList;
		container.innerHTML = '';
		this.strategyToggles.clear();
		this.strategyItems.clear();
		this.strategyOrder = [];
		this.lastStrategyToggleKey = null;

		const strategies = strategyRegistry.getAll();
		const allStrategies = getStrategyList();
		const fragment = document.createDocumentFragment();

		for (const { key, name } of allStrategies) {
			const strategy = strategies[key];
			const displayName = strategy?.name ?? name;
			const item = document.createElement('div');
			item.className = 'strategy-list-item';
			item.dataset.strategyKey = key;
			item.dataset.strategyName = displayName.toLowerCase();

			const checkbox = document.createElement('input');
			checkbox.type = 'checkbox';
			checkbox.id = `finder-strategy-${key}`;
			checkbox.checked = this.isStrategySelected(key);
			checkbox.addEventListener('click', (event) => {
				this.handleStrategyToggleClick(key, event as MouseEvent);
			});
			checkbox.addEventListener('change', () => {
				this.handleStrategyToggleChange(key);
			});

			const label = document.createElement('label');
			label.htmlFor = `finder-strategy-${key}`;
			label.textContent = displayName;

			item.appendChild(checkbox);
			item.appendChild(label);
			fragment.appendChild(item);

			this.strategyToggles.set(key, checkbox);
			this.strategyItems.set(key, item);
			this.strategyOrder.push(key);
		}
		container.appendChild(fragment);

		this.applyStrategyFilter();
		this.syncStrategySelectionUi();
	}

	private readFinderNumberInput(input: HTMLInputElement, fallback: number, min?: number): number {
		const value = parseInputNumber(input.value);
		if (value === null) return fallback;
		return min === undefined ? value : Math.max(min, value);
	}

	private handleStrategyToggleClick(strategyKey: string, event: MouseEvent): void {
		const checkbox = this.strategyToggles.get(strategyKey);
		if (!checkbox) return;

		if (event.shiftKey && this.lastStrategyToggleKey) {
			const orderedKeys = this.getStrategyKeysForRangeSelection();
			const startIndex = orderedKeys.indexOf(this.lastStrategyToggleKey);
			const endIndex = orderedKeys.indexOf(strategyKey);

			if (startIndex !== -1 && endIndex !== -1) {
				const [from, to] = startIndex < endIndex ? [startIndex, endIndex] : [endIndex, startIndex];
				this.setStrategySelection(orderedKeys.slice(from, to + 1), checkbox.checked, false);
			}
		}

		this.lastStrategyToggleKey = strategyKey;
		this.syncStrategySelectionUi();
	}

	private handleStrategyToggleChange(strategyKey: string): void {
		const checkbox = this.strategyToggles.get(strategyKey);
		if (!checkbox) {
			return;
		}

		const selected = this.isUniverseScope()
			? this.getUniverseSelectedStrategyKeys()
			: this.getCurrentChartSelectedStrategyKeys();
		if (checkbox.checked) {
			selected.add(strategyKey);
		} else {
			selected.delete(strategyKey);
		}
		if (this.isUniverseScope()) {
			this.uiState.universeSelectedStrategyKeys = [...selected];
		} else {
			this.uiState.currentChartSelectedStrategyKeys = [...selected];
		}
		this.saveUiState();
		this.syncStrategySelectionUi();
	}

	private getStrategyKeysForRangeSelection(): string[] {
		const visibleKeys = this.getVisibleStrategyKeys();
		return visibleKeys.length > 0 ? visibleKeys : this.strategyOrder;
	}

	private getVisibleStrategyKeys(): string[] {
		return this.strategyOrder.filter((key) => {
			const item = this.strategyItems.get(key);
			return item ? !item.hidden : false;
		});
	}

	private setStrategySelection(strategyKeys: Iterable<string>, checked: boolean, syncUi = true): void {
		const selected = this.isUniverseScope()
			? this.getUniverseSelectedStrategyKeys()
			: this.getCurrentChartSelectedStrategyKeys();
		for (const key of strategyKeys) {
			const toggle = this.strategyToggles.get(key);
			if (toggle) {
				toggle.checked = checked;
				if (checked) {
					selected.add(key);
				} else {
					selected.delete(key);
				}
			}
		}
		if (this.isUniverseScope()) {
			this.uiState.universeSelectedStrategyKeys = [...selected];
		} else {
			this.uiState.currentChartSelectedStrategyKeys = [...selected];
		}
		this.saveUiState();

		if (syncUi) {
			this.syncStrategySelectionUi();
		}
	}

	private invertStrategySelection(strategyKeys: Iterable<string>): void {
		const selected = this.isUniverseScope()
			? this.getUniverseSelectedStrategyKeys()
			: this.getCurrentChartSelectedStrategyKeys();
		for (const key of strategyKeys) {
			const toggle = this.strategyToggles.get(key);
			if (toggle) {
				toggle.checked = !toggle.checked;
				if (toggle.checked) {
					selected.add(key);
				} else {
					selected.delete(key);
				}
			}
		}
		if (this.isUniverseScope()) {
			this.uiState.universeSelectedStrategyKeys = [...selected];
		} else {
			this.uiState.currentChartSelectedStrategyKeys = [...selected];
		}
		this.saveUiState();

		this.syncStrategySelectionUi();
	}

	private applyStrategyFilter(): void {
		const { finderStrategySearch: searchInput } = this.getDom();
		const query = searchInput.value.trim().toLowerCase();

		this.strategyItems.forEach((item) => {
			const strategyName = item.dataset.strategyName ?? '';
			item.hidden = query.length > 0 && !strategyName.includes(query);
		});

		this.syncStrategySelectionUi();
	}

	private syncStrategySelectionUi(): void {
		const dom = this.getDom();
		const totalCount = this.strategyOrder.length;
		const visibleKeys = this.getVisibleStrategyKeys();
		const visibleSet = new Set(visibleKeys);
		let selectedCount = 0;
		let visibleSelectedCount = 0;

		this.strategyToggles.forEach((toggle, key) => {
			if (!toggle.checked) return;
			selectedCount += 1;
			if (visibleSet.has(key)) {
				visibleSelectedCount += 1;
			}
		});

		const hasFilter = dom.finderStrategySearch.value.trim().length > 0;
		dom.finderStrategiesToggleAll.checked = totalCount > 0 && selectedCount === totalCount;
		dom.finderStrategiesToggleAll.indeterminate = selectedCount > 0 && selectedCount < totalCount;
		dom.finderStrategySelectVisible.disabled = visibleKeys.length === 0;
		dom.finderStrategyInvertVisible.disabled = visibleKeys.length === 0;
		dom.finderStrategySummary.textContent = hasFilter
			? `${selectedCount} selected | ${visibleKeys.length} visible | ${visibleSelectedCount} visible selected`
			: `${selectedCount} selected`;
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
		if (this.isRunning) return;
		if (!this.isUniverseScope() && state.ohlcvData.length === 0) {
			this.setStatus('Data not loaded. Attempting to load...');
			await dataManager.loadData();

			if (state.ohlcvData.length === 0) {
				this.setStatus('Load data before running the finder.');
				return;
			}
		}

		this.isCancelled = false;
		this.isRunning = true;
		const startTime = performance.now();
		this.lastFinderRunBacktestSettings = null;
		this.lastFinderOptions = null;

		const settingsSnapshot = this.cloneBacktestSettings(settingsManager.getBacktestSettings());
		this.lastFinderRunBacktestSettings = this.cloneBacktestSettings(settingsSnapshot);
		const options = this.readOptions(settingsSnapshot);
		this.lastFinderOptions = this.cloneBacktestSettings(options);

		const dom = this.getDom();
		const runButton = dom.runFinder;
		const stopButton = dom.stopFinder;
		let progressFinalized = false;
		const setRunningUI = (running: boolean) => {
			runButton.disabled = running;
			runButton.classList.toggle('is-loading', running);
			runButton.setAttribute('aria-busy', running ? 'true' : 'false');
			stopButton.style.display = running ? '' : 'none';
		};
		const finalizeProgress = (percent: number, text: string) => {
			this.setProgress(false, percent, text);
			progressFinalized = true;
		};

		setRunningUI(true);
		this.setProgress(true, 0, 'Preparing...');
		this.setStatus('Running strategy finder...');
		this.ui.renderRandomBenchmark(options.mode);
		this.setLatestResults({
			scope: options.scope === 'symbol_universe' ? 'symbol_universe' : 'current_chart',
			results: [],
		});
		this.renderLatestResults();

		try {
			const completed = options.scope === 'symbol_universe'
				? await this.runUniverseFinder(options, startTime)
				: await this.runCurrentChartFinder(options, startTime);

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
					polymarketScoringEnabled: options.polymarketScoringEnabled,
					error: message,
				});
				this.setStatus(`Finder failed. ${message}`);
				uiManager.showToast('Finder run failed. Check the status panel for details.', 'error');
			}
		} finally {
			if (!progressFinalized) {
				finalizeProgress(0, '');
			}
			this.isCancelled = false;
			setRunningUI(false);
			this.isRunning = false;
		}
	}

	private async runCurrentChartFinder(options: FinderOptions, startTime: number): Promise<boolean> {
		const selectedStrategies = await this.getSelectedStrategies();
		if (selectedStrategies.length === 0) {
			this.setStatus('No strategies selected.');
			return false;
		}

		const capitalSettings = backtestService.getCapitalSettings();
		const settings = backtestService.getBacktestSettings();
		const requiresTsEngine = backtestService.requiresTypescriptEngine(settings) || isSmartTradeSizingMode(capitalSettings.sizingMode);

		const ohlcvData = sliceOhlcvByBlock(state.ohlcvData, state.blockRange);
		if (ohlcvData.length === 0) {
			this.setStatus('No candles available for finder run.');
			return false;
		}

		const output = await runFinderExecution(
			{
				ohlcvData,
				symbol: state.currentSymbol,
				interval: state.currentInterval,
				options,
				settings,
				requiresTsEngine,
				selectedStrategies,
				capitalSettings,
				getFinderTimeframesForRun: () => [state.currentInterval],
				loadMultiTimeframeDatasets: async () => [],
				generateParamSets: (defaultParams, finderOptions) => this.generateParamSets(defaultParams, finderOptions),
				buildRandomConfirmationParams: (strategyKeys, finderOptions) => this.buildRandomConfirmationParams(strategyKeys, finderOptions),
			},
			{
				setProgress: (percent, text) => this.setProgress(true, percent, text),
				setStatus: (text) => this.setStatus(text),
				yieldControl: () => this.taskYielder.yieldControl(),
				isCancelled: () => this.isCancelled,
				onResultsUpdate: (results: FinderResult[]) => {
					const sorted = sortFinderResults(results, options.sortPriority);
					this.setLatestResults({ scope: 'current_chart', results: sorted });
					this.renderLatestResults();
				},
			}
		);

		const sortedResults = sortFinderResults(output.results, options.sortPriority);
		this.setLatestResults({ scope: 'current_chart', results: sortedResults });
		this.renderLatestResults();
		this.ui.renderRandomBenchmark(options.mode, output.randomBenchmark);

		if (!this.isCancelled) {
			this.setStatus(`Finder complete. ${sortedResults.length} result${sortedResults.length === 1 ? '' : 's'} in ${Math.round(performance.now() - startTime)}ms.`);
		}
		return true;
	}

	private async runUniverseFinder(options: FinderOptions, startTime: number): Promise<boolean> {
		const selectedStrategies = await this.getUniverseSelectedStrategies();
		if (selectedStrategies.length === 0) {
			this.setStatus('Select at least one strategy for Symbol Universe mode.');
			return false;
		}
		if (!options.universe || options.universe.symbols.length === 0) {
			this.setStatus('Add at least one symbol for Symbol Universe mode.');
			return false;
		}

		const allResults: FinderUniverseCandidate[] = [];
		const failedSymbols = new Set<string>();
		let maxLoadedSymbols = 0;
		const settings = backtestService.getBacktestSettings();
		const capitalSettings = backtestService.getCapitalSettings();
		const datasetCache = new Map<string, Promise<OHLCVData[]>>();
		const loadDataset = (symbol: string, interval: string, signal?: AbortSignal) => {
			const key = `${symbol.trim().toUpperCase()}|${interval.trim().toLowerCase()}`;
			const cached = datasetCache.get(key);
			if (cached) {
				return cached;
			}
			const promise = dataManager.fetchDataDetached(symbol, interval, signal);
			datasetCache.set(key, promise);
			return promise;
		};

		for (let strategyIndex = 0; strategyIndex < selectedStrategies.length; strategyIndex += 1) {
			const selectedStrategy = selectedStrategies[strategyIndex]!;
			const output = await runFinderUniverseExecution(
				{
					interval: state.currentInterval,
					options,
					settings,
					capitalSettings,
					selectedStrategy,
					loadDataset,
					generateParamSets: (defaultParams, finderOptions) => this.generateParamSets(defaultParams, finderOptions),
				},
				{
					setProgress: (percent, text) => {
						const scaledPercent = ((strategyIndex + (percent / 100)) / selectedStrategies.length) * 100;
						this.setProgress(true, scaledPercent, text);
					},
					setStatus: (text) => this.setStatus(`[${strategyIndex + 1}/${selectedStrategies.length}] ${selectedStrategy.name}: ${text}`),
					yieldControl: () => this.taskYielder.yieldControl(),
					isCancelled: () => this.isCancelled,
					onResultsUpdate: (results) => {
						const mergedResults = sortFinderUniverseCandidates(
							[...allResults, ...results],
							options.universe?.sortPriority ?? []
						).slice(0, options.topN);
						this.setLatestResults({ scope: 'symbol_universe', results: mergedResults });
						this.renderLatestResults();
					},
				}
			);

			allResults.push(...output.results);
			maxLoadedSymbols = Math.max(maxLoadedSymbols, output.loadedSymbols);
			output.failedSymbols.forEach((symbol) => failedSymbols.add(symbol));

			const mergedResults = sortFinderUniverseCandidates(
				allResults,
				options.universe.sortPriority
			).slice(0, options.topN);
			this.setLatestResults({ scope: 'symbol_universe', results: mergedResults });
			this.renderLatestResults();

			if (this.isCancelled) {
				break;
			}
		}

		this.ui.renderRandomBenchmark(options.mode);

		if (!this.isCancelled) {
			const totalSymbols = options.universe.symbols.length;
			const failureCount = failedSymbols.size;
			const survivors = this.getUniverseResults().length;
			const segments = [
				`Universe Finder complete. ${survivors} survivor${survivors === 1 ? '' : 's'}`,
				`${selectedStrategies.length} strateg${selectedStrategies.length === 1 ? 'y' : 'ies'}`,
				`${maxLoadedSymbols}/${totalSymbols} symbols loaded`,
			];
			if (failureCount > 0) {
				segments.push(`${failureCount} load failure${failureCount === 1 ? '' : 's'}`);
			}
			segments.push(`${Math.round(performance.now() - startTime)}ms`);
			this.setStatus(segments.join(' | '));
		}
		return true;
	}

	private readOptions(backtestSettings: Pick<ReturnType<typeof settingsManager.getBacktestSettings>, 'polymarketExitMode' | 'executionModel'>): FinderOptions {
		const dom = this.getDom();
		const scope = this.isUniverseScope() ? 'symbol_universe' : 'current_chart';
		const useAdvancedSort = dom.finderAdvancedToggle.checked;
		const sortItems = dom.finderSortList.querySelectorAll('.finder-sort-item');
		const advancedSortValues = Array.from(sortItems)
			.map(el => (el as HTMLElement).dataset.value as FinderMetric | undefined);
		const mode = scope === 'symbol_universe' ? 'random' : dom.finderMode.value as FinderMode;
		const topN = Math.round(this.readFinderNumberInput(dom.finderTopN, 10, 1));
		const steps = Math.round(this.readFinderNumberInput(dom.finderSteps, 3, 2));
		const rangePercent = this.readFinderNumberInput(dom.finderRange, 35, 0);
		const maxRuns = Math.round(this.readFinderNumberInput(dom.finderMaxRuns, 120, 1));
		const tradeFilterEnabled = scope === 'current_chart' && dom.finderTradesToggle.checked;
		const minTrades = tradeFilterEnabled ? Math.round(this.readFinderNumberInput(dom.finderTradesMin, 40, 0)) : 0;
		const maxTrades = tradeFilterEnabled
			? Math.round(this.readFinderNumberInput(dom.finderTradesMax, Number.POSITIVE_INFINITY, 0))
			: Number.POSITIVE_INFINITY;
		const freezeRiskManagement = dom.finderFreezeRiskManagementToggle.checked;
		const polymarketScoringEnabled = scope === 'current_chart' && dom.finderPolymarketToggle.checked;
		const polymarketRankMode = (dom.finderPolymarketRankMode.value as PolymarketFinderRankMode) || 'balanced';
		const polymarketMinScoredPredictions = polymarketScoringEnabled
			? Math.round(this.readFinderNumberInput(dom.finderPolymarketMinScored, 0, 0))
			: 0;
		const polymarketLockOffset = polymarketScoringEnabled && dom.finderPolymarketLockOffset.checked;
		const polymarketAfterTakeProfitOnly = polymarketScoringEnabled && dom.finderPolymarketAfterTakeProfitOnly.checked;

		const effectiveExitMode = resolveFinderPolymarketExitMode({
			requestedMode: backtestSettings.polymarketExitMode,
			interval: state.currentInterval,
			executionModel: backtestSettings.executionModel,
			polymarketAnnotationEnabled: polymarketScoringEnabled,
		});

		const options = buildFinderOptions({
			mode,
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
			polymarketScoringEnabled,
			polymarketRankMode,
			polymarketMinScoredPredictions,
			polymarketLockOffset,
			polymarketAfterTakeProfitOnly,
			polymarketExitMode: effectiveExitMode,
		});

		options.scope = scope;
		if (scope === 'symbol_universe') {
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
		}

		return options;
	}

	private generateParamSets(defaultParams: StrategyParams, options: FinderOptions): StrategyParams[] {
		return this.paramSpace.generateParamSets(defaultParams, options);
	}

	private buildRandomConfirmationParams(strategyKeys: string[], options: FinderOptions): Record<string, StrategyParams> {
		return this.paramSpace.buildRandomConfirmationParams(strategyKeys, options);
	}

	private setLatestResults(results: FinderLatestResults): void {
		this.latestResults = results;
	}

	private getCurrentChartResults(): FinderResult[] {
		return this.latestResults.scope === 'current_chart' ? this.latestResults.results : [];
	}

	private getUniverseResults(): FinderUniverseCandidate[] {
		return this.latestResults.scope === 'symbol_universe' ? this.latestResults.results : [];
	}

	private renderLatestResults(): void {
		if (this.getScope() === 'symbol_universe') {
			const results = this.latestResults.scope === 'symbol_universe' ? this.latestResults.results : [];
			this.ui.renderUniverseResults(results);
			return;
		}
		const results = this.latestResults.scope === 'current_chart' ? this.latestResults.results : [];
		this.ui.renderResults(results);
	}

	private buildCurrentChartMetadataPayload(result: FinderResult, rank: number) {
		const strategy = strategyRegistry.get(result.key);
		const displayedResult = result.selectionResult;
		return {
			scope: 'current_chart' as const,
			rank,
			strategyId: result.key,
			strategyName: result.name,
			timeframes: result.timeframes ?? [state.currentInterval],
			params: result.params,
			metadata: strategy?.metadata ?? null,
			metrics: {
				netProfit: displayedResult.netProfit,
				netProfitPercent: displayedResult.netProfitPercent,
				expectancy: displayedResult.expectancy,
				avgTrade: displayedResult.avgTrade,
				winRate: displayedResult.winRate,
				profitFactor: displayedResult.profitFactor,
				totalTrades: displayedResult.totalTrades,
				maxDrawdownPercent: displayedResult.maxDrawdownPercent,
				winningTrades: displayedResult.winningTrades,
				losingTrades: displayedResult.losingTrades,
				avgWin: displayedResult.avgWin,
				avgLoss: displayedResult.avgLoss,
				sharpeRatio: displayedResult.sharpeRatio,
			},
			rawMetrics: {
				netProfit: result.result.netProfit,
				netProfitPercent: result.result.netProfitPercent,
				expectancy: result.result.expectancy,
				avgTrade: result.result.avgTrade,
				winRate: result.result.winRate,
				profitFactor: result.result.profitFactor,
				totalTrades: result.result.totalTrades,
				maxDrawdownPercent: result.result.maxDrawdownPercent,
				winningTrades: result.result.winningTrades,
				losingTrades: result.result.losingTrades,
				avgWin: result.result.avgWin,
				avgLoss: result.result.avgLoss,
				sharpeRatio: result.result.sharpeRatio,
			},
			selectionMetrics: {
				netProfit: result.selectionResult.netProfit,
				netProfitPercent: result.selectionResult.netProfitPercent,
				expectancy: result.selectionResult.expectancy,
				avgTrade: result.selectionResult.avgTrade,
				winRate: result.selectionResult.winRate,
				profitFactor: result.selectionResult.profitFactor,
				totalTrades: result.selectionResult.totalTrades,
				maxDrawdownPercent: result.selectionResult.maxDrawdownPercent,
				winningTrades: result.selectionResult.winningTrades,
				losingTrades: result.selectionResult.losingTrades,
				avgWin: result.selectionResult.avgWin,
				avgLoss: result.selectionResult.avgLoss,
				sharpeRatio: result.selectionResult.sharpeRatio,
			},
			endpointAdjusted: result.endpointAdjusted,
			endpointRemovedTrades: result.endpointRemovedTrades,
			polymarketEval: result.polymarketEval ?? null,
		};
	}

	private buildUniverseMetadataPayload(result: FinderUniverseCandidate, rank: number) {
		const strategy = strategyRegistry.get(result.strategyKey);
		return {
			scope: 'symbol_universe' as const,
			rank,
			strategyId: result.strategyKey,
			strategyName: result.strategyName,
			interval: state.currentInterval,
			params: result.params,
			metadata: strategy?.metadata ?? null,
			summary: {
				activeSymbols: result.activeSymbols,
				profitableSymbols: result.profitableSymbols,
				losingSymbols: result.losingSymbols,
				flatSymbols: result.flatSymbols,
				noTradeSymbols: result.noTradeSymbols,
				totalSymbols: result.symbols.length,
				totalTrades: result.totalTrades,
				profitableActiveRatio: result.profitableActiveRatio,
				medianExpectancy: result.medianExpectancy,
				medianNetProfit: result.medianNetProfit,
				worstNetProfit: result.worstNetProfit,
				bestNetProfit: result.bestNetProfit,
				evaluationStoppedEarly: Boolean(result.evaluationStoppedEarly),
				stoppedReason: result.stoppedReason ?? null,
			},
			symbols: result.symbols.map((symbolResult) => ({
				symbol: symbolResult.symbol,
				status: symbolResult.status,
				barCount: symbolResult.barCount,
				firstTime: symbolResult.firstTime ?? null,
				lastTime: symbolResult.lastTime ?? null,
				error: symbolResult.error ?? null,
				metrics: symbolResult.result ? {
					netProfit: symbolResult.result.netProfit,
					netProfitPercent: symbolResult.result.netProfitPercent,
					expectancy: symbolResult.result.expectancy,
					avgTrade: symbolResult.result.avgTrade,
					winRate: symbolResult.result.winRate,
					profitFactor: symbolResult.result.profitFactor,
					totalTrades: symbolResult.result.totalTrades,
					maxDrawdownPercent: symbolResult.result.maxDrawdownPercent,
					winningTrades: symbolResult.result.winningTrades,
					losingTrades: symbolResult.result.losingTrades,
					avgWin: symbolResult.result.avgWin,
					avgLoss: symbolResult.result.avgLoss,
					sharpeRatio: symbolResult.result.sharpeRatio,
				} : null,
			})),
		};
	}

	private async copyTopResultsMetadata(): Promise<void> {
		const chartResults = this.getCurrentChartResults();
		const universeResults = this.getUniverseResults();
		if (chartResults.length === 0 && universeResults.length === 0) {
			uiManager.showToast('No results to copy', 'info');
			return;
		}

		const payload = this.latestResults.scope === 'current_chart'
			? chartResults.map((result, index) => this.buildCurrentChartMetadataPayload(result, index + 1))
			: universeResults.map((result, index) => this.buildUniverseMetadataPayload(result, index + 1));

		try {
			await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
			uiManager.showToast('Top results metadata copied', 'success');
		} catch (error) {
			debugLogger.error('finder.copy_metadata_failed', { error: error instanceof Error ? error.message : String(error) });
			uiManager.showToast('Copy failed - check browser permissions', 'error');
		}
	}

	private async applyCurrentChartResult(result: FinderResult): Promise<void> {
		const isPolymarketResult = Boolean(result.polymarketEval);

		setCurrentStrategyKey(result.key);
		uiManager.updateStrategyDropdown(result.key);
		const strategy = strategyRegistry.get(result.key);
		if (!strategy) return;
		paramManager.render(strategy);
		paramManager.setValues(strategy, result.params);

		this.applyFinderBacktestSettings(result.params, result.polymarketEval);
		strategyPanelController.switchTab('trades');

		if (result.endpointAdjusted) {
			uiManager.showToast(
				'Finder ranked this row on an endpoint-adjusted selection snapshot. Running the raw backtest now.',
				'info'
			);
		}

		try {
			await backtestService.runCurrentBacktest();
			if (isPolymarketResult && result.polymarketEval) {
				uiManager.showToast(
					`Applied Polymarket params: ${(result.polymarketEval.winRate * 100).toFixed(1)}% Finder win rate, ${result.polymarketEval.scoredPredictions} scored predictions. Backtest trades refreshed below.`,
					'success'
				);
			}
		} catch (error) {
			debugLogger.error('finder.apply_result_backtest_failed', {
				strategyKey: result.key,
				strategyName: result.name,
				error: error instanceof Error ? error.message : String(error),
			});
			uiManager.showToast('Backtest rerun failed after applying Finder result.', 'error');
		}
	}

	private async applyUniverseCandidate(candidate: FinderUniverseCandidate): Promise<void> {
		setCurrentStrategyKey(candidate.strategyKey);
		uiManager.updateStrategyDropdown(candidate.strategyKey);
		const strategy = strategyRegistry.get(candidate.strategyKey);
		if (!strategy) return;

		paramManager.render(strategy);
		paramManager.setValues(strategy, candidate.params);
		this.applyFinderBacktestSettings(candidate.params);
		strategyPanelController.switchTab('trades');

		try {
			await backtestService.runCurrentBacktest();
			uiManager.showToast(
				`Applied Symbol Universe survivor: ${candidate.profitableSymbols}/${candidate.activeSymbols} profitable active symbols, ${candidate.totalTrades} total trades.`,
				'success'
			);
		} catch (error) {
			debugLogger.error('finder.apply_universe_result_backtest_failed', {
				strategyKey: candidate.strategyKey,
				strategyName: candidate.strategyName,
				error: error instanceof Error ? error.message : String(error),
			});
			uiManager.showToast('Backtest rerun failed after applying Symbol Universe result.', 'error');
		}
	}

	private applyFinderBacktestSettings(params: StrategyParams, polymarketEval?: FinderResult['polymarketEval']): void {
		const baseSettings = this.lastFinderRunBacktestSettings
			? this.cloneBacktestSettings(this.lastFinderRunBacktestSettings)
			: settingsManager.getBacktestSettings();
		const mergedSettings = mergeFinderRiskParamsIntoBacktestSettings(baseSettings, params, this.lastFinderOptions ?? undefined);
		const effectiveMode = this.lastFinderOptions?.polymarketExitMode ?? 'resolve_hold';
		if (isSignalExitSameEventMode(effectiveMode)) {
			mergedSettings.polymarketAnnotationEnabled = true;
			mergedSettings.polymarketExitMode = 'signal_exit_same_event';
		} else if (Number.isFinite(params.polymarketEntryOffset)) {
			mergedSettings.polymarketEntryOffset = Math.max(0, Math.min(4, Math.round(Number(params.polymarketEntryOffset))));
			if (polymarketEval) {
				mergedSettings.polymarketAnnotationEnabled = true;
			}
		}
		settingsManager.applyBacktestSettings(mergedSettings);
	}

	private setProgress(active: boolean, percent: number, text: string): void {
		this.ui.setProgress(active, percent, text);
	}

	private setStatus(text: string): void {
		this.ui.setStatus(text);
	}

	private cloneBacktestSettings<T>(settings: T): T {
		return JSON.parse(JSON.stringify(settings)) as T;
	}

	public getLatestResults(): FinderLatestResults {
		return this.cloneBacktestSettings(this.latestResults);
	}

	public getLatestCandidate(): FinderResult | FinderUniverseCandidate | null {
		if (this.latestResults.results.length === 0) return null;
		return this.cloneBacktestSettings(this.latestResults.results[0]);
	}

	public getLastRunBacktestSettings(): ReturnType<typeof settingsManager.getBacktestSettings> | null {
		return this.lastFinderRunBacktestSettings
			? this.cloneBacktestSettings(this.lastFinderRunBacktestSettings)
			: null;
	}
}

export const finderManager = new FinderManager();








