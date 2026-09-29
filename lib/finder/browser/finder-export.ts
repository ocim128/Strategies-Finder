/**
 * Finder copy/export payloads and the clipboard transport. Browser-only.
 * Builders assemble the exact JSON the Copy buttons put on the clipboard;
 * they receive run context explicitly and never touch the manager instance,
 * its DOM, or result inventories. Toast/log presentation stays with the
 * manager. Metadata assembly reuses `finder-config-capture.ts` and
 * `finder-asset-opportunity-metadata.ts` leaves.
 */
import { strategyRegistry } from "../../../strategyRegistry";
import { state } from "../../state";
import { captureTradeFilter } from "../finder-config-capture";
import { buildAssetOpportunityMetadataPayload } from "../finder-asset-opportunity-metadata";
import { buildFinderArmPerformanceRunConfiguration } from "../finder-config-capture";
import { buildCompactFinderDiagnostics } from "../finder-diagnostics";
import type {
	FinderArmPerformanceCandidate,
	FinderArmPerformanceRunContext,
	FinderAssetOpportunityResult,
	FinderDiagnostics,
	FinderLatestResults,
	FinderResult,
	FinderStrategyQualityResult,
	FinderUniverseCandidate,
} from "../../types/finder";
import { getFinderArmPerformanceMetric, type FinderArmPerformanceArm, type FinderArmPerformanceDisplayFilter, type FinderArmPerformanceScoringBasis } from "../finder-arm-performance-metrics";
import type { FinderPersistedUiState } from "./finder-settings";
import type { BacktestSettings } from "../../types/strategies";
import type { CapitalSettings } from "../../types/backtest";
import { builtInStrategyKeys } from "../../strategies/manifest-keys";

export function buildCurrentChartMetadataPayload(result: FinderResult, rank: number) {
	const strategy = strategyRegistry.get(result.key);
	const displayedResult = result.selectionResult;
	return {
		scope: 'current_chart' as const,
		rank,
		strategyId: result.key,
		strategyName: result.name,
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
			...(Number.isFinite(result.exitAlpha) ? { exitAlpha: result.exitAlpha } : {}),
			...(Number.isFinite(result.oosExitAlpha) ? { oosExitAlpha: result.oosExitAlpha } : {}),
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
			...(Number.isFinite(result.exitAlpha) ? { exitAlpha: result.exitAlpha } : {}),
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
			...(Number.isFinite(result.exitAlpha) ? { exitAlpha: result.exitAlpha } : {}),
		},
		endpointAdjusted: result.endpointAdjusted,
		endpointRemovedTrades: result.endpointRemovedTrades,
		exitStrategy: result.exitStrategyKey ? {
			key: result.exitStrategyKey,
			params: result.exitStrategyParams ?? {},
		} : null,
		...(Number.isFinite(result.exitAlpha) ? { exitAlpha: result.exitAlpha } : {}),
		...(Number.isFinite(result.oosExitAlpha) ? { oosExitAlpha: result.oosExitAlpha } : {}),
	};
}

export function buildUniverseMetadataPayload(result: FinderUniverseCandidate, rank: number) {
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
			medianSharpe: result.medianSharpe,
			medianSharpeAvailable: result.medianSharpeAvailable,
			medianNetProfit: result.medianNetProfit,
			worstNetProfit: result.worstNetProfit,
			bestNetProfit: result.bestNetProfit,
			...(Number.isFinite(result.medianExitAlpha) ? { medianExitAlpha: result.medianExitAlpha } : {}),
			...(Number.isFinite(result.medianOosExitAlpha) ? { medianOosExitAlpha: result.medianOosExitAlpha } : {}),
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
				drawdownAvailable: symbolResult.result.drawdownAvailable === true,
				winningTrades: symbolResult.result.winningTrades,
				losingTrades: symbolResult.result.losingTrades,
				avgWin: symbolResult.result.avgWin,
				avgLoss: symbolResult.result.avgLoss,
				sharpeRatio: symbolResult.result.sharpeRatio,
				sharpeRatioAvailable: symbolResult.result.sharpeRatioAvailable === true,
				...(Number.isFinite(symbolResult.result.exitAlpha) ? { exitAlpha: symbolResult.result.exitAlpha } : {}),
			} : null,
			oosExitAlpha: Number.isFinite(symbolResult.oosResult?.exitAlpha)
				? symbolResult.oosResult?.exitAlpha
				: null,
		})),
	};
}

