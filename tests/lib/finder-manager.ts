import { StrategyParams, type OHLCVData } from "./strategies/index";
import { strategyRegistry, getStrategyList, loadBuiltInStrategyByKey, getStrategyKind, getStrategyKindTitle } from "../strategyRegistry";
import { state } from "./state";
import { backtestService } from "./backtest-service";
import { paramManager } from "./param-manager";
import { uiManager } from "./ui-manager";
import { setVisible } from "./dom-utils";
import { dataManager } from "./data-manager";
import { settingsManager } from "./settings-manager";
import { readPersistedJson, writePersistedJson } from "./persisted-json";
import { MAJOR_SYMBOLS } from "./portfolioLab/portfolio-lab-types";
import { getLocalDailyAssets, type LocalDailyAsset } from "./local-daily-datasets";
import { cloneJsonCompatible } from "./json-utils";

import { FINDER_SORT_OPTIONS, METRIC_FULL_LABELS, UNIVERSE_METRIC_FULL_LABELS } from "./finder/constants";
import { buildFinderEvaluationData, runFinderExecution, type FinderSelectedStrategy } from "./finder/finder-runner";
import { runFinderUniverseExecution } from "./finder/finder-runner-universe";
import { FinderParamSpace } from "./finder/finder-param-space";
import { FinderUI } from "./finder/finder-ui";
import {
	buildFinderOptions,
	buildFinderUniverseOptions,
	normalizeFinderDataSlice,
	resolveFinderPolymarketExitMode,
	sliceFinderDataWindow,
} from "./finder/finder-manager-logic";
import { sortFinderResults } from "./finder/finder-engine";
import { mergeFinderRiskParamsIntoBacktestSettings } from "./finder/finder-runner-core";
import { sortFinderUniverseCandidates } from "./finder/finder-universe-metrics";
import {
	buildFinderDiagnostics,
	buildCompactFinderDiagnostics,
	createEmptyFinderDiagnosticsTimings,
	createFinderRunId,
} from "./finder/finder-diagnostics";
import { debugLogger } from "./debug-logger";
import { parseInputNumber } from "./dom-input-readers";
import { sliceOhlcvByBlock } from "./block-selector";
import { strategyPanelController } from "./strategy-panel-controller";
import { setCurrentInterval, setCurrentStrategyKey } from "./state-actions";
import { createTaskYielder } from "./task-yield";
import { resolveCrossSymbolSecondaryForStrategy } from "./cross-symbol-runtime";
import {
	createFinderManagerDom,
	type FinderManagerDom,
} from "./finder/finder-manager-dom";
import type {
	FinderLatestResults,
	FinderDiagnostics,
	FinderMetric,
	FinderMode,
	FinderDataSlice,
	FinderOptions,
	FinderScope,
	PolymarketFinderRankMode,
	FinderResult,
	FinderUniverseCandidate,
	FinderUniverseMetric,
	FinderFailureDiagnostics,
	FinderStrategyDiagnostics,
} from './types/finder';
import { isSmartTradeSizingMode } from "./types/backtest";
import { buildSyntheticPairFromLegs, deriveSyntheticSymbol, pickSourceInterval } from "../scripts/lib/synthetic-pair";
import { SYNTHETIC_TARGET_BARS, DATA_CHART_TOTAL_LIMIT } from "./data/constants";

const QUOTE_SUFFIXES = ['USDT', 'BUSD', 'USDC', 'FDUSD', 'TUSD', 'BTC', 'ETH', 'BNB', 'EUR', 'TRY', 'BRL'];
const FINDER_FOLLOW_STRATEGY_KEYS = [
	"decay_momentum_alignment",
	"volatility_regime_median_alignment",
	"initiative_pressure_acceleration_follow",
	"volatility_breakout_follow",
	"accumulation_persistence_streak_gate",
] as const;
const FINDER_REVERSION_STRATEGY_KEYS = [
	"decay_pressure_percentile_reversion",
	"cumulative_return_zscore_reversion",
	"cumulative_return_percentile_reversion",
	"acceptance_deviation_median_reversion",
	"negative_autocorrelation_median_reversion",
	"range_expansion_exhaustion_reversion",
	"probability_boundary_eigen_shift",
] as const;
type FinderStrategyPreset = "follow" | "reversion" | "custom";

function sameStrategySet(keys: readonly string[], preset: readonly string[]): boolean {
	if (keys.length !== preset.length) {
		return false;
	}
	const selected = new Set(keys);
	return preset.every((key) => selected.has(key));
}

function resolveFinderStrategyPreset(keys: readonly string[]): FinderStrategyPreset {
	if (sameStrategySet(keys, FINDER_FOLLOW_STRATEGY_KEYS)) {
		return "follow";
	}
	if (sameStrategySet(keys, FINDER_REVERSION_STRATEGY_KEYS)) {
		return "reversion";
	}
	return "custom";
}

function resolveToBinanceSymbol(token: string): string {
	const upper = token.toUpperCase();
	if (QUOTE_SUFFIXES.some((s) => upper.endsWith(s) && upper.length > s.length)) {
		return upper;
	}
	return `${upper}USDT`;
}

export function parseSyntheticPairToken(symbol: string): { baseSymbol: string; quoteSymbol: string } | null {
	const plusIdx = symbol.indexOf('+');
	if (plusIdx < 1 || plusIdx === symbol.length - 1) return null;
	const baseRaw = symbol.slice(0, plusIdx).trim().toUpperCase();
	const quoteRaw = symbol.slice(plusIdx + 1).trim().toUpperCase();
	if (!baseRaw || !quoteRaw) return null;
	return {
		baseSymbol: resolveToBinanceSymbol(baseRaw),
		quoteSymbol: resolveToBinanceSymbol(quoteRaw),
	};
}

interface UniverseDatasetWindowStats {
	symbol: string;
	loadedBars: number;
	slicedBars: number;
	firstTime?: OHLCVData["time"];
	lastTime?: OHLCVData["time"];
	synthetic: boolean;
}

type UniverseDataWindowDiagnostics = NonNullable<FinderDiagnostics["universe"]>["dataWindow"];

import { isSameEventPolymarketExitMode } from "./polymarket-exit-mode";
import { resolvePolymarketDomSettings } from "./polymarket-dom-reader";
import {
	clampPolymarketPostSignalLimitEntryPriceCents,
	clampPolymarketPostSignalLimitExitPriceCents,
	clampPolymarketPostSignalLimitOffsetCents,
	resolvePolymarketPostSignalLimitEntryMode,
	resolvePolymarketPostSignalLimitExitMode,
} from "./polymarket-post-signal-limit-entry";
import { finderSortRequiresTradeTimingQuality } from "./trade-timing-quality";
import { isSecondMarketPolymarketSupported } from "./second-market/evaluation";

type FinderPersistedUiState = {
	scope: FinderScope;
	currentChartSelectedStrategyKeys: string[];
	universeSelectedStrategyKeys: string[];
	sortPrimary: FinderMetric;
	sortSecondary: FinderMetric;
	useAdvancedSort: boolean;
	advancedSortOrder: FinderMetric[];
	advancedTimingSortEnabled: FinderMetric[];
	mode: FinderMode;
	dataSlice: FinderDataSlice;
	topN: number;
	maxRuns: number;
	rangePercent: number;
	steps: number;
	freezeRiskManagement: boolean;
	exitStrategyOverrideEnabled: boolean;
	tradeFilterEnabled: boolean;
	minTrades: number;
	maxTradesText: string;
	polymarketScoringEnabled: boolean;
	polymarketRankMode: PolymarketFinderRankMode;
	polymarketMinScoredPredictions: number;
	polymarketLockOffset: boolean;
	polymarketAfterTakeProfitOnly: boolean;
	universeSymbolsText: string;
	universeMinActiveSymbols: number;
	universeMinTotalTrades: number;
	universeMinProfitableActiveRatio: number;
	universeSort: FinderUniverseMetric;
	universeSortSecondary: FinderUniverseMetric;
};

const FINDER_UI_STORAGE = {
	key: "playground_finder_ui",
	schema: "finder.ui",
	version: 1,
} as const;

const DEFAULT_FINDER_UI_STATE: FinderPersistedUiState = {
	scope: "current_chart",
	currentChartSelectedStrategyKeys: [],
	universeSelectedStrategyKeys: [],
	sortPrimary: "expectancy",
	sortSecondary: "profitFactor",
	useAdvancedSort: false,
	advancedSortOrder: [...FINDER_SORT_OPTIONS],
	advancedTimingSortEnabled: [],
	mode: "random",
	dataSlice: "all",
	topN: 10,
	maxRuns: 120,
	rangePercent: 555,
	steps: 3,
	freezeRiskManagement: false,
	exitStrategyOverrideEnabled: false,
	tradeFilterEnabled: true,
	minTrades: 40,
	maxTradesText: "",
	polymarketScoringEnabled: false,
	polymarketRankMode: "balanced",
	polymarketMinScoredPredictions: 100,
	polymarketLockOffset: false,
	polymarketAfterTakeProfitOnly: false,
	universeSymbolsText: "",
	universeMinActiveSymbols: 2,
	universeMinTotalTrades: 40,
	universeMinProfitableActiveRatio: 0.5,
	universeSort: "profitableActiveRatio",
	universeSortSecondary: "medianExpectancy",
};

const UNIVERSE_SORT_OPTIONS: readonly FinderUniverseMetric[] = [
    "profitableActiveRatio",
    "medianExpectancy",
    "medianSharpe",
    "medianProfitFactor",
    "worstNetProfit",
    "totalTrades",
    "activeSymbols",
] as const;
const UNIVERSE_DATASET_CACHE_MAX_ENTRIES = 512;
// Synthetic universe runs reuse the same source symbols (e.g. BNBUSDT 1m) across
// many pairs. A typical universe has <50 unique source symbols, so a small LRU
// is enough to dedup 200+ source reads down to the unique set per run.
const SYNTHETIC_SOURCE_SERIES_CACHE_MAX_ENTRIES = 64;
const TIMING_SORT_METRICS: readonly FinderMetric[] = ["entryScore", "exitScore"];

