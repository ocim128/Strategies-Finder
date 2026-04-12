import { StrategyParams } from "./strategies/index";
import { strategyRegistry } from "../strategyRegistry";
import { state } from "./state";
import { backtestService } from "./backtest-service";
import { paramManager } from "./param-manager";
import { uiManager } from "./ui-manager";
import { setVisible } from "./dom-utils";
import { dataManager } from "./data-manager";
import { settingsManager } from "./settings-manager";

import { DEFAULT_SORT_PRIORITY, METRIC_FULL_LABELS } from "./finder/constants";
import { runFinderExecution, type FinderSelectedStrategy } from "./finder/finder-runner";
import { FinderParamSpace } from "./finder/finder-param-space";
import { FinderUI } from "./finder/finder-ui";
import { buildFinderOptions } from "./finder/finder-manager-logic";
import { sortFinderResults } from "./finder/finder-engine";
import { mergeFinderRiskParamsIntoBacktestSettings } from "./finder/finder-runner-core";
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
	FinderMetric,
	FinderMode,
	FinderOptions,
	PolymarketFinderRankMode,
	FinderResult
} from './types/finder';
import { isSmartTradeSizingMode } from "./types/backtest";
import { resolveEffectivePolymarketExitMode, isSignalExitSameEventMode } from "./polymarket-exit-mode";

export class FinderManager {
	private isRunning = false;
	private isCancelled = false;
	private displayResults: FinderResult[] = [];
	private lastFinderRunBacktestSettings: ReturnType<typeof settingsManager.getBacktestSettings> | null = null;
	private lastFinderOptions: FinderOptions | null = null;
	private strategyToggles: Map<string, HTMLInputElement> = new Map();
	private strategyItems: Map<string, HTMLDivElement> = new Map();
	private strategyOrder: string[] = [];
	private lastStrategyToggleKey: string | null = null;
	private readonly ui = new FinderUI();
	private readonly paramSpace = new FinderParamSpace();
	private readonly taskYielder = createTaskYielder();
	private dom: FinderManagerDom | null = null;

	private getDom(): FinderManagerDom {
		return this.dom ??= createFinderManagerDom();
	}