export function buildAssetOpportunityResultMetadataPayload(result: FinderAssetOpportunityResult, rank: number) {
	const strategy = strategyRegistry.get(result.strategyKey);
	return buildAssetOpportunityMetadataPayload({
		result,
		rank,
		interval: state.currentInterval,
		strategyMetadata: strategy?.metadata ?? null,
	});
}

export function buildStrategyQualityMetadataPayload(result: FinderStrategyQualityResult, rank: number) {
	return {
		scope: 'strategy_quality' as const,
		rank,
		strategyId: result.strategyKey,
		strategyName: result.strategyName,
		interval: state.currentInterval,
		params: result.params,
		metrics: {
			averageExpectancy: result.averageExpectancy,
			medianExpectancy: result.medianExpectancy,
			profitFactor: result.profitFactor,
			averageProfitFactor: result.averageProfitFactor,
			averageSharpe: result.averageSharpe,
			totalNetProfit: result.totalNetProfit,
			totalTrades: result.totalTrades,
			weightedWinRate: result.weightedWinRate,
			activeSymbols: result.activeSymbols,
			profitableSymbols: result.profitableSymbols,
		},
		oos: result.oos ?? null,
	};
}

export function buildArmPerformanceTopResultsPayload(args: {
	results: readonly FinderArmPerformanceCandidate[];
	runContext: FinderArmPerformanceRunContext | null;
	inventoryComplete: boolean;
	selectedArm: FinderArmPerformanceArm;
	scoringBasis?: FinderArmPerformanceScoringBasis;
	displayFilter?: FinderArmPerformanceDisplayFilter;
}) {
	const { results, runContext, inventoryComplete, selectedArm, scoringBasis = "raw", displayFilter = {} } = args;
	return {
		scope: 'arm_performance' as const,
		selectedArm,
		scoringBasis,
		eventFilter: {
			enabled: displayFilter.eventFilterEnabled === true,
			minEvents: displayFilter.minEvents ?? 1,
			maxEvents: displayFilter.maxEvents ?? null,
		},
		selectionCooldownBars: runContext?.searchOptions?.armPerformance?.selectionCooldownEnabled
			? runContext.searchOptions.armPerformance.selectionCooldownBars ?? 5
			: 0,
		rankingMetric: 'topMean',
		runContext,
		inventoryComplete,
		results: results.map((candidate, index) => ({
			rank: index + 1,
			runId: runContext?.runId ?? null,
			candidateId: candidate.candidateId,
			candidateOrdinal: candidate.candidateOrdinal,
			strategyKey: candidate.strategyKey,
			strategyName: candidate.strategyName,
			interval: runContext?.interval ?? null,
			horizon: candidate.horizon,
			params: candidate.params,
			backtestSettings: candidate.backtestSettings,
			exitStrategyKey: candidate.exitStrategyKey ?? null,
			exitStrategyParams: candidate.exitStrategyParams ?? null,
			pairCoverage: candidate.pairCoverage,
			selectedArm,
			selectedArmMetric: getFinderArmPerformanceMetric(candidate, selectedArm, scoringBasis) ?? null,
			excludedContributor: candidate.contributorExclusions?.[selectedArm] ?? null,
			allArmMetrics: candidate.metrics,
			allArmMetricsExTopContributor: candidate.metricsExTopContributor ?? null,
		})),
	};
}

/**
 * Top-results clipboard payload for the active result scope. `selectedArm`
 * supplies the Arm sort the user sees; every other scope derives entirely
 * from `latestResults`.
 */
export function buildFinderTopResultsPayload(args: {
	latestResults: FinderLatestResults;
	armRunContext: FinderArmPerformanceRunContext | null;
	armInventoryComplete: boolean;
	selectedArm: FinderArmPerformanceArm;
	scoringBasis?: FinderArmPerformanceScoringBasis;
	displayFilter?: FinderArmPerformanceDisplayFilter;
}) {
	const { latestResults, armRunContext, armInventoryComplete, selectedArm, scoringBasis = "raw", displayFilter = {} } = args;
	if (latestResults.scope === 'arm_performance') {
		return buildArmPerformanceTopResultsPayload({
			results: latestResults.results,
			runContext: armRunContext,
			inventoryComplete: armInventoryComplete,
			selectedArm,
			scoringBasis,
			displayFilter,
		});
	}
	if (latestResults.scope === 'current_chart') {
		return latestResults.results.map((result, index) => buildCurrentChartMetadataPayload(result, index + 1));
	}
	if (latestResults.scope === 'asset_opportunity') {
		return latestResults.results.map((result, index) => buildAssetOpportunityResultMetadataPayload(result, index + 1));
	}
	if (latestResults.scope === 'strategy_quality') {
		return latestResults.results.map((result, index) => buildStrategyQualityMetadataPayload(result, index + 1));
	}
	return latestResults.results.map((result, index) => buildUniverseMetadataPayload(result, index + 1));
}

