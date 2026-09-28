/**
 * Current Chart scope workflow: in-browser param sweep over the chart's own
 * OHLCV data, plus the optional OOS validation gate. Terminal results are
 * adopted through the result store; provisional mid-run renders never
 * persist.
 */
import type { OHLCVData } from "../../../strategies/index";
import { state } from "../../../state";
import { backtestService } from "../../../backtest-service";
import { sliceOhlcvByBlock } from "../../../block-selector";
import { isRustSupportedTradeSizingMode } from "../../../types/backtest";
import type { CapitalSettings } from "../../../types/backtest";
import type { BacktestSettings } from "../../../types/strategies";
import { buildFinderEvaluationData, runFinderExecution } from "../../finder-runner";
import { sortFinderResults } from "../../finder-engine";
import {
	normalizeFinderDateRange,
	resolveOosDataSlice,
	sliceFinderDataWindow,
} from "../../finder-manager-logic";
import { runCandidateOosPass } from "../../finder-candidate-oos";
import { finderSortRequiresTradeTimingQuality } from "../../../trade-timing-quality";
import { buildFallbackDiagnostics } from "../finder-run-diagnostics";
import type { FinderResultStore } from "../finder-result-store";
import type { FinderOptions, FinderResult } from "../../../types/finder";
import type { FinderRunHost, FinderStrategySource, FinderSelectedStrategy } from "./finder-run-host";

export interface CurrentChartWorkflowArgs {
	host: FinderRunHost;
	store: FinderResultStore;
	strategies: FinderStrategySource;
	options: FinderOptions;
	startTime: number;
	getSelectedStrategies(): Promise<FinderSelectedStrategy[]>;
	generateParamSets(defaultParams: import("../../../types/strategies").StrategyParams, options: FinderOptions): import("../../../types/strategies").StrategyParams[];
	/** Retain the evaluation window for the Apply snapshot re-run. */
	retainEvaluationData(data: { interval: string; data: OHLCVData[] }): void;
	/** Store the run diagnostics (failure/fallback/runner-provided). */
	onDiagnostics(diagnostics: import("../../../types/finder").FinderDiagnostics | null): void;
}

export async function runCurrentChartFinder(args: CurrentChartWorkflowArgs): Promise<boolean> {
	const { host, store, options, startTime } = args;
	const selectedStrategies = await args.getSelectedStrategies();
	if (selectedStrategies.length === 0) {
		host.setStatus('No strategies selected.');
		return false;
	}
	const exitStrategyCandidates = await args.strategies.resolveExitStrategyCandidates(options, selectedStrategies);
	if (options.mode === "genetic" && finderSortRequiresTradeTimingQuality(options.sortPriority)) {
		host.setStatus("Entry Score and Exit Score sorting are supported in grid and random modes only.");
		return false;
	}

	const capitalSettings = backtestService.getCapitalSettings();
	const settings = backtestService.getBacktestSettings();
	const requiresTsEngine = backtestService.requiresTypescriptEngine(settings) || !isRustSupportedTradeSizingMode(capitalSettings.sizingMode);

	const blockSlicedData = sliceOhlcvByBlock(state.ohlcvData, state.blockRange);
	const windowSlicedData = sliceFinderDataWindow(
		blockSlicedData,
		options.dataSlice ?? "all",
		normalizeFinderDateRange(options.dataRangeFrom, options.dataRangeTo),
	);
	const ohlcvData = buildFinderEvaluationData(windowSlicedData, state.currentInterval, settings);
	if (ohlcvData.length === 0) {
		host.setStatus('No candles available for finder run.');
		return false;
	}
	// Retain the evaluation reference WITHOUT cloning: Finder execution
	// treats the OHLCV input as read-only (enforced by the frozen-input
	// test), so the upfront clone only duplicated ~5-10MB per 100k-bar
	// run. The defensive copy is made at the Apply boundary instead, where
	// the backtest actually consumes the data.
	args.retainEvaluationData({
		interval: state.currentInterval,
		data: ohlcvData,
	});

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
			exitStrategyCandidates,
			signal: host.getAbortSignal(),
			generateParamSets: (defaultParams, finderOptions) => args.generateParamSets(defaultParams, finderOptions),
		},
		{
			setProgress: (percent, text) => host.setProgress(true, percent, text),
			setStatus: (text) => host.setStatus(text),
			yieldControl: () => host.yieldControl(),
			isCancelled: () => host.isCancelled(),
			onResultsUpdate: (results: FinderResult[]) => {
				const sorted = sortFinderResults(results, options.sortPriority);
				// Provisional mid-run render — no persistence until the final
				// adoption below.
				store.setLatestResults({ scope: 'current_chart', results: sorted }, false);
				host.renderLatestResults();
			},
		}
	);

	const sortedResults = sortFinderResults(output.results, options.sortPriority);
	const oosReport = await applyOosValidationIfNeeded({
		host,
		results: sortedResults,
		blockSlicedData,
		selectedStrategies,
		settings,
		capitalSettings,
		options,
		startTime,
		resolveExitStrategyCandidates: (options_, strategies_) => args.strategies.resolveExitStrategyCandidates(options_, strategies_),
	});
	const finalResults = oosReport?.filtered ?? sortedResults;
	const finalSortedResults = oosReport
		? sortFinderResults(finalResults, options.sortPriority, { useOosValues: true })
		: finalResults;
	store.setLatestResults({ scope: 'current_chart', results: finalSortedResults });
	const diagnostics = output.diagnostics ?? buildFallbackDiagnostics({
		options,
		results: finalSortedResults,
		selectedStrategies,
		ohlcvData,
		elapsedMs: performance.now() - startTime,
		requiresTsEngine,
	});
	args.onDiagnostics(diagnostics);
	host.showDiagnosticsAvailability(Boolean(diagnostics));
	host.stashAndResetResort();
	host.populateResortOptions();
	host.renderLatestResults();
	host.renderRandomBenchmark(options.mode, output.randomBenchmark);

	if (!host.isCancelled()) {
		const elapsed = Math.round(performance.now() - startTime);
		if (oosReport && oosReport.removedCount > 0) {
			host.setStatus(
				`Finder complete. ${finalResults.length} result${finalResults.length === 1 ? '' : 's'}`
				+ ` (${oosReport.removedCount} filtered by OOS gate) in ${elapsed}ms.`
			);
		} else {
			host.setStatus(`Finder complete. ${finalResults.length} result${finalResults.length === 1 ? '' : 's'} in ${elapsed}ms.`);
		}
	}
	return true;
}