	public init() {
		const dom = this.getDom();
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
			const result = this.displayResults[index];
			if (result) {
				void this.applyResult(result);
			}
		});

		this.renderStrategySelection();
		this.initStrategySelectionUI();

		this.initSortingUI();
		this.initPolymarketUI();
	}

	private initSortingUI(): void {
		// Populate Dropdowns
		const { finderSort: sortPrimary, finderSortSecondary: sortSecondary, finderAdvancedToggle: toggle, finderSimpleSort: simpleSection, finderSortList: advancedSection } = this.getDom();

		const optionsHtml = DEFAULT_SORT_PRIORITY.map(key =>
			`<option value="${key}">${METRIC_FULL_LABELS[key]}</option>`
		).join('');

		sortPrimary.innerHTML = optionsHtml;
		sortSecondary.innerHTML = optionsHtml;

		// Set defaults
		sortPrimary.value = 'expectancy';
		sortSecondary.value = 'profitFactor';

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

	private initPolymarketUI(): void {
		const { finderPolymarketToggle: toggle } = this.getDom();

		this.setPolymarketControlsEnabled(toggle.checked);
		toggle.addEventListener('change', () => {
			this.setPolymarketControlsEnabled(toggle.checked);
		});
	}

	private setPolymarketControlsEnabled(enabled: boolean): void {
		const dom = this.getDom();
		dom.finderPolymarketSettings.classList.toggle('is-disabled', !enabled);
		dom.finderPolymarketRankMode.disabled = !enabled;
		dom.finderPolymarketMinScored.disabled = !enabled;
		dom.finderPolymarketLockOffset.disabled = !enabled;
		dom.finderPolymarketAfterTakeProfitOnly.disabled = !enabled;

		const exitModeSelect = document.getElementById('polymarketExitMode');
		const isSignalExit = exitModeSelect instanceof HTMLSelectElement
			&& exitModeSelect.value === 'signal_exit_same_event';
		if (isSignalExit) {
			dom.finderPolymarketLockOffset.disabled = true;
		}
	}

	private renderStrategySelection(): void {
		const container = this.getDom().finderStrategyList;
		const previouslySelected = new Set<string>();
		this.strategyToggles.forEach((toggle, key) => {
			if (toggle.checked) {
				previouslySelected.add(key);
			}
		});
		container.innerHTML = '';
		this.strategyToggles.clear();
		this.strategyItems.clear();
		this.strategyOrder = [];
		this.lastStrategyToggleKey = null;
		const fragment = document.createDocumentFragment();

		const strategies = strategyRegistry.getAll();
		Object.entries(strategies).forEach(([key, strategy]) => {
			const item = document.createElement('div');
			item.className = 'strategy-list-item';
			item.dataset.strategyKey = key;
			item.dataset.strategyName = strategy.name.toLowerCase();

			const checkbox = document.createElement('input');
			checkbox.type = 'checkbox';
			checkbox.id = `finder-strategy-${key}`;
			checkbox.checked = previouslySelected.has(key);
			checkbox.addEventListener('click', (event) => {
				this.handleStrategyToggleClick(key, event as MouseEvent);
			});
			checkbox.addEventListener('change', () => {
				this.syncStrategySelectionUi();
			});

			const label = document.createElement('label');
			label.htmlFor = `finder-strategy-${key}`;
			label.textContent = strategy.name;

			item.appendChild(checkbox);
			item.appendChild(label);
			fragment.appendChild(item);

			this.strategyToggles.set(key, checkbox);
			this.strategyItems.set(key, item);
			this.strategyOrder.push(key);
		});
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
		for (const key of strategyKeys) {
			const toggle = this.strategyToggles.get(key);
			if (toggle) {
				toggle.checked = checked;
			}
		}

		if (syncUi) {
			this.syncStrategySelectionUi();
		}
	}

	private invertStrategySelection(strategyKeys: Iterable<string>): void {
		for (const key of strategyKeys) {
			const toggle = this.strategyToggles.get(key);
			if (toggle) {
				toggle.checked = !toggle.checked;
			}
		}

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

		dom.finderStrategiesToggleAll.checked = totalCount > 0 && selectedCount === totalCount;
		dom.finderStrategiesToggleAll.indeterminate = selectedCount > 0 && selectedCount < totalCount;
		dom.finderStrategySelectVisible.disabled = visibleKeys.length === 0;
		dom.finderStrategyInvertVisible.disabled = visibleKeys.length === 0;

		const hasFilter = dom.finderStrategySearch.value.trim().length > 0;
		dom.finderStrategySummary.textContent = hasFilter
			? `${selectedCount} selected • ${visibleKeys.length} visible • ${visibleSelectedCount} visible selected`
			: `${selectedCount} selected`;
	}

	private getSelectedStrategies(): FinderSelectedStrategy[] {
		const strategies = strategyRegistry.getAll();
		return Object.entries(strategies)
			.filter(([key]) => {
				const toggle = this.strategyToggles.get(key);
				return toggle ? toggle.checked : false;
			})
			.map(([key, strategy]) => ({
				key,
				name: strategy.name,
				strategy
			}));
	}

	public async runFinder(): Promise<void> {
		if (this.isRunning) return;
		if (state.ohlcvData.length === 0) {
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
		const options = this.readOptions();
		this.lastFinderOptions = {
			...options,
			sortPriority: [...options.sortPriority],
		};
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
		this.displayResults = [];
		this.renderResults([], options.sortPriority[0]);

		try {
			const selectedStrategies = this.getSelectedStrategies();
			if (selectedStrategies.length === 0) {
				this.setStatus('No strategies selected.');
				return;
			}

			const capitalSettings = backtestService.getCapitalSettings();
			const settings = backtestService.getBacktestSettings();
			this.lastFinderRunBacktestSettings = this.cloneBacktestSettings(settingsManager.getBacktestSettings());
			const requiresTsEngine = backtestService.requiresTypescriptEngine(settings) || isSmartTradeSizingMode(capitalSettings.sizingMode);

			// Freeze the selected chart block; execution-aware closed-candle normalization
			// is applied inside the finder run so it matches manual backtests.
			const ohlcvData = sliceOhlcvByBlock(state.ohlcvData, state.blockRange);
			if (ohlcvData.length === 0) {
				this.setStatus('No candles available for finder run.');
				return;
			}

			try {
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
							this.displayResults = sorted;
							this.renderResults(sorted, options.sortPriority[0]);
						},
					}
				);

				const sortedResults = sortFinderResults(output.results, options.sortPriority);
				this.displayResults = sortedResults;
				this.renderResults(sortedResults, options.sortPriority[0]);
				this.ui.renderRandomBenchmark(options.mode, output.randomBenchmark);

				if (this.isCancelled) {
					finalizeProgress(0, "");
					this.setStatus(`Finder stopped by user after ${Math.round(performance.now() - startTime)}ms.`);
				} else {
					this.setStatus(`Finder completed in ${Math.round(performance.now() - startTime)}ms.`);
					finalizeProgress(100, "");
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (this.isCancelled && (message.includes('stopped') || message.includes('cancel'))) {
					this.setStatus('Finder stopped by user.');
					uiManager.showToast('Finder stopped.', 'info');
				} else {
					debugLogger.error('finder.run_failed', {
						symbol: state.currentSymbol,
						interval: state.currentInterval,
						mode: options.mode,
						polymarketScoringEnabled: options.polymarketScoringEnabled,
						error: message,
					});
					this.setStatus(`Finder failed. ${message}`);
					uiManager.showToast('Finder run failed. Check the status panel for details.', 'error');
				}
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

	private readOptions(): FinderOptions {
		const dom = this.getDom();
		const useAdvancedSort = dom.finderAdvancedToggle.checked;
		const sortItems = dom.finderSortList.querySelectorAll('.finder-sort-item');
		const advancedSortValues = Array.from(sortItems)
			.map(el => (el as HTMLElement).dataset.value as FinderMetric | undefined);
		const mode = dom.finderMode.value as FinderMode;
		const topN = Math.round(this.readFinderNumberInput(dom.finderTopN, 10, 1));
		const steps = Math.round(this.readFinderNumberInput(dom.finderSteps, 3, 2));
		const rangePercent = this.readFinderNumberInput(dom.finderRange, 35, 0);
		const maxRuns = Math.round(this.readFinderNumberInput(dom.finderMaxRuns, 120, 1));
		const tradeFilterEnabled = dom.finderTradesToggle.checked;
		const minTrades = tradeFilterEnabled ? Math.round(this.readFinderNumberInput(dom.finderTradesMin, 40, 0)) : 0;
		const maxTrades = tradeFilterEnabled
			? Math.round(this.readFinderNumberInput(dom.finderTradesMax, Number.POSITIVE_INFINITY, 0))
			: Number.POSITIVE_INFINITY;
		const freezeRiskManagement = dom.finderFreezeRiskManagementToggle.checked;
		const polymarketScoringEnabled = dom.finderPolymarketToggle.checked;
		const polymarketRankMode = (dom.finderPolymarketRankMode.value as PolymarketFinderRankMode) || 'balanced';
		const polymarketMinScoredPredictions = polymarketScoringEnabled
			? Math.round(this.readFinderNumberInput(dom.finderPolymarketMinScored, 0, 0))
			: 0;
		const polymarketLockOffset = polymarketScoringEnabled && dom.finderPolymarketLockOffset.checked;
		const polymarketAfterTakeProfitOnly = polymarketScoringEnabled && dom.finderPolymarketAfterTakeProfitOnly.checked;

		const effectiveExitMode = resolveEffectivePolymarketExitMode({
			requestedMode: this.lastFinderRunBacktestSettings?.polymarketExitMode,
			interval: state.currentInterval,
			executionModel: this.lastFinderRunBacktestSettings?.executionModel,
			polymarketAnnotationEnabled: polymarketScoringEnabled,
		});

		return buildFinderOptions({
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
	}

	private generateParamSets(defaultParams: StrategyParams, options: FinderOptions): StrategyParams[] {
		return this.paramSpace.generateParamSets(defaultParams, options);
	}

	private buildRandomConfirmationParams(strategyKeys: string[], options: FinderOptions): Record<string, StrategyParams> {
		return this.paramSpace.buildRandomConfirmationParams(strategyKeys, options);
	}

	private renderResults(results: FinderResult[], _sortBy: FinderMetric): void {
		this.ui.renderResults(results);
	}

	private buildMetadataPayload(result: FinderResult, rank: number) {
		const strategy = strategyRegistry.get(result.key);
		const displayedResult = result.selectionResult;
		return {
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
				sharpeRatio: displayedResult.sharpeRatio
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
				sharpeRatio: result.result.sharpeRatio
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
				sharpeRatio: result.selectionResult.sharpeRatio
			},
			endpointAdjusted: result.endpointAdjusted,
			endpointRemovedTrades: result.endpointRemovedTrades,
			polymarketEval: result.polymarketEval ?? null,
		};
	}

	private async copyTopResultsMetadata(): Promise<void> {
		if (this.displayResults.length === 0) {
			uiManager.showToast('No results to copy', 'info');
			return;
		}

		const payload = this.displayResults.map((result, index) => this.buildMetadataPayload(result, index + 1));

		try {
			await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
			uiManager.showToast('Top results metadata copied', 'success');
		} catch (error) {
			debugLogger.error('finder.copy_metadata_failed', { error: error instanceof Error ? error.message : String(error) });
			uiManager.showToast('Copy failed - check browser permissions', 'error');
		}
	}

	private async applyResult(result: FinderResult): Promise<void> {
		const isPolymarketResult = Boolean(result.polymarketEval);

		setCurrentStrategyKey(result.key);
		uiManager.updateStrategyDropdown(result.key);
		const strategy = strategyRegistry.get(result.key);
		if (!strategy) return;
		paramManager.render(strategy);
		paramManager.setValues(strategy, result.params);

		this.applyFinderBacktestSettings(result);
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
				error: error instanceof Error ? error.message : String(error)
			});
			uiManager.showToast('Backtest rerun failed after applying Finder result.', 'error');
		}
	}

	private applyFinderBacktestSettings(result: FinderResult): void {
		const baseSettings = this.lastFinderRunBacktestSettings
			? this.cloneBacktestSettings(this.lastFinderRunBacktestSettings)
			: settingsManager.getBacktestSettings();
		const mergedSettings = mergeFinderRiskParamsIntoBacktestSettings(baseSettings, result.params, this.lastFinderOptions ?? undefined);
		const effectiveMode = this.lastFinderOptions?.polymarketExitMode ?? "resolve_hold";
		if (isSignalExitSameEventMode(effectiveMode)) {
			mergedSettings.polymarketAnnotationEnabled = true;
			mergedSettings.polymarketExitMode = "signal_exit_same_event";
		} else if (Number.isFinite(result.params.polymarketEntryOffset)) {
			mergedSettings.polymarketEntryOffset = Math.max(0, Math.min(4, Math.round(Number(result.params.polymarketEntryOffset))));
			if (result.polymarketEval) {
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

	public getLatestResults(): FinderResult[] {
		return JSON.parse(JSON.stringify(this.displayResults)) as FinderResult[];
	}

	public getLatestCandidate(): FinderResult | null {
		if (this.displayResults.length === 0) return null;
		return JSON.parse(JSON.stringify(this.displayResults[0])) as FinderResult;
	}

	public getLastRunBacktestSettings(): ReturnType<typeof settingsManager.getBacktestSettings> | null {
		return this.lastFinderRunBacktestSettings
			? this.cloneBacktestSettings(this.lastFinderRunBacktestSettings)
			: null;
	}
}

export const finderManager = new FinderManager();








