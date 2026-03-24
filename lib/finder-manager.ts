import { StrategyParams, applySignalPolarity } from "./strategies/index";
import { strategyRegistry } from "../strategyRegistry";
import { state } from "./state";
import { backtestService } from "./backtest-service";
import { paramManager } from "./param-manager";
import { uiManager } from "./ui-manager";
import { setVisible } from "./dom-utils";
import { dataManager } from "./data-manager";
import { settingsManager, type StrategyConfig } from "./settings-manager";
import { resolveBacktestSettingsFromRaw } from "./backtest-settings-resolver";

import { DEFAULT_SORT_PRIORITY, METRIC_FULL_LABELS } from "./finder/constants";
import { runFinderExecution, type FinderSelectedStrategy } from "./finder/finder-runner";
import { FinderParamSpace } from "./finder/finder-param-space";
import { FinderTimeframeLoader, type FinderDataset } from "./finder/finder-timeframe-loader";
import { FinderUI } from "./finder/finder-ui";
import { mergeFinderRiskParamsIntoBacktestSettings } from "./finder/finder-runner-core";
import { debugLogger, robustAuditSink } from "./debug-logger";
import { parseInputNumber } from "./dom-input-readers";
import { sliceOhlcvByBlock } from "./block-selector";
import { strategyPanelController } from "./strategy-panel-controller";
import { commitBacktestResult, commitParityBacktestResults } from "./state-actions";
import {
	createFinderManagerDom,
	createPairCombinerBridgeDom,
	type FinderManagerDom,
	type PairCombinerBridgeDom
} from "./feature-dom-contracts";
import type {
	FinderMetric,
	FinderMode,
	FinderOptions,
	FinderResult
} from './types/finder';
import { isSmartTradeSizingMode, type CapitalSettings } from "./types/backtest";

export class FinderManager {
	private static readonly MAX_MULTI_TIMEFRAMES = 10;
	private static readonly MULTI_TIMEFRAME_DEFAULTS = ['1m', '2m', '3m', '4m', '5m', '6m', '7m', '8m', '9m', '10m'];
	private static readonly MULTI_TIMEFRAME_PRESETS = [
		...FinderManager.MULTI_TIMEFRAME_DEFAULTS,
		'15m', '30m', '1h', '4h', '1d', '1w', '1M'
	];
	private isRunning = false;
	private displayResults: FinderResult[] = [];
	private lastFinderRunBacktestSettings: ReturnType<typeof settingsManager.getBacktestSettings> | null = null;
	private lastFinderOptions: FinderOptions | null = null;
	private strategyToggles: Map<string, HTMLInputElement> = new Map();
	private strategyItems: Map<string, HTMLDivElement> = new Map();
	private strategyOrder: string[] = [];
	private lastStrategyToggleKey: string | null = null;
	private selectedFinderTimeframes: string[] = [];
	private readonly ui = new FinderUI();
	private readonly paramSpace = new FinderParamSpace();
	private readonly timeframeLoader = new FinderTimeframeLoader(FinderManager.MAX_MULTI_TIMEFRAMES);
	private dom: FinderManagerDom | null = null;
	private pairCombinerDom: PairCombinerBridgeDom | null = null;

	private getDom(): FinderManagerDom {
		return this.dom ??= createFinderManagerDom();
	}

	private getPairCombinerDom(): PairCombinerBridgeDom {
		return this.pairCombinerDom ??= createPairCombinerBridgeDom();
	}

