/**
 * Finder candidate Apply actions: the in-flight guard, the per-scope Apply
 * flows, and the shared backtest-settings merge. Browser-only.
 *
 * Apply always reuses the retained run context (settings snapshot, finder
 * options, Arm run/apply context) and delegates to the existing application
 * services (settings manager, param manager, backtest service) rather than
 * wrapping them. The manager injects its run-context accessors; everything
 * else is the app singleton it has always been.
 */
import type { OHLCVData, StrategyParams } from "../../strategies/index";
import { strategyRegistry, loadBuiltInStrategyByKey } from "../../../strategyRegistry";
import { state } from "../../state";
import { backtestService } from "../../backtest-service";
import { paramManager } from "../../param-manager";
import { uiManager } from "../../ui-manager";
import { dataManager } from "../../data-manager";
import { settingsManager } from "../../settings-manager";
import { cloneJsonCompatible } from "../../json-utils";
import { debugLogger } from "../../debug-logger";
import { strategyPanelController } from "../../strategy-panel-controller";
import { setCurrentInterval, setCurrentStrategyKey } from "../../state-actions";
import { buildFinderArmPerformanceApplySettings } from "../finder-arm-performance-settings";
import { mergeFinderRiskParamsIntoBacktestSettings } from "../finder-runner-core";
import type { FinderResultStore } from "./finder-result-store";
import type {
	FinderArmPerformanceCandidate,
	FinderAssetOpportunityResult,
	FinderOptions,
	FinderResult,
	FinderUniverseCandidate,
} from "../../types/finder";

export interface FinderResultActionsDeps {
	getResultStore: () => FinderResultStore;
	/** Backtest settings captured when the last run started (or null). */
	getLastRunBacktestSettings: () => ReturnType<typeof settingsManager.getBacktestSettings> | null;
	/** Finder options captured when the last run started (or null). */
	getLastFinderOptions: () => FinderOptions | null;
	/** Evaluation data retained by the last current-chart run (or null). */
	getLastFinderEvaluationData: () => { interval: string; data: OHLCVData[] } | null;
}

export class FinderResultActions {
	private applyInFlight = false;

	constructor(private readonly deps: FinderResultActionsDeps) {}

	private get store(): FinderResultStore {
		return this.deps.getResultStore();
	}

	/**
	 * Resolve a Finder result's strategy, lazy-loading the built-in if it isn't
	 * registered yet (the common case after a tab reload — only the
	 * startup/current built-ins are eagerly registered, so restored Finder rows
	 * for other built-ins reference strategies that aren't loaded). Returns
	 * `null` if the strategy genuinely does not exist (deleted custom strategy
	 * or unknown key) so Apply can surface a visible error instead of silently
	 * no-op'ing (audit finding 4).
	 *
	 * Both Apply paths (current-chart + Universe) share this seam so the
	 * lazy-load + missing-strategy behavior is identical.
	 */
	async resolveFinderResultStrategy(strategyKey: string): Promise<NonNullable<ReturnType<typeof strategyRegistry.get>> | null> {
		const strategy = strategyRegistry.get(strategyKey)
			?? await loadBuiltInStrategyByKey(strategyKey);
		return strategy ?? null;
	}

	async runFinderApply(work: () => Promise<void>): Promise<void> {
		if (this.applyInFlight) {
			uiManager.showToast('A Finder result is already being applied. Wait for it to finish.', 'info');
			return;
		}
		this.applyInFlight = true;
		try {
			await work();
		} finally {
			this.applyInFlight = false;
		}
	}

