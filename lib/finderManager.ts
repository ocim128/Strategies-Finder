import { BacktestResult, StrategyParams, runBacktest } from "./strategies/index";
import { strategyRegistry } from "../strategyRegistry";
import { state } from "./state";
import { backtestService } from "./backtestService";
import { paramManager } from "./paramManager";
import { uiManager } from "./uiManager";
import { getRequiredElement, setVisible } from "./domUtils";
import { dataManager } from "./dataManager";

type FinderMode = 'default' | 'grid' | 'random';
type FinderMetric = 'netProfit' | 'profitFactor' | 'sharpeRatio' | 'netProfitPercent' | 'winRate' | 'maxDrawdownPercent' | 'expectancy' | 'averageGain';

const DEFAULT_SORT_PRIORITY: FinderMetric[] = [
	'netProfit',
	'profitFactor',
	'sharpeRatio',
	'winRate',
	'maxDrawdownPercent',
	'expectancy',
	'averageGain',
	'netProfitPercent'
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
}

const METRIC_LABELS: Record<FinderMetric, string> = {
	netProfit: 'Net',
	profitFactor: 'PF',
	sharpeRatio: 'Sharpe',
	netProfitPercent: 'Net %',
	winRate: 'Win %',
	maxDrawdownPercent: 'DD %',
	expectancy: 'Exp',
	averageGain: 'Avg Gain'
};

const METRIC_FULL_LABELS: Record<FinderMetric, string> = {
	netProfit: 'Net Profit',
	profitFactor: 'Profit Factor',
	sharpeRatio: 'Sharpe Ratio',
	netProfitPercent: 'Net Profit %',
	winRate: 'Win Rate',
	maxDrawdownPercent: 'Max Drawdown %',
	expectancy: 'Expectancy',
	averageGain: 'Average Gain'
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

			const strategies = strategyRegistry.getAll();
			const strategyEntries = Object.entries(strategies).filter(([key]) => {
				const toggle = this.strategyToggles.get(key);
				return toggle ? toggle.checked : false;
			});

			if (strategyEntries.length === 0) {
				this.setStatus('No strategies selected.');
				return;
			}
			const results: FinderResult[] = [];

			const runsByStrategy: Map<string, number> = new Map();
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
				runsByStrategy.set(key, paramSets.length);
			}
			const totalRuns = Array.from(runsByStrategy.values()).reduce((sum, count) => sum + count, 0);
			let completed = 0;
			let errorCount = 0;

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
					try {
						// Apply percentage risk params to local settings copy for backtest
						const backtestSettings = { ...settings };
						if (params['stopLossPercent'] !== undefined) {
							backtestSettings.stopLossPercent = params['stopLossPercent'];
						}
						if (params['takeProfitPercent'] !== undefined) {
							backtestSettings.takeProfitPercent = params['takeProfitPercent'];
						}

						const signals = strategy.execute(state.ohlcvData, params);
						const result = runBacktest(
							state.ohlcvData,
							signals,
							initialCapital,
							positionSize,
							commission,
							backtestSettings,
							{ mode: sizingMode, fixedTradeAmount }
						);
						results.push({ key, name: strategy.name, params, result });
					} catch (err) {
						errorCount += 1;
						if (errorCount <= 3) {
							console.warn(`[Finder] Skipping ${key} due to error:`, err);
						}
					}

					completed += 1;
					if (completed % 25 === 0) {
						const progress = totalRuns > 0 ? (completed / totalRuns) * 100 : 0;
						this.setProgress(true, progress, `${completed}/${totalRuns} runs`);
						await this.yieldControl();
					}
				}
			}

			const filteredResults = options.tradeFilterEnabled
				? results.filter(({ result }) =>
					result.totalTrades >= options.minTrades && result.totalTrades <= options.maxTrades
				)
				: results;

			filteredResults.sort((a, b) => {
				for (const metric of options.sortPriority) {
					const valA = this.getMetricValue(a.result, metric);
					const valB = this.getMetricValue(b.result, metric);

					// Different values determine the order
					if (Math.abs(valA - valB) > 0.0001) {
						const isAscending = metric === 'maxDrawdownPercent';
						return isAscending ? valA - valB : valB - valA;
					}
				}
				return 0;
			});

			const trimmed = filteredResults.slice(0, Math.max(1, options.topN));
			this.renderResults(trimmed, options.sortPriority[0]);
			this.displayResults = trimmed;

			const progressText = totalRuns > 0 ? `${totalRuns}/${totalRuns} runs` : 'Complete';
			this.setProgress(true, 100, progressText);
			const statusParts = [`${results.length} runs`];
			if (options.tradeFilterEnabled) {
				statusParts.push(`${filteredResults.length} matched`);
			}
			statusParts.push(`${trimmed.length} shown`);
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
		const min = baseValue - range;
		const max = baseValue + range;
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
				numericRanges.push({ key, baseValue, min: baseValue - range, max: baseValue + range });
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
		const periodLike = /(period|lookback|bars|bins|length)/i.test(key);
		const percentLike = /(percent|pct|overbought|oversold|rsi)/i.test(key);
		const nonNegative = /(std|dev|factor|multiplier|atr|adx)/i.test(key);

		let next = value;
		if (periodLike) {
			next = Math.max(1, Math.round(next));
		} else if (key === 'stopLossPercent') {
			next = Math.min(15, Math.max(0, Number(next.toFixed(2))));
		} else if (key === 'takeProfitPercent') {
			next = Math.min(100, Math.max(0, Number(next.toFixed(2))));
		} else if (percentLike) {
			next = Math.min(100, Math.max(0, next));
		} else if (nonNegative) {
			next = Math.max(0, next);
		}

		if (!periodLike && Number.isInteger(defaultValue) && !percentLike && key !== 'stopLossPercent' && key !== 'takeProfitPercent') {
			next = Math.round(next);
		} else if (key === 'stopLossPercent' || key === 'takeProfitPercent') {
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
		list.innerHTML = '';

		if (results.length === 0) {
			setVisible('finderEmpty', true);
			return;
		}

		setVisible('finderEmpty', false);

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

	private applyResult(result: FinderResult): void {
		state.set('currentStrategyKey', result.key);
		uiManager.updateStrategyDropdown(result.key);
		const strategy = strategyRegistry.get(result.key);
		if (!strategy) return;
		paramManager.render(strategy);
		paramManager.setValues(strategy, result.params);

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
