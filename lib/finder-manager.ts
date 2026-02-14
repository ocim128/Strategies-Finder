import { StrategyParams } from "./strategies/index";
import { strategyRegistry } from "../strategyRegistry";
import { state } from "./state";
import { backtestService } from "./backtest-service";
import { paramManager } from "./param-manager";
import { uiManager } from "./ui-manager";
import { getRequiredElement, setVisible } from "./dom-utils";
import { dataManager } from "./data-manager";
import { getConfirmationStrategyValues, renderConfirmationStrategyList, setConfirmationStrategyParams } from "./confirmation-strategies";
import { DEFAULT_SORT_PRIORITY, METRIC_FULL_LABELS } from "./finder/constants";
import { runFinderExecution, type FinderSelectedStrategy } from "./finder/finder-runner";
import { FinderParamSpace } from "./finder/finder-param-space";
import { FinderTimeframeLoader, type FinderDataset } from "./finder/finder-timeframe-loader";
import { FinderUI } from "./finder/finder-ui";
import { debugLogger } from "./debug-logger";
import { readNumberInputValue, readToggleValue } from "./dom-input-readers";
import type {
	FinderMetric,
	FinderMode,
	FinderOptions,
	FinderResult
} from './types/finder';

export class FinderManager {
	private static readonly MAX_MULTI_TIMEFRAMES = 10;
	private static readonly MULTI_TIMEFRAME_DEFAULTS = ['1m', '2m', '3m', '4m', '5m', '6m', '7m', '8m', '9m', '10m'];
	private static readonly MULTI_TIMEFRAME_PRESETS = [
		...FinderManager.MULTI_TIMEFRAME_DEFAULTS,
		'15m', '30m', '1h', '4h', '1d', '1w', '1M'
	];
	private isRunning = false;
	private displayResults: FinderResult[] = [];
	private strategyToggles: Map<string, HTMLInputElement> = new Map();
	private selectedFinderTimeframes: string[] = [];
	private readonly ui = new FinderUI();
	private readonly paramSpace = new FinderParamSpace();
	private readonly timeframeLoader = new FinderTimeframeLoader(FinderManager.MAX_MULTI_TIMEFRAMES);

	public init() {
		getRequiredElement('runFinder').addEventListener('click', () => {
			void this.runFinder();
		});

		const copyTopButton = getRequiredElement<HTMLButtonElement>('finderCopyTopResults');
		copyTopButton.disabled = true;
		copyTopButton.addEventListener('click', () => {
			void this.copyTopResultsMetadata();
		});

		const saveSeedAuditButton = getRequiredElement<HTMLButtonElement>('finderSaveSeedAudit');
		saveSeedAuditButton.addEventListener('click', () => {
			void this.saveCurrentSeedAuditFile();
		});

		getRequiredElement('finderList').addEventListener('click', (event) => {
			const target = event.target as HTMLElement | null;
			const button = target?.closest<HTMLButtonElement>('.finder-apply');
			if (!button) return;
			const index = Number(button.dataset.index);
			const result = this.displayResults[index];
			if (result) {
				this.applyResult(result);
			}
		});

		this.renderStrategySelection();
		getRequiredElement('finderStrategiesToggleAll').addEventListener('change', (event) => {
			const checked = (event.target as HTMLInputElement).checked;
			this.strategyToggles.forEach(toggle => {
				toggle.checked = checked;
			});
		});

		this.initSortingUI();
		this.initMultiTimeframeUI();


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
		const sortPrimary = getRequiredElement<HTMLSelectElement>('finderSort');
		const sortSecondary = getRequiredElement<HTMLSelectElement>('finderSortSecondary');

		const optionsHtml = DEFAULT_SORT_PRIORITY.map(key =>
			`<option value="${key}">${METRIC_FULL_LABELS[key]}</option>`
		).join('');

		sortPrimary.innerHTML = optionsHtml;
		sortSecondary.innerHTML = optionsHtml;

		// Set defaults
		sortPrimary.value = 'expectancy';
		sortSecondary.value = 'profitFactor';

		// Advanced Toggle Logic
		const toggle = getRequiredElement<HTMLInputElement>('finderAdvancedToggle');
		const simpleSection = getRequiredElement('finderSimpleSort');
		const advancedSection = getRequiredElement('finderSortList');

		toggle.addEventListener('change', () => {
			setVisible(simpleSection.id, !toggle.checked);
			setVisible(advancedSection.id, toggle.checked);
		});

		// Initialize Advanced List
		this.initSortList();
	}

