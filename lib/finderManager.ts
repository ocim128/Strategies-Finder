import { BacktestResult, StrategyParams, runBacktest, runBacktestCompact, Signal, buildEntryBacktestResult } from "./strategies/index";
import { strategyRegistry } from "../strategyRegistry";
import { state } from "./state";
import { backtestService } from "./backtestService";
import { paramManager } from "./paramManager";
import { uiManager } from "./uiManager";
import { getRequiredElement, setVisible } from "./domUtils";
import { dataManager } from "./dataManager";
import { rustEngine } from "./rustEngineClient";
import { debugLogger } from "./debugLogger";
import { shouldUseRustEngine } from "./enginePreferences";
import { buildConfirmationStates, filterSignalsWithConfirmations, filterSignalsWithConfirmationsBoth, getConfirmationStrategyValues, renderConfirmationStrategyList, setConfirmationStrategyParams } from "./confirmationStrategies";

type FinderMode = 'default' | 'grid' | 'random';
type FinderMetric = 'netProfit' | 'profitFactor' | 'sharpeRatio' | 'netProfitPercent' | 'winRate' | 'maxDrawdownPercent' | 'expectancy' | 'averageGain' | 'totalTrades';

const DEFAULT_SORT_PRIORITY: FinderMetric[] = [
	'expectancy',
	'profitFactor',
	'totalTrades',
	'maxDrawdownPercent',
	'sharpeRatio',
	'averageGain',
	'winRate',
	'netProfitPercent',
	'netProfit'
];

interface FinderOptions {
	mode: FinderMode;
	sortPriority: FinderMetric[];
	useAdvancedSort: boolean;
	topN: number;
	steps: number;
	rangePercent: number;
	maxRuns: number;
	tradeFilterEnabled: boolean;
	minTrades: number;
	maxTrades: number;
}

interface FinderResult {
	key: string;
	name: string;
	params: StrategyParams;
	result: BacktestResult;
	confirmationParams?: Record<string, StrategyParams>;
}

const METRIC_LABELS: Record<FinderMetric, string> = {
	netProfit: 'Net',
	profitFactor: 'PF',
	sharpeRatio: 'Sharpe',
	netProfitPercent: 'Net %',
	winRate: 'Win %',
	maxDrawdownPercent: 'DD %',
	expectancy: 'Exp',
	averageGain: 'Avg Gain',
	totalTrades: 'Trades'
};

const METRIC_FULL_LABELS: Record<FinderMetric, string> = {
	netProfit: 'Net Profit',
	profitFactor: 'Profit Factor',
	sharpeRatio: 'Sharpe Ratio',
	netProfitPercent: 'Net Profit %',
	winRate: 'Win Rate',
	maxDrawdownPercent: 'Max Drawdown %',
	expectancy: 'Expectancy',
	averageGain: 'Average Gain',
	totalTrades: 'Total Trades'
};

/**
 * Detects if a parameter is a toggle (on/off) parameter.
 * Toggle params: start with 'use' prefix and have value 0 or 1.
 */
function isToggleParam(key: string, value: number): boolean {
	return /^use[A-Z]/.test(key) && (value === 0 || value === 1);
}

export class FinderManager {
	private isRunning = false;
	private displayResults: FinderResult[] = [];
	private strategyToggles: Map<string, HTMLInputElement> = new Map();

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
		sortPrimary.value = 'netProfit';
		sortSecondary.value = 'sharpeRatio';

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
			const rustSettings: typeof settings = { ...settings };
			delete (rustSettings as { confirmationStrategies?: string[] }).confirmationStrategies;
			delete (rustSettings as { confirmationStrategyParams?: Record<string, StrategyParams> }).confirmationStrategyParams;
			delete (rustSettings as { executionModel?: string }).executionModel;
			delete (rustSettings as { allowSameBarExit?: boolean }).allowSameBarExit;
			delete (rustSettings as { slippageBps?: number }).slippageBps;

			const strategies = strategyRegistry.getAll();
			const strategyEntries = Object.entries(strategies).filter(([key]) => {
				const toggle = this.strategyToggles.get(key);
				return toggle ? toggle.checked : false;
			});

