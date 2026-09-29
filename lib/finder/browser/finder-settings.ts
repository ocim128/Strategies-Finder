/**
 * Finder UI settings: the persisted shape, its defaults, and the pure
 * normalizers that turn arbitrary stored JSON into that shape. Browser-only.
 * Serialization itself lives in `finder-persistence.ts`; applying the state to
 * DOM stays with the controls owner in `finder-manager.ts`.
 */
import {
	FINDER_SORT_OPTIONS,
	ADVANCED_OPTIONAL_SORT_METRICS,
} from "../constants";
import {
	DEFAULT_FINDER_ASSET_OOS_HORIZONS,
	normalizeFinderAssetEvalLastBars,
	normalizeFinderAssetEvalWindowMode,
	normalizeFinderAssetOosHorizonBasis,
	normalizeFinderAssetOosBatchHoldoutRange,
	normalizeFinderAssetOosMeasurementMode,
	normalizeFinderAssetOosHorizons,
	normalizeFinderAssetOosIgnoreLastBars,
} from "../finder-asset-opportunity-oos";
import {
	normalizeFinderDataSlice,
	normalizeFinderDateInput,
} from "../finder-manager-logic";
import type {
	FinderDataSlice,
	FinderLatestResults,
	FinderMetric,
	FinderMode,
	FinderScope,
	FinderUniverseMetric,
} from "../../types/finder";

export type FinderPersistedUiState = {
	scope: FinderScope;
	currentChartSelectedStrategyKeys: string[];
	universeSelectedStrategyKeys: string[];
	sortPrimary: FinderMetric;
	sortSecondary: FinderMetric;
	useAdvancedSort: boolean;
	advancedSortOrder: FinderMetric[];
	advancedTimingSortEnabled: FinderMetric[];
	advancedOptionalSortEnabled: FinderMetric[];
	mode: FinderMode;
	dataSlice: FinderDataSlice;
	dataRangeFrom: string;
	dataRangeTo: string;
	topN: number;
	maxRuns: number;
	rangePercent: number;
	steps: number;
	freezeRiskManagement: boolean;
	randomizePathExitParams: boolean;
	exitStrategyOverrideEnabled: boolean;
	tradeFilterEnabled: boolean;
	minTrades: number;
	maxTradesText: string;
	/** IS/OOS gate toggle (only effective with a half data window). */
	oosValidationEnabled: boolean;
	universeSymbolsText: string;
	universeMinActiveSymbols: number;
	universeMinTotalTrades: number;
	universeMinProfitableActiveRatio: number;
	universeSort: FinderUniverseMetric;
	universeSortSecondary: FinderUniverseMetric;
	assetOpportunityCandidatePoolSize: number;
	assetOpportunityMinFreshSupport: number;
	assetOpportunityIncludeOpenPositions: boolean;
	assetOpportunityOosMeasurementMode: "fixed_horizon" | "next_exit";
	assetOpportunityOosHorizonBasis: "pair" | "base_only";
	assetOpportunityOosIgnoreLastBars: number;
	assetOpportunityOosHorizons: string;
	assetOpportunityEvalWindowMode: "fixed" | "range_bar";
	/** Cap the in-sample evaluation window to the last N bars; 0 = all bars. */
	assetOpportunityEvalWindowBars: number;
	/** Batch OOS holdout mode: one Asset Opportunity run per holdout value. */
	assetOpportunityOosBatchEnabled: boolean;
	assetOpportunityOosBatchStartBars: number;
	assetOpportunityOosBatchEndBars: number;
	armPerformanceHorizon: number;
	armPerformanceExcludeTopContributor: boolean;
	armPerformanceEventFilterEnabled: boolean;
	armPerformanceMinEvents: number;
	armPerformanceMaxEventsText: string;
	armPerformanceSelectionCooldownEnabled: boolean;
	armPerformanceSelectionCooldownBars: number;
};