/**
 * Out-of-sample gate. After the normal Finder ranking produces its top-N survivors,
 * each survivor is re-backtested on the complementary half of the data window. Any
 * candidate that degrades (netProfit < 0 or profitFactor < 1.0) is filtered out;
 * inconclusive OOS runs (too few trades) are kept and flagged. Returns null when the
 * gate is not applicable (toggle off, non-half window, cancelled).
 *
 * Delegates to the extracted `runCandidateOosPass` leaf so the Asset Opportunity
 * server job reuses the identical OOS semantics.
 */
async function applyOosValidationIfNeeded(args: {
	host: FinderRunHost;
	results: FinderResult[];
	blockSlicedData: OHLCVData[];
	selectedStrategies: FinderSelectedStrategy[];
	settings: BacktestSettings;
	capitalSettings: CapitalSettings;
	options: FinderOptions;
	startTime: number;
	resolveExitStrategyCandidates(
		options: FinderOptions,
		selectedStrategies: FinderSelectedStrategy[],
	): Promise<FinderSelectedStrategy[] | undefined>;
}): Promise<{ filtered: FinderResult[]; removedCount: number } | null> {
	const { host, results, blockSlicedData, selectedStrategies, settings, capitalSettings, options } = args;
	const dataSlice = options.dataSlice ?? 'all';
	if (!options.oosValidationEnabled) return null;
	const oosSlice = resolveOosDataSlice(dataSlice);
	if (!oosSlice) return null;
	if (results.length === 0) return { filtered: results, removedCount: 0 };

	const oosWindowData = sliceFinderDataWindow(
		blockSlicedData,
		oosSlice,
		normalizeFinderDateRange(options.dataRangeFrom, options.dataRangeTo),
	);
	const oosData = buildFinderEvaluationData(oosWindowData, state.currentInterval, settings);
	if (oosData.length === 0) {
		return { filtered: results, removedCount: 0 };
	}

	const strategyByKey = new Map(selectedStrategies.map((item) => [item.key, item.strategy]));
	const exitCandidatesForOos = await args.resolveExitStrategyCandidates(options, selectedStrategies);
	const exitStrategyByKey = new Map((exitCandidatesForOos ?? []).map((item) => [item.key, item.strategy]));

	const report = await runCandidateOosPass({
		results,
		strategyByKey,
		exitStrategyByKey,
		settings,
		options,
		capitalSettings,
		interval: state.currentInterval,
		oosData,
		isCancelled: () => host.isCancelled(),
		onProgress: (percent, text) => host.setProgress(true, percent, text),
		yieldControl: () => host.yieldControl(),
	});

	if (!report.applied) return null;
	return { filtered: report.filtered, removedCount: report.removedCount };
}