	public init() {
		const dom = this.getDom();
		dom.runFinder.addEventListener('click', () => {
			void this.runFinder();
		});

		const copyTopButton = dom.finderCopyTopResults;
		copyTopButton.disabled = true;
		copyTopButton.addEventListener('click', () => {
			void this.copyTopResultsMetadata();
		});

		const saveSeedAuditButton = dom.finderSaveSeedAudit;
		saveSeedAuditButton.addEventListener('click', () => {
			void this.saveCurrentSeedAuditFile();
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
		this.initMultiTimeframeUI();
		this.initComboUI();


		state.subscribe('currentInterval', () => {
			this.populateMultiTimeframePresets();
		});
		state.subscribe('currentSymbol', () => {
			this.timeframeLoader.clearCache();
			this.applyMockRestrictionToMultiTimeframe();
		});
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

	private initMultiTimeframeUI(): void {
		const dom = this.getDom();
		const toggle = dom.finderMultiTimeframeToggle;
		const addPresetBtn = dom.finderMultiTimeframeAdd;
		const addCustomBtn = dom.finderMultiTimeframeCustomAdd;
		const customInput = dom.finderMultiTimeframeCustom;

		this.populateMultiTimeframePresets();
		this.renderSelectedFinderTimeframes();

		toggle.addEventListener('change', () => {
			if (toggle.checked) {
				this.applyDefaultFinderTimeframes();
			}
			this.applyMockRestrictionToMultiTimeframe();
		});

		addPresetBtn.addEventListener('click', () => {
			const select = this.getDom().finderMultiTimeframeSelect;
			this.addFinderTimeframe(select.value, false);
		});

		const submitCustom = () => {
			const value = customInput.value.trim();
			if (!value) return;
			this.addFinderTimeframe(value, false);
			customInput.value = '';
		};

		addCustomBtn.addEventListener('click', submitCustom);
		customInput.addEventListener('keydown', (event) => {
			if (event.key === 'Enter') {
				event.preventDefault();
				submitCustom();
			}
		});

		dom.finderMultiTimeframeSelected.addEventListener('click', (event) => {
			const target = event.target as HTMLElement | null;
			const removeBtn = target?.closest<HTMLButtonElement>('.finder-timeframe-chip-remove');
			if (!removeBtn) return;
			const interval = removeBtn.dataset.interval;
			if (!interval) return;
			this.removeFinderTimeframe(interval);
		});

		this.applyMockRestrictionToMultiTimeframe();
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

	private initComboUI(): void {
		const { finderComboToggle: toggle } = this.getDom();

		this.populateComboDropdown();
		this.setComboControlsEnabled(toggle.checked);

		toggle.addEventListener('change', () => {
			this.setComboControlsEnabled(toggle.checked);
		});
	}

	public populateComboDropdown(): void {
		const select = this.getDom().finderComboPrimarySelect;

		const configs = settingsManager.loadAllStrategyConfigs();
		const currentValue = select.value;

		select.innerHTML = '<option value="">-- Select primary config --</option>';
		configs.forEach(config => {
			const option = document.createElement('option');
			option.value = config.name;
			option.textContent = `${config.name} (${config.strategyKey})`;
			select.appendChild(option);
		});

		if (currentValue && configs.some(c => c.name === currentValue)) {
			select.value = currentValue;
		}
	}

	private setComboControlsEnabled(enabled: boolean): void {
		const { finderComboSettings: settings, finderComboPrimarySelect: select } = this.getDom();
		settings.classList.toggle('is-disabled', !enabled);
		select.disabled = !enabled;
	}

	public clearTimeframeCache(): void {
		this.timeframeLoader.clearCache();
	}

	private populateMultiTimeframePresets(): void {
		const select = this.getDom().finderMultiTimeframeSelect;

		const intervals = [...FinderManager.MULTI_TIMEFRAME_PRESETS];
		if (!intervals.includes(state.currentInterval)) {
			intervals.push(state.currentInterval);
		}

		select.innerHTML = '';
		intervals.forEach(interval => {
			const option = document.createElement('option');
			option.value = interval;
			option.textContent = interval;
			select.appendChild(option);
		});

		if (intervals.includes(state.currentInterval)) {
			select.value = state.currentInterval;
		}
	}

	private applyMockRestrictionToMultiTimeframe(): void {
		const { finderMultiTimeframeToggle: toggle, finderMultiTimeframeNote: note } = this.getDom();
		const isMock = dataManager.isMockSymbol(state.currentSymbol);
		const enabled = !isMock;

		if (isMock) {
			toggle.checked = false;
			note.textContent = 'Multi timeframe is disabled for mock chart symbols.';
		} else {
			note.textContent = `Select up to ${FinderManager.MAX_MULTI_TIMEFRAMES} timeframes.`;
		}

		toggle.disabled = !enabled;
		this.setMultiTimeframeControlsEnabled(enabled && toggle.checked);
	}

	private setMultiTimeframeControlsEnabled(enabled: boolean): void {
		const dom = this.getDom();
		const settings = dom.finderMultiTimeframeSettings;
		const select = dom.finderMultiTimeframeSelect;
		const addPresetBtn = dom.finderMultiTimeframeAdd;
		const customInput = dom.finderMultiTimeframeCustom;
		const addCustomBtn = dom.finderMultiTimeframeCustomAdd;

		settings.classList.toggle('is-disabled', !enabled);
		select.disabled = !enabled;
		addPresetBtn.disabled = !enabled;
		customInput.disabled = !enabled;
		addCustomBtn.disabled = !enabled;
	}

	private applyDefaultFinderTimeframes(): void {
		this.selectedFinderTimeframes = [...FinderManager.MULTI_TIMEFRAME_DEFAULTS];
		this.renderSelectedFinderTimeframes();
	}

	private async loadMultiTimeframeDatasets(symbol: string, intervals: string[]): Promise<FinderDataset[]> {
		return this.timeframeLoader.loadMultiTimeframeDatasets(symbol, intervals, {
			currentSymbol: state.currentSymbol,
			currentInterval: state.currentInterval,
			currentData: state.ohlcvData
		});
	}

	private normalizeFinderInterval(rawInterval: string): string | null {
		return this.timeframeLoader.normalizeInterval(rawInterval);
	}

	private addFinderTimeframe(interval: string, silent: boolean): void {
		const normalized = this.normalizeFinderInterval(interval);
		if (!normalized) {
			if (!silent) {
				uiManager.showToast('Invalid timeframe. Use format like 2m, 4m, 7m, 1h, 1d.', 'error');
			}
			return;
		}
		if (this.selectedFinderTimeframes.includes(normalized)) {
			if (!silent) {
				uiManager.showToast(`${normalized} is already selected.`, 'info');
			}
			return;
		}
		if (this.selectedFinderTimeframes.length >= FinderManager.MAX_MULTI_TIMEFRAMES) {
			uiManager.showToast(`Max ${FinderManager.MAX_MULTI_TIMEFRAMES} timeframes allowed.`, 'error');
			return;
		}

		this.selectedFinderTimeframes.push(normalized);
		this.renderSelectedFinderTimeframes();
	}

	private removeFinderTimeframe(interval: string): void {
		this.selectedFinderTimeframes = this.selectedFinderTimeframes.filter(value => value !== interval);
		this.renderSelectedFinderTimeframes();
	}

	private renderSelectedFinderTimeframes(): void {
		const container = this.getDom().finderMultiTimeframeSelected;
		container.innerHTML = '';

		if (this.selectedFinderTimeframes.length === 0) {
			const empty = document.createElement('span');
			empty.className = 'finder-timeframe-empty';
			empty.textContent = 'No timeframe selected.';
			container.appendChild(empty);
			return;
		}

		this.selectedFinderTimeframes.forEach(interval => {
			const chip = document.createElement('span');
			chip.className = 'finder-timeframe-chip';
			chip.textContent = interval;

			const remove = document.createElement('button');
			remove.type = 'button';
			remove.className = 'finder-timeframe-chip-remove';
			remove.dataset.interval = interval;
			remove.textContent = 'x';
			remove.title = `Remove ${interval}`;

			chip.appendChild(remove);
			container.appendChild(chip);
		});
	}

	private getFinderTimeframesForRun(options: FinderOptions): string[] {
		return this.timeframeLoader.getFinderTimeframesForRun(options, state.currentInterval);
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

		this.isRunning = true;
		this.lastFinderRunBacktestSettings = null;
		this.lastFinderOptions = null;
		const options = this.readOptions();
		this.lastFinderOptions = {
			...options,
			sortPriority: [...options.sortPriority],
			timeframes: [...(options.timeframes ?? [])],
		};
		const runButton = this.getDom().runFinder;
		const setLoading = (loading: boolean) => {
			runButton.disabled = loading;
			runButton.classList.toggle('is-loading', loading);
			runButton.setAttribute('aria-busy', loading ? 'true' : 'false');
		};

		setLoading(true);
		this.setProgress(true, 0, 'Preparing...');
		this.setStatus('Running strategy finder...');
		this.ui.renderRandomBenchmark(options.mode);
		this.displayResults = [];
		this.renderResults([], options.sortPriority[0]);

		try {
			if (options.multiTimeframeEnabled && dataManager.isMockSymbol(state.currentSymbol)) {
				uiManager.showToast('Multi timeframe finder is not available for mock chart symbols.', 'error');
				this.setStatus('Multi timeframe finder is disabled for mock chart symbols.');
				return;
			}

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

			// --- Combo Mode: resolve primary config, generate primary signals once ---
			let comboPrimarySignals: undefined | ReturnType<typeof applySignalPolarity>;
			let comboPrimarySettings: undefined | typeof settings;
			let comboPrimaryCapital: undefined | CapitalSettings;

			if (options.comboEnabled && options.comboPrimaryConfigName) {
				const primaryConfig = settingsManager.loadStrategyConfig(options.comboPrimaryConfigName);
				if (!primaryConfig) {
					this.setStatus(`Primary config "${options.comboPrimaryConfigName}" not found.`);
					return;
				}
				const primaryStrategy = strategyRegistry.get(primaryConfig.strategyKey);
				if (!primaryStrategy) {
					this.setStatus(`Primary strategy "${primaryConfig.strategyKey}" not found in registry.`);
					return;
				}

				this.setStatus('Combo mode: generating primary signals...');
				comboPrimarySettings = resolveBacktestSettingsFromRaw(
					primaryConfig.backtestSettings as unknown as typeof settings,
					{ captureSnapshots: false, coerceWithoutUiToggles: true }
				);
				comboPrimarySignals = applySignalPolarity(
					primaryStrategy.execute(ohlcvData, primaryConfig.strategyParams),
					comboPrimarySettings
				);
				comboPrimaryCapital = settingsManager.resolveCapitalFromConfig(primaryConfig);

				debugLogger.event('finder.combo.primary_resolved', {
					primaryConfig: options.comboPrimaryConfigName,
					primaryStrategy: primaryConfig.strategyKey,
					primarySignals: comboPrimarySignals.length,
				});
			} else if (options.comboEnabled && !options.comboPrimaryConfigName) {
				uiManager.showToast('Combo mode enabled but no primary config selected.', 'error');
				this.setStatus('Select a primary config for combo mode.');
				return;
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
					getFinderTimeframesForRun: (finderOptions) => this.getFinderTimeframesForRun(finderOptions),
					loadMultiTimeframeDatasets: (symbol, intervals) => this.loadMultiTimeframeDatasets(symbol, intervals),
					generateParamSets: (defaultParams, finderOptions) => this.generateParamSets(defaultParams, finderOptions),
					buildRandomConfirmationParams: (strategyKeys, finderOptions) => this.buildRandomConfirmationParams(strategyKeys, finderOptions),
					comboPrimarySignals,
					comboPrimarySettings,
					comboPrimaryCapital,
				},
				{
					setProgress: (percent, text) => this.setProgress(true, percent, text),
					setStatus: (text) => this.setStatus(text),
					yieldControl: () => this.yieldControl()
				}
			);

			this.displayResults = output.results;
			this.renderResults(output.results, options.sortPriority[0]);
			this.ui.renderRandomBenchmark(options.mode, output.randomBenchmark);
		} finally {
			setLoading(false);
			this.isRunning = false;
		}
	}

	private readOptions(): FinderOptions {
		const dom = this.getDom();
		const useAdvancedSort = dom.finderAdvancedToggle.checked;
		let sortPriority: FinderMetric[] = [];

		if (useAdvancedSort) {
			// Scrape sort priority from the list
			const sortItems = dom.finderSortList.querySelectorAll('.finder-sort-item');
			sortPriority = Array.from(sortItems)
				.map(el => (el as HTMLElement).dataset.value as FinderMetric | undefined)
				.filter((val): val is FinderMetric => !!val);

			// Fallback
			if (sortPriority.length === 0) {
				sortPriority.push(...DEFAULT_SORT_PRIORITY);
			}
		} else {
			// Simple Sort Mode
			const p1 = this.getDom().finderSort.value as FinderMetric;
			const p2 = this.getDom().finderSortSecondary.value as FinderMetric;
			sortPriority.push(p1);
			if (p1 !== p2) {
				sortPriority.push(p2);
			}
			// Append 'netProfit' as fallback if not present, to ensure stable sort for rest (tie breaking)
			if (!sortPriority.includes('netProfit')) {
				sortPriority.push('netProfit');
			}
		}

		const mode = dom.finderMode.value as FinderMode;
		const multiTimeframeRequested = dom.finderMultiTimeframeToggle.checked;
		const multiTimeframeEnabled = multiTimeframeRequested && !dataManager.isMockSymbol(state.currentSymbol);
		const timeframes = multiTimeframeEnabled
			? this.selectedFinderTimeframes.slice(0, FinderManager.MAX_MULTI_TIMEFRAMES)
			: [];
		const topN = Math.round(this.readFinderNumberInput(dom.finderTopN, 10, 1));
		const steps = Math.round(this.readFinderNumberInput(dom.finderSteps, 3, 2));
		const robustSeed = Math.round(this.readFinderNumberInput(dom.finderRobustSeed, 1337, -2147483648));
		const rangePercent = this.readFinderNumberInput(dom.finderRange, 35, 0);
		const maxRuns = Math.round(this.readFinderNumberInput(dom.finderMaxRuns, 120, 1));
		const tradeFilterEnabled = dom.finderTradesToggle.checked;
		const minTrades = tradeFilterEnabled ? Math.round(this.readFinderNumberInput(dom.finderTradesMin, 40, 0)) : 0;
		const maxTradesRaw = tradeFilterEnabled
			? Math.round(this.readFinderNumberInput(dom.finderTradesMax, Number.POSITIVE_INFINITY, 0))
			: Number.POSITIVE_INFINITY;
		const maxTrades = Math.max(minTrades, maxTradesRaw);
		const freezeRiskManagement = dom.finderFreezeRiskManagementToggle.checked;
		const comboEnabled = dom.finderComboToggle.checked;
		const comboPrimaryConfigName = comboEnabled ? (dom.finderComboPrimarySelect.value || undefined) : undefined;
		return {
			mode,
			sortPriority,
			useAdvancedSort,
			robustSeed,
			multiTimeframeEnabled,
			timeframes,
			topN,
			steps,
			rangePercent,
			maxRuns,
			tradeFilterEnabled,
			minTrades,
			maxTrades,
			freezeRiskManagement,
			comboEnabled,
			comboPrimaryConfigName,
		};
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
			robustMetrics: result.robustMetrics ?? null
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

	private async saveCurrentSeedAuditFile(): Promise<void> {
		const dom = this.getDom();
		const mode = dom.finderMode.value as FinderMode;
		if (mode !== 'robust_random_wf') {
			uiManager.showToast('Seed audit export is available only in Robust Random WF mode.', 'info');
			return;
		}

		const seed = Math.round(this.readFinderNumberInput(dom.finderRobustSeed, 1337, -2147483648));
		if (!Number.isFinite(seed)) {
			uiManager.showToast('Invalid robust seed value.', 'error');
			return;
		}

		// Query from robust audit sink for complete audit trail (not capped like debugLogger)
		const matchingEntries = robustAuditSink.query((entry) => {
			if (entry.message !== '[Finder][robust_random_wf][cell_audit]') return false;
			if (!entry.data || typeof entry.data !== 'object') return false;
			const dataSeed = Number((entry.data as Record<string, unknown>).seed);
			return Number.isFinite(dataSeed) && Math.round(dataSeed) === seed;
		});

		if (matchingEntries.length === 0) {
			uiManager.showToast(`No robust cell-audit logs found for seed ${seed}. Run Finder first.`, 'warning');
			return;
		}

		const payload = matchingEntries
			.map((entry) => `${entry.message} ${JSON.stringify(entry.data)}`)
			.join('\n');
		const fileName = `run-seed-${seed}.txt`;

		try {
			const response = await fetch('/api/sqlite/write-seed-log', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					seed,
					content: payload
				})
			});

			const responseBody = await response.json().catch(() => null) as { ok?: boolean; error?: string; path?: string } | null;
			if (!response.ok || !responseBody?.ok) {
				throw new Error(responseBody?.error || `HTTP ${response.status}`);
			}

			uiManager.showToast(`Saved ${fileName}`, 'success');
		} catch (error) {
			debugLogger.error('finder.save_seed_audit_failed', {
				seed,
				error: error instanceof Error ? error.message : String(error)
			});
			uiManager.showToast('Failed to save seed audit file. Start app with Vite dev server.', 'error');
		}
	}

	private async applyResult(result: FinderResult): Promise<void> {
		if (Array.isArray(result.timeframes) && result.timeframes.length > 1) {
			uiManager.showToast(
				'Applied params from a multi-timeframe aggregate result. The backtest run below uses current chart timeframe only.',
				'info'
			);
		}

		state.set('currentStrategyKey', result.key);
		uiManager.updateStrategyDropdown(result.key);
		const strategy = strategyRegistry.get(result.key);
		if (!strategy) return;
		paramManager.render(strategy);
		paramManager.setValues(strategy, result.params);

		// Robust finder rows represent combined OOS walk-forward outcomes, not a single full-history backtest.
		// Show the exact robust OOS snapshot to avoid mismatch with an auto-rerun full backtest.
		if (result.robustMetrics?.mode === 'robust_random_wf') {
			commitBacktestResult(result.result, 'finder_robust_oos', {
				parityResults: null,
				reason: 'finder_robust_snapshot',
			});
			strategyPanelController.switchTab('trades');
			uiManager.showToast(
				'Applied robust OOS walk-forward snapshot. Full backtest runs can differ from Finder robust metrics.',
				'info'
			);
			return;
		}

		if (result.comboMode) {
			const primaryConfigName = result.comboPrimaryConfigName || this.getDom().finderComboPrimarySelect.value || '';
			if (!primaryConfigName) {
				uiManager.showToast('Combo result needs a primary config. Re-select it in Finder Combo Mode.', 'error');
				return;
			}

			const primaryConfig = settingsManager.loadStrategyConfig(primaryConfigName);
			if (!primaryConfig) {
				uiManager.showToast(`Primary config "${primaryConfigName}" not found.`, 'error');
				return;
			}

			const now = new Date().toISOString();
			const secondaryBacktestSettings: StrategyConfig['backtestSettings'] = this.lastFinderRunBacktestSettings
				? this.cloneBacktestSettings(this.lastFinderRunBacktestSettings) as StrategyConfig['backtestSettings']
				: settingsManager.getBacktestSettings();
			const secondaryConfig: StrategyConfig = {
				name: `finder_combo_secondary_${result.key}`,
				createdAt: now,
				updatedAt: now,
				strategyKey: result.key,
				strategyParams: { ...result.params },
				backtestSettings: secondaryBacktestSettings,
			};

			const pairCombinerDom = this.getPairCombinerDom();
			pairCombinerDom.combinerPrimarySelect.value = primaryConfigName;
			pairCombinerDom.combinerSecondarySelect.value = '';
			pairCombinerDom.combinerMode.value = 'and';

			strategyPanelController.switchTab('trades');

			setTimeout(() => {
				backtestService.runCombinedStrategyBacktest(primaryConfig, secondaryConfig, 'and')
					.then(() => {
						uiManager.showToast(`Applied combo result with primary "${primaryConfigName}" (AND).`, 'success');
					})
					.catch(err => {
						debugLogger.error('finder.apply_combo_result_backtest_failed', {
							primaryConfigName,
							secondaryStrategy: result.key,
							error: err instanceof Error ? err.message : String(err)
						});
						uiManager.showToast('Combined backtest failed for combo result.', 'error');
					});
			}, 0);
			return;
		}

		this.applyFinderBacktestSettings(result);
		strategyPanelController.switchTab('trades');

		commitParityBacktestResults(null, 'finder_row_apply');

		if (result.endpointAdjusted) {
			uiManager.showToast(
				'Finder ranked this row on an endpoint-adjusted selection snapshot. Running the raw backtest now.',
				'info'
			);
		}

		try {
			await backtestService.runCurrentBacktest();
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
		settingsManager.applyBacktestSettings(mergedSettings);
	}

	private setProgress(active: boolean, percent: number, text: string): void {
		this.ui.setProgress(active, percent, text);
	}

	private setStatus(text: string): void {
		this.ui.setStatus(text);
	}

	private lastRealYieldAt = 0;

	private async yieldControl(): Promise<void> {
		if (document.hidden) {
			// Skip most yields for near-100% CPU speed when backgrounded.
			// But every ~4s do a real macrotask yield so the browser can update
			// document.hidden when the tab becomes visible again.
			const now = performance.now();
			if (now - this.lastRealYieldAt < 4_000) return;
			this.lastRealYieldAt = now;
			await new Promise<void>(resolve => setTimeout(resolve, 0));
			return;
		}

		await new Promise<void>(resolve => {
			const ch = new MessageChannel();
			ch.port1.onmessage = () => resolve();
			ch.port2.postMessage(undefined);
		});
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