export const DEFAULT_FINDER_UI_STATE: FinderPersistedUiState = {
	scope: "current_chart",
	currentChartSelectedStrategyKeys: [],
	universeSelectedStrategyKeys: [],
	sortPrimary: "expectancy",
	sortSecondary: "profitFactor",
	useAdvancedSort: false,
	advancedSortOrder: [...FINDER_SORT_OPTIONS],
	advancedTimingSortEnabled: [],
	advancedOptionalSortEnabled: [],
	mode: "random",
	dataSlice: "all",
	dataRangeFrom: "",
	dataRangeTo: "",
	topN: 10,
	maxRuns: 120,
	rangePercent: 555,
	steps: 3,
	freezeRiskManagement: false,
	randomizePathExitParams: false,
	exitStrategyOverrideEnabled: false,
	tradeFilterEnabled: true,
	minTrades: 40,
	maxTradesText: "",
	oosValidationEnabled: false,
	universeSymbolsText: "",
	universeMinActiveSymbols: 2,
	universeMinTotalTrades: 40,
	universeMinProfitableActiveRatio: 0.5,
	universeSort: "robustUniverseScore",
	universeSortSecondary: "windowStabilityScore",
	assetOpportunityCandidatePoolSize: 10,
	assetOpportunityMinFreshSupport: 2,
	assetOpportunityIncludeOpenPositions: false,
	assetOpportunityOosMeasurementMode: "fixed_horizon",
	assetOpportunityOosHorizonBasis: "pair",
	assetOpportunityOosIgnoreLastBars: 0,
	assetOpportunityOosHorizons: DEFAULT_FINDER_ASSET_OOS_HORIZONS.join(","),
	assetOpportunityEvalWindowMode: "fixed",
	assetOpportunityEvalWindowBars: 0,
	assetOpportunityOosBatchEnabled: false,
	assetOpportunityOosBatchStartBars: 1,
	assetOpportunityOosBatchEndBars: 5,
	armPerformanceHorizon: 5,
	armPerformanceExcludeTopContributor: false,
	armPerformanceEventFilterEnabled: false,
	armPerformanceMinEvents: 1,
	armPerformanceMaxEventsText: "",
	armPerformanceSelectionCooldownEnabled: false,
	armPerformanceSelectionCooldownBars: 5,
};

export const UNIVERSE_SORT_OPTIONS: readonly FinderUniverseMetric[] = [
    "robustUniverseScore",
    "windowStabilityScore",
    "profitableActiveRatio",
    "averageWinRate",
    "tradeWeightedWinRate",
    "winReliabilityQ25",
    "medianExpectancy",
    "medianExpectancyWeightedTrades",
    "medianSharpe",
    "medianProfitFactor",
    "medianProfitFactorWeightedTrades",
    "medianCompositeEdgeRatio",
    "medianExitAlpha",
    "worstMaxDrawdownPercent",
    "medianMaxDrawdownPercent",
    "medianReturnDrawdownRatio",
    "worstNetProfit",
    "totalTrades",
    "activeSymbols",
] as const;
const TIMING_SORT_METRICS: readonly FinderMetric[] = ["entryScore", "exitScore"];

export function isTimingSortMetric(value: unknown): value is FinderMetric {
	return TIMING_SORT_METRICS.includes(value as FinderMetric);
}

export function isAdvancedOptionalSortMetric(value: unknown): value is FinderMetric {
	return ADVANCED_OPTIONAL_SORT_METRICS.includes(value as FinderMetric);
}

function normalizeStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const unique = new Set<string>();
	for (const entry of value) {
		if (typeof entry !== "string") {
			continue;
		}
		const normalized = entry.trim();
		if (normalized) {
			unique.add(normalized);
		}
	}
	return [...unique];
}

export function normalizeFinderScope(value: unknown): FinderScope {
	return value === "symbol_universe" || value === "asset_opportunity" || value === "strategy_quality" || value === "arm_performance"
		? value
		: "current_chart";
}

export function emptyFinderLatestResults(scope: FinderScope): FinderLatestResults {
	switch (scope) {
		case 'symbol_universe': return { scope, results: [] };
		case 'asset_opportunity': return { scope, results: [] };
		case 'strategy_quality': return { scope, results: [] };
		case 'arm_performance': return { scope, results: [], runContext: null, inventoryComplete: true };
		default: return { scope: 'current_chart', results: [] };
	}
}

export function normalizeFinderUniverseMetric(
	value: unknown,
	fallback: FinderUniverseMetric
): FinderUniverseMetric {
	return UNIVERSE_SORT_OPTIONS.includes(value as FinderUniverseMetric)
		? value as FinderUniverseMetric
		: fallback;
}

export function normalizeFinderMetric(value: unknown, fallback: FinderMetric): FinderMetric {
	return FINDER_SORT_OPTIONS.includes(value as FinderMetric)
		? value as FinderMetric
		: fallback;
}

export function normalizeFinderMode(value: unknown): FinderMode {
	return value === "grid" || value === "genetic" ? value : "random";
}

function normalizeNumber(value: unknown, fallback: number, min: number): number {
	if (typeof value !== "number" && typeof value !== "string") {
		return fallback;
	}
	if (typeof value === "string" && value.trim() === "") {
		return fallback;
	}
	const numeric = Number(value);
	return Number.isFinite(numeric) ? Math.max(min, numeric) : fallback;
}