	async applyArmPerformanceCandidate(candidate: FinderArmPerformanceCandidate): Promise<void> {
		const runContext = this.store.armPerformanceRunContext
			?? (this.store.latestResults.scope === 'arm_performance' ? this.store.latestResults.runContext : null);
		const savedInterval = (candidate.backtestSettings as unknown as { interval?: unknown }).interval;
		const context = runContext
			?? this.store.armPerformanceApplyContext
			?? {
				interval: typeof savedInterval === 'string' ? savedInterval : state.currentInterval,
				uiBacktestSettings: settingsManager.getBacktestSettings(),
				capitalSettings: backtestService.getCapitalSettings(),
			};
		const interval = runContext?.interval
			?? this.store.armPerformanceApplyContext?.interval
			?? (typeof savedInterval === 'string' ? savedInterval : state.currentInterval);
		const usedFallbackContext = !runContext && !this.store.armPerformanceApplyContext;
		const strategy = await this.resolveFinderResultStrategy(candidate.strategyKey);
		if (!strategy) {
			uiManager.showToast(`Strategy no longer available: ${candidate.strategyKey}. Apply aborted.`, 'error');
			return;
		}

		try {
			if (state.currentInterval !== interval) {
				setCurrentInterval(interval);
				await dataManager.loadData(state.currentSymbol, interval);
			}
			// Finder Apply is external configuration application: any dropdown
			// selection still loading when Apply commits must not commit over
			// the applied configuration afterwards (see cancelPendingStrategySelection).
			uiManager.cancelPendingStrategySelection();
			setCurrentStrategyKey(candidate.strategyKey);
			uiManager.updateStrategyDropdown(candidate.strategyKey);
			paramManager.render(strategy);
			paramManager.setValues(strategy, candidate.params);
			settingsManager.applyBacktestSettings(buildFinderArmPerformanceApplySettings(context, candidate));
			strategyPanelController.switchTab('trades');
			await backtestService.runCurrentBacktest();
			uiManager.showToast(
				`Applied ${candidate.strategyName} from Arm Performance. The normal backtest is running on the current chart; the pair-universe replay is not a chart P&L result.`,
				'info',
			);
			if (usedFallbackContext) {
				uiManager.showToast('Original Arm Performance context was unavailable; used saved candidate settings and current capital settings.', 'info');
			}
		} catch (error) {
			debugLogger.error('finder.apply_arm_performance_backtest_failed', {
				candidateId: candidate.candidateId,
				strategyKey: candidate.strategyKey,
				error: error instanceof Error ? error.message : String(error),
			});
			uiManager.showToast('Unable to apply the Arm Performance configuration to the current chart.', 'error');
		}
	}

	async applyCurrentChartResult(result: FinderResult): Promise<void> {

		// Load the strategy BEFORE mutating currentStrategyKey / dropdown so a
		// missing strategy leaves the prior selection unchanged (audit finding
		// 4). Previously the key was flipped first and Apply then silently
		// returned if the registry lookup failed, leaving the UI in a
		// half-updated state with the wrong strategy active.
		const strategy = await this.resolveFinderResultStrategy(result.key);
		if (!strategy) {
			uiManager.showToast(
				`Strategy no longer available: ${result.key}. Apply aborted; current strategy unchanged.`,
				'error',
			);
			debugLogger.warn('finder.apply_strategy_missing', { strategyKey: result.key });
			return;
		}
		// External configuration application boundary: supersede any pending
		// dropdown selection before committing the applied configuration.
		uiManager.cancelPendingStrategySelection();
		setCurrentStrategyKey(result.key);
		uiManager.updateStrategyDropdown(result.key);
		paramManager.render(strategy);
		paramManager.setValues(strategy, result.params);

		this.applyFinderBacktestSettings(result.params, result.exitStrategyKey, result.exitStrategyParams);
		strategyPanelController.switchTab('trades');

		if (result.endpointAdjusted) {
			uiManager.showToast(
				'Finder ranked this row on an endpoint-adjusted selection snapshot. Running the raw backtest now.',
				'info'
			);
		}

		try {
			const evaluationData = this.deps.getLastFinderEvaluationData();
			const snapshot = evaluationData?.interval === state.currentInterval
				? this.cloneOhlcvData(evaluationData.data)
				: null;
			await backtestService.runCurrentBacktest(snapshot
				? { dataOverride: snapshot, reason: 'finder_apply_snapshot' }
				: undefined);
		} catch (error) {
			debugLogger.error('finder.apply_result_backtest_failed', {
				strategyKey: result.key,
				strategyName: result.name,
				error: error instanceof Error ? error.message : String(error),
			});
			uiManager.showToast('Backtest rerun failed after applying Finder result.', 'error');
		}
	}

