/**
 * Finder diagnostics assembly for browser runs: the engine-mode label, the
 * minimal failure/fallback diagnostics that keep Copy Diagnostics available
 * when a run dies early, and the Strategy Quality audit diagnostics mapping.
 * Pure assembly over supplied inputs plus the current global chart context
 * (`state`); rendering and clipboard presentation stay with the manager.
 */
import type { OHLCVData } from "../../strategies/index";
import { state } from "../../state";
import type { FinderSelectedStrategy } from "../finder-runner";
import {
	buildFinderDiagnostics,
	createEmptyFinderDiagnosticsTimings,
	createFinderRunId,
} from "../finder-diagnostics";
import type {
	FinderDiagnostics,
	FinderOptions,
	FinderResult,
	FinderStrategyQualityDiagnostics,
	FinderStrategyQualityResult,
} from "../../types/finder";

/**
 * Resolve the engine-mode label used by the diagnostics builders.
 */
export function resolveDiagnosticsEngineMode(options: FinderOptions): string {
	return options.mode === 'genetic'
		? 'genetic'
		: 'typescript';
}

/**
 * Minimal diagnostics for failure paths. `kind: 'load'` is used when the
 * universe symbols failed to load (richer per-symbol failure detail);
 * `kind: 'run'` covers any other mid-run failure (engine throw, OOS
 * re-load error, etc.). Without this, latestDiagnostics stays null on a
 * mid-run failure and the Copy Diagnostics button is silently disabled.
 * The error reason is surfaced as the first bottleneck line so the user
 * can copy and share why the run failed.
 */
export function buildFailureDiagnostics(args: {
	kind: 'load' | 'run';
	options: FinderOptions;
	elapsedMs: number;
	error?: string;
	loadFailures?: Map<string, { error?: string }>;
	totalSymbols?: number;
	loadedSymbols?: number;
}): FinderDiagnostics {
	const failedSymbols = args.loadFailures
		? [...args.loadFailures.entries()].map(([symbol, result]) => ({
			symbol,
			reason: result.error ?? 'unknown error',
		}))
		: [];
	const timings = createEmptyFinderDiagnosticsTimings();
	timings.total = args.elapsedMs;
	if (args.kind === 'load') {
		timings.dataLoading = args.elapsedMs;
	}
	const universeDiagnostics = args.kind === 'load'
		? {
			totalSymbols: args.totalSymbols ?? failedSymbols.length,
			loadedSymbols: args.loadedSymbols ?? 0,
			failedSymbols,
		}
		: (args.options.scope === 'symbol_universe' || args.options.scope === 'strategy_quality') && args.options.universe
			? {
				totalSymbols: args.options.universe.symbols.length,
				loadedSymbols: 0,
				failedSymbols: [] as Array<{ symbol: string; reason: string }>,
			}
			: undefined;
	const base = buildFinderDiagnostics({
		runId: createFinderRunId(args.kind === 'load' ? 'finder-load-failure' : 'finder-run-failure'),
		symbol: state.currentSymbol,
		interval: state.currentInterval,
		mode: args.options.mode,
		engineMode: resolveDiagnosticsEngineMode(args.options),
		inputBars: 0,
		evaluationBars: 0,
		selectedStrategies: 0,
		totalParamRuns: 0,
		batchSize: 0,
		processedRuns: 0,
		filteredRuns: 0,
		shownResults: 0,
		endpointAdjusted: 0,
		failedRuns: 0,
		skippedRuns: 0,
		timings,
		strategyBreakdown: [],
		universeDiagnostics,
	});
	if (args.error) {
		// buildFinderDiagnostics already emits a fallback bottleneck line; prepend
		// the error reason so it is the first thing the user sees when copying.
		const truncatedError = args.error.length > 220 ? `${args.error.slice(0, 217)}...` : args.error;
		base.bottlenecks = [`Finder run failed: ${truncatedError}`, ...base.bottlenecks];
	}
	return base;
}