function normalizeOptionalNumberText(value: unknown): string {
	if (typeof value !== "string") {
		return "";
	}
	const trimmed = value.trim();
	if (!trimmed) {
		return "";
	}
	const numeric = Number(trimmed);
	return Number.isFinite(numeric) && numeric >= 0 ? trimmed : "";
}

export function normalizeAdvancedSortOrder(value: unknown): FinderMetric[] {
	const order = Array.isArray(value)
		? value
			.filter((entry): entry is FinderMetric => FINDER_SORT_OPTIONS.includes(entry as FinderMetric))
			.filter((entry, index, entries) => entries.indexOf(entry) === index)
		: [];
	const missing = FINDER_SORT_OPTIONS.filter((metric) => !order.includes(metric));
	return [...order, ...missing];
}

function normalizeTimingSortMetrics(value: unknown): FinderMetric[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value
		.filter((metric): metric is FinderMetric => isTimingSortMetric(metric))
		.filter((metric, index, metrics) => metrics.indexOf(metric) === index);
}

function normalizeAdvancedOptionalSortMetrics(value: unknown): FinderMetric[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((metric): metric is FinderMetric => isAdvancedOptionalSortMetric(metric))
		.filter((metric, index, metrics) => metrics.indexOf(metric) === index);
}

export function normalizeFinderUiState(raw: unknown): FinderPersistedUiState {
	const source = raw && typeof raw === "object" && !Array.isArray(raw)
		? raw as Record<string, unknown>
		: {};
	const minActiveSymbols = typeof source.universeMinActiveSymbols === "number"
		? Math.max(1, Math.round(source.universeMinActiveSymbols))
		: DEFAULT_FINDER_UI_STATE.universeMinActiveSymbols;
	const minTotalTrades = typeof source.universeMinTotalTrades === "number"
		? Math.max(0, Math.round(source.universeMinTotalTrades))
		: DEFAULT_FINDER_UI_STATE.universeMinTotalTrades;
	const minProfitableActiveRatio = typeof source.universeMinProfitableActiveRatio === "number"
		? Math.max(0, Math.min(1, source.universeMinProfitableActiveRatio))
		: DEFAULT_FINDER_UI_STATE.universeMinProfitableActiveRatio;
	const assetOpportunityCandidatePoolSize = typeof source.assetOpportunityCandidatePoolSize === "number"
		? Math.max(1, Math.min(50, Math.round(source.assetOpportunityCandidatePoolSize)))
		: DEFAULT_FINDER_UI_STATE.assetOpportunityCandidatePoolSize;
	const assetOpportunityMinFreshSupport = typeof source.assetOpportunityMinFreshSupport === "number"
		? Math.max(1, Math.min(50, Math.round(source.assetOpportunityMinFreshSupport)))
		: DEFAULT_FINDER_UI_STATE.assetOpportunityMinFreshSupport;
	const assetOpportunityOosMeasurementMode = normalizeFinderAssetOosMeasurementMode(
		source.assetOpportunityOosMeasurementMode,
	);
	const assetOpportunityOosHorizonBasis = normalizeFinderAssetOosHorizonBasis(
		source.assetOpportunityOosHorizonBasis,
	);
	const assetOpportunityOosIgnoreLastBars = normalizeFinderAssetOosIgnoreLastBars(
		source.assetOpportunityOosIgnoreLastBars,
	);
	const assetOpportunityOosHorizons = normalizeFinderAssetOosHorizons(
		source.assetOpportunityOosHorizons,
	).join(",");
	const assetOpportunityEvalWindowBars = normalizeFinderAssetEvalLastBars(
		source.assetOpportunityEvalWindowBars,
	);
	const assetOpportunityEvalWindowMode = normalizeFinderAssetEvalWindowMode(
		source.assetOpportunityEvalWindowMode,
	);
	const batchRange = normalizeFinderAssetOosBatchHoldoutRange(
		source.assetOpportunityOosBatchStartBars,
		source.assetOpportunityOosBatchEndBars,
	);

	return {
		scope: normalizeFinderScope(source.scope),
		currentChartSelectedStrategyKeys: normalizeStringArray(source.currentChartSelectedStrategyKeys),
		universeSelectedStrategyKeys: (() => {
			const normalized = normalizeStringArray(source.universeSelectedStrategyKeys);
			if (normalized.length > 0) {
				return normalized;
			}
			if (typeof source.universeSelectedStrategyKey === "string" && source.universeSelectedStrategyKey.trim()) {
				return [source.universeSelectedStrategyKey.trim()];
			}
			return [];
		})(),
		sortPrimary: normalizeFinderMetric(source.sortPrimary, DEFAULT_FINDER_UI_STATE.sortPrimary),
		sortSecondary: normalizeFinderMetric(source.sortSecondary, DEFAULT_FINDER_UI_STATE.sortSecondary),
		useAdvancedSort: source.useAdvancedSort === true,
		advancedSortOrder: normalizeAdvancedSortOrder(source.advancedSortOrder),
		advancedTimingSortEnabled: normalizeTimingSortMetrics(source.advancedTimingSortEnabled),
		advancedOptionalSortEnabled: normalizeAdvancedOptionalSortMetrics(source.advancedOptionalSortEnabled),
		mode: normalizeFinderMode(source.mode),
		dataSlice: normalizeFinderDataSlice(source.dataSlice),
		dataRangeFrom: normalizeFinderDateInput(source.dataRangeFrom) ?? "",
		dataRangeTo: normalizeFinderDateInput(source.dataRangeTo) ?? "",
		topN: Math.round(normalizeNumber(source.topN, DEFAULT_FINDER_UI_STATE.topN, 1)),
		maxRuns: Math.round(normalizeNumber(source.maxRuns, DEFAULT_FINDER_UI_STATE.maxRuns, 1)),
		rangePercent: normalizeNumber(source.rangePercent, DEFAULT_FINDER_UI_STATE.rangePercent, 0),
		steps: Math.round(normalizeNumber(source.steps, DEFAULT_FINDER_UI_STATE.steps, 2)),
		freezeRiskManagement: source.freezeRiskManagement === true,
		randomizePathExitParams: source.randomizePathExitParams === true,
		exitStrategyOverrideEnabled: source.exitStrategyOverrideEnabled === true,
		tradeFilterEnabled: source.tradeFilterEnabled !== false,
		minTrades: Math.round(normalizeNumber(source.minTrades, DEFAULT_FINDER_UI_STATE.minTrades, 0)),
		maxTradesText: normalizeOptionalNumberText(source.maxTradesText),
		oosValidationEnabled: source.oosValidationEnabled === true,
		universeSymbolsText: typeof source.universeSymbolsText === "string" ? source.universeSymbolsText : "",
		universeMinActiveSymbols: minActiveSymbols,
		universeMinTotalTrades: minTotalTrades,
		universeMinProfitableActiveRatio: minProfitableActiveRatio,
		universeSort: normalizeFinderUniverseMetric(source.universeSort, DEFAULT_FINDER_UI_STATE.universeSort),
		universeSortSecondary: normalizeFinderUniverseMetric(source.universeSortSecondary, DEFAULT_FINDER_UI_STATE.universeSortSecondary),
		assetOpportunityCandidatePoolSize,
		assetOpportunityMinFreshSupport,
		assetOpportunityIncludeOpenPositions: source.assetOpportunityIncludeOpenPositions === true,
		assetOpportunityOosMeasurementMode,
		assetOpportunityOosHorizonBasis,
		assetOpportunityOosIgnoreLastBars,
		assetOpportunityOosHorizons,
		assetOpportunityEvalWindowMode,
		assetOpportunityEvalWindowBars,
		assetOpportunityOosBatchEnabled: source.assetOpportunityOosBatchEnabled === true,
		assetOpportunityOosBatchStartBars: batchRange.error === null
			? batchRange.start
			: DEFAULT_FINDER_UI_STATE.assetOpportunityOosBatchStartBars,
		assetOpportunityOosBatchEndBars: batchRange.error === null
			? batchRange.end
			: DEFAULT_FINDER_UI_STATE.assetOpportunityOosBatchEndBars,
		armPerformanceHorizon: Math.max(1, Math.min(1_000, Math.round(normalizeNumber(
			source.armPerformanceHorizon,
			DEFAULT_FINDER_UI_STATE.armPerformanceHorizon,
			1,
		)))),
		armPerformanceExcludeTopContributor: source.armPerformanceExcludeTopContributor === true,
		armPerformanceEventFilterEnabled: source.armPerformanceEventFilterEnabled === true,
		armPerformanceMinEvents: Math.max(1, Math.min(1_000_000, Math.round(normalizeNumber(
			source.armPerformanceMinEvents,
			DEFAULT_FINDER_UI_STATE.armPerformanceMinEvents,
			1,
		)))),
		armPerformanceMaxEventsText: normalizeOptionalNumberText(source.armPerformanceMaxEventsText),
		armPerformanceSelectionCooldownEnabled: source.armPerformanceSelectionCooldownEnabled === true,
		armPerformanceSelectionCooldownBars: Math.max(1, Math.min(10_000, Math.round(normalizeNumber(
			source.armPerformanceSelectionCooldownBars,
			DEFAULT_FINDER_UI_STATE.armPerformanceSelectionCooldownBars,
			1,
		)))),
	};
}