			if (strategyEntries.length === 0) {
				this.setStatus('No strategies selected.');
				return;
			}

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

			this.setProgress(true, 10, `Running ${totalRuns} backtests (batch mode)...`);

			// MEMORY OPTIMIZATION: Use a max-heap-like structure to keep only top N results
			const topResults: FinderResult[] = [];
			const maxResults = Math.max(options.topN * 2, 50); // Keep 2x topN as buffer
			let processedCount = 0;
			let filteredCount = 0;

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
			const insertResult = (result: FinderResult) => {
				// Apply trade filter early to reduce memory
				if (options.tradeFilterEnabled) {
					if (result.result.totalTrades < options.minTrades ||
						result.result.totalTrades > options.maxTrades) {
						return;
					}
				}
				filteredCount++;

				topResults.push(result);

				// Periodically trim to avoid unbounded growth
				if (topResults.length > maxResults * 2) {
					topResults.sort((a, b) => {
						for (const metric of options.sortPriority) {
							const valA = this.getMetricValue(a.result, metric);
							const valB = this.getMetricValue(b.result, metric);
							if (Math.abs(valA - valB) > 0.0001) {
								const isAscending = metric === 'maxDrawdownPercent';
								return isAscending ? valA - valB : valB - valA;
							}
						}
						return 0;
					});
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
										settings.entryConfirmation ?? 'none'
									)
									: filterSignalsWithConfirmations(
										state.ohlcvData,
										signals,
										confirmationContext.states,
										settings.entryConfirmation ?? 'none',
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

							// CRITICAL: Clear signals array immediately to free memory
							signals.length = 0;
							(signals as any) = null;

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
					key: string;
					name: string;
					params: StrategyParams;
					signals: Signal[];
					backtestSettings: typeof settings;
					confirmationParams?: Record<string, StrategyParams>;
				};
				const batchRuns: PreparedRun[] = [];

				for (const job of batchJobs) {
					try {
						const confirmationContext = buildConfirmationContext();
						let signals = job.strategy.execute(state.ohlcvData, job.params);
						if (confirmationContext.states.length > 0) {
							signals = job.strategy.metadata?.role === 'entry'
								? filterSignalsWithConfirmationsBoth(
									state.ohlcvData,
									signals,
									confirmationContext.states,
									settings.entryConfirmation ?? 'none'
								)
								: filterSignalsWithConfirmations(
									state.ohlcvData,
									signals,
									confirmationContext.states,
									settings.entryConfirmation ?? 'none',
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
					const batchItems = batchRuns.map((run, idx) => {
						const itemSettings = { ...run.backtestSettings };
						delete (itemSettings as { confirmationStrategies?: string[] }).confirmationStrategies;
						delete (itemSettings as { confirmationStrategyParams?: Record<string, StrategyParams> }).confirmationStrategyParams;
						delete (itemSettings as { executionModel?: string }).executionModel;
						delete (itemSettings as { allowSameBarExit?: boolean }).allowSameBarExit;
						delete (itemSettings as { slippageBps?: number }).slippageBps;
						return {
							id: `${run.key}-${startIdx + idx}`,
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
							for (let i = 0; i < batchResult.results.length; i++) {
								const run = batchRuns[i];
								insertResult({
									key: run.key,
									name: run.name,
									params: run.params,
									result: batchResult.results[i].result,
									confirmationParams: run.confirmationParams
								});
							}
						} else {
							// Fallback for this batch
							for (const run of batchRuns) {
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
							}
						}
					} catch (err) {
						// Fallback for this batch on error
						for (const run of batchRuns) {
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
							} catch (innerErr) {
								console.warn(`[Finder] Backtest failed for ${run.key}:`, innerErr);
							}
						}
					}
				}

				// MEMORY: Clear batch arrays after processing
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
			topResults.sort((a, b) => {
				for (const metric of options.sortPriority) {
					const valA = this.getMetricValue(a.result, metric);
					const valB = this.getMetricValue(b.result, metric);

					if (Math.abs(valA - valB) > 0.0001) {
						const isAscending = metric === 'maxDrawdownPercent';
						return isAscending ? valA - valB : valB - valA;
					}
				}
				return 0;
			});

			const trimmed = topResults.slice(0, Math.max(1, options.topN));
			this.renderResults(trimmed, options.sortPriority[0]);
			this.displayResults = trimmed;

			const progressText = totalRuns > 0 ? `${totalRuns}/${totalRuns} runs` : 'Complete';
			this.setProgress(true, 100, progressText);
			const statusParts = [`${processedCount} runs`];
			if (options.tradeFilterEnabled) {
				statusParts.push(`${filteredCount} matched`);
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
		const topN = Math.round(this.readNumberInput('finderTopN', 10, 1));
		const steps = Math.round(this.readNumberInput('finderSteps', 3, 2));
		const rangePercent = this.readNumberInput('finderRange', 50, 0);
		const maxRuns = Math.round(this.readNumberInput('finderMaxRuns', 50, 1));
		const tradeFilterEnabled = this.isToggleEnabled('finderTradesToggle', false);
		const minTrades = tradeFilterEnabled ? Math.round(this.readNumberInput('finderTradesMin', 0, 0)) : 0;
		const maxTradesRaw = tradeFilterEnabled
			? Math.round(this.readNumberInput('finderTradesMax', Number.POSITIVE_INFINITY, 0))
			: Number.POSITIVE_INFINITY;
		const maxTrades = Math.max(minTrades, maxTradesRaw);

		return {
			mode,
			sortPriority,
			useAdvancedSort,
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
		const keys = Object.keys(defaultParams);
		if (keys.length === 0 || options.mode === 'default') {
			return [this.normalizeParams(defaultParams)];
		}

		const valuesByKey = keys.map(key => this.buildRangeValues(key, defaultParams[key], options));
		const totalCombos = valuesByKey.reduce((product, values) => product * values.length, 1);

		if (options.mode === 'grid' && totalCombos <= options.maxRuns) {
			const combos: StrategyParams[] = [];
			this.buildGridCombos(keys, valuesByKey, 0, {}, combos, options.maxRuns);
			return combos.length > 0 ? combos : [this.normalizeParams(defaultParams)];
		}

		if (options.mode === 'grid') {
			return this.sampleGridCombos(keys, valuesByKey, defaultParams, options.maxRuns);
		}

		return this.generateRandomCombos(keys, defaultParams, options);
	}

	private buildRangeValues(key: string, baseValue: number, options: FinderOptions): number[] {
		// Toggle params (use*) always get [0, 1] for grid search
		if (isToggleParam(key, baseValue)) {
			return [0, 1];
		}

		const rangeRatio = Math.max(0, options.rangePercent) / 100;
		const rawRange = Math.abs(baseValue) * rangeRatio;
		const range = rawRange > 0 ? rawRange : rangeRatio > 0 ? 1 : 0;
		let min = baseValue - range;
		let max = baseValue + range;

		if (key === 'clusterChoice') {
			min = 0;
			max = 2;
		} else if (/(iteration|iterations|interval|alpha)/i.test(key)) {
			min = Math.max(1, min);
		} else if (key === 'warmupBars') {
			min = Math.max(0, min);
		}

		// Special clamping for percent params
		if (key === 'stopLossPercent') {
			// Clamp to valid range: 0-15%
			min = Math.max(0, min);
			max = Math.min(15, max);
		} else if (key === 'targetPct') {
			min = 0;
			max = 2;
		} else if (key === 'takeProfitPercent') {
			// Clamp to valid range: 0-100%
			min = Math.max(0, min);
			max = Math.min(100, max);
		}

		const steps = Math.max(2, options.steps);
		const stepSize = steps > 1 ? (max - min) / (steps - 1) : 0;

		const values = new Set<number>();
		for (let i = 0; i < steps; i++) {
			const rawValue = min + stepSize * i;
			values.add(this.normalizeParamValue(key, rawValue, baseValue));
		}

		values.add(this.normalizeParamValue(key, baseValue, baseValue));
		return Array.from(values).sort((a, b) => a - b);
	}

	private buildGridCombos(
		keys: string[],
		valuesByKey: number[][],
		index: number,
		current: StrategyParams,
		combos: StrategyParams[],
		maxRuns: number
	): void {
		if (combos.length >= maxRuns) return;
		if (index >= keys.length) {
			if (this.validateParams(current)) {
				combos.push({ ...current });
			}
			return;
		}

		const key = keys[index];
		for (const value of valuesByKey[index]) {
			current[key] = value;
			this.buildGridCombos(keys, valuesByKey, index + 1, current, combos, maxRuns);
			if (combos.length >= maxRuns) break;
		}
	}

	private sampleGridCombos(
		keys: string[],
		valuesByKey: number[][],
		defaultParams: StrategyParams,
		maxRuns: number
	): StrategyParams[] {
		const combos: StrategyParams[] = [];
		const seen = new Set<string>();
		const normalizedDefault = this.normalizeParams(defaultParams);
		this.tryAddCombo(normalizedDefault, combos, seen, maxRuns);

		let attempts = 0;
		const maxAttempts = maxRuns * 10;
		while (combos.length < maxRuns && attempts < maxAttempts) {
			const params: StrategyParams = {};
			for (let i = 0; i < keys.length; i++) {
				const values = valuesByKey[i];
				const pick = values[Math.floor(Math.random() * values.length)];
				params[keys[i]] = pick;
			}
			this.tryAddCombo(params, combos, seen, maxRuns);
			attempts += 1;
		}
		return combos;
	}

	private generateRandomCombos(
		keys: string[],
		defaultParams: StrategyParams,
		options: FinderOptions
	): StrategyParams[] {
		const combos: StrategyParams[] = [];
		const seen = new Set<string>();
		const normalizedDefault = this.normalizeParams(defaultParams);
		this.tryAddCombo(normalizedDefault, combos, seen, options.maxRuns);

		// Separate toggle params from numeric params
		const toggleKeys: string[] = [];
		const numericRanges: { key: string; baseValue: number; min: number; max: number }[] = [];

		for (const key of keys) {
			const baseValue = defaultParams[key];
			if (isToggleParam(key, baseValue)) {
				toggleKeys.push(key);
			} else {
				const rangeRatio = Math.max(0, options.rangePercent) / 100;
				const rawRange = Math.abs(baseValue) * rangeRatio;
				const range = rawRange > 0 ? rawRange : rangeRatio > 0 ? 1 : 0;
				let min = baseValue - range;
				let max = baseValue + range;

				// Special clamping for percent params
				if (key === 'stopLossPercent') {
					min = Math.max(0, min);
					max = Math.min(15, max);
				} else if (key === 'targetPct') {
					min = 0;
					max = 2;
				} else if (key === 'takeProfitPercent') {
					min = Math.max(0, min);
					max = Math.min(100, max);
				}

				numericRanges.push({ key, baseValue, min, max });
			}
		}

		let attempts = 0;
		const maxAttempts = options.maxRuns * 10;
		while (combos.length < options.maxRuns && attempts < maxAttempts) {
			const params: StrategyParams = {};

			// Randomize toggle params (50% chance on/off)
			for (const key of toggleKeys) {
				params[key] = Math.random() < 0.5 ? 0 : 1;
			}

			// Randomize numeric params within range
			for (const range of numericRanges) {
				const raw = range.min + Math.random() * (range.max - range.min);
				params[range.key] = this.normalizeParamValue(range.key, raw, range.baseValue);
			}

			this.tryAddCombo(params, combos, seen, options.maxRuns);
			attempts += 1;
		}
		return combos;
	}

	private buildRandomConfirmationParams(strategyKeys: string[], options: FinderOptions): Record<string, StrategyParams> {
		const paramsByKey: Record<string, StrategyParams> = {};
		for (const key of strategyKeys) {
			const strategy = strategyRegistry.get(key);
			if (!strategy) continue;
			paramsByKey[key] = this.generateRandomParams(strategy.defaultParams, options);
		}
		return paramsByKey;
	}

	private generateRandomParams(defaultParams: StrategyParams, options: FinderOptions): StrategyParams {
		const keys = Object.keys(defaultParams);
		if (keys.length === 0) return {};

		// Separate toggle params from numeric params
		const toggleKeys: string[] = [];
		const numericRanges: { key: string; baseValue: number; min: number; max: number }[] = [];

		for (const key of keys) {
			const baseValue = defaultParams[key];
			if (isToggleParam(key, baseValue)) {
				toggleKeys.push(key);
				continue;
			}

			const rangeRatio = Math.max(0, options.rangePercent) / 100;
			const rawRange = Math.abs(baseValue) * rangeRatio;
			const range = rawRange > 0 ? rawRange : rangeRatio > 0 ? 1 : 0;
			let min = baseValue - range;
			let max = baseValue + range;

			// Special clamping for percent params
			if (key === 'stopLossPercent') {
				min = Math.max(0, min);
				max = Math.min(15, max);
			} else if (key === 'targetPct') {
				min = 0;
				max = 2;
			} else if (key === 'takeProfitPercent') {
				min = Math.max(0, min);
				max = Math.min(100, max);
			}

			numericRanges.push({ key, baseValue, min, max });
		}

		const maxAttempts = Math.max(10, keys.length * 5);
		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			const params: StrategyParams = {};

			for (const key of toggleKeys) {
				params[key] = Math.random() < 0.5 ? 0 : 1;
			}

			for (const range of numericRanges) {
				const raw = range.min + Math.random() * (range.max - range.min);
				params[range.key] = this.normalizeParamValue(range.key, raw, range.baseValue);
			}

			if (this.validateParams(params)) {
				return params;
			}
		}

		return this.normalizeParams(defaultParams);
	}

	private tryAddCombo(params: StrategyParams, combos: StrategyParams[], seen: Set<string>, maxRuns: number): void {
		if (combos.length >= maxRuns) return;
		if (!this.validateParams(params)) return;
		const key = this.serializeParams(params);
		if (seen.has(key)) return;
		seen.add(key);
		combos.push({ ...params });
	}

	private normalizeParams(params: StrategyParams): StrategyParams {
		const normalized: StrategyParams = {};
		Object.entries(params).forEach(([key, value]) => {
			normalized[key] = this.normalizeParamValue(key, value, value);
		});
		return normalized;
	}

	private normalizeParamValue(key: string, value: number, defaultValue: number): number {
		const isRsiThreshold = /(rsi(bullish|bearish|overbought|oversold)|overbought|oversold)/i.test(key);
		const isRsiPeriod = /rsi/i.test(key) && !isRsiThreshold;
		const iterationLike = /(iteration|iterations|interval)/i.test(key);
		const alphaLike = /alpha/i.test(key);
		const periodLike = /(period|lookback|bars|bins|length)/i.test(key) || isRsiPeriod || iterationLike || alphaLike;
		const percentLike = /(percent|pct)/i.test(key) || isRsiThreshold;
		const nonNegative = /(std|dev|factor|multiplier|atr|adx)/i.test(key);

		let next = value;
		if (key === 'warmupBars') {
			next = Math.max(0, Math.round(next));
		} else if (key === 'clusterChoice') {
			next = Math.min(2, Math.max(0, Math.round(next)));
		} else if (periodLike) {
			next = Math.max(1, Math.round(next));
		} else if (key === 'targetPct') {
			next = Math.min(2, Math.max(0, Number(next.toFixed(2))));
		} else if (key === 'stopLossPercent') {
			next = Math.min(15, Math.max(0, Number(next.toFixed(2))));
		} else if (key === 'takeProfitPercent') {
			next = Math.min(100, Math.max(0, Number(next.toFixed(2))));
		} else if (percentLike) {
			next = Math.min(100, Math.max(0, next));
		} else if (nonNegative) {
			next = Math.max(0, next);
		}

		if (/(multiplier|factor)/i.test(key) && defaultValue > 0) {
			next = Math.max(0.1, next);
		}

		if (/z(entry|exit)/i.test(key)) {
			next = Math.max(0, next);
		}

		if (key === 'bufferAtr') {
			next = Math.max(0, next);
		}

		if (!periodLike && Number.isInteger(defaultValue) && !percentLike && key !== 'stopLossPercent' && key !== 'takeProfitPercent' && key !== 'targetPct') {
			next = Math.round(next);
		} else if (key === 'stopLossPercent' || key === 'takeProfitPercent') {
			next = Number(next.toFixed(2));
		} else if (key === 'targetPct') {
			next = Number(next.toFixed(2));
		} else if (!Number.isInteger(defaultValue)) {
			next = Number(next.toFixed(4));
		}

		return next;
	}

	private validateParams(params: StrategyParams): boolean {
		const fast = params.fastPeriod;
		const slow = params.slowPeriod;
		const medium = params.mediumPeriod;
		if (fast !== undefined && slow !== undefined && fast >= slow) return false;
		if (fast !== undefined && medium !== undefined && fast >= medium) return false;
		if (medium !== undefined && slow !== undefined && medium >= slow) return false;

		const oversold = params.oversold;
		const overbought = params.overbought;
		if (oversold !== undefined && overbought !== undefined && oversold >= overbought) return false;

		const rsiOversold = params.rsiOversold;
		const rsiOverbought = params.rsiOverbought;
		if (rsiOversold !== undefined && rsiOverbought !== undefined && rsiOversold >= rsiOverbought) return false;

		const kPeriod = params.kPeriod;
		const dPeriod = params.dPeriod;
		if (kPeriod !== undefined && dPeriod !== undefined && kPeriod < dPeriod) return false;

		const macdFast = params.macdFast;
		const macdSlow = params.macdSlow;
		if (macdFast !== undefined && macdSlow !== undefined && macdFast >= macdSlow) return false;

		const minFactor = params.minFactor;
		const maxFactor = params.maxFactor;
		if (minFactor !== undefined && maxFactor !== undefined && minFactor > maxFactor) return false;
		if (params.factorStep !== undefined && params.factorStep <= 0) return false;

		if (params.kMeansIterations !== undefined && params.kMeansIterations <= 0) return false;
		if (params.kMeansInterval !== undefined && params.kMeansInterval <= 0) return false;
		if (params.perfAlpha !== undefined && params.perfAlpha <= 0) return false;
		if (params.clusterChoice !== undefined && (params.clusterChoice < 0 || params.clusterChoice > 2)) return false;

		const zEntry = params.zEntry;
		const zExit = params.zExit;
		if (zEntry !== undefined && zExit !== undefined && zExit >= zEntry) return false;

		return true;
	}

	private serializeParams(params: StrategyParams): string {
		return Object.keys(params)
			.sort()
			.map((key) => `${key}:${params[key]}`)
			.join('|');
	}

	private renderResults(results: FinderResult[], sortBy: FinderMetric): void {
		const list = getRequiredElement('finderList');
		const copyButton = document.getElementById('finderCopyTopResults') as HTMLButtonElement | null;
		list.innerHTML = '';

		if (results.length === 0) {
			setVisible('finderEmpty', true);
			if (copyButton) copyButton.disabled = true;
			return;
		}

		setVisible('finderEmpty', false);
		if (copyButton) copyButton.disabled = false;

		results.forEach((item, index) => {
			const row = document.createElement('div');
			row.className = 'finder-row';

			const rank = document.createElement('div');
			rank.className = 'finder-rank';
			rank.textContent = `${index + 1}`;

			const main = document.createElement('div');
			main.className = 'finder-main';

			const title = document.createElement('div');
			title.className = 'finder-title';
			title.textContent = item.name;

			const sub = document.createElement('div');
			sub.className = 'finder-sub';
			sub.textContent = item.key;

			const params = document.createElement('div');
			params.className = 'finder-params';
			params.textContent = this.formatParams(item.params);

			const metrics = document.createElement('div');
			metrics.className = 'finder-metrics';
			metrics.appendChild(this.createMetricChip(`${METRIC_LABELS[sortBy]} ${this.formatMetric(item.result, sortBy)}`));
			metrics.appendChild(this.createMetricChip(`Net ${this.formatCurrency(item.result.netProfit)}`));
			metrics.appendChild(this.createMetricChip(`PF ${this.formatProfitFactor(item.result.profitFactor)}`));
			metrics.appendChild(this.createMetricChip(`Sharpe ${item.result.sharpeRatio.toFixed(2)}`));
			metrics.appendChild(this.createMetricChip(`DD ${item.result.maxDrawdownPercent.toFixed(2)}%`));
			metrics.appendChild(this.createMetricChip(`Trades ${item.result.totalTrades}`));

			main.appendChild(title);
			main.appendChild(sub);
			main.appendChild(params);
			main.appendChild(metrics);

			const button = document.createElement('button');
			button.className = 'btn btn-secondary finder-apply';
			button.textContent = 'Apply';
			button.dataset.index = index.toString();

			row.appendChild(rank);
			row.appendChild(main);
			row.appendChild(button);
			list.appendChild(row);
		});
	}

	private createMetricChip(text: string): HTMLSpanElement {
		const span = document.createElement('span');
		span.textContent = text;
		return span;
	}

	private formatParams(params: StrategyParams): string {
		return Object.entries(params)
			.map(([key, value]) => `${key}=${this.formatParamValue(value)}`)
			.join(', ');
	}

	private formatParamValue(value: number): string {
		if (Number.isInteger(value)) return value.toString();
		return value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
	}

	private formatMetric(result: BacktestResult, metric: FinderMetric): string {
		switch (metric) {
			case 'netProfit':
				return this.formatCurrency(result.netProfit);
			case 'netProfitPercent':
				return this.formatPercent(result.netProfitPercent);
			case 'profitFactor':
				return this.formatProfitFactor(result.profitFactor);
			case 'sharpeRatio':
				return result.sharpeRatio.toFixed(2);
			case 'winRate':
				return this.formatPercent(result.winRate);
			case 'maxDrawdownPercent':
				return `${result.maxDrawdownPercent.toFixed(2)}%`;
			case 'expectancy':
				return this.formatCurrency(result.expectancy);
			case 'averageGain':
				return this.formatCurrency(result.avgWin);
			case 'totalTrades':
				return result.totalTrades.toString();
			default:
				return '';
		}
	}

	private getMetricValue(result: BacktestResult, metric: FinderMetric): number {
		switch (metric) {
			case 'netProfit':
				return result.netProfit;
			case 'netProfitPercent':
				return result.netProfitPercent;
			case 'profitFactor':
				return result.profitFactor === Infinity ? Number.MAX_SAFE_INTEGER : result.profitFactor;
			case 'sharpeRatio':
				return result.sharpeRatio;
			case 'winRate':
				return result.winRate;
			case 'maxDrawdownPercent':
				return result.maxDrawdownPercent;
			case 'expectancy':
				return result.expectancy;
			case 'averageGain':
				return result.avgWin;
			case 'totalTrades':
				return result.totalTrades;
			default:
				return 0;
		}
	}

	private formatCurrency(value: number): string {
		const sign = value >= 0 ? '+' : '';
		return `${sign}$${value.toFixed(2)}`;
	}

	private formatPercent(value: number): string {
		const sign = value >= 0 ? '+' : '';
		return `${sign}${value.toFixed(2)}%`;
	}

	private formatProfitFactor(value: number): string {
		return value === Infinity ? 'Inf' : value.toFixed(2);
	}

	private buildMetadataPayload(result: FinderResult, rank: number) {
		const strategy = strategyRegistry.get(result.key);
		return {
			rank,
			strategyId: result.key,
			strategyName: result.name,
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
			}
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
		const container = getRequiredElement('finderProgress');
		const fill = getRequiredElement('finderProgressFill');
		const label = getRequiredElement('finderProgressText');
		container.classList.toggle('active', active);
		fill.style.width = `${Math.min(100, Math.max(0, percent))}%`;
		label.textContent = text;
	}

	private setStatus(text: string): void {
		getRequiredElement('finderStatus').textContent = text;
	}

	private async yieldControl(): Promise<void> {
		await new Promise(resolve => setTimeout(resolve, 0));
	}
}

export const finderManager = new FinderManager();