function isTimingSortMetric(value: unknown): value is FinderMetric {
	return TIMING_SORT_METRICS.includes(value as FinderMetric);
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

function normalizeFinderScope(value: unknown): FinderScope {
	return value === "symbol_universe" ? "symbol_universe" : "current_chart";
}

function normalizeFinderUniverseMetric(
	value: unknown,
	fallback: FinderUniverseMetric
): FinderUniverseMetric {
	return UNIVERSE_SORT_OPTIONS.includes(value as FinderUniverseMetric)
		? value as FinderUniverseMetric
		: fallback;
}

function normalizeFinderMetric(value: unknown, fallback: FinderMetric): FinderMetric {
	return FINDER_SORT_OPTIONS.includes(value as FinderMetric)
		? value as FinderMetric
		: fallback;
}

function normalizeFinderMode(value: unknown): FinderMode {
	return value === "grid" || value === "genetic" ? value : "random";
}

function normalizePolymarketRankMode(value: unknown): PolymarketFinderRankMode {
	return value === "accuracy"
		|| value === "accuracyTrades"
		|| value === "expectancy"
		|| value === "expectancyTrades"
		|| value === "profitFactor"
		|| value === "profitFactorTrades"
		|| value === "sizedNet"
		|| value === "volume"
		? value
		: "balanced";
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

function normalizeAdvancedSortOrder(value: unknown): FinderMetric[] {
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

function normalizeFinderUiState(raw: unknown): FinderPersistedUiState {
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
		mode: normalizeFinderMode(source.mode),
		dataSlice: normalizeFinderDataSlice(source.dataSlice),
		topN: Math.round(normalizeNumber(source.topN, DEFAULT_FINDER_UI_STATE.topN, 1)),
		maxRuns: Math.round(normalizeNumber(source.maxRuns, DEFAULT_FINDER_UI_STATE.maxRuns, 1)),
		rangePercent: normalizeNumber(source.rangePercent, DEFAULT_FINDER_UI_STATE.rangePercent, 0),
		steps: Math.round(normalizeNumber(source.steps, DEFAULT_FINDER_UI_STATE.steps, 2)),
		freezeRiskManagement: source.freezeRiskManagement === true,
		exitStrategyOverrideEnabled: source.exitStrategyOverrideEnabled === true,
		tradeFilterEnabled: source.tradeFilterEnabled !== false,
		minTrades: Math.round(normalizeNumber(source.minTrades, DEFAULT_FINDER_UI_STATE.minTrades, 0)),
		maxTradesText: normalizeOptionalNumberText(source.maxTradesText),
		polymarketScoringEnabled: source.polymarketScoringEnabled === true,
		polymarketRankMode: normalizePolymarketRankMode(source.polymarketRankMode),
		polymarketMinScoredPredictions: Math.round(normalizeNumber(source.polymarketMinScoredPredictions, DEFAULT_FINDER_UI_STATE.polymarketMinScoredPredictions, 0)),
		polymarketLockOffset: source.polymarketLockOffset === true,
		polymarketAfterTakeProfitOnly: source.polymarketAfterTakeProfitOnly === true,
		universeSymbolsText: typeof source.universeSymbolsText === "string" ? source.universeSymbolsText : "",
		universeMinActiveSymbols: minActiveSymbols,
		universeMinTotalTrades: minTotalTrades,
		universeMinProfitableActiveRatio: minProfitableActiveRatio,
		universeSort: normalizeFinderUniverseMetric(source.universeSort, DEFAULT_FINDER_UI_STATE.universeSort),
		universeSortSecondary: normalizeFinderUniverseMetric(source.universeSortSecondary, DEFAULT_FINDER_UI_STATE.universeSortSecondary),
	};
}

export class FinderManager {
	private isRunning = false;
	private isCancelled = false;
	private latestResults: FinderLatestResults = { scope: "current_chart", results: [] };
	private latestDiagnostics: FinderDiagnostics | null = null;
	private lastFinderRunBacktestSettings: ReturnType<typeof settingsManager.getBacktestSettings> | null = null;
	private lastFinderOptions: FinderOptions | null = null;
	private lastFinderEvaluationData: { interval: string; data: OHLCVData[] } | null = null;
	private strategyToggles: Map<string, HTMLInputElement> = new Map();
	private strategyItems: Map<string, HTMLDivElement> = new Map();
	private strategyOrder: string[] = [];
	private lastStrategyToggleKey: string | null = null;
	private uiState: FinderPersistedUiState = normalizeFinderUiState(null);
	private readonly ui = new FinderUI();
	private readonly paramSpace = new FinderParamSpace();
	private readonly taskYielder = createTaskYielder();
	private dom: FinderManagerDom | null = null;
	private localDailyAssetMapPromise: Promise<Map<string, LocalDailyAsset>> | null = null;
	private readonly universeDatasetCache = new Map<string, Promise<OHLCVData[]>>();
	private readonly syntheticSourceSeriesCache = new Map<string, Promise<OHLCVData[]>>();

	private getDom(): FinderManagerDom {
		return this.dom ??= createFinderManagerDom();
	}

	private getScope(): FinderScope {
		return this.uiState.scope;
	}

	private isUniverseScope(): boolean {
		return this.getScope() === "symbol_universe";
	}

	private loadUiState(): void {
		this.uiState = readPersistedJson<FinderPersistedUiState>({
			...FINDER_UI_STORAGE,
			fallback: { ...DEFAULT_FINDER_UI_STATE },
			migrate: ({ data }) => normalizeFinderUiState(data),
			onError: (error) => {
				debugLogger.error("finder.ui_state_load_failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			},
		});
	}

	private saveUiState(): void {
		writePersistedJson({
			...FINDER_UI_STORAGE,
			data: this.uiState,
			onError: (error) => {
				debugLogger.error("finder.ui_state_save_failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			},
		});
	}

	private parseUniverseSymbols(rawText = this.getDom().finderUniverseSymbols.value): string[] {
		const unique = new Set<string>();
		for (const token of rawText.split(/[\s,]+/)) {
			const normalized = token.trim().toUpperCase();
			if (normalized) {
				unique.add(normalized);
			}
		}
		return [...unique];
	}

	private updateUniverseSummary(): void {
		const dom = this.getDom();
		const symbols = this.parseUniverseSymbols(dom.finderUniverseSymbols.value);
		dom.finderUniverseSummary.textContent = `${symbols.length} symbol${symbols.length === 1 ? "" : "s"}`;
	}

	private getLocalDailyAssetMap(): Promise<Map<string, LocalDailyAsset>> {
		if (!this.localDailyAssetMapPromise) {
			this.localDailyAssetMapPromise = getLocalDailyAssets().then((assets) => {
				const bySymbol = new Map<string, LocalDailyAsset>();
				for (const asset of assets) {
					const symbol = asset.symbol.trim().toUpperCase();
					if (symbol && !bySymbol.has(symbol)) {
						bySymbol.set(symbol, asset);
					}
				}
				return bySymbol;
			});
		}
		return this.localDailyAssetMapPromise;
	}

	private async prepareUniverseSymbolProvider(symbol: string): Promise<void> {
		const normalizedSymbol = symbol.trim().toUpperCase();
		if (!normalizedSymbol) return;

		const localDailyAssets = await this.getLocalDailyAssetMap();
		const asset = localDailyAssets.get(normalizedSymbol);
		if (asset) {
			dataManager.setProviderOverride(normalizedSymbol, asset.provider);
		}
	}

	private buildUniverseDatasetCacheKey(symbol: string, interval: string): string {
		const normalizedSymbol = symbol.trim().toUpperCase();
		const normalizedInterval = interval.trim().toLowerCase();
		const provider = dataManager.getProvider(normalizedSymbol);
		const lookbackBars = dataManager.getChartLookbackBars() ?? "all";
		return `${provider}|${normalizedSymbol}|${normalizedInterval}|${lookbackBars}`;
	}

	private setUniverseDatasetCache(key: string, promise: Promise<OHLCVData[]>): void {
		if (this.universeDatasetCache.has(key)) {
			this.universeDatasetCache.delete(key);
		}
		this.universeDatasetCache.set(key, promise);
		while (this.universeDatasetCache.size > UNIVERSE_DATASET_CACHE_MAX_ENTRIES) {
			const oldestKey = this.universeDatasetCache.keys().next().value;
			if (!oldestKey) break;
			this.universeDatasetCache.delete(oldestKey);
		}
	}

	private async loadUniverseDataset(symbol: string, interval: string, signal?: AbortSignal) {
		const synthParts = parseSyntheticPairToken(symbol);
		if (synthParts) {
			return this.loadSyntheticPairForUniverse(synthParts.baseSymbol, synthParts.quoteSymbol, interval, signal);
		}
		await this.prepareUniverseSymbolProvider(symbol);
		const cacheKey = this.buildUniverseDatasetCacheKey(symbol, interval);
		const cached = this.universeDatasetCache.get(cacheKey);
		if (cached) {
			debugLogger.event("finder.universe_dataset_cache_hit", { symbol, interval, cacheKey });
			this.setUniverseDatasetCache(cacheKey, cached);
			return cached;
		}
		debugLogger.event("finder.universe_dataset_cache_miss", { symbol, interval, cacheKey });

		let promise: Promise<OHLCVData[]>;
		promise = dataManager.fetchDataDetached(symbol, interval, { signal, offline: true })
			.then((data) => {
				if (signal?.aborted || !Array.isArray(data) || data.length === 0) {
					if (this.universeDatasetCache.get(cacheKey) === promise) {
						this.universeDatasetCache.delete(cacheKey);
					}
				}
				return data;
			})
			.catch((error) => {
				if (this.universeDatasetCache.get(cacheKey) === promise) {
					this.universeDatasetCache.delete(cacheKey);
				}
				throw error;
			});
		this.setUniverseDatasetCache(cacheKey, promise);
		return promise;
	}

	private buildSyntheticUniverseCacheKey(args: {
		syntheticSymbol: string;
		baseSymbol: string;
		quoteSymbol: string;
		interval: string;
		sourceInterval: string;
		sourceBars: number;
	}): string {
		const normalizedBase = args.baseSymbol.trim().toUpperCase();
		const normalizedQuote = args.quoteSymbol.trim().toUpperCase();
		const normalizedSymbol = args.syntheticSymbol.trim().toUpperCase();
		const normalizedInterval = args.interval.trim().toLowerCase();
		const normalizedSourceInterval = args.sourceInterval.trim().toLowerCase();
		const provider = dataManager.getProvider(normalizedSymbol);
		return `${provider}|${normalizedSymbol}|${normalizedBase}|${normalizedQuote}|${normalizedInterval}|${normalizedSourceInterval}|${args.sourceBars}|synthetic`;
	}

	private getSourceSeriesForSynthetic(
		sourceSymbol: string,
		sourceInterval: string,
		sourceBars: number,
		signal?: AbortSignal,
	): Promise<OHLCVData[]> {
		// Synthetic universe pairs reuse the same source symbols (e.g. BNBUSDT 1m)
		// across many pairs. Without this cache, BNBUSDT 1m would be re-read once
		// per pair that references it (up to ~15x in a typical universe). The
		// source arrays are treated as read-only by buildSyntheticPairDataset and
		// aggregateSyntheticBars, so sharing is safe.
		//
		// Note: unlike loadUniverseDataset for real symbols, the source fetch here
		// intentionally does NOT pass offline:true. The source interval (e.g. 5m
		// for a 1h target) is a derived interval the user may never have loaded,
		// so an offline-only read would return whatever stray bars the local
		// cache holds and produce a degenerate 1-bar synthetic pair. Allowing the
		// remote Binance gap-fill here matches the Data Mining synthetic generator
		// and the original universe synthetic loader. The LRU cache above means
		// each unique source symbol is fetched at most once per run.
		const cacheKey = `${sourceSymbol.trim().toUpperCase()}|${sourceInterval.trim().toLowerCase()}|${sourceBars}`;
		const cached = this.syntheticSourceSeriesCache.get(cacheKey);
		if (cached) {
			debugLogger.event("finder.synthetic_source_cache_hit", { sourceSymbol, sourceInterval, sourceBars });
			return cached;
		}
		const promise = dataManager
			.fetchHistoricalData(sourceSymbol, sourceInterval, sourceBars, { signal })
			.catch((error) => {
				if (this.syntheticSourceSeriesCache.get(cacheKey) === promise) {
					this.syntheticSourceSeriesCache.delete(cacheKey);
				}
				throw error;
			});
		this.syntheticSourceSeriesCache.set(cacheKey, promise);
		while (this.syntheticSourceSeriesCache.size > SYNTHETIC_SOURCE_SERIES_CACHE_MAX_ENTRIES) {
			const oldestKey = this.syntheticSourceSeriesCache.keys().next().value;
			if (!oldestKey) break;
			this.syntheticSourceSeriesCache.delete(oldestKey);
		}
		return promise;
	}

	private async loadSyntheticPairForUniverse(
		baseSymbol: string,
		quoteSymbol: string,
		interval: string,
		signal?: AbortSignal,
	): Promise<OHLCVData[]> {
		const syntheticSymbol = deriveSyntheticSymbol(baseSymbol, quoteSymbol);
		const source = pickSourceInterval(interval);
		const sourceInterval = source?.sourceInterval ?? interval;
		// Cap source bars at DATA_CHART_TOTAL_LIMIT (100k). The synthetic source
		// interval is a derived interval the user may not have pre-warmed, so the
		// read often has to gap-fill from Binance; capping keeps the paginated
		// remote fetch bounded (the original universe synthetic loader used this
		// same cap before the SYNTHETIC_SOURCE_BARS_LIMIT inflation regressed it).
		const sourceBars = Math.min(SYNTHETIC_TARGET_BARS * (source?.ratio ?? 1), DATA_CHART_TOTAL_LIMIT);
		const cacheKey = this.buildSyntheticUniverseCacheKey({
			syntheticSymbol,
			baseSymbol,
			quoteSymbol,
			interval,
			sourceInterval,
			sourceBars,
		});
		const cached = this.universeDatasetCache.get(cacheKey);
		if (cached) {
			debugLogger.event("finder.synthetic_universe_cache_hit", {
				syntheticSymbol,
				baseSymbol,
				quoteSymbol,
				interval,
				sourceInterval,
				sourceBars,
			});
			this.setUniverseDatasetCache(cacheKey, cached);
			return cached;
		}
		debugLogger.event("finder.synthetic_universe_cache_miss", {
			syntheticSymbol,
			baseSymbol,
			quoteSymbol,
			interval,
			sourceInterval,
			sourceBars,
		});

		let promise: Promise<OHLCVData[]>;
		promise = (async () => {
			if (signal?.aborted) return [];
			// The pipeline (pick source -> fetch legs -> align -> aggregate)
			// is centralized in buildSyntheticPairFromLegs so every synthetic
			// consumer stays in lockstep. This callsite keeps two local
			// variations: the source-bars cap below (kept bounded because the
			// derived source interval often forces a remote Binance gap-fill),
			// and getSourceSeriesForSynthetic as the fetchLeg so BNBUSDT 1m is
			// reused ~15x rather than re-read per pair.
			const result = await buildSyntheticPairFromLegs({
				baseSymbol,
				quoteSymbol,
				interval,
				targetBars: SYNTHETIC_TARGET_BARS,
				sourceBarsCap: DATA_CHART_TOTAL_LIMIT,
				fetchLeg: (legSymbol, sourceInterval, sourceBars) =>
					this.getSourceSeriesForSynthetic(legSymbol, sourceInterval, sourceBars, signal),
			});
			if (signal?.aborted) return [];
			const syntheticBars = result.bars;
			if (syntheticBars.length === 0) return [];

			dataManager.registerImportedData(syntheticSymbol, interval, syntheticBars);
			return syntheticBars;
		})()
			.then((data) => {
				const isShortSyntheticDataset = Array.isArray(data)
					&& data.length > 0
					&& data.length < SYNTHETIC_TARGET_BARS;
				if (signal?.aborted || !Array.isArray(data) || data.length === 0 || isShortSyntheticDataset) {
					if (this.universeDatasetCache.get(cacheKey) === promise) {
						this.universeDatasetCache.delete(cacheKey);
					}
				}
				return data;
			})
			.catch((error) => {
				if (this.universeDatasetCache.get(cacheKey) === promise) {
					this.universeDatasetCache.delete(cacheKey);
				}
				throw error;
			});

		this.setUniverseDatasetCache(cacheKey, promise);
		return promise;
	}

	private async prepareUniverseCrossSymbolProvider(
		selectedStrategy: FinderSelectedStrategy,
		settings: ReturnType<typeof backtestService.getBacktestSettings>
	): Promise<void> {
		const secondarySymbol = resolveCrossSymbolSecondaryForStrategy(selectedStrategy.strategy, settings);
		if (secondarySymbol) {
			await this.prepareUniverseSymbolProvider(secondarySymbol);
		}
	}

	private async populateUniverseWithLocalDailySeeds(): Promise<void> {
		const dom = this.getDom();
		dom.finderUniverseUseLocalSp500.disabled = true;

		try {
			const assets = await getLocalDailyAssets();
			const symbols = assets
				.map((asset) => asset.symbol.trim().toUpperCase())
				.filter(Boolean);

			if (symbols.length === 0) {
				this.setStatus("Local seed catalogs are unavailable.");
				uiManager.showToast("Local seed catalogs are unavailable.", "warning");
				return;
			}

			for (const asset of assets) {
				dataManager.setProviderOverride(asset.symbol, asset.provider);
			}
			if (state.currentInterval !== "1d") {
				setCurrentInterval("1d");
			}
			dom.finderUniverseSymbols.value = symbols.join("\n");
			this.uiState.universeSymbolsText = dom.finderUniverseSymbols.value;
			this.updateUniverseSummary();
			this.saveUiState();
			this.setStatus(`Loaded ${symbols.length} local daily seed symbols for Symbol Universe mode on 1d.`);
		} catch (error) {
			debugLogger.error("finder.local_daily_universe_load_failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			this.setStatus("Unable to load local seed catalogs.");
			uiManager.showToast("Unable to load local seed catalogs.", "error");
		} finally {
			dom.finderUniverseUseLocalSp500.disabled = false;
		}
	}

	private applyPersistedUiStateToDom(): void {
		const dom = this.getDom();
		dom.finderScope.value = this.uiState.scope;
		dom.finderSort.value = this.uiState.sortPrimary;
		dom.finderSortSecondary.value = this.uiState.sortSecondary;
		dom.finderAdvancedToggle.checked = this.uiState.useAdvancedSort;
		setVisible(dom.finderSimpleSort, !this.uiState.useAdvancedSort);
		setVisible(dom.finderSortList, this.uiState.useAdvancedSort);
		this.applyAdvancedSortStateToDom();
		dom.finderMode.value = this.uiState.mode;
		dom.finderDataSlice.value = this.uiState.dataSlice;
		dom.finderTopN.value = String(this.uiState.topN);
		dom.finderMaxRuns.value = String(this.uiState.maxRuns);
		dom.finderRange.value = String(this.uiState.rangePercent);
		dom.finderSteps.value = String(this.uiState.steps);
		dom.finderFreezeRiskManagementToggle.checked = this.uiState.freezeRiskManagement;
		dom.finderExitStrategyOverrideToggle.checked = this.uiState.exitStrategyOverrideEnabled;
		dom.finderTradesToggle.checked = this.uiState.tradeFilterEnabled;
		dom.finderTradesMin.value = String(this.uiState.minTrades);
		dom.finderTradesMax.value = this.uiState.maxTradesText;
		dom.finderPolymarketToggle.checked = this.uiState.polymarketScoringEnabled;
		dom.finderPolymarketRankMode.value = this.uiState.polymarketRankMode;
		dom.finderPolymarketMinScored.value = String(this.uiState.polymarketMinScoredPredictions);
		dom.finderPolymarketLockOffset.checked = this.uiState.polymarketLockOffset;
		dom.finderPolymarketAfterTakeProfitOnly.checked = this.uiState.polymarketAfterTakeProfitOnly;
		dom.finderUniverseSymbols.value = this.uiState.universeSymbolsText;
		dom.finderUniverseMinActiveSymbols.value = String(this.uiState.universeMinActiveSymbols);
		dom.finderUniverseMinTotalTrades.value = String(this.uiState.universeMinTotalTrades);
		dom.finderUniverseMinProfitableActiveRatio.value = String(this.uiState.universeMinProfitableActiveRatio);
		this.updateUniverseSummary();
	}

	public init() {
		this.loadUiState();
		const dom = this.getDom();
		dom.runFinder.addEventListener('click', () => {
			void this.runFinder();
		});

		dom.stopFinder.addEventListener('click', () => {
			this.isCancelled = true;
		});

		dom.resetFinderSettings.addEventListener('click', () => {
			this.resetFinderSettings();
		});

		const copyTopButton = dom.finderCopyTopResults;
		copyTopButton.disabled = true;
		copyTopButton.addEventListener('click', () => {
			void this.copyTopResultsMetadata();
		});
		dom.finderCopyDiagnostics.disabled = true;
		dom.finderCopyDiagnostics.addEventListener('click', () => {
			void this.copyFinderDiagnostics();
		});

		dom.finderList.addEventListener('click', (event) => {
			const target = event.target as HTMLElement | null;
			const button = target?.closest<HTMLButtonElement>('.finder-apply');
			if (!button) return;
			const index = Number(button.dataset.index);
			if (this.latestResults.scope === "current_chart") {
				const result = this.latestResults.results[index];
				if (result) {
					void this.applyCurrentChartResult(result);
				}
				return;
			}
			const candidate = this.latestResults.results[index];
			if (candidate) {
				void this.applyUniverseCandidate(candidate);
			}
		});

		this.renderStrategySelection();
		this.initStrategySelectionUI();

		this.initSortingUI();
		this.applyPersistedUiStateToDom();
		this.initUniverseUI();
		this.initTradeFilterUI();
		this.initPolymarketUI();
		this.initFinderSettingsPersistenceUI();
		this.applyScopeUi();
	}

	private initSortingUI(): void {
		// Populate Dropdowns
		const {
			finderSort: sortPrimary,
			finderSortSecondary: sortSecondary,
			finderAdvancedToggle: toggle,
			finderSimpleSort: simpleSection,
			finderSortList: advancedSection,
			finderUniverseSort,
			finderUniverseSortSecondary,
		} = this.getDom();

		const optionsHtml = FINDER_SORT_OPTIONS.map(key =>
			`<option value="${key}">${METRIC_FULL_LABELS[key]}</option>`
		).join('');
		const universeOptionsHtml = UNIVERSE_SORT_OPTIONS.map((key) =>
			`<option value="${key}">${UNIVERSE_METRIC_FULL_LABELS[key]}</option>`
		).join("");

		sortPrimary.innerHTML = optionsHtml;
		sortSecondary.innerHTML = optionsHtml;
		finderUniverseSort.innerHTML = universeOptionsHtml;
		finderUniverseSortSecondary.innerHTML = universeOptionsHtml;

		// Set defaults
		sortPrimary.value = 'expectancy';
		sortSecondary.value = 'profitFactor';
		finderUniverseSort.value = this.uiState.universeSort;
		finderUniverseSortSecondary.value = this.uiState.universeSortSecondary;
		this.updateTimingSortControlState();

		// Advanced Toggle Logic
		toggle.addEventListener('change', () => {
			setVisible(simpleSection, !toggle.checked);
			setVisible(advancedSection, toggle.checked);
		});
		sortPrimary.addEventListener('change', () => this.updateTimingSortControlState());
		sortSecondary.addEventListener('change', () => this.updateTimingSortControlState());
		this.getDom().finderMode.addEventListener('change', () => this.updateTimingSortControlState());

		// Initialize Advanced List
		this.initSortList();
		this.updateTimingSortControlState();
	}

	private initSortList(): void {
		const { finderSortList: list } = this.getDom();

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
			this.captureFinderUiState();
		});

		list.addEventListener('change', (event) => {
			if ((event.target as HTMLElement | null)?.classList.contains("finder-sort-enabled")) {
				this.captureFinderUiState();
			}
		});

		this.renderSortList();
	}

	private renderSortList(): void {
		const { finderSortList: container } = this.getDom();
		container.innerHTML = '';

		this.uiState.advancedSortOrder.forEach(metric => {
			const isTimingMetric = isTimingSortMetric(metric);
			const div = document.createElement('div');
			div.className = isTimingMetric ? 'finder-sort-item finder-sort-item--optional' : 'finder-sort-item';
			div.dataset.value = metric;
			div.innerHTML = `
				<label class="finder-sort-label">
					${isTimingMetric ? `<input type="checkbox" class="finder-sort-enabled" aria-label="Enable ${METRIC_FULL_LABELS[metric]}">` : ''}
					<span class="sort-label">${METRIC_FULL_LABELS[metric]}</span>
				</label>
				<div class="finder-sort-actions">
					<button class="finder-sort-btn sort-up" title="Move Up">▲</button>
					<button class="finder-sort-btn sort-down" title="Move Down">▼</button>
				</div>
			`;
			container.appendChild(div);
		});
		this.applyAdvancedSortStateToDom();
	}

	private applyAdvancedSortStateToDom(): void {
		const { finderSortList: container } = this.getDom();
		const enabledTimingMetrics = new Set(this.uiState.advancedTimingSortEnabled);
		for (const item of Array.from(container.querySelectorAll<HTMLElement>(".finder-sort-item"))) {
			const metric = item.dataset.value as FinderMetric | undefined;
			if (!metric || !isTimingSortMetric(metric)) {
				continue;
			}
			const checkbox = item.querySelector<HTMLInputElement>(".finder-sort-enabled");
			if (checkbox) {
				checkbox.checked = enabledTimingMetrics.has(metric);
			}
		}
	}

	private initStrategySelectionUI(): void {
		const dom = this.getDom();

		dom.finderStrategyList.addEventListener('click', (event) => {
			const target = event.target as HTMLElement | null;
			const checkbox = target?.closest<HTMLInputElement>('input[type="checkbox"][data-strategy-key]');
			const strategyKey = checkbox?.dataset.strategyKey;
			if (!checkbox || !strategyKey || !dom.finderStrategyList.contains(checkbox)) {
				return;
			}
			this.handleStrategyToggleClick(strategyKey, event as MouseEvent);
		});

		dom.finderStrategyList.addEventListener('change', (event) => {
			const target = event.target as HTMLElement | null;
			const checkbox = target?.closest<HTMLInputElement>('input[type="checkbox"][data-strategy-key]');
			const strategyKey = checkbox?.dataset.strategyKey;
			if (!checkbox || !strategyKey || !dom.finderStrategyList.contains(checkbox)) {
				return;
			}
			this.handleStrategyToggleChange(strategyKey);
		});

		dom.finderStrategiesToggleAll.addEventListener('change', (event) => {
			this.setStrategySelection(this.strategyOrder, (event.target as HTMLInputElement).checked);
		});

		dom.finderStrategySearch.addEventListener('input', () => {
			this.applyStrategyFilter();
		});

		dom.finderStrategySelectAll.addEventListener('click', () => {
			this.setStrategySelection(this.strategyOrder, true);
		});

		dom.finderStrategySelectNone.addEventListener('click', () => {
			this.setStrategySelection(this.strategyOrder, false);
		});

		dom.finderStrategyInvertVisible.addEventListener('click', () => {
			this.invertStrategySelection(this.getVisibleStrategyKeys());
		});

		dom.finderStrategySelectVisible.addEventListener('click', () => {
			this.setStrategySelection(this.getVisibleStrategyKeys(), true);
		});

		dom.finderStrategySelectFollow.addEventListener('click', () => {
			this.replaceStrategySelection(FINDER_FOLLOW_STRATEGY_KEYS);
		});

		dom.finderStrategySelectReversion.addEventListener('click', () => {
			this.replaceStrategySelection(FINDER_REVERSION_STRATEGY_KEYS);
		});
	}

	private initUniverseUI(): void {
		const dom = this.getDom();

		dom.finderScope.addEventListener("change", () => {
			this.uiState.scope = dom.finderScope.value === "symbol_universe" ? "symbol_universe" : "current_chart";
			this.applyScopeUi();
			this.syncStrategyToggleInputsFromState();
			this.syncStrategySelectionUi();
			this.ui.renderRandomBenchmark("grid");
			this.renderLatestResults();
			this.saveUiState();
		});

		dom.finderUniverseUseCurrent.addEventListener("click", () => {
			dom.finderUniverseSymbols.value = state.currentSymbol;
			this.uiState.universeSymbolsText = dom.finderUniverseSymbols.value;
			this.updateUniverseSummary();
			this.saveUiState();
		});

		dom.finderUniverseUseCurrentMajors.addEventListener("click", () => {
			dom.finderUniverseSymbols.value = Array.from(new Set<string>([state.currentSymbol, ...MAJOR_SYMBOLS])).join("\n");
			this.uiState.universeSymbolsText = dom.finderUniverseSymbols.value;
			this.updateUniverseSummary();
			this.saveUiState();
		});

		dom.finderUniverseUseLocalSp500.addEventListener("click", () => {
			void this.populateUniverseWithLocalDailySeeds();
		});

		dom.finderUniverseClear.addEventListener("click", () => {
			dom.finderUniverseSymbols.value = "";
			this.uiState.universeSymbolsText = "";
			this.updateUniverseSummary();
			this.saveUiState();
		});

		[
			dom.finderUniverseSymbols,
			dom.finderUniverseMinActiveSymbols,
			dom.finderUniverseMinTotalTrades,
			dom.finderUniverseMinProfitableActiveRatio,
			dom.finderUniverseSort,
			dom.finderUniverseSortSecondary,
		].forEach((element) => {
			element.addEventListener("input", () => {
				this.captureUniverseUiState();
			});
			element.addEventListener("change", () => {
				this.captureUniverseUiState();
			});
		});
	}

	private captureUniverseUiState(): void {
		const dom = this.getDom();
		this.uiState.universeSymbolsText = dom.finderUniverseSymbols.value;
		this.uiState.universeMinActiveSymbols = Math.max(1, Math.round(this.readFinderNumberInput(dom.finderUniverseMinActiveSymbols, DEFAULT_FINDER_UI_STATE.universeMinActiveSymbols, 1)));
		this.uiState.universeMinTotalTrades = Math.max(0, Math.round(this.readFinderNumberInput(dom.finderUniverseMinTotalTrades, DEFAULT_FINDER_UI_STATE.universeMinTotalTrades, 0)));
		this.uiState.universeMinProfitableActiveRatio = Math.max(
			0,
			Math.min(1, this.readFinderNumberInput(dom.finderUniverseMinProfitableActiveRatio, DEFAULT_FINDER_UI_STATE.universeMinProfitableActiveRatio, 0))
		);
		this.uiState.universeSort = normalizeFinderUniverseMetric(dom.finderUniverseSort.value, DEFAULT_FINDER_UI_STATE.universeSort);
		this.uiState.universeSortSecondary = normalizeFinderUniverseMetric(dom.finderUniverseSortSecondary.value, DEFAULT_FINDER_UI_STATE.universeSortSecondary);
		this.updateUniverseSummary();
		this.saveUiState();
	}

	private applyScopeUi(): void {
		const dom = this.getDom();
		const universeScope = this.isUniverseScope();
		const modeInput = dom.finderMode;

		dom.finderChartSortSection.style.display = universeScope ? "none" : "";
		dom.finderUniverseSortSection.style.display = universeScope ? "" : "none";
		dom.finderUniverseSectionHeader.style.display = universeScope ? "" : "none";
		dom.finderUniverseSection.style.display = universeScope ? "" : "none";
		dom.finderPolymarketSection.style.display = universeScope ? "none" : "";
		dom.finderTradeFilterSection.style.display = universeScope ? "none" : "";
		dom.finderModeRow.classList.toggle("is-disabled", universeScope);
		dom.finderStepsRow.style.display = universeScope ? "none" : "";
		dom.finderDataSliceRow.style.display = "";
		dom.finderStrategyActions.classList.remove("is-disabled");
		dom.finderStrategiesToggleAll.disabled = false;
		dom.finderStrategySelectAll.disabled = false;
		dom.finderStrategySelectNone.disabled = false;
		dom.finderStrategyInvertVisible.disabled = this.getVisibleStrategyKeys().length === 0;
		dom.finderStrategySelectVisible.disabled = this.getVisibleStrategyKeys().length === 0;
		modeInput.disabled = universeScope;
		if (universeScope) {
			modeInput.value = "random";
		}
		setVisible("finderBlockBadge", !universeScope && Boolean(state.blockRange));
		this.setTradeFilterControlsEnabled(this.isTradeFilterControlsEnabled());
		this.updateTimingSortControlState();
	}

	private initTradeFilterUI(): void {
		const { finderTradesToggle } = this.getDom();
		finderTradesToggle.addEventListener("change", () => {
			this.setTradeFilterControlsEnabled(this.isTradeFilterControlsEnabled());
		});
		this.setTradeFilterControlsEnabled(this.isTradeFilterControlsEnabled());
	}

	private isTradeFilterControlsEnabled(): boolean {
		const dom = this.getDom();
		return !this.isUniverseScope() && dom.finderTradesToggle.checked;
	}

	private setTradeFilterControlsEnabled(enabled: boolean): void {
		const dom = this.getDom();
		dom.finderTradeFilters.classList.toggle("is-disabled", !enabled);
		dom.finderTradesMin.disabled = !enabled;
		dom.finderTradesMax.disabled = !enabled;
	}

	private initPolymarketUI(): void {
		const { finderPolymarketToggle: toggle } = this.getDom();
		const refreshControls = () => {
			this.setPolymarketControlsEnabled(toggle.checked);
		};

		refreshControls();
		toggle.addEventListener('change', refreshControls);
		document.getElementById('polymarketOutcomeInterval')?.addEventListener('change', refreshControls);
		document.getElementById('polymarketExitMode')?.addEventListener('change', refreshControls);
	}

	private initFinderSettingsPersistenceUI(): void {
		const dom = this.getDom();
		const persist = () => {
			this.captureFinderUiState();
		};
		[
			dom.finderSort,
			dom.finderSortSecondary,
			dom.finderAdvancedToggle,
			dom.finderMode,
			dom.finderDataSlice,
			dom.finderTopN,
			dom.finderMaxRuns,
			dom.finderRange,
			dom.finderSteps,
			dom.finderFreezeRiskManagementToggle,
			dom.finderExitStrategyOverrideToggle,
			dom.finderTradesToggle,
			dom.finderTradesMin,
			dom.finderTradesMax,
			dom.finderPolymarketToggle,
			dom.finderPolymarketRankMode,
			dom.finderPolymarketMinScored,
			dom.finderPolymarketLockOffset,
			dom.finderPolymarketAfterTakeProfitOnly,
		].forEach((element) => {
			element.addEventListener("input", persist);
			element.addEventListener("change", persist);
		});
	}

	private captureFinderUiState(): void {
		const dom = this.getDom();
		const sortItems = Array.from(dom.finderSortList.querySelectorAll<HTMLElement>(".finder-sort-item"));
		this.uiState.sortPrimary = normalizeFinderMetric(dom.finderSort.value, DEFAULT_FINDER_UI_STATE.sortPrimary);
		this.uiState.sortSecondary = normalizeFinderMetric(dom.finderSortSecondary.value, DEFAULT_FINDER_UI_STATE.sortSecondary);
		this.uiState.useAdvancedSort = dom.finderAdvancedToggle.checked;
		this.uiState.advancedSortOrder = normalizeAdvancedSortOrder(sortItems.map((item) => item.dataset.value));
		this.uiState.advancedTimingSortEnabled = sortItems
			.filter((item) => item.querySelector<HTMLInputElement>(".finder-sort-enabled")?.checked === true)
			.map((item) => item.dataset.value)
			.filter((metric): metric is FinderMetric => isTimingSortMetric(metric));
		this.uiState.mode = normalizeFinderMode(dom.finderMode.value);
		this.uiState.dataSlice = normalizeFinderDataSlice(dom.finderDataSlice.value);
		this.uiState.topN = Math.round(this.readFinderNumberInput(dom.finderTopN, DEFAULT_FINDER_UI_STATE.topN, 1));
		this.uiState.maxRuns = Math.round(this.readFinderNumberInput(dom.finderMaxRuns, DEFAULT_FINDER_UI_STATE.maxRuns, 1));
		this.uiState.rangePercent = this.readFinderNumberInput(dom.finderRange, DEFAULT_FINDER_UI_STATE.rangePercent, 0);
		this.uiState.steps = Math.round(this.readFinderNumberInput(dom.finderSteps, DEFAULT_FINDER_UI_STATE.steps, 2));
		this.uiState.freezeRiskManagement = dom.finderFreezeRiskManagementToggle.checked;
		this.uiState.exitStrategyOverrideEnabled = dom.finderExitStrategyOverrideToggle.checked;
		this.uiState.tradeFilterEnabled = dom.finderTradesToggle.checked;
		this.uiState.minTrades = Math.round(this.readFinderNumberInput(dom.finderTradesMin, DEFAULT_FINDER_UI_STATE.minTrades, 0));
		this.uiState.maxTradesText = dom.finderTradesMax.value.trim();
		this.uiState.polymarketScoringEnabled = dom.finderPolymarketToggle.checked;
		this.uiState.polymarketRankMode = normalizePolymarketRankMode(dom.finderPolymarketRankMode.value);
		this.uiState.polymarketMinScoredPredictions = Math.round(this.readFinderNumberInput(
			dom.finderPolymarketMinScored,
			DEFAULT_FINDER_UI_STATE.polymarketMinScoredPredictions,
			0
		));
		this.uiState.polymarketLockOffset = dom.finderPolymarketLockOffset.checked;
		this.uiState.polymarketAfterTakeProfitOnly = dom.finderPolymarketAfterTakeProfitOnly.checked;
		this.saveUiState();
	}

	private resetFinderSettings(): void {
		const {
			currentChartSelectedStrategyKeys,
			universeSelectedStrategyKeys,
		} = this.uiState;
		this.uiState = {
			...DEFAULT_FINDER_UI_STATE,
			currentChartSelectedStrategyKeys: [...currentChartSelectedStrategyKeys],
			universeSelectedStrategyKeys: [...universeSelectedStrategyKeys],
		};
		this.renderSortList();
		this.applyPersistedUiStateToDom();
		this.syncStrategyToggleInputsFromState();
		this.syncStrategySelectionUi();
		this.setTradeFilterControlsEnabled(this.isTradeFilterControlsEnabled());
		this.setPolymarketControlsEnabled(this.uiState.polymarketScoringEnabled);
		this.applyScopeUi();
		this.saveUiState();
		this.setStatus("Finder settings reset.");
	}

	private setPolymarketControlsEnabled(enabled: boolean): void {
		const dom = this.getDom();
		const polymarketSettings = resolvePolymarketDomSettings();
		const lockOffsetRelevant = !isSameEventPolymarketExitMode(polymarketSettings.exitMode)
			&& polymarketSettings.outcomeInterval === '5m';

		dom.finderPolymarketSettings.classList.toggle('is-disabled', !enabled);
		dom.finderPolymarketRankMode.disabled = !enabled;
		dom.finderPolymarketMinScored.disabled = !enabled;
		dom.finderPolymarketLockOffset.disabled = !enabled || !lockOffsetRelevant;
		dom.finderPolymarketAfterTakeProfitOnly.disabled = !enabled;
		this.updateTimingSortControlState();
	}

	private updateTimingSortControlState(): void {
		const dom = this.getDom();
		const timingSortDisabled = this.isUniverseScope()
			|| dom.finderPolymarketToggle.checked
			|| dom.finderMode.value === "genetic";

		for (const select of [dom.finderSort, dom.finderSortSecondary]) {
			for (const option of Array.from(select.options)) {
				if (isTimingSortMetric(option.value)) {
					option.disabled = timingSortDisabled;
				}
			}
		}

		for (const item of Array.from(dom.finderSortList.querySelectorAll<HTMLElement>(".finder-sort-item"))) {
			const isTimingMetric = isTimingSortMetric(item.dataset.value);
			if (!isTimingMetric) continue;
			item.classList.toggle("is-disabled", timingSortDisabled);
			item.querySelectorAll<HTMLInputElement>(".finder-sort-enabled").forEach((checkbox) => {
				checkbox.disabled = timingSortDisabled;
			});
			item.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
				button.disabled = timingSortDisabled;
			});
		}
	}

	private getCurrentChartSelectedStrategyKeys(): Set<string> {
		return new Set(this.uiState.currentChartSelectedStrategyKeys);
	}

	private getUniverseSelectedStrategyKeys(): Set<string> {
		return new Set(this.uiState.universeSelectedStrategyKeys);
	}

	private syncStrategyToggleInputsFromState(): void {
		this.strategyToggles.forEach((toggle, key) => {
			toggle.checked = this.isStrategySelected(key);
		});
	}

	private isStrategySelected(key: string): boolean {
		return this.isUniverseScope()
			? this.getUniverseSelectedStrategyKeys().has(key)
			: this.getCurrentChartSelectedStrategyKeys().has(key);
	}

	private renderStrategySelection(): void {
		const container = this.getDom().finderStrategyList;
		container.innerHTML = '';
		this.strategyToggles.clear();
		this.strategyItems.clear();
		this.strategyOrder = [];
		this.lastStrategyToggleKey = null;

		const strategies = strategyRegistry.getAll();
		const allStrategies = getStrategyList();
		const fragment = document.createDocumentFragment();

		for (const { key, name } of allStrategies) {
			const strategy = strategies[key];
			const displayName = strategy?.name ?? name;
			const kind = getStrategyKind(key, strategy);
			const item = document.createElement('div');
			item.className = 'strategy-list-item';
			item.dataset.strategyKey = key;
			item.dataset.strategyName = displayName.toLowerCase();
			item.dataset.strategyKind = kind;
			item.title = getStrategyKindTitle(kind);

			const checkbox = document.createElement('input');
			checkbox.type = 'checkbox';
			checkbox.id = `finder-strategy-${key}`;
			checkbox.checked = this.isStrategySelected(key);
			checkbox.dataset.strategyKey = key;

			const label = document.createElement('label');
			label.htmlFor = `finder-strategy-${key}`;
			label.textContent = displayName;

			item.appendChild(checkbox);
			item.appendChild(label);
			fragment.appendChild(item);

			this.strategyToggles.set(key, checkbox);
			this.strategyItems.set(key, item);
			this.strategyOrder.push(key);
		}
		container.appendChild(fragment);

		this.applyStrategyFilter();
		this.syncStrategySelectionUi();
	}

	private readFinderNumberInput(input: HTMLInputElement, fallback: number, min?: number): number {
		const value = parseInputNumber(input.value);
		if (value === null) return fallback;
		return min === undefined ? value : Math.max(min, value);
	}

	private handleStrategyToggleClick(strategyKey: string, event: MouseEvent): void {
		const checkbox = this.strategyToggles.get(strategyKey);
		if (!checkbox) return;

		if (event.shiftKey && this.lastStrategyToggleKey) {
			const orderedKeys = this.getStrategyKeysForRangeSelection();
			const startIndex = orderedKeys.indexOf(this.lastStrategyToggleKey);
			const endIndex = orderedKeys.indexOf(strategyKey);

			if (startIndex !== -1 && endIndex !== -1) {
				const [from, to] = startIndex < endIndex ? [startIndex, endIndex] : [endIndex, startIndex];
				this.setStrategySelection(orderedKeys.slice(from, to + 1), checkbox.checked, false);
			}
		}

		this.lastStrategyToggleKey = strategyKey;
		this.syncStrategySelectionUi();
	}

	private handleStrategyToggleChange(strategyKey: string): void {
		const checkbox = this.strategyToggles.get(strategyKey);
		if (!checkbox) {
			return;
		}

		const selected = this.isUniverseScope()
			? this.getUniverseSelectedStrategyKeys()
			: this.getCurrentChartSelectedStrategyKeys();
		if (checkbox.checked) {
			selected.add(strategyKey);
		} else {
			selected.delete(strategyKey);
		}
		if (this.isUniverseScope()) {
			this.uiState.universeSelectedStrategyKeys = [...selected];
		} else {
			this.uiState.currentChartSelectedStrategyKeys = [...selected];
		}
		this.saveUiState();
		this.syncStrategySelectionUi();
	}

	private getStrategyKeysForRangeSelection(): string[] {
		const visibleKeys = this.getVisibleStrategyKeys();
		return visibleKeys.length > 0 ? visibleKeys : this.strategyOrder;
	}

	private getVisibleStrategyKeys(): string[] {
		return this.strategyOrder.filter((key) => {
			const item = this.strategyItems.get(key);
			return item ? !item.hidden : false;
		});
	}

	private setStrategySelection(strategyKeys: Iterable<string>, checked: boolean, syncUi = true): void {
		const selected = this.isUniverseScope()
			? this.getUniverseSelectedStrategyKeys()
			: this.getCurrentChartSelectedStrategyKeys();
		for (const key of strategyKeys) {
			const toggle = this.strategyToggles.get(key);
			if (toggle) {
				toggle.checked = checked;
				if (checked) {
					selected.add(key);
				} else {
					selected.delete(key);
				}
			}
		}
		if (this.isUniverseScope()) {
			this.uiState.universeSelectedStrategyKeys = [...selected];
		} else {
			this.uiState.currentChartSelectedStrategyKeys = [...selected];
		}
		this.saveUiState();

		if (syncUi) {
			this.syncStrategySelectionUi();
		}
	}

	private replaceStrategySelection(strategyKeys: readonly string[]): void {
		const availableKeys = strategyKeys.filter((key) => this.strategyToggles.has(key));
		this.setStrategySelection(this.strategyOrder, false, false);
		this.setStrategySelection(availableKeys, true);
	}

	private invertStrategySelection(strategyKeys: Iterable<string>): void {
		const selected = this.isUniverseScope()
			? this.getUniverseSelectedStrategyKeys()
			: this.getCurrentChartSelectedStrategyKeys();
		for (const key of strategyKeys) {
			const toggle = this.strategyToggles.get(key);
			if (toggle) {
				toggle.checked = !toggle.checked;
				if (toggle.checked) {
					selected.add(key);
				} else {
					selected.delete(key);
				}
			}
		}
		if (this.isUniverseScope()) {
			this.uiState.universeSelectedStrategyKeys = [...selected];
		} else {
			this.uiState.currentChartSelectedStrategyKeys = [...selected];
		}
		this.saveUiState();

		this.syncStrategySelectionUi();
	}

	private applyStrategyFilter(): void {
		const { finderStrategySearch: searchInput } = this.getDom();
		const query = searchInput.value.trim().toLowerCase();

		this.strategyItems.forEach((item) => {
			const strategyName = item.dataset.strategyName ?? '';
			item.hidden = query.length > 0 && !strategyName.includes(query);
		});

		this.syncStrategySelectionUi();
	}

	private syncStrategySelectionUi(): void {
		const dom = this.getDom();
		const totalCount = this.strategyOrder.length;
		const visibleKeys = this.getVisibleStrategyKeys();
		const visibleSet = new Set(visibleKeys);
		let selectedCount = 0;
		let visibleSelectedCount = 0;

		this.strategyToggles.forEach((toggle, key) => {
			if (!toggle.checked) return;
			selectedCount += 1;
			if (visibleSet.has(key)) {
				visibleSelectedCount += 1;
			}
		});

		const hasFilter = dom.finderStrategySearch.value.trim().length > 0;
		dom.finderStrategiesToggleAll.checked = totalCount > 0 && selectedCount === totalCount;
		dom.finderStrategiesToggleAll.indeterminate = selectedCount > 0 && selectedCount < totalCount;
		dom.finderStrategySelectVisible.disabled = visibleKeys.length === 0;
		dom.finderStrategyInvertVisible.disabled = visibleKeys.length === 0;
		dom.finderStrategySummary.textContent = hasFilter
			? `${selectedCount} selected | ${visibleKeys.length} visible | ${visibleSelectedCount} visible selected`
			: `${selectedCount} selected`;
	}

	private async loadSelectedStrategy(strategyKey: string): Promise<FinderSelectedStrategy | null> {
		if (!strategyRegistry.has(strategyKey)) {
			await loadBuiltInStrategyByKey(strategyKey);
		}
		const strategy = strategyRegistry.get(strategyKey);
		return strategy ? { key: strategyKey, name: strategy.name, strategy } : null;
	}

	private async getSelectedStrategies(): Promise<FinderSelectedStrategy[]> {
		const results: FinderSelectedStrategy[] = [];
		for (const key of this.uiState.currentChartSelectedStrategyKeys) {
			const selection = await this.loadSelectedStrategy(key);
			if (selection) {
				results.push(selection);
			}
		}
		return results;
	}

	private async getUniverseSelectedStrategies(): Promise<FinderSelectedStrategy[]> {
		const results: FinderSelectedStrategy[] = [];
		for (const key of this.uiState.universeSelectedStrategyKeys) {
			const selection = await this.loadSelectedStrategy(key);
			if (selection) {
				results.push(selection);
			}
		}
		return results;
	}

	public async runFinder(): Promise<void> {
		if (this.isRunning) return;
		if (!this.isUniverseScope() && state.ohlcvData.length === 0) {
			this.setStatus('Data not loaded. Attempting to load...');
			await dataManager.loadData();

			if (state.ohlcvData.length === 0) {
				this.setStatus('Load data before running the finder.');
				return;
			}
		}

		this.isCancelled = false;
		this.isRunning = true;
		const startTime = performance.now();
		this.lastFinderRunBacktestSettings = null;
		this.lastFinderOptions = null;
		this.lastFinderEvaluationData = null;
		this.latestDiagnostics = null;

		const settingsSnapshot = this.cloneBacktestSettings(settingsManager.getBacktestSettings());
		this.lastFinderRunBacktestSettings = this.cloneBacktestSettings(settingsSnapshot);
		const options = this.readOptions(settingsSnapshot);
		this.lastFinderOptions = this.cloneBacktestSettings(options);

		const dom = this.getDom();
		const runButton = dom.runFinder;
		const stopButton = dom.stopFinder;
		dom.finderCopyDiagnostics.disabled = true;
		let progressFinalized = false;
		const setRunningUI = (running: boolean) => {
			runButton.disabled = running;
			runButton.classList.toggle('is-loading', running);
			runButton.setAttribute('aria-busy', running ? 'true' : 'false');
			stopButton.style.display = running ? '' : 'none';
		};
		const finalizeProgress = (percent: number, text: string) => {
			this.setProgress(false, percent, text);
			progressFinalized = true;
		};

		setRunningUI(true);
		this.setProgress(true, 0, 'Preparing...');
		this.setStatus('Running strategy finder...');
		this.ui.renderRandomBenchmark(options.mode);
		this.setLatestResults({
			scope: options.scope === 'symbol_universe' ? 'symbol_universe' : 'current_chart',
			results: [],
		});
		this.renderLatestResults();

		try {
			const completed = options.scope === 'symbol_universe'
				? await this.runUniverseFinder(options, startTime)
				: await this.runCurrentChartFinder(options, startTime);

			if (!completed) {
				finalizeProgress(0, '');
			} else if (this.isCancelled) {
				finalizeProgress(0, '');
				this.setStatus(`Finder stopped by user after ${Math.round(performance.now() - startTime)}ms.`);
			} else {
				finalizeProgress(100, '');
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (this.isCancelled && (message.includes('stopped') || message.includes('cancel'))) {
				this.setStatus('Finder stopped by user.');
				uiManager.showToast('Finder stopped.', 'info');
			} else {
				debugLogger.error('finder.run_failed', {
					scope: options.scope ?? 'current_chart',
					symbol: state.currentSymbol,
					interval: state.currentInterval,
					mode: options.mode,
					polymarketScoringEnabled: options.polymarketScoringEnabled,
					error: message,
				});
				this.setStatus(`Finder failed. ${message}`);
				uiManager.showToast('Finder run failed. Check the status panel for details.', 'error');
			}
		} finally {
			if (!progressFinalized) {
				finalizeProgress(0, '');
			}
			this.isCancelled = false;
			setRunningUI(false);
			this.isRunning = false;
		}
	}

	private async runCurrentChartFinder(options: FinderOptions, startTime: number): Promise<boolean> {
		const selectedStrategies = await this.getSelectedStrategies();
		if (selectedStrategies.length === 0) {
			this.setStatus('No strategies selected.');
			return false;
		}
		const exitStrategyCandidates = this.resolveExitStrategyCandidates(options, selectedStrategies);
		if (options.mode === "genetic" && finderSortRequiresTradeTimingQuality(options.sortPriority)) {
			this.setStatus("Entry Score and Exit Score sorting are supported in grid and random modes only.");
			return false;
		}

		const capitalSettings = backtestService.getCapitalSettings();
		const settings = backtestService.getBacktestSettings();
		const requiresTsEngine = backtestService.requiresTypescriptEngine(settings) || isSmartTradeSizingMode(capitalSettings.sizingMode);

		const blockSlicedData = sliceOhlcvByBlock(state.ohlcvData, state.blockRange);
		const windowSlicedData = sliceFinderDataWindow(blockSlicedData, options.dataSlice ?? "all");
		const ohlcvData = buildFinderEvaluationData(windowSlicedData, state.currentInterval, settings);
		if (ohlcvData.length === 0) {
			this.setStatus('No candles available for finder run.');
			return false;
		}
		this.lastFinderEvaluationData = {
			interval: state.currentInterval,
			data: this.cloneOhlcvData(ohlcvData),
		};

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
				generateParamSets: (defaultParams, finderOptions) => this.generateParamSets(defaultParams, finderOptions),
			},
			{
				setProgress: (percent, text) => this.setProgress(true, percent, text),
				setStatus: (text) => this.setStatus(text),
				yieldControl: () => this.taskYielder.yieldControl(),
				isCancelled: () => this.isCancelled,
				onResultsUpdate: (results: FinderResult[]) => {
					const sorted = sortFinderResults(results, options.sortPriority);
					this.setLatestResults({ scope: 'current_chart', results: sorted });
					this.renderLatestResults();
				},
			}
		);

		const sortedResults = sortFinderResults(output.results, options.sortPriority);
		this.setLatestResults({ scope: 'current_chart', results: sortedResults });
		this.latestDiagnostics = output.diagnostics ?? this.buildFallbackDiagnostics({
			options,
			results: sortedResults,
			selectedStrategies,
			ohlcvData,
			elapsedMs: performance.now() - startTime,
			requiresTsEngine,
		});
		this.getDom().finderCopyDiagnostics.disabled = !this.latestDiagnostics;
		this.renderLatestResults();
		this.ui.renderRandomBenchmark(options.mode, output.randomBenchmark);

		if (!this.isCancelled) {
			this.setStatus(`Finder complete. ${sortedResults.length} result${sortedResults.length === 1 ? '' : 's'} in ${Math.round(performance.now() - startTime)}ms.`);
		}
		return true;
	}

	private buildUniverseDataWindowDiagnostics(
		dataSlice: FinderDataSlice,
		statsBySymbol: Map<string, UniverseDatasetWindowStats>
	): UniverseDataWindowDiagnostics {
		const stats = [...statsBySymbol.values()];
		const emptyBars = { min: 0, max: 0, avg: 0 };
		if (stats.length === 0) {
			return {
				dataSlice,
				loadedBars: emptyBars,
				slicedBars: emptyBars,
				shortestSymbols: [],
			};
		}

		const summarizeBars = (values: number[]) => {
			const sum = values.reduce((total, value) => total + value, 0);
			return {
				min: Math.min(...values),
				max: Math.max(...values),
				avg: Number((sum / values.length).toFixed(2)),
			};
		};

		return {
			dataSlice,
			loadedBars: summarizeBars(stats.map((item) => item.loadedBars)),
			slicedBars: summarizeBars(stats.map((item) => item.slicedBars)),
			shortestSymbols: stats
				.slice()
				.sort((a, b) => a.slicedBars - b.slicedBars || a.loadedBars - b.loadedBars || a.symbol.localeCompare(b.symbol))
				.slice(0, 8)
				.map((item) => ({
					symbol: item.symbol,
					loadedBars: item.loadedBars,
					slicedBars: item.slicedBars,
					firstTime: item.firstTime,
					lastTime: item.lastTime,
					synthetic: item.synthetic,
				})),
		};
	}

	private attachUniverseDataWindowDiagnostics(
		diagnostics: FinderDiagnostics,
		dataSlice: FinderDataSlice,
		statsBySymbol: Map<string, UniverseDatasetWindowStats>
	): void {
		if (!diagnostics.universe) return;
		diagnostics.universe.dataWindow = this.buildUniverseDataWindowDiagnostics(dataSlice, statsBySymbol);
	}

	private async runUniverseFinder(options: FinderOptions, startTime: number): Promise<boolean> {
		const selectedStrategies = await this.getUniverseSelectedStrategies();
		if (selectedStrategies.length === 0) {
			this.setStatus('Select at least one strategy for Symbol Universe mode.');
			return false;
		}
		if (!options.universe || options.universe.symbols.length === 0) {
			this.setStatus('Add at least one symbol for Symbol Universe mode.');
			return false;
		}
		const exitStrategyCandidates = this.resolveExitStrategyCandidates(options, selectedStrategies);

		const allResults: FinderUniverseCandidate[] = [];
		const failedSymbols = new Set<string>();
		const diagnosticsParts: FinderDiagnostics[] = [];
		let maxLoadedSymbols = 0;
		const settings = backtestService.getBacktestSettings();
		const capitalSettings = backtestService.getCapitalSettings();
		const dataWindowStats = new Map<string, UniverseDatasetWindowStats>();
		const loadDataset = async (symbol: string, interval: string, signal?: AbortSignal): Promise<OHLCVData[]> => {
			const data = await this.loadUniverseDataset(symbol, interval, signal);
			const sliced = sliceFinderDataWindow(data, options.dataSlice ?? "all");
			const normalizedSymbol = symbol.trim().toUpperCase();
			dataWindowStats.set(normalizedSymbol, {
				symbol: normalizedSymbol,
				loadedBars: data.length,
				slicedBars: sliced.length,
				firstTime: sliced[0]?.time,
				lastTime: sliced[sliced.length - 1]?.time,
				synthetic: Boolean(parseSyntheticPairToken(symbol)),
			});
			return sliced;
		};

		for (let strategyIndex = 0; strategyIndex < selectedStrategies.length; strategyIndex += 1) {
			const selectedStrategy = selectedStrategies[strategyIndex]!;
			await this.prepareUniverseCrossSymbolProvider(selectedStrategy, settings);
			const output = await runFinderUniverseExecution(
				{
					interval: state.currentInterval,
					options,
					settings,
					capitalSettings,
					selectedStrategy,
					loadDataset,
					getProvider: (symbol) => dataManager.getProvider(symbol),
					generateParamSets: (defaultParams, finderOptions) => this.generateParamSets(defaultParams, finderOptions),
					exitStrategyCandidates,
				},
				{
					setProgress: (percent, text) => {
						const scaledPercent = ((strategyIndex + (percent / 100)) / selectedStrategies.length) * 100;
						this.setProgress(true, scaledPercent, text);
					},
					setStatus: (text) => this.setStatus(`[${strategyIndex + 1}/${selectedStrategies.length}] ${selectedStrategy.name}: ${text}`),
					yieldControl: () => this.taskYielder.yieldControl(),
					isCancelled: () => this.isCancelled,
					onResultsUpdate: (results) => {
						const mergedResults = sortFinderUniverseCandidates(
							[...allResults, ...results],
							options.universe?.sortPriority ?? []
						).slice(0, options.topN);
						this.setLatestResults({ scope: 'symbol_universe', results: mergedResults });
						this.renderLatestResults();
					},
				}
			);

			allResults.push(...output.results);
			if (output.diagnostics) {
				this.attachUniverseDataWindowDiagnostics(output.diagnostics, options.dataSlice ?? "all", dataWindowStats);
				diagnosticsParts.push(output.diagnostics);
			}
			maxLoadedSymbols = Math.max(maxLoadedSymbols, output.loadedSymbols);
			output.failedSymbols.forEach((symbol) => failedSymbols.add(symbol));

			const mergedResults = sortFinderUniverseCandidates(
				allResults,
				options.universe.sortPriority
			).slice(0, options.topN);
			this.setLatestResults({ scope: 'symbol_universe', results: mergedResults });
			this.renderLatestResults();

			if (this.isCancelled) {
				break;
			}
		}

		this.latestDiagnostics = diagnosticsParts.length === 0
			? null
			: diagnosticsParts.length === 1
				? diagnosticsParts[0]!
				: this.buildCombinedUniverseDiagnostics({
					options,
					parts: diagnosticsParts,
					shownResults: this.getUniverseResults().length,
					elapsedMs: performance.now() - startTime,
				});
		this.getDom().finderCopyDiagnostics.disabled = !this.latestDiagnostics;
		this.ui.renderRandomBenchmark(options.mode);

		if (!this.isCancelled) {
			const totalSymbols = options.universe.symbols.length;
			const failureCount = failedSymbols.size;
			const survivors = this.getUniverseResults().length;
			const segments = [
				`Universe Finder complete. ${survivors} survivor${survivors === 1 ? '' : 's'}`,
				`${selectedStrategies.length} strateg${selectedStrategies.length === 1 ? 'y' : 'ies'}`,
				`${maxLoadedSymbols}/${totalSymbols} symbols loaded`,
			];
			if (failureCount > 0) {
				segments.push(`${failureCount} load failure${failureCount === 1 ? '' : 's'}`);
			}
			segments.push(`${Math.round(performance.now() - startTime)}ms`);
			this.setStatus(segments.join(' | '));

			// Persist universe results for Asset Leadership analysis
			try {
				const { assetLeadershipService } = await import("./asset-leadership-service");
				void assetLeadershipService.persistUniverseRun({
					interval: state.currentInterval,
					strategyPreset: resolveFinderStrategyPreset(selectedStrategies.map((selection) => selection.key)),
					strategyCount: selectedStrategies.length,
					universeSymbolCount: totalSymbols,
					topN: options.topN,
					candidates: this.getUniverseResults(),
				});
			} catch (error) {
				debugLogger.error("finder.asset_leadership_persist_failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		return true;
	}

	private readOptions(backtestSettings: Pick<ReturnType<typeof settingsManager.getBacktestSettings>, 'polymarketExitMode' | 'polymarketSignalExitAllowMultipleTradesPerEvent' | 'executionModel' | 'polymarketEntryDelayBars' | 'polymarketEntryPriceFilterCents' | 'polymarketBacktestSlippageCents' | 'polymarketPostSignalLimitEntryEnabled' | 'polymarketPostSignalLimitEntryMode' | 'polymarketPostSignalLimitEntryPriceCents' | 'polymarketPostSignalLimitEntryOffsetCents' | 'polymarketPostSignalLimitExitEnabled' | 'polymarketPostSignalLimitExitMode' | 'polymarketPostSignalLimitExitPriceCents' | 'polymarketPostSignalLimitExitOffsetCents' | 'disableSignalExits' | 'exitStrategyOverrideEnabled'>): FinderOptions {
		const dom = this.getDom();
		const scope = this.isUniverseScope() ? 'symbol_universe' : 'current_chart';
		const useAdvancedSort = dom.finderAdvancedToggle.checked;
		const sortItems = dom.finderSortList.querySelectorAll('.finder-sort-item');
		const advancedSortValues = Array.from(sortItems)
			.filter((el) => {
				const item = el as HTMLElement;
				const metric = item.dataset.value as FinderMetric | undefined;
				if (!isTimingSortMetric(metric)) {
					return true;
				}
				return item.querySelector<HTMLInputElement>(".finder-sort-enabled")?.checked === true;
			})
			.map(el => (el as HTMLElement).dataset.value as FinderMetric | undefined);
		const mode = scope === 'symbol_universe' ? 'random' : dom.finderMode.value as FinderMode;
		const dataSlice = normalizeFinderDataSlice(dom.finderDataSlice.value);
		const topN = Math.round(this.readFinderNumberInput(dom.finderTopN, DEFAULT_FINDER_UI_STATE.topN, 1));
		const steps = Math.round(this.readFinderNumberInput(dom.finderSteps, DEFAULT_FINDER_UI_STATE.steps, 2));
		const rangePercent = this.readFinderNumberInput(dom.finderRange, DEFAULT_FINDER_UI_STATE.rangePercent, 0);
		const maxRuns = Math.round(this.readFinderNumberInput(dom.finderMaxRuns, DEFAULT_FINDER_UI_STATE.maxRuns, 1));
		const tradeFilterEnabled = scope === 'current_chart' && dom.finderTradesToggle.checked;
		const minTrades = tradeFilterEnabled ? Math.round(this.readFinderNumberInput(dom.finderTradesMin, DEFAULT_FINDER_UI_STATE.minTrades, 0)) : 0;
		const maxTrades = tradeFilterEnabled
			? Math.round(this.readFinderNumberInput(dom.finderTradesMax, Number.POSITIVE_INFINITY, 0))
			: Number.POSITIVE_INFINITY;
		const freezeRiskManagement = dom.finderFreezeRiskManagementToggle.checked;
		const finderExitStrategyToggleOn = dom.finderExitStrategyOverrideToggle.checked;
		const exitStrategyOverrideEnabled = finderExitStrategyToggleOn
			&& backtestSettings.disableSignalExits === true
			&& backtestSettings.exitStrategyOverrideEnabled === true;
		const polymarketScoringEnabled = scope === 'current_chart' && dom.finderPolymarketToggle.checked;
		const polymarketRankMode = (dom.finderPolymarketRankMode.value as PolymarketFinderRankMode) || 'balanced';
		const polymarketMinScoredPredictions = polymarketScoringEnabled
			? Math.round(this.readFinderNumberInput(dom.finderPolymarketMinScored, 0, 0))
			: 0;
		const polymarketLockOffset = polymarketScoringEnabled && dom.finderPolymarketLockOffset.checked;
		const polymarketAfterTakeProfitOnly = polymarketScoringEnabled && dom.finderPolymarketAfterTakeProfitOnly.checked;

		const effectiveExitMode = resolveFinderPolymarketExitMode({
			requestedMode: backtestSettings.polymarketExitMode,
			interval: state.currentInterval,
			executionModel: backtestSettings.executionModel,
			polymarketAnnotationEnabled: polymarketScoringEnabled,
		});

		const options = buildFinderOptions({
			mode,
			dataSlice,
			useAdvancedSort,
			advancedSortValues,
			primarySort: dom.finderSort.value as FinderMetric,
			secondarySort: dom.finderSortSecondary.value as FinderMetric,
			topN,
			steps,
			rangePercent,
			maxRuns,
			tradeFilterEnabled,
			minTrades,
			maxTrades,
			freezeRiskManagement,
			polymarketScoringEnabled,
			polymarketRankMode,
			polymarketMinScoredPredictions,
			polymarketLockOffset,
			polymarketAfterTakeProfitOnly,
			polymarketEntryDelayBars: backtestSettings.polymarketEntryDelayBars,
			polymarketEntryPriceFilterCents: backtestSettings.polymarketEntryPriceFilterCents,
			polymarketBacktestSlippageCents: backtestSettings.polymarketBacktestSlippageCents,
			polymarketExitMode: effectiveExitMode,
			polymarketSignalExitAllowMultipleTradesPerEvent: backtestSettings.polymarketSignalExitAllowMultipleTradesPerEvent,
			polymarketPostSignalLimitEntryEnabled: backtestSettings.polymarketPostSignalLimitEntryEnabled,
			polymarketPostSignalLimitEntryMode: backtestSettings.polymarketPostSignalLimitEntryMode,
			polymarketPostSignalLimitEntryPriceCents: backtestSettings.polymarketPostSignalLimitEntryPriceCents,
			polymarketPostSignalLimitEntryOffsetCents: backtestSettings.polymarketPostSignalLimitEntryOffsetCents,
			polymarketPostSignalLimitExitEnabled: backtestSettings.polymarketPostSignalLimitExitEnabled,
			polymarketPostSignalLimitExitMode: backtestSettings.polymarketPostSignalLimitExitMode,
			polymarketPostSignalLimitExitPriceCents: backtestSettings.polymarketPostSignalLimitExitPriceCents,
			polymarketPostSignalLimitExitOffsetCents: backtestSettings.polymarketPostSignalLimitExitOffsetCents,
			exitStrategyOverrideEnabled,
		});

		options.scope = scope;
		if (scope === 'symbol_universe') {
			options.universe = buildFinderUniverseOptions({
				symbols: this.parseUniverseSymbols(dom.finderUniverseSymbols.value),
				minActiveSymbols: Math.round(this.readFinderNumberInput(dom.finderUniverseMinActiveSymbols, DEFAULT_FINDER_UI_STATE.universeMinActiveSymbols, 1)),
				minTotalTrades: Math.round(this.readFinderNumberInput(dom.finderUniverseMinTotalTrades, DEFAULT_FINDER_UI_STATE.universeMinTotalTrades, 0)),
				minProfitableActiveRatio: this.readFinderNumberInput(
					dom.finderUniverseMinProfitableActiveRatio,
					DEFAULT_FINDER_UI_STATE.universeMinProfitableActiveRatio,
					0
				),
				primarySort: normalizeFinderUniverseMetric(dom.finderUniverseSort.value, DEFAULT_FINDER_UI_STATE.universeSort),
				secondarySort: normalizeFinderUniverseMetric(dom.finderUniverseSortSecondary.value, DEFAULT_FINDER_UI_STATE.universeSortSecondary),
			});
		}

		return options;
	}

	private generateParamSets(defaultParams: StrategyParams, options: FinderOptions): StrategyParams[] {
		return this.paramSpace.generateParamSets(defaultParams, options);
	}

	private resolveExitStrategyCandidates(
		options: FinderOptions,
		selectedStrategies: FinderSelectedStrategy[]
	): FinderSelectedStrategy[] | undefined {
		if (!options.exitStrategyOverrideEnabled) {
			return undefined;
		}
		if (selectedStrategies.length === 0) {
			options.exitStrategyOverrideEnabled = false;
			return undefined;
		}
		return selectedStrategies;
	}

	private setLatestResults(results: FinderLatestResults): void {
		this.latestResults = results;
	}

	private getCurrentChartResults(): FinderResult[] {
		return this.latestResults.scope === 'current_chart' ? this.latestResults.results : [];
	}

	private getUniverseResults(): FinderUniverseCandidate[] {
		return this.latestResults.scope === 'symbol_universe' ? this.latestResults.results : [];
	}

	private buildFallbackDiagnostics(args: {
		options: FinderOptions;
		results: FinderResult[];
		selectedStrategies: FinderSelectedStrategy[];
		ohlcvData: OHLCVData[];
		elapsedMs: number;
		requiresTsEngine: boolean;
	}): FinderDiagnostics {
		const engineMode = args.options.polymarketScoringEnabled
			? (isSecondMarketPolymarketSupported(state.currentSymbol, state.currentInterval) ? 'second_market_polymarket' : 'polymarket')
			: args.options.mode === 'genetic'
				? 'genetic'
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
				polymarketEvaluation: 0,
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
				polymarketEvaluation: 0,
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

	private combineFailureBreakdown(parts: FinderDiagnostics[]): FinderFailureDiagnostics[] | undefined {
		const byReason = new Map<string, { runs: number; strategyKeys: Set<string> }>();
		for (const part of parts) {
			for (const failure of part.failureBreakdown ?? []) {
				let entry = byReason.get(failure.reason);
				if (!entry) {
					entry = { runs: 0, strategyKeys: new Set<string>() };
					byReason.set(failure.reason, entry);
				}
				entry.runs += failure.runs;
				failure.strategyKeys.forEach((key) => entry.strategyKeys.add(key));
			}
		}
		if (byReason.size === 0) return undefined;
		return [...byReason.entries()]
			.map(([reason, entry]) => ({
				reason,
				runs: entry.runs,
				strategyKeys: [...entry.strategyKeys].sort(),
			}))
			.sort((a, b) => b.runs - a.runs || a.reason.localeCompare(b.reason));
	}

	private combineUniverseStrategyBreakdown(parts: FinderDiagnostics[]): FinderStrategyDiagnostics[] {
		const strategyBreakdown = parts.flatMap((part) => part.strategyBreakdown);
		const totalMs = strategyBreakdown.reduce((sum, strategy) => sum + strategy.totalMs, 0);
		return strategyBreakdown
			.map((strategy) => ({
				...strategy,
				runtimePct: totalMs > 0 ? Number(((strategy.totalMs / totalMs) * 100).toFixed(2)) : 0,
			}))
			.sort((a, b) => b.avgTotalMs - a.avgTotalMs);
	}

	private combineUniverseDiagnostics(parts: FinderDiagnostics[]): FinderDiagnostics["universe"] | undefined {
		const universeParts = parts
			.map((part) => part.universe)
			.filter((universe): universe is NonNullable<FinderDiagnostics["universe"]> => Boolean(universe));
		if (universeParts.length === 0) return undefined;

		const failedSymbols = new Map<string, string>();
		for (const universe of universeParts) {
			for (const failure of universe.failedSymbols) {
				if (!failedSymbols.has(failure.symbol)) {
					failedSymbols.set(failure.symbol, failure.reason);
				}
			}
		}

		return {
			totalSymbols: Math.max(...universeParts.map((universe) => universe.totalSymbols)),
			loadedSymbols: Math.max(...universeParts.map((universe) => universe.loadedSymbols)),
			failedSymbols: [...failedSymbols.entries()]
				.map(([symbol, reason]) => ({ symbol, reason }))
				.sort((a, b) => a.symbol.localeCompare(b.symbol)),
			dataWindow: universeParts
				.slice()
				.reverse()
				.find((universe) => universe.dataWindow)?.dataWindow,
		};
	}

	private buildCombinedUniverseDiagnostics(args: {
		options: FinderOptions;
		parts: FinderDiagnostics[];
		shownResults: number;
		elapsedMs: number;
	}): FinderDiagnostics {
		const timings = createEmptyFinderDiagnosticsTimings();
		for (const part of args.parts) {
			for (const key of Object.keys(timings) as Array<keyof typeof timings>) {
				timings[key] += part.timingsMs[key] ?? 0;
			}
		}
		timings.total = args.elapsedMs;

		return buildFinderDiagnostics({
			runId: createFinderRunId("finder-universe"),
			symbol: "SYMBOL_UNIVERSE",
			interval: state.currentInterval,
			mode: args.options.mode,
			engineMode: "symbol_universe",
			inputBars: Math.max(...args.parts.map((part) => part.data.inputBars)),
			evaluationBars: Math.max(...args.parts.map((part) => part.data.evaluationBars)),
			selectedStrategies: args.parts.reduce((sum, part) => sum + part.data.selectedStrategies, 0),
			totalParamRuns: args.parts.reduce((sum, part) => sum + part.data.totalParamRuns, 0),
			batchSize: Math.max(...args.parts.map((part) => part.data.batchSize)),
			processedRuns: args.parts.reduce((sum, part) => sum + part.counts.processedRuns, 0),
			filteredRuns: args.parts.reduce((sum, part) => sum + part.counts.filteredRuns, 0),
			shownResults: args.shownResults,
			endpointAdjusted: args.parts.reduce((sum, part) => sum + part.counts.endpointAdjusted, 0),
			failedRuns: args.parts.reduce((sum, part) => sum + part.counts.failedRuns, 0),
			skippedRuns: args.parts.reduce((sum, part) => sum + part.counts.skippedRuns, 0),
			timings,
			strategyBreakdown: this.combineUniverseStrategyBreakdown(args.parts),
			failureBreakdown: this.combineFailureBreakdown(args.parts),
			universeDiagnostics: this.combineUniverseDiagnostics(args.parts),
		});
	}

	private renderLatestResults(): void {
		if (this.getScope() === 'symbol_universe') {
			const results = this.latestResults.scope === 'symbol_universe' ? this.latestResults.results : [];
			this.ui.renderUniverseResults(results);
			return;
		}
		const results = this.latestResults.scope === 'current_chart' ? this.latestResults.results : [];
		this.ui.renderResults(results);
	}

	private buildCurrentChartMetadataPayload(result: FinderResult, rank: number) {
		const strategy = strategyRegistry.get(result.key);
		const displayedResult = result.selectionResult;
		return {
			scope: 'current_chart' as const,
			rank,
			strategyId: result.key,
			strategyName: result.name,
			timeframes: result.timeframes ?? [state.currentInterval],
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
			},
			endpointAdjusted: result.endpointAdjusted,
			endpointRemovedTrades: result.endpointRemovedTrades,
			exitStrategy: result.exitStrategyKey ? {
				key: result.exitStrategyKey,
				params: result.exitStrategyParams ?? {},
			} : null,
			polymarketEval: result.polymarketEval ?? null,
		};
	}

	private buildUniverseMetadataPayload(result: FinderUniverseCandidate, rank: number) {
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
				medianNetProfit: result.medianNetProfit,
				worstNetProfit: result.worstNetProfit,
				bestNetProfit: result.bestNetProfit,
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
					winningTrades: symbolResult.result.winningTrades,
					losingTrades: symbolResult.result.losingTrades,
					avgWin: symbolResult.result.avgWin,
					avgLoss: symbolResult.result.avgLoss,
					sharpeRatio: symbolResult.result.sharpeRatio,
				} : null,
			})),
		};
	}

	private async copyTopResultsMetadata(): Promise<void> {
		const chartResults = this.getCurrentChartResults();
		const universeResults = this.getUniverseResults();
		if (chartResults.length === 0 && universeResults.length === 0) {
			uiManager.showToast('No results to copy', 'info');
			return;
		}

		const payload = this.latestResults.scope === 'current_chart'
			? chartResults.map((result, index) => this.buildCurrentChartMetadataPayload(result, index + 1))
			: universeResults.map((result, index) => this.buildUniverseMetadataPayload(result, index + 1));

		try {
			await this.copyTextToClipboard(JSON.stringify(payload, null, 2));
			uiManager.showToast('Top results metadata copied', 'success');
		} catch (error) {
			debugLogger.error('finder.copy_metadata_failed', { error: error instanceof Error ? error.message : String(error) });
			uiManager.showToast('Copy failed - check browser permissions', 'error');
		}
	}

	private async copyTextToClipboard(text: string): Promise<void> {
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

	private async copyFinderDiagnostics(): Promise<void> {
		if (!this.latestDiagnostics) {
			uiManager.showToast('No Finder diagnostics to copy', 'info');
			return;
		}

		try {
			await this.copyTextToClipboard(JSON.stringify(buildCompactFinderDiagnostics(this.latestDiagnostics), null, 2));
			uiManager.showToast('Compact Finder diagnostics copied', 'success');
		} catch (error) {
			debugLogger.error('finder.copy_diagnostics_failed', { error: error instanceof Error ? error.message : String(error) });
			uiManager.showToast('Copy failed - check browser permissions', 'error');
		}
	}

	private async applyCurrentChartResult(result: FinderResult): Promise<void> {
		const isPolymarketResult = Boolean(result.polymarketEval);

		setCurrentStrategyKey(result.key);
		uiManager.updateStrategyDropdown(result.key);
		const strategy = strategyRegistry.get(result.key);
		if (!strategy) return;
		paramManager.render(strategy);
		paramManager.setValues(strategy, result.params);

		this.applyFinderBacktestSettings(result.params, result.polymarketEval, result.exitStrategyKey, result.exitStrategyParams);
		strategyPanelController.switchTab('trades');

		if (result.endpointAdjusted) {
			uiManager.showToast(
				'Finder ranked this row on an endpoint-adjusted selection snapshot. Running the raw backtest now.',
				'info'
			);
		}

		try {
			const snapshot = this.lastFinderEvaluationData?.interval === state.currentInterval
				? this.cloneOhlcvData(this.lastFinderEvaluationData.data)
				: null;
			await backtestService.runCurrentBacktest(snapshot
				? { dataOverride: snapshot, reason: 'finder_apply_snapshot' }
				: undefined);
			if (isPolymarketResult && result.polymarketEval) {
				uiManager.showToast(
					`Applied Polymarket params: ${(result.polymarketEval.winRate * 100).toFixed(1)}% Finder win rate, ${result.polymarketEval.scoredPredictions} scored predictions. Backtest trades refreshed below.`,
					'success'
				);
			}
		} catch (error) {
			debugLogger.error('finder.apply_result_backtest_failed', {
				strategyKey: result.key,
				strategyName: result.name,
				error: error instanceof Error ? error.message : String(error),
			});
			uiManager.showToast('Backtest rerun failed after applying Finder result.', 'error');
		}
	}

	private async applyUniverseCandidate(candidate: FinderUniverseCandidate): Promise<void> {
		setCurrentStrategyKey(candidate.strategyKey);
		uiManager.updateStrategyDropdown(candidate.strategyKey);
		const strategy = strategyRegistry.get(candidate.strategyKey);
		if (!strategy) return;

		paramManager.render(strategy);
		paramManager.setValues(strategy, candidate.params);
		this.applyFinderBacktestSettings(candidate.params, undefined, candidate.exitStrategyKey, candidate.exitStrategyParams);
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

	private applyFinderBacktestSettings(
		params: StrategyParams,
		polymarketEval?: FinderResult['polymarketEval'],
		exitStrategyKey?: string,
		exitStrategyParams?: StrategyParams
	): void {
		const baseSettings = this.lastFinderRunBacktestSettings
			? this.cloneBacktestSettings(this.lastFinderRunBacktestSettings)
			: settingsManager.getBacktestSettings();
		// `params` is already entry-only: buildFinderResult split exit params into
		// exitStrategyParams when it built the result. Merge directly.
		const mergedSettings = mergeFinderRiskParamsIntoBacktestSettings(baseSettings, params, this.lastFinderOptions ?? undefined);
		if (exitStrategyKey) {
			mergedSettings.disableSignalExits = true;
			mergedSettings.exitStrategyOverrideEnabled = true;
			mergedSettings.exitStrategyKey = exitStrategyKey;
			mergedSettings.exitStrategyParams = { ...(exitStrategyParams ?? {}) };
		}
		const effectiveMode = this.lastFinderOptions?.polymarketExitMode ?? 'resolve_hold';
		const applyPolymarketLimitEntrySettings = (): boolean => {
			if (!polymarketEval?.limitEntryEnabled) {
				return false;
			}
			mergedSettings.polymarketPostSignalLimitEntryEnabled = true;
			mergedSettings.polymarketPostSignalLimitEntryMode = resolvePolymarketPostSignalLimitEntryMode(
				polymarketEval.limitEntryMode
			);
			mergedSettings.polymarketPostSignalLimitEntryPriceCents = clampPolymarketPostSignalLimitEntryPriceCents(
				polymarketEval.limitEntryPriceCents ?? mergedSettings.polymarketPostSignalLimitEntryPriceCents
			);
			mergedSettings.polymarketPostSignalLimitEntryOffsetCents = clampPolymarketPostSignalLimitOffsetCents(
				polymarketEval.limitEntryOffsetCents ?? mergedSettings.polymarketPostSignalLimitEntryOffsetCents
			);
			mergedSettings.polymarketPostSignalLimitExitEnabled = polymarketEval.limitExitEnabled === true;
			mergedSettings.polymarketPostSignalLimitExitMode = resolvePolymarketPostSignalLimitExitMode(
				polymarketEval.limitExitMode
			);
			mergedSettings.polymarketPostSignalLimitExitPriceCents = clampPolymarketPostSignalLimitExitPriceCents(
				polymarketEval.limitExitPriceCents ?? mergedSettings.polymarketPostSignalLimitExitPriceCents
			);
			mergedSettings.polymarketPostSignalLimitExitOffsetCents = clampPolymarketPostSignalLimitOffsetCents(
				polymarketEval.limitExitOffsetCents ?? mergedSettings.polymarketPostSignalLimitExitOffsetCents
			);
			return true;
		};
		if (isSameEventPolymarketExitMode(effectiveMode)) {
			mergedSettings.polymarketAnnotationEnabled = true;
			mergedSettings.polymarketExitMode = effectiveMode;
			mergedSettings.polymarketSignalExitAllowMultipleTradesPerEvent = this.lastFinderOptions?.polymarketSignalExitAllowMultipleTradesPerEvent === true;
			applyPolymarketLimitEntrySettings();
		} else if (polymarketEval && isSecondMarketPolymarketSupported(state.currentSymbol, state.currentInterval)) {
			mergedSettings.polymarketAnnotationEnabled = true;
		} else if (applyPolymarketLimitEntrySettings()) {
			mergedSettings.polymarketAnnotationEnabled = true;
		} else if (Number.isFinite(params.polymarketEntryOffset)) {
			mergedSettings.polymarketEntryOffset = Math.max(0, Math.min(4, Math.round(Number(params.polymarketEntryOffset))));
			if (polymarketEval) {
				mergedSettings.polymarketAnnotationEnabled = true;
			}
		}
		settingsManager.applyBacktestSettings(mergedSettings);
	}

	private setProgress(active: boolean, percent: number, text: string): void {
		this.ui.setProgress(active, percent, text);
	}

	private setStatus(text: string): void {
		this.ui.setStatus(text);
	}

	private cloneBacktestSettings<T>(settings: T): T {
		return cloneJsonCompatible(settings);
	}

	private cloneOhlcvData(data: OHLCVData[]): OHLCVData[] {
		return data.map((candle) => ({ ...candle }));
	}

	public getLatestResults(): FinderLatestResults {
		return this.cloneBacktestSettings(this.latestResults);
	}

	public getLatestCandidate(): FinderResult | FinderUniverseCandidate | null {
		if (this.latestResults.results.length === 0) return null;
		return this.cloneBacktestSettings(this.latestResults.results[0]);
	}

	public getLastRunBacktestSettings(): ReturnType<typeof settingsManager.getBacktestSettings> | null {
		return this.lastFinderRunBacktestSettings
			? this.cloneBacktestSettings(this.lastFinderRunBacktestSettings)
			: null;
	}
}

export const finderManager = new FinderManager();