	async applyUniverseCandidate(candidate: FinderUniverseCandidate): Promise<void> {
		// Load the strategy BEFORE mutating currentStrategyKey / dropdown (same
		// reasoning as `applyCurrentChartResult`; audit finding 4).
		const strategy = await this.resolveFinderResultStrategy(candidate.strategyKey);
		if (!strategy) {
			uiManager.showToast(
				`Strategy no longer available: ${candidate.strategyKey}. Apply aborted; current strategy unchanged.`,
				'error',
			);
			debugLogger.warn('finder.apply_universe_strategy_missing', { strategyKey: candidate.strategyKey });
			return;
		}
		// External configuration application boundary (see applyCurrentChartResult).
		uiManager.cancelPendingStrategySelection();
		setCurrentStrategyKey(candidate.strategyKey);
		uiManager.updateStrategyDropdown(candidate.strategyKey);

		paramManager.render(strategy);
		paramManager.setValues(strategy, candidate.params);
		this.applyFinderBacktestSettings(candidate.params, candidate.exitStrategyKey, candidate.exitStrategyParams);
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

	/**
	 * Apply an Asset Opportunity result. Sets the selected asset as the current
	 * symbol, selects the winning strategy, applies its parameters through the
	 * existing state/settings actions, and runs the normal backtest. Mirrors the
	 * universe Apply path.
	 */
	async applyAssetOpportunityResult(result: FinderAssetOpportunityResult): Promise<void> {
		const strategy = await this.resolveFinderResultStrategy(result.strategyKey);
		if (!strategy) {
			uiManager.showToast(
				`Strategy no longer available: ${result.strategyKey}. Apply aborted; current strategy unchanged.`,
				'error',
			);
			debugLogger.warn('finder.apply_asset_opportunity_strategy_missing', { strategyKey: result.strategyKey });
			return;
		}
		// Load the asset through the existing data-loading path so provider
		// classification is preserved (current-chart Apply assumes the symbol is
		// already loaded; the asset-opportunity symbol may not be).
		try {
			await this.loadAssetForApply(result.symbol);
		} catch (error) {
			debugLogger.error('finder.apply_asset_opportunity_load_failed', {
				symbol: result.symbol,
				error: error instanceof Error ? error.message : String(error),
			});
			uiManager.showToast(`Failed to load ${result.symbol} for Apply.`, 'error');
			return;
		}
		// External configuration application boundary (see applyCurrentChartResult).
		uiManager.cancelPendingStrategySelection();
		setCurrentStrategyKey(result.strategyKey);
		uiManager.updateStrategyDropdown(result.strategyKey);
		paramManager.render(strategy);
		paramManager.setValues(strategy, result.params);
		this.applyFinderBacktestSettings(result.params, result.exitStrategyKey, result.exitStrategyParams);
		strategyPanelController.switchTab('trades');
		try {
			await backtestService.runCurrentBacktest();
			uiManager.showToast(
				`Applied Asset Opportunity: ${result.symbol} (${result.grade}) — rank ${result.historicalRank}, expectancy ${result.selectionResult.expectancy.toFixed(2)}.`,
				'success',
			);
		} catch (error) {
			debugLogger.error('finder.apply_asset_opportunity_backtest_failed', {
				symbol: result.symbol,
				strategyKey: result.strategyKey,
				error: error instanceof Error ? error.message : String(error),
			});
			uiManager.showToast('Backtest rerun failed after applying Asset Opportunity result.', 'error');
		}
	}

	/**
	 * Loads the given symbol through the existing data-loading path so an Asset
	 * Opportunity Apply preserves provider classification.
	 */
	async loadAssetForApply(symbol: string): Promise<void> {
		if (symbol === state.currentSymbol) return;
		await dataManager.loadData(symbol, state.currentInterval);
	}

	applyFinderBacktestSettings(
		params: StrategyParams,
		exitStrategyKey?: string,
		exitStrategyParams?: StrategyParams
	): void {
		const lastRunSettings = this.deps.getLastRunBacktestSettings();
		const baseSettings = lastRunSettings
			? this.cloneBacktestSettings(lastRunSettings)
			: settingsManager.getBacktestSettings();
		// `params` is already entry-only: buildFinderResult split exit params into
		// exitStrategyParams when it built the result. Merge directly.
		const mergedSettings = mergeFinderRiskParamsIntoBacktestSettings(baseSettings, params, this.deps.getLastFinderOptions() ?? undefined);
		if (exitStrategyKey) {
			mergedSettings.disableSignalExits = true;
			mergedSettings.exitStrategyOverrideEnabled = true;
			mergedSettings.exitStrategyKey = exitStrategyKey;
			mergedSettings.exitStrategyParams = { ...(exitStrategyParams ?? {}) };
		}
		settingsManager.applyBacktestSettings(mergedSettings);
	}

	private cloneOhlcvData(data: OHLCVData[]): OHLCVData[] {
		return data.map((candle) => ({ ...candle }));
	}

	private cloneBacktestSettings<T>(settings: T): T {
		return cloneJsonCompatible(settings);
	}
}
