import { BacktestResult, StrategyParams, runBacktest, runBacktestCompact, Signal, Time, buildEntryBacktestResult } from "./strategies/index";
import { strategyRegistry } from "../strategyRegistry";
import { state } from "./state";
import { backtestService } from "./backtest-service";
import { paramManager } from "./param-manager";
import { uiManager } from "./ui-manager";
import { getRequiredElement, setVisible } from "./dom-utils";
import { dataManager } from "./data-manager";
import { rustEngine } from "./rust-engine-client";
import { debugLogger } from "./debug-logger";
import { shouldUseRustEngine } from "./engine-preferences";
import { buildConfirmationStates, filterSignalsWithConfirmations, filterSignalsWithConfirmationsBoth, getConfirmationStrategyValues, renderConfirmationStrategyList, setConfirmationStrategyParams } from "./confirmation-strategies";
import { DEFAULT_SORT_PRIORITY, METRIC_FULL_LABELS } from "./finder/constants";
import { buildSelectionResult } from "./finder/endpoint";
import { FinderParamSpace } from "./finder/finder-param-space";
import { FinderTimeframeLoader, type FinderDataset } from "./finder/finder-timeframe-loader";
import { FinderUI } from "./finder/finder-ui";
import { aggregateFinderBacktestResults, compareFinderResults } from "./finder/finder-engine";
import type {
	EndpointSelectionAdjustment,
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
		sortSecondary.value = 'oosProfitFactor';

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

	private compareResults(a: FinderResult, b: FinderResult, sortPriority: FinderMetric[]): number {
		return compareFinderResults(a, b, sortPriority);
	}

	private buildSelectionResult(
		raw: BacktestResult,
		lastDataTime: Time | null,
		initialCapital: number
	): EndpointSelectionAdjustment {
		return buildSelectionResult(raw, lastDataTime, initialCapital);
	}



	/**
	 * Memory-efficient finder that processes in batches to avoid OOM with large datasets.
	 * Key optimizations:
	 * 1. Process parameter combinations in small batches (not all at once)
	 * 2. Maintain only top-N results at any time (discard worse results early)
	 * 3. Chunk Rust batch requests for large datasets
	 * 4. Yield control frequently to prevent UI freeze
	 */
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
			const { initialCapital, positionSize, commission, sizingMode, fixedTradeAmount } = backtestService.getCapitalSettings();
			const settings = backtestService.getBacktestSettings();
			const requiresTsEngine = backtestService.requiresTypescriptEngine(settings);
			const confirmationStrategies = settings.confirmationStrategies ?? [];
			const shouldRandomizeConfirmations = options.mode === 'random';
			const hasConfirmationStrategies = confirmationStrategies.length > 0;
			const baseConfirmationParams = settings.confirmationStrategyParams ?? {};
			const runTimeframes = this.getFinderTimeframesForRun(options);
			const usingMultiTimeframe = options.multiTimeframeEnabled === true;
			if (usingMultiTimeframe && dataManager.isMockSymbol(state.currentSymbol)) {
				uiManager.showToast('Multi timeframe finder is not available for mock chart symbols.', 'error');
				this.setStatus('Multi timeframe finder is disabled for mock chart symbols.');
				return;
			}
			const rustSettings: typeof settings = { ...settings };
			delete (rustSettings as { confirmationStrategies?: string[] }).confirmationStrategies;
			delete (rustSettings as { confirmationStrategyParams?: Record<string, StrategyParams> }).confirmationStrategyParams;
			delete (rustSettings as { executionModel?: string }).executionModel;
			delete (rustSettings as { allowSameBarExit?: boolean }).allowSameBarExit;
			delete (rustSettings as { slippageBps?: number }).slippageBps;
			delete (rustSettings as { marketMode?: string }).marketMode;
			delete (rustSettings as { strategyTimeframeEnabled?: boolean }).strategyTimeframeEnabled;
			delete (rustSettings as { strategyTimeframeMinutes?: number }).strategyTimeframeMinutes;
			delete (rustSettings as { captureSnapshots?: boolean }).captureSnapshots;
			delete (rustSettings as { snapshotAtrPercentMin?: number }).snapshotAtrPercentMin;
			delete (rustSettings as { snapshotAtrPercentMax?: number }).snapshotAtrPercentMax;
			delete (rustSettings as { snapshotVolumeRatioMin?: number }).snapshotVolumeRatioMin;
			delete (rustSettings as { snapshotVolumeRatioMax?: number }).snapshotVolumeRatioMax;
			delete (rustSettings as { snapshotAdxMin?: number }).snapshotAdxMin;
			delete (rustSettings as { snapshotAdxMax?: number }).snapshotAdxMax;
			delete (rustSettings as { snapshotEmaDistanceMin?: number }).snapshotEmaDistanceMin;
			delete (rustSettings as { snapshotEmaDistanceMax?: number }).snapshotEmaDistanceMax;
			delete (rustSettings as { snapshotRsiMin?: number }).snapshotRsiMin;
			delete (rustSettings as { snapshotRsiMax?: number }).snapshotRsiMax;
			delete (rustSettings as { snapshotPriceRangePosMin?: number }).snapshotPriceRangePosMin;
			delete (rustSettings as { snapshotPriceRangePosMax?: number }).snapshotPriceRangePosMax;
			delete (rustSettings as { snapshotBarsFromHighMax?: number }).snapshotBarsFromHighMax;
			delete (rustSettings as { snapshotBarsFromLowMax?: number }).snapshotBarsFromLowMax;
			delete (rustSettings as { snapshotTrendEfficiencyMin?: number }).snapshotTrendEfficiencyMin;
			delete (rustSettings as { snapshotTrendEfficiencyMax?: number }).snapshotTrendEfficiencyMax;
			delete (rustSettings as { snapshotAtrRegimeRatioMin?: number }).snapshotAtrRegimeRatioMin;
			delete (rustSettings as { snapshotAtrRegimeRatioMax?: number }).snapshotAtrRegimeRatioMax;
			delete (rustSettings as { snapshotBodyPercentMin?: number }).snapshotBodyPercentMin;
			delete (rustSettings as { snapshotBodyPercentMax?: number }).snapshotBodyPercentMax;
			delete (rustSettings as { snapshotWickSkewMin?: number }).snapshotWickSkewMin;
			delete (rustSettings as { snapshotWickSkewMax?: number }).snapshotWickSkewMax;

			const strategies = strategyRegistry.getAll();
			const selectedStrategyEntries = Object.entries(strategies).filter(([key]) => {
				const toggle = this.strategyToggles.get(key);
				return toggle ? toggle.checked : false;
			});

			if (selectedStrategyEntries.length === 0) {
				this.setStatus('No strategies selected.');
				return;
			}

			const strategyEntries = selectedStrategyEntries;

			// MEMORY OPTIMIZATION: Determine batch size based on data size
			// For 5M+ candles, use very small batches to avoid OOM
			const dataSize = state.ohlcvData.length;
			const isLargeDataset = dataSize > 500000;      // 500K+ candles
			const isVeryLargeDataset = dataSize > 2000000; // 2M+ candles
			const isExtremeDataset = dataSize > 4000000;   // 4M+ candles (OOM risk zone)
			const backtestFn = isLargeDataset ? runBacktestCompact : runBacktest;

			// Smaller batches for larger datasets - CRITICAL for 5M+ bars
			// For extreme datasets, process ONE job at a time to minimize peak memory
			const BATCH_SIZE = isExtremeDataset ? 1 : (isVeryLargeDataset ? 2 : (isLargeDataset ? 8 : 50));

			// For very large datasets, warn user
			if (isExtremeDataset) {
				debugLogger.warn(`[Finder] EXTREME dataset detected (${dataSize} bars). Using ultra-memory-efficient mode.`);
				this.setStatus(`Ultra-memory mode: ${(dataSize / 1000000).toFixed(1)}M bars`);
			} else if (isVeryLargeDataset) {
				debugLogger.warn(`[Finder] Very large dataset detected (${dataSize} bars). Using memory-efficient mode.`);
			}

			// Collect parameter combinations WITHOUT generating signals yet
			type ParamJob = {
				key: string;
				name: string;
				params: StrategyParams;
				backtestSettings: typeof settings;
				strategy: (typeof strategyEntries)[0][1];
			};
			const allJobs: ParamJob[] = [];

			this.setProgress(true, 5, 'Preparing parameter combinations...');

			for (const [key, strategy] of strategyEntries) {
				const extendedDefaults = { ...strategy.defaultParams };
				if (settings.riskMode === 'percentage') {
					if (settings.stopLossEnabled) {
						extendedDefaults['stopLossPercent'] = settings.stopLossPercent ?? 5;
					}
					if (settings.takeProfitEnabled) {
						extendedDefaults['takeProfitPercent'] = settings.takeProfitPercent ?? 10;
					}
				}
				const paramSets = this.generateParamSets(extendedDefaults, options);
				for (const params of paramSets) {
					const backtestSettings = { ...settings };
					if (params['stopLossPercent'] !== undefined) {
						backtestSettings.stopLossPercent = params['stopLossPercent'];
					}
					if (params['takeProfitPercent'] !== undefined) {
						backtestSettings.takeProfitPercent = params['takeProfitPercent'];
					}
					allJobs.push({ key, name: strategy.name, params, backtestSettings, strategy });
				}
			}

			const totalRuns = allJobs.length;
			if (totalRuns === 0) {
				this.setStatus('No valid parameter combinations generated.');
				return;
			}

			if (usingMultiTimeframe) {
				this.setProgress(true, 8, `Loading ${runTimeframes.length} timeframe datasets...`);
				this.setStatus(`Loading timeframe datasets (${runTimeframes.length})...`);
				const datasets = await this.loadMultiTimeframeDatasets(state.currentSymbol, runTimeframes);

				if (datasets.length === 0) {
					this.setStatus('No data available for selected timeframes.');
					return;
				}

				this.setProgress(true, 12, `Running ${totalRuns} runs across ${datasets.length} timeframes...`);

				const fixedConfirmationStatesByInterval = new Map<string, Int8Array[]>();
				if (hasConfirmationStrategies && !shouldRandomizeConfirmations) {
					for (const dataset of datasets) {
						const states = buildConfirmationStates(dataset.data, confirmationStrategies, baseConfirmationParams);
						fixedConfirmationStatesByInterval.set(dataset.interval, states);
					}
				}

				const topResults: FinderResult[] = [];
				const maxResults = Math.max(options.topN * 2, 50);
				let processedCount = 0;
				let filteredCount = 0;
				let endpointAdjustedCount = 0;

				for (const job of allJobs) {
					let confirmationParamsForJob: Record<string, StrategyParams> | undefined;
					if (hasConfirmationStrategies) {
						if (shouldRandomizeConfirmations) {
							confirmationParamsForJob = this.buildRandomConfirmationParams(confirmationStrategies, options);
						} else if (Object.keys(baseConfirmationParams).length > 0) {
							confirmationParamsForJob = baseConfirmationParams;
						}
					}

					const timeframeResults: BacktestResult[] = [];

					for (const dataset of datasets) {
						try {
							let signals = job.strategy.execute(dataset.data, job.params);
							const confirmationStates = !hasConfirmationStrategies
								? []
								: shouldRandomizeConfirmations
									? buildConfirmationStates(dataset.data, confirmationStrategies, confirmationParamsForJob ?? {})
									: (fixedConfirmationStatesByInterval.get(dataset.interval) ?? []);

							if (confirmationStates.length > 0) {
								signals = (job.strategy.metadata?.role === 'entry' || settings.tradeDirection === 'both')
									? filterSignalsWithConfirmationsBoth(
										dataset.data,
										signals,
										confirmationStates,
										settings.tradeFilterMode ?? settings.entryConfirmation ?? 'none'
									)
									: filterSignalsWithConfirmations(
										dataset.data,
										signals,
										confirmationStates,
										settings.tradeFilterMode ?? settings.entryConfirmation ?? 'none',
										settings.tradeDirection ?? 'long'
									);
							}

							const evaluation = job.strategy.evaluate?.(dataset.data, job.params, signals);
							const entryStats = evaluation?.entryStats;
							const backtestFn = dataset.data.length > 500000 ? runBacktestCompact : runBacktest;
							const result = job.strategy.metadata?.role === 'entry' && entryStats
								? buildEntryBacktestResult(entryStats)
								: backtestFn(
									dataset.data,
									signals,
									initialCapital,
									positionSize,
									commission,
									job.backtestSettings,
									{ mode: sizingMode, fixedTradeAmount }
								);

							timeframeResults.push(result);

							signals.length = 0;
						} catch (error) {
							console.warn(`[Finder] Multi timeframe run failed for ${job.key} @ ${dataset.interval}:`, error);
						}
					}

					if (timeframeResults.length === 0) {
						processedCount++;
						continue;
					}

					const aggregatedResult = this.aggregateBacktestResults(timeframeResults, initialCapital);
					const lastDataTime = datasets.length === 1
						? datasets[0].data[datasets[0].data.length - 1]?.time ?? null
						: null;
					const adjustment = this.buildSelectionResult(aggregatedResult, lastDataTime, initialCapital);
					const enriched: FinderResult = {
						key: job.key,
						name: job.name,
						timeframes: datasets.map(dataset => dataset.interval),
						params: job.params,
						result: aggregatedResult,
						selectionResult: adjustment.result,
						endpointAdjusted: adjustment.adjusted,
						endpointRemovedTrades: adjustment.removedTrades,
						confirmationParams: confirmationParamsForJob
					};

					if (options.tradeFilterEnabled) {
						if (enriched.selectionResult.totalTrades < options.minTrades ||
							enriched.selectionResult.totalTrades > options.maxTrades) {
							processedCount++;
							continue;
						}
					}



					filteredCount++;
					if (enriched.endpointAdjusted) {
						endpointAdjustedCount++;
					}


					topResults.push(enriched);
					if (topResults.length > maxResults * 2) {
						topResults.sort((a, b) => this.compareResults(a, b, options.sortPriority));
						topResults.length = maxResults;
					}

					processedCount++;
					if (processedCount % 5 === 0 || processedCount === totalRuns) {
						const progress = 12 + (processedCount / totalRuns) * 84;
						this.setProgress(
							true,
							progress,
							`${processedCount}/${totalRuns} runs (${datasets.length} TF)`
						);
						this.setStatus(`Processing ${processedCount}/${totalRuns} runs across ${datasets.length} timeframes...`);
						await this.yieldControl();
					}
				}

				topResults.sort((a, b) => this.compareResults(a, b, options.sortPriority));
				const trimmed = topResults.slice(0, Math.max(1, options.topN));
				this.renderResults(trimmed, options.sortPriority[0]);
				this.displayResults = trimmed;

				const statusParts = [
					`${processedCount} runs`,
					`${datasets.length} timeframes`
				];
				if (options.tradeFilterEnabled) {
					statusParts.push(`${filteredCount} matched`);
				}
				statusParts.push(`${trimmed.length} shown`);

				this.setProgress(true, 100, `${totalRuns}/${totalRuns} runs`);
				this.setStatus(`Complete. ${statusParts.join(', ')}.`);
				return;
			}

			const confirmationStates = !shouldRandomizeConfirmations && hasConfirmationStrategies
				? buildConfirmationStates(state.ohlcvData, confirmationStrategies, baseConfirmationParams)
				: [];
			const buildConfirmationContext = (): { states: Int8Array[]; params?: Record<string, StrategyParams> } => {
				if (!hasConfirmationStrategies) return { states: [] };
				if (!shouldRandomizeConfirmations) {
					return {
						states: confirmationStates,
						params: Object.keys(baseConfirmationParams).length > 0 ? baseConfirmationParams : undefined
					};
				}
				const params = this.buildRandomConfirmationParams(confirmationStrategies, options);
				const states = buildConfirmationStates(state.ohlcvData, confirmationStrategies, params);
				return { states, params };
			};

			this.setProgress(true, 10, `Running ${totalRuns} backtests (batch mode)...`);

			// MEMORY OPTIMIZATION: Use a max-heap-like structure to keep only top N results
			const topResults: FinderResult[] = [];
			const maxResults = Math.max(options.topN * 2, 50); // Keep 2x topN as buffer
			let processedCount = 0;
			let filteredCount = 0;
			let endpointAdjustedCount = 0;
			const lastDataTime = state.ohlcvData.length > 0 ? state.ohlcvData[state.ohlcvData.length - 1].time : null;


			// CRITICAL: For very large datasets, use data caching to avoid JSON serialization OOM
			// SOLUTION: Send OHLCV data ONCE to Rust server, then reference by cache ID

			// Check if Rust is available
			const rustHealthy = !requiresTsEngine && shouldUseRustEngine() && await rustEngine.checkHealth();
			if (requiresTsEngine) {
				debugLogger.info('[Finder] Realism settings enabled - forcing TypeScript engine.');
				this.setStatus('Realism settings enabled - using TypeScript engine.');
			}

			// For large datasets, use data caching approach (send data once, reference by ID)
			let cacheId: string | null = null;
			const useCachedMode = isLargeDataset; // Enable cache mode for 500K+ candles

			if (useCachedMode && rustHealthy) {
				this.setStatus('Caching data on Rust engine...');
				this.setProgress(true, 8, 'Uploading data to Rust...');

				// Cache the OHLCV data on the Rust server (only happens once!)
				cacheId = await rustEngine.cacheData(state.ohlcvData);

				if (cacheId) {
					debugLogger.info(`[Finder] Data cached with ID: ${cacheId} (${dataSize} bars)`);
				} else {
					debugLogger.warn('[Finder] Failed to cache data, falling back to TypeScript');
				}
			}

			// Determine which mode to use
			const useRustCached = useCachedMode && cacheId !== null;
			const useRustDirect = rustHealthy && !isLargeDataset;
			// CRITICAL: For extreme datasets, disable Rust entirely to avoid JSON serialization OOM
			// Even cached mode sends signals array which can be huge
			const rustAvailable = isExtremeDataset ? false : (useRustCached || useRustDirect);

			if (isExtremeDataset) {
				debugLogger.info(`[Finder] Extreme dataset (${(dataSize / 1000000).toFixed(1)}M bars) - using TypeScript ultra-memory mode`);
				this.setStatus(`Ultra-memory mode: TypeScript only (${(dataSize / 1000000).toFixed(1)}M bars)`);
			} else if (isVeryLargeDataset && rustAvailable) {
				this.setStatus(`Using Rust engine with cached data ?`);
			} else if (!rustAvailable && isLargeDataset) {
				debugLogger.warn(`[Finder] Using TypeScript for ${dataSize} bars (Rust unavailable)`);
				this.setStatus('Using TypeScript engine...');
			}

			// Helper to insert result, maintaining only top N
			type CandidateResult = Omit<FinderResult, 'selectionResult' | 'endpointAdjusted' | 'endpointRemovedTrades'>;
			const insertResult = (result: CandidateResult) => {
				const adjustment = this.buildSelectionResult(result.result, lastDataTime, initialCapital);
				const enriched: FinderResult = {
					...result,
					selectionResult: adjustment.result,
					endpointAdjusted: adjustment.adjusted,
					endpointRemovedTrades: adjustment.removedTrades
				};

				// Apply trade filter early to reduce memory
				if (options.tradeFilterEnabled) {
					if (enriched.selectionResult.totalTrades < options.minTrades ||
						enriched.selectionResult.totalTrades > options.maxTrades) {
						return;
					}
				}
				filteredCount++;
				if (enriched.endpointAdjusted) {
					endpointAdjustedCount++;
				}

				topResults.push(enriched);

				// Periodically trim to avoid unbounded growth
				if (topResults.length > maxResults * 2) {
					topResults.sort((a, b) => this.compareResults(a, b, options.sortPriority));
					topResults.length = maxResults;
				}
			};

			// NOTE: Indicator pre-computation disabled for now
			// Each job may have different settings (stopLossPercent, takeProfitPercent) which
			// could require different indicator calculations. Enabling this caused incorrect results.
			// TODO: Re-enable with proper settings validation for safe precomputation

			// Process in batches
			const totalBatches = Math.ceil(totalRuns / BATCH_SIZE);
			let batchNum = 0;

			for (let startIdx = 0; startIdx < totalRuns; startIdx += BATCH_SIZE) {
				batchNum++;
				const endIdx = Math.min(startIdx + BATCH_SIZE, totalRuns);
				const batchJobs = allJobs.slice(startIdx, endIdx);

				// MEMORY OPTIMIZATION: For TypeScript-only mode with extreme datasets
				// Process jobs one at a time, clearing signals immediately after use
				if (!rustAvailable) {
					for (const job of batchJobs) {
						try {
							const confirmationContext = buildConfirmationContext();
							// Generate signals - these can be large arrays
							let signals = job.strategy.execute(state.ohlcvData, job.params);
							if (confirmationContext.states.length > 0) {
								signals = job.strategy.metadata?.role === 'entry'
									? filterSignalsWithConfirmationsBoth(
										state.ohlcvData,
										signals,
										confirmationContext.states,
										settings.tradeFilterMode ?? settings.entryConfirmation ?? 'none'
									)
									: filterSignalsWithConfirmations(
										state.ohlcvData,
										signals,
										confirmationContext.states,
										settings.tradeFilterMode ?? settings.entryConfirmation ?? 'none',
										settings.tradeDirection ?? 'long'
									);
							}

							const evaluation = job.strategy.evaluate?.(state.ohlcvData, job.params, signals);
							const entryStats = evaluation?.entryStats;
							const result = job.strategy.metadata?.role === 'entry' && entryStats
								? buildEntryBacktestResult(entryStats)
								: backtestFn(
									state.ohlcvData,
									signals,
									initialCapital,
									positionSize,
									commission,
									job.backtestSettings,
									{ mode: sizingMode, fixedTradeAmount }
									// precomputedIndicators disabled - can cause different results
								);
							insertResult({
								key: job.key,
								name: job.name,
								params: job.params,
								result,
								confirmationParams: confirmationContext.params
							});
						} catch (err) {
							console.warn(`[Finder] Backtest failed for ${job.key}:`, err);
						}

						// For extreme datasets, yield after EVERY job to allow GC
						if (isExtremeDataset) {
							await this.yieldControl();
						}
					}

					processedCount += batchJobs.length;
					const progress = 10 + (processedCount / totalRuns) * 85;
					this.setProgress(true, progress, `Batch ${batchNum}/${totalBatches} (${processedCount}/${totalRuns})`);
					this.setStatus(`Processing batch ${batchNum}/${totalBatches}...`);
					await this.yieldControl();
					continue;
				}

				// Generate signals for this batch only
				type PreparedRun = {
					id: string;
					key: string;
					name: string;
					params: StrategyParams;
					signals: Signal[];
					backtestSettings: typeof settings;
					confirmationParams?: Record<string, StrategyParams>;
				};
				const batchRuns: PreparedRun[] = [];

				const runBacktestFallback = (run: PreparedRun) => {
					try {
						const result = backtestFn(
							state.ohlcvData,
							run.signals,
							initialCapital,
							positionSize,
							commission,
							run.backtestSettings,
							{ mode: sizingMode, fixedTradeAmount }
						);
						insertResult({
							key: run.key,
							name: run.name,
							params: run.params,
							result,
							confirmationParams: run.confirmationParams
						});
					} catch (err) {
						console.warn(`[Finder] Backtest failed for ${run.key}:`, err);
					}
				};

				for (let jobOffset = 0; jobOffset < batchJobs.length; jobOffset++) {
					const job = batchJobs[jobOffset];
					try {
						const confirmationContext = buildConfirmationContext();
						let signals = job.strategy.execute(state.ohlcvData, job.params);
						if (confirmationContext.states.length > 0) {
							signals = job.strategy.metadata?.role === 'entry'
								? filterSignalsWithConfirmationsBoth(
									state.ohlcvData,
									signals,
									confirmationContext.states,
									settings.tradeFilterMode ?? settings.entryConfirmation ?? 'none'
								)
								: filterSignalsWithConfirmations(
									state.ohlcvData,
									signals,
									confirmationContext.states,
									settings.tradeFilterMode ?? settings.entryConfirmation ?? 'none',
									settings.tradeDirection ?? 'long'
								);
						}
						const evaluation = job.strategy.evaluate?.(state.ohlcvData, job.params, signals);
						const entryStats = evaluation?.entryStats;
						if (job.strategy.metadata?.role === 'entry' && entryStats) {
							const result = buildEntryBacktestResult(entryStats);
							insertResult({
								key: job.key,
								name: job.name,
								params: job.params,
								result,
								confirmationParams: confirmationContext.params
							});
							signals.length = 0;
							continue;
						}
						batchRuns.push({
							id: `${job.key}-${startIdx + jobOffset}`,
							key: job.key,
							name: job.name,
							params: job.params,
							signals,
							backtestSettings: job.backtestSettings,
							confirmationParams: confirmationContext.params
						});
					} catch (err) {
						console.warn(`[Finder] Signal generation failed for ${job.key}:`, err);
					}
				}

				if (batchRuns.length === 0) {
					processedCount += batchJobs.length;
					continue;
				}

				// Run backtests for this batch
				if (rustAvailable) {
					const batchItems = batchRuns.map((run) => {
						const itemSettings = { ...run.backtestSettings };
						delete (itemSettings as { confirmationStrategies?: string[] }).confirmationStrategies;
						delete (itemSettings as { confirmationStrategyParams?: Record<string, StrategyParams> }).confirmationStrategyParams;
						delete (itemSettings as { executionModel?: string }).executionModel;
						delete (itemSettings as { allowSameBarExit?: boolean }).allowSameBarExit;
						delete (itemSettings as { slippageBps?: number }).slippageBps;
						delete (itemSettings as { strategyTimeframeEnabled?: boolean }).strategyTimeframeEnabled;
						delete (itemSettings as { strategyTimeframeMinutes?: number }).strategyTimeframeMinutes;
						delete (itemSettings as { captureSnapshots?: boolean }).captureSnapshots;
						delete (itemSettings as { snapshotAtrPercentMin?: number }).snapshotAtrPercentMin;
						delete (itemSettings as { snapshotAtrPercentMax?: number }).snapshotAtrPercentMax;
						delete (itemSettings as { snapshotVolumeRatioMin?: number }).snapshotVolumeRatioMin;
						delete (itemSettings as { snapshotVolumeRatioMax?: number }).snapshotVolumeRatioMax;
						delete (itemSettings as { snapshotAdxMin?: number }).snapshotAdxMin;
						delete (itemSettings as { snapshotAdxMax?: number }).snapshotAdxMax;
						delete (itemSettings as { snapshotEmaDistanceMin?: number }).snapshotEmaDistanceMin;
						delete (itemSettings as { snapshotEmaDistanceMax?: number }).snapshotEmaDistanceMax;
						delete (itemSettings as { snapshotRsiMin?: number }).snapshotRsiMin;
						delete (itemSettings as { snapshotRsiMax?: number }).snapshotRsiMax;
						delete (itemSettings as { snapshotPriceRangePosMin?: number }).snapshotPriceRangePosMin;
						delete (itemSettings as { snapshotPriceRangePosMax?: number }).snapshotPriceRangePosMax;
						delete (itemSettings as { snapshotBarsFromHighMax?: number }).snapshotBarsFromHighMax;
						delete (itemSettings as { snapshotBarsFromLowMax?: number }).snapshotBarsFromLowMax;
						delete (itemSettings as { snapshotTrendEfficiencyMin?: number }).snapshotTrendEfficiencyMin;
						delete (itemSettings as { snapshotTrendEfficiencyMax?: number }).snapshotTrendEfficiencyMax;
						delete (itemSettings as { snapshotAtrRegimeRatioMin?: number }).snapshotAtrRegimeRatioMin;
						delete (itemSettings as { snapshotAtrRegimeRatioMax?: number }).snapshotAtrRegimeRatioMax;
						delete (itemSettings as { snapshotBodyPercentMin?: number }).snapshotBodyPercentMin;
						delete (itemSettings as { snapshotBodyPercentMax?: number }).snapshotBodyPercentMax;
						delete (itemSettings as { snapshotWickSkewMin?: number }).snapshotWickSkewMin;
						delete (itemSettings as { snapshotWickSkewMax?: number }).snapshotWickSkewMax;
						return {
							id: run.id,
							signals: run.signals,
							settings: itemSettings,
						};
					});

					try {
						// Use cached endpoint for large datasets, regular for smaller ones
						const batchResult = cacheId
							? await rustEngine.runCachedBatchBacktest(
								cacheId,
								batchItems,
								initialCapital,
								positionSize,
								commission,
								rustSettings,
								{ mode: sizingMode, fixedTradeAmount }
							)
							: await rustEngine.runBatchBacktest(
								state.ohlcvData,
								batchItems,
								initialCapital,
								positionSize,
								commission,
								rustSettings,
								{ mode: sizingMode, fixedTradeAmount }
							);

						if (batchResult && batchResult.results.length > 0) {
							const runById = new Map(batchRuns.map(run => [run.id, run]));
							const completedRunIds = new Set<string>();

							for (const batchEntry of batchResult.results) {
								const run = runById.get(batchEntry.id);
								if (!run) {
									console.warn(`[Finder] Rust batch returned unknown run id: ${batchEntry.id}`);
									continue;
								}
								insertResult({
									key: run.key,
									name: run.name,
									params: run.params,
									result: batchEntry.result,
									confirmationParams: run.confirmationParams
								});
								completedRunIds.add(run.id);
							}

							// If Rust skipped any jobs, run TypeScript fallback for those jobs only.
							if (completedRunIds.size < batchRuns.length) {
								for (const run of batchRuns) {
									if (completedRunIds.has(run.id)) continue;
									runBacktestFallback(run);
								}
							}
						} else {
							// Fallback for this batch
							for (const run of batchRuns) {
								runBacktestFallback(run);
							}
						}
					} catch (err) {
						// Fallback for this batch on error
						for (const run of batchRuns) {
							runBacktestFallback(run);
						}
					}
				}

				// MEMORY: Clear batch arrays after processing
				for (const run of batchRuns) {
					run.signals.length = 0;
				}
				batchRuns.length = 0;

				processedCount += batchJobs.length;

				// Update progress and yield control
				const progress = 10 + (processedCount / totalRuns) * 85;
				this.setProgress(true, progress, `Batch ${batchNum}/${totalBatches} (${processedCount}/${totalRuns})`);
				if (isExtremeDataset) {
					this.setStatus(`Processing ${batchNum}/${totalBatches} (ultra-memory mode)...`);
				} else {
					this.setStatus(`Processing batch ${batchNum}/${totalBatches}...`);
				}

				// Yield more frequently for large datasets to prevent freeze and allow GC
				await this.yieldControl();
			}

			// Final sort
			topResults.sort((a, b) => this.compareResults(a, b, options.sortPriority));

			const trimmed = topResults.slice(0, Math.max(1, options.topN));
			this.renderResults(trimmed, options.sortPriority[0]);
			this.displayResults = trimmed;

			const progressText = totalRuns > 0 ? `${totalRuns}/${totalRuns} runs` : 'Complete';
			this.setProgress(true, 100, progressText);
			const statusParts = [`${processedCount} runs`];
			if (options.tradeFilterEnabled) {
				statusParts.push(`${filteredCount} matched`);
			}
			if (endpointAdjustedCount > 0) {
				statusParts.push(`${endpointAdjustedCount} endpoint-adjusted`);
			}
			statusParts.push(`${trimmed.length} shown`);
			if (isVeryLargeDataset) {
				statusParts.push('(memory-efficient mode)');
			}
			this.setStatus(`Complete. ${statusParts.join(', ')}.`);
		} finally {
			setLoading(false);
			this.isRunning = false;
		}
	}


	private readOptions(): FinderOptions {
		const useAdvancedSort = this.isToggleEnabled('finderAdvancedToggle', false);
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
		const multiTimeframeRequested = this.isToggleEnabled('finderMultiTimeframeToggle', false);
		const multiTimeframeEnabled = multiTimeframeRequested && !dataManager.isMockSymbol(state.currentSymbol);
		const timeframes = multiTimeframeEnabled
			? this.selectedFinderTimeframes.slice(0, FinderManager.MAX_MULTI_TIMEFRAMES)
			: [];
		const topN = Math.round(this.readNumberInput('finderTopN', 10, 1));
		const steps = Math.round(this.readNumberInput('finderSteps', 3, 2));
		const rangePercent = this.readNumberInput('finderRange', 35, 0);
		const maxRuns = Math.round(this.readNumberInput('finderMaxRuns', 120, 1));
		const tradeFilterEnabled = this.isToggleEnabled('finderTradesToggle', true);
		const minTrades = tradeFilterEnabled ? Math.round(this.readNumberInput('finderTradesMin', 40, 0)) : 0;
		const maxTradesRaw = tradeFilterEnabled
			? Math.round(this.readNumberInput('finderTradesMax', Number.POSITIVE_INFINITY, 0))
			: Number.POSITIVE_INFINITY;
		const maxTrades = Math.max(minTrades, maxTradesRaw);
		return {
			mode,
			sortPriority,
			useAdvancedSort,
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

	private readNumberInput(id: string, fallback: number, min: number): number {
		const input = document.getElementById(id) as HTMLInputElement | null;
		if (!input) return fallback;
		const value = parseFloat(input.value);
		if (!Number.isFinite(value)) return fallback;
		return Math.max(min, value);
	}

	private isToggleEnabled(id: string, fallback: boolean): boolean {
		const toggle = document.getElementById(id) as HTMLInputElement | null;
		return toggle ? toggle.checked : fallback;
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

	private aggregateBacktestResults(results: BacktestResult[], initialCapital: number): BacktestResult {
		return aggregateFinderBacktestResults(results, initialCapital);
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
			endpointAdjusted: result.endpointAdjusted,
			endpointRemovedTrades: result.endpointRemovedTrades
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
			console.error('Failed to copy finder metadata:', error);
			uiManager.showToast('Copy failed - check browser permissions', 'error');
		}
	}

	private applyResult(result: FinderResult): void {
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
				console.error('Failed to run backtest after applying result:', err);
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