/**
 * Copy the complete run configuration (Finder UI state + backtest settings) as
 * JSON. The AO batch archives a config.txt with backtest settings only; this
 * payload carries the Finder-side settings (strategies, universe, holdout,
 * eval window, trade filters) so archive runs are fully reproducible.
 *
 * Deleted strategy libraries keep stale keys in persisted UI state; both
 * selection lists are filtered against the live manifest so the copied config
 * only references strategies that exist. The trade-filter inputs are nulled
 * when the toggle is off — stale values captured verbatim read as an enforced
 * filter in archived configs.
 */
export function buildFinderRunConfigurationPayload(args: {
	uiState: FinderPersistedUiState;
	backtestSettings: BacktestSettings;
	capitalSettings: CapitalSettings;
}) {
	const { uiState } = args;
	const knownKeys = new Set<string>(builtInStrategyKeys);
	const filterKeys = (keys: string[]) => keys.filter((key) => knownKeys.has(key));
	const tradeFilter = captureTradeFilter(uiState);
	return {
		finder: {
			...uiState,
			tradeFilterEnabled: tradeFilter.tradeFilterEnabled,
			minTrades: tradeFilter.minTrades,
			maxTradesText: tradeFilter.tradeFilterEnabled ? uiState.maxTradesText : null,
			currentChartSelectedStrategyKeys: filterKeys(uiState.currentChartSelectedStrategyKeys),
			universeSelectedStrategyKeys: filterKeys(uiState.universeSelectedStrategyKeys),
		},
		backtestSettings: args.backtestSettings,
		// Capital settings live outside backtestSettings (commission is a
		// capital setting) — without this line the copied config cannot prove
		// whether commission was active.
		capitalSettings: args.capitalSettings,
	};
}

export function buildArmPerformanceRunConfigurationPayload(
	context: FinderArmPerformanceRunContext,
	resultCount: number,
	inventoryComplete: boolean,
) {
	return buildFinderArmPerformanceRunConfiguration(context, resultCount, inventoryComplete);
}

export function buildArmPerformanceDiagnosticsPayload(args: {
	runContext: FinderArmPerformanceRunContext | null;
	inventoryComplete: boolean;
	results: readonly FinderArmPerformanceCandidate[];
}) {
	return {
		scope: 'arm_performance' as const,
		runContext: args.runContext,
		inventoryComplete: args.inventoryComplete,
		results: args.results.map((candidate) => ({
			candidateId: candidate.candidateId,
			candidateOrdinal: candidate.candidateOrdinal,
			strategyKey: candidate.strategyKey,
			pairCoverage: candidate.pairCoverage,
			metrics: candidate.metrics,
		})),
	};
}

export function buildAssetOpportunityDiagnosticsPayload(diagnostics: FinderDiagnostics['assetOpportunity']) {
	return {
		scope: 'asset_opportunity' as const,
		assetOpportunity: diagnostics,
	};
}

export function buildCompactFinderDiagnosticsPayload(diagnostics: FinderDiagnostics) {
	return buildCompactFinderDiagnostics(diagnostics);
}

export async function copyTextToClipboard(text: string): Promise<void> {
	try {
		if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(text);
			return;
		}
	} catch (_error) {
		// Fall through to the textarea path for browsers that reject clipboard writes without focus.
	}

	const textarea = document.createElement('textarea');
	textarea.value = text;
	textarea.setAttribute('readonly', 'true');
	textarea.style.position = 'fixed';
	textarea.style.left = '-9999px';
	textarea.style.top = '0';
	document.body.appendChild(textarea);
	textarea.focus();
	textarea.select();
	try {
		if (!document.execCommand('copy')) {
			throw new Error('Fallback clipboard copy returned false');
		}
	} finally {
		textarea.remove();
	}
}
