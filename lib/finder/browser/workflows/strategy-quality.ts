/**
 * Strategy Quality Audit scope workflow: resolves local dataset providers for
 * the requested symbols, runs the existing browser-side audit runner, sorts
 * its rows, and adopts them into the result store with audit diagnostics.
 */
import { state } from "../../../state";
import { backtestService } from "../../../backtest-service";
import { dataManager } from "../../../data-manager";
import { getLocalDailyAssets } from "../../../local-daily-datasets";
import { getBatchDatasetCacheStats, loadBatchDataset } from "../../../batch-backtest/batch-backtest-loader";
import { runStrategyQualityAudit } from "../../finder-strategy-quality";
import { buildStrategyQualityDiagnostics } from "../finder-run-diagnostics";
import type {
	FinderDiagnostics,
	FinderOptions,
} from "../../../types/finder";
import type { FinderResultStore } from "../finder-result-store";
import type { FinderRunHost } from "./finder-run-host";

export interface StrategyQualityWorkflowArgs {
	host: FinderRunHost;
	store: FinderResultStore;
	options: FinderOptions;
	startTime: number;
	getUniverseSelectedStrategies(): Promise<import("../../../finder/finder-runner").FinderSelectedStrategy[]>;
	/** Store the run diagnostics on the facade. */
	onDiagnostics(diagnostics: FinderDiagnostics | null): void;
}

export async function runStrategyQualityFinder(args: StrategyQualityWorkflowArgs): Promise<boolean> {
	const { host, store, options, startTime } = args;
	const selectedStrategies = await args.getUniverseSelectedStrategies();
	if (selectedStrategies.length === 0) {
		host.setStatus('Select at least one strategy for Strategy Quality Audit mode.');
		return false;
	}
	const symbols = options.universe?.symbols ?? [];
	if (symbols.length === 0) {
		host.setStatus('Add at least one symbol for Strategy Quality Audit mode.');
		return false;
	}
	host.setStatus('Resolving local dataset providers...');
	const providerResolutionStartedAt = performance.now();
	const localAssets = await getLocalDailyAssets();
	const universeSymbols = new Set(symbols.map((symbol) => symbol.trim().toUpperCase()));
	for (const asset of localAssets) {
		if (universeSymbols.has(asset.symbol)) {
			dataManager.setProviderOverride(asset.symbol, asset.provider);
		}
	}
	const providerResolutionMs = performance.now() - providerResolutionStartedAt;

	const qualitySettings = {
		...backtestService.getBacktestSettings(),
		exitStrategyOverrideEnabled: false,
		exitStrategyKey: undefined,
		exitStrategyParams: undefined,
	};
	const output = await runStrategyQualityAudit({
		selectedStrategies,
		symbols,
		interval: state.currentInterval,
		dataSlice: options.dataSlice ?? 'all',
		dataRangeFrom: options.dataRangeFrom,
		dataRangeTo: options.dataRangeTo,
		oosValidationEnabled: options.oosValidationEnabled === true,
		settings: qualitySettings,
		capitalSettings: backtestService.getCapitalSettings(),
		loadDataset: (symbol, interval) => loadBatchDataset(symbol, interval),
		getProvider: (symbol) => dataManager.getProvider(symbol),
		getDatasetCacheStats: () => getBatchDatasetCacheStats(),
		yieldControl: () => host.yieldControl(),
		isCancelled: () => host.isCancelled(),
		setProgress: (percent, text) => host.setProgress(true, percent, text),
		setStatus: (text) => host.setStatus(text),
	});

	const results = [...output.results].sort((a, b) =>
		b.averageExpectancy - a.averageExpectancy
		|| b.profitFactor - a.profitFactor
		|| b.activeSymbols - a.activeSymbols
		|| a.strategyName.localeCompare(b.strategyName),
	);
	store.setLatestResults({ scope: 'strategy_quality', results });
	output.performance.timingsMs.providerResolution = Number(providerResolutionMs.toFixed(2));
	const diagnostics = buildStrategyQualityDiagnostics({
		options,
		results,
		performance: output.performance,
		failedSymbolDetails: output.failedSymbolDetails,
		elapsedMs: performance.now() - startTime,
	});
	args.onDiagnostics(diagnostics);
	host.showDiagnosticsAvailability(!diagnostics);
	host.stashAndResetResort();
	host.renderLatestResults();

	if (!host.isCancelled()) {
		const oosLabel = options.oosValidationEnabled && (options.dataSlice === 'half_oldest' || options.dataSlice === 'half_newest')
			? ' | OOS included'
			: '';
		const statusPrefix = output.loadedSymbols === 0 ? 'Quality Audit failed.' : 'Quality Audit complete.';
		const diagnosticSuffix = output.failedSymbols > 0
			? ' Copy Diagnostics for load details and performance.'
			: ' Copy Diagnostics for performance.';
		host.setStatus(
			`${statusPrefix} ${results.length} strateg${results.length === 1 ? 'y' : 'ies'}, `
			+ `${output.loadedSymbols}/${symbols.length} symbols loaded${oosLabel} `
			+ `in ${Math.round(performance.now() - startTime)}ms.${diagnosticSuffix}`,
		);
	}
	return true;
}