	private initSortList(): void {
		const list = getRequiredElement('finderSortList');

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
		const container = getRequiredElement('finderSortList');
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
		const toggle = getRequiredElement<HTMLInputElement>('finderMultiTimeframeToggle');
		const addPresetBtn = getRequiredElement<HTMLButtonElement>('finderMultiTimeframeAdd');
		const addCustomBtn = getRequiredElement<HTMLButtonElement>('finderMultiTimeframeCustomAdd');
		const customInput = getRequiredElement<HTMLInputElement>('finderMultiTimeframeCustom');

		this.populateMultiTimeframePresets();
		this.renderSelectedFinderTimeframes();

		toggle.addEventListener('change', () => {
			if (toggle.checked) {
				this.applyDefaultFinderTimeframes();
			}
			this.applyMockRestrictionToMultiTimeframe();
		});

		addPresetBtn.addEventListener('click', () => {
			const select = getRequiredElement<HTMLSelectElement>('finderMultiTimeframeSelect');
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

		getRequiredElement('finderMultiTimeframeSelected').addEventListener('click', (event) => {
			const target = event.target as HTMLElement | null;
			const removeBtn = target?.closest<HTMLButtonElement>('.finder-timeframe-chip-remove');
			if (!removeBtn) return;
			const interval = removeBtn.dataset.interval;
			if (!interval) return;
			this.removeFinderTimeframe(interval);
		});

		this.applyMockRestrictionToMultiTimeframe();
	}

	public clearTimeframeCache(): void {
		this.timeframeLoader.clearCache();
	}

	private populateMultiTimeframePresets(): void {
		const select = document.getElementById('finderMultiTimeframeSelect') as HTMLSelectElement | null;
		if (!select) return;

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
		const toggle = getRequiredElement<HTMLInputElement>('finderMultiTimeframeToggle');
		const note = getRequiredElement('finderMultiTimeframeNote');
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
		const settings = getRequiredElement('finderMultiTimeframeSettings');
		const select = getRequiredElement<HTMLSelectElement>('finderMultiTimeframeSelect');
		const addPresetBtn = getRequiredElement<HTMLButtonElement>('finderMultiTimeframeAdd');
		const customInput = getRequiredElement<HTMLInputElement>('finderMultiTimeframeCustom');
		const addCustomBtn = getRequiredElement<HTMLButtonElement>('finderMultiTimeframeCustomAdd');

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
		const container = getRequiredElement('finderMultiTimeframeSelected');
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
		const container = getRequiredElement('finderStrategyList');
		container.innerHTML = '';
		this.strategyToggles.clear();

		const strategies = strategyRegistry.getAll();
		Object.entries(strategies).forEach(([key, strategy]) => {
			const item = document.createElement('div');
			item.className = 'strategy-list-item';

			const checkbox = document.createElement('input');
			checkbox.type = 'checkbox';
			checkbox.id = `finder-strategy-${key}`;
			checkbox.checked = false;

			const label = document.createElement('label');
			label.htmlFor = `finder-strategy-${key}`;
			label.textContent = strategy.name;

			item.appendChild(checkbox);
			item.appendChild(label);
			container.appendChild(item);

			this.strategyToggles.set(key, checkbox);
		});
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
		const options = this.readOptions();
		const runButton = getRequiredElement<HTMLButtonElement>('runFinder');
		const setLoading = (loading: boolean) => {
			runButton.disabled = loading;
			runButton.classList.toggle('is-loading', loading);
			runButton.setAttribute('aria-busy', loading ? 'true' : 'false');
		};

		setLoading(true);
		this.setProgress(true, 0, 'Preparing...');
		this.setStatus('Running strategy finder...');
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

			const { initialCapital, positionSize, commission, sizingMode, fixedTradeAmount } = backtestService.getCapitalSettings();
			const settings = backtestService.getBacktestSettings();
			const requiresTsEngine = backtestService.requiresTypescriptEngine(settings);

			const output = await runFinderExecution(
				{
					ohlcvData: state.ohlcvData,
					symbol: state.currentSymbol,
					interval: state.currentInterval,
					options,
					settings,
					requiresTsEngine,
					selectedStrategies,
					initialCapital,
					positionSize,
					commission,
					sizingMode,
					fixedTradeAmount,
					getFinderTimeframesForRun: (finderOptions) => this.getFinderTimeframesForRun(finderOptions),
					loadMultiTimeframeDatasets: (symbol, intervals) => this.loadMultiTimeframeDatasets(symbol, intervals),
					generateParamSets: (defaultParams, finderOptions) => this.generateParamSets(defaultParams, finderOptions),
					buildRandomConfirmationParams: (strategyKeys, finderOptions) => this.buildRandomConfirmationParams(strategyKeys, finderOptions)
				},
				{
					setProgress: (percent, text) => this.setProgress(true, percent, text),
					setStatus: (text) => this.setStatus(text),
					yieldControl: () => this.yieldControl()
				}
			);

			this.displayResults = output.results;
			this.renderResults(output.results, options.sortPriority[0]);
		} finally {
			setLoading(false);
			this.isRunning = false;
		}
	}

	private readOptions(): FinderOptions {
		const useAdvancedSort = readToggleValue('finderAdvancedToggle', false);
		let sortPriority: FinderMetric[] = [];

		if (useAdvancedSort) {
			// Scrape sort priority from the list
			const sortItems = document.querySelectorAll('#finderSortList .finder-sort-item');
			sortPriority = Array.from(sortItems)
				.map(el => (el as HTMLElement).dataset.value as FinderMetric | undefined)
				.filter((val): val is FinderMetric => !!val);

			// Fallback
			if (sortPriority.length === 0) {
				sortPriority.push(...DEFAULT_SORT_PRIORITY);
			}
		} else {
			// Simple Sort Mode
			const p1 = getRequiredElement<HTMLSelectElement>('finderSort').value as FinderMetric;
			const p2 = getRequiredElement<HTMLSelectElement>('finderSortSecondary').value as FinderMetric;
			sortPriority.push(p1);
			if (p1 !== p2) {
				sortPriority.push(p2);
			}
			// Append 'netProfit' as fallback if not present, to ensure stable sort for rest (tie breaking)
			if (!sortPriority.includes('netProfit')) {
				sortPriority.push('netProfit');
			}
		}

		const mode = getRequiredElement<HTMLSelectElement>('finderMode').value as FinderMode;
		const multiTimeframeRequested = readToggleValue('finderMultiTimeframeToggle', false);
		const multiTimeframeEnabled = multiTimeframeRequested && !dataManager.isMockSymbol(state.currentSymbol);
		const timeframes = multiTimeframeEnabled
			? this.selectedFinderTimeframes.slice(0, FinderManager.MAX_MULTI_TIMEFRAMES)
			: [];
		const topN = Math.round(readNumberInputValue('finderTopN', 10, 1));
		const steps = Math.round(readNumberInputValue('finderSteps', 3, 2));
		const robustSeed = Math.round(readNumberInputValue('finderRobustSeed', 1337, -2147483648));
		const rangePercent = readNumberInputValue('finderRange', 35, 0);
		const maxRuns = Math.round(readNumberInputValue('finderMaxRuns', 120, 1));
		const tradeFilterEnabled = readToggleValue('finderTradesToggle', true);
		const minTrades = tradeFilterEnabled ? Math.round(readNumberInputValue('finderTradesMin', 40, 0)) : 0;
		const maxTradesRaw = tradeFilterEnabled
			? Math.round(readNumberInputValue('finderTradesMax', Number.POSITIVE_INFINITY, 0))
			: Number.POSITIVE_INFINITY;
		const maxTrades = Math.max(minTrades, maxTradesRaw);
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
			maxTrades
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
		return {
			rank,
			strategyId: result.key,
			strategyName: result.name,
			timeframes: result.timeframes ?? [state.currentInterval],
			params: result.params,
			metadata: strategy?.metadata ?? null,
			metrics: {
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
		const mode = getRequiredElement<HTMLSelectElement>('finderMode').value as FinderMode;
		if (mode !== 'robust_random_wf') {
			uiManager.showToast('Seed audit export is available only in Robust Random WF mode.', 'info');
			return;
		}

		const seed = Math.round(readNumberInputValue('finderRobustSeed', 1337, -2147483648));
		if (!Number.isFinite(seed)) {
			uiManager.showToast('Invalid robust seed value.', 'error');
			return;
		}

		const matchingEntries = debugLogger.getEntries().filter((entry) => {
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

	private applyResult(result: FinderResult): void {
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

		if (result.confirmationParams) {
			setConfirmationStrategyParams(result.confirmationParams);
		} else {
			setConfirmationStrategyParams({});
		}
		renderConfirmationStrategyList(getConfirmationStrategyValues());

		// Also apply global risk settings if present in result
		if (result.params['stopLossPercent'] !== undefined) {
			const input = document.getElementById('stopLossPercent') as HTMLInputElement | null;
			if (input) input.value = String(result.params['stopLossPercent']);
		}
		if (result.params['takeProfitPercent'] !== undefined) {
			const input = document.getElementById('takeProfitPercent') as HTMLInputElement | null;
			if (input) input.value = String(result.params['takeProfitPercent']);
		}

		// Switch to trades tab
		const tradesTab = document.querySelector('.panel-tab[data-tab="trades"]') as HTMLElement;
		if (tradesTab) tradesTab.click();

		setTimeout(() => {
			backtestService.runCurrentBacktest().catch(err => {
				debugLogger.error('finder.apply_result_backtest_failed', { error: err instanceof Error ? err.message : String(err) });
			});
		}, 0);
	}

	private setProgress(active: boolean, percent: number, text: string): void {
		this.ui.setProgress(active, percent, text);
	}

	private setStatus(text: string): void {
		this.ui.setStatus(text);
	}

	private async yieldControl(): Promise<void> {
		await new Promise(resolve => setTimeout(resolve, 0));
	}
}

export const finderManager = new FinderManager();