export function buildFallbackDiagnostics(args: {
	options: FinderOptions;
	results: FinderResult[];
	selectedStrategies: FinderSelectedStrategy[];
	ohlcvData: OHLCVData[];
	elapsedMs: number;
	requiresTsEngine: boolean;
}): FinderDiagnostics {
	const engineMode = (args.options.mode === 'genetic')
		? resolveDiagnosticsEngineMode(args.options)
		: args.requiresTsEngine
			? 'typescript'
			: 'unknown';
	return {
		runId: `finder-fallback-${Date.now().toString(36)}`,
		symbol: state.currentSymbol,
		interval: state.currentInterval,
		mode: args.options.mode,
		engineMode,
		data: {
			inputBars: args.ohlcvData.length,
			evaluationBars: args.ohlcvData.length,
			selectedStrategies: args.selectedStrategies.length,
			totalParamRuns: args.options.maxRuns,
			batchSize: 0,
		},
		counts: {
			processedRuns: args.options.maxRuns,
			filteredRuns: args.results.length,
			shownResults: args.results.length,
			rustCompletedRuns: 0,
			rustFallbackRuns: 0,
			endpointAdjusted: args.results.filter((result) => result.endpointAdjusted).length,
			failedRuns: 0,
			skippedRuns: 0,
		},
		timingsMs: {
			total: Number(args.elapsedMs.toFixed(2)),
			paramGeneration: 0,
			dataLoading: 0,
			pricePointLoading: 0,
			closedDataSelection: 0,
			indicatorPrecompute: 0,
			preparedData: 0,
			signalGeneration: 0,
			backtest: 0,
			rustRequest: 0,
			resultEnrichment: 0,
			resultRanking: 0,
			reconciliation: 0,
			uiUpdates: 0,
			yielding: 0,
		},
		timingPct: {
			paramGeneration: 0,
			dataLoading: 0,
			pricePointLoading: 0,
			closedDataSelection: 0,
			indicatorPrecompute: 0,
			preparedData: 0,
			signalGeneration: 0,
			backtest: 0,
			rustRequest: 0,
			resultEnrichment: 0,
			resultRanking: 0,
			reconciliation: 0,
			uiUpdates: 0,
			yielding: 0,
		},
		strategyBreakdown: args.selectedStrategies.map((selection) => ({
			key: selection.key,
			name: selection.name,
			runs: 0,
			failedRuns: 0,
			skippedRuns: 0,
			zeroSignalRuns: 0,
			avgSignalMs: 0,
			avgBacktestMs: 0,
			avgTotalMs: 0,
			totalMs: 0,
			runtimePct: 0,
			usedPreparedData: Boolean(selection.strategy.prepareFinderData && selection.strategy.executePrepared),
		})),
		bottlenecks: [
			`${engineMode} runner returned path-level diagnostics only`,
			`Total run time was ${Math.round(args.elapsedMs)}ms`,
		],
	};
}

export function buildStrategyQualityDiagnostics(args: {
	options: FinderOptions;
	results: FinderStrategyQualityResult[];
	performance: FinderStrategyQualityDiagnostics;
	failedSymbolDetails: Array<{ symbol: string; error: string }>;
	elapsedMs: number;
}): FinderDiagnostics {
	const quality = args.performance;
	const timings = createEmptyFinderDiagnosticsTimings();
	timings.total = args.elapsedMs;
	timings.dataLoading = quality.timingsMs.providerResolution + quality.timingsMs.dataLoading;
	timings.preparedData = quality.timingsMs.dataPreparation;
	timings.backtest = quality.timingsMs.strategyExecution + quality.timingsMs.oosExecution;
	timings.resultRanking = quality.timingsMs.resultReduction;
	timings.yielding = quality.timingsMs.yielding;
	const diagnostics = buildFinderDiagnostics({
		runId: createFinderRunId('finder-strategy-quality'),
		symbol: state.currentSymbol,
		interval: state.currentInterval,
		mode: args.options.mode,
		engineMode: 'auto',
		inputBars: quality.data.averageBars,
		evaluationBars: quality.data.averageBars,
		selectedStrategies: quality.selectedStrategies,
		totalParamRuns: quality.runs.planned,
		batchSize: 1,
		processedRuns: quality.runs.completed,
		filteredRuns: 0,
		shownResults: args.results.length,
		endpointAdjusted: 0,
		failedRuns: quality.runs.failed,
		skippedRuns: quality.runs.noTrade,
		timings,
		strategyBreakdown: [],
		universeDiagnostics: {
			totalSymbols: quality.requestedSymbols,
			loadedSymbols: quality.loadedSymbols,
			failedSymbols: args.failedSymbolDetails.map(({ symbol, error }) => ({ symbol, reason: error })),
		},
	});
	diagnostics.strategyQuality = {
		...quality,
		timingsMs: {
			...quality.timingsMs,
			total: args.elapsedMs,
		},
	};
	return diagnostics;
}
