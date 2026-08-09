import { StrategyParams, type OHLCVData } from "./strategies/index";
import { strategyRegistry, getStrategyList, loadBuiltInStrategyByKey, ensureStrategyKeysLoaded, getStrategyKind, getStrategyKindTitle } from "../strategyRegistry";
import { state } from "./state";
import { backtestService } from "./backtest-service";
import { paramManager } from "./param-manager";
import { uiManager } from "./ui-manager";
import { setVisible } from "./dom-utils";
import { dataManager } from "./data-manager";
import { settingsManager } from "./settings-manager";
import { readPersistedJson, writePersistedJson } from "./persisted-json";
import { getLocalDailyAssets, isMarkedLocalStockSymbol } from "./local-daily-datasets";
import { cloneJsonCompatible, parseJsonPreservingNonFinite } from "./json-utils";

import { FINDER_SORT_OPTIONS, METRIC_FULL_LABELS, UNIVERSE_METRIC_FULL_LABELS } from "./finder/constants";
import { buildFinderEvaluationData, runFinderExecution, type FinderSelectedStrategy } from "./finder/finder-runner";
import { FinderParamSpace } from "./finder/finder-param-space";
import { FinderUI } from "./finder/finder-ui";
import {
	buildFinderOptions,
	buildFinderUniverseOptions,
	normalizeFinderDataSlice,
	resolveOosDataSlice,
	sliceFinderDataWindow,
} from "./finder/finder-manager-logic";
import { sortFinderResults } from "./finder/finder-engine";
import {
	mergeFinderRiskParamsIntoBacktestSettings,
} from "./finder/finder-runner-core";
import { runCandidateOosPass } from "./finder/finder-candidate-oos";
import { runStrategyQualityAudit } from "./finder/finder-strategy-quality";
import { getBatchDatasetCacheStats, loadBatchDataset } from "./batch-backtest/batch-backtest-loader";
import {
	sortFinderUniverseCandidates,
} from "./finder/finder-universe-metrics";
import {
	sortAssetOpportunityResults,
	sortAssetOpportunityResultsByMetric,
	getAssetOpportunityResortMetrics,
	retainAssetOpportunityResultsForSymbols,
} from "./finder/finder-asset-opportunity-metrics";
import {
	compactFinderLatestResults,
	normalizeFinderLatestResultsSnapshot,
} from "./finder/finder-result-snapshot";
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
import {
	DEFAULT_FINDER_ASSET_OOS_HORIZONS,
	normalizeFinderAssetOosHorizons,
	normalizeFinderAssetOosIgnoreLastBars,
} from "./finder/finder-asset-opportunity-oos";
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
	FinderAssetOpportunityResult,
	FinderStrategyQualityDiagnostics,
	FinderStrategyQualityResult,
	FinderUniverseCandidate,
	FinderUniverseMetric,
} from './types/finder';
import { isSmartTradeSizingMode, type CapitalSettings } from "./types/backtest";
import type { BacktestSettings } from "./types/strategies";

const QUOTE_SUFFIXES = ['USDT', 'BUSD', 'USDC', 'FDUSD', 'TUSD', 'BTC', 'ETH', 'BNB', 'EUR', 'TRY', 'BRL'];
const MAJOR_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "ADAUSDT"] as const;
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
	// Diamond-marked legs are offline stock_market_data tickers and must NOT
	// be funneled through resolveToBinanceSymbol, which appends `USDT` to
	// bare tokens — that would strip the marker's self-resolving provider
	// hint and route the fetch to Binance.
	return {
		baseSymbol: isMarkedLocalStockSymbol(baseRaw) ? baseRaw : resolveToBinanceSymbol(baseRaw),
		quoteSymbol: isMarkedLocalStockSymbol(quoteRaw) ? quoteRaw : resolveToBinanceSymbol(quoteRaw),
	};
}

/**
 * Outcome of a server-owned Finder Universe job, returned by
 * `runUniverseFinderServer`. The server owns IS evaluation, survivor merge,
 * and OOS; the browser only renders. `oosRemoved` reflects the server-side
 * OOS aggregate-fail filter count (0 when OOS is disabled).
 */
interface ServerUniverseRunOutcome {
	results: FinderUniverseCandidate[];
	diagnostics: FinderDiagnostics | null;
	loadedSymbols: number;
	failedSymbolCount: number;
	oosRemoved: number;
}

interface ServerAssetOpportunityRunOutcome {
	results: FinderAssetOpportunityResult[];
	diagnostics: FinderDiagnostics | null;
	assetDiagnostics: FinderDiagnostics['assetOpportunity'] | null;
	assetsWithFreshEntry: number;
	failedAssets: number;
}

import { isSameEventPolymarketExitMode, resolveEffectivePolymarketExitMode } from "./polymarket-exit-mode";
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
import { consumeNdjsonStream } from "./ndjson-stream";
import { shouldUseRustEngine } from "./engine-preferences";
import type {
	FinderAssetOpportunityStreamEvent,
	FinderRunStatusSnapshot,
	FinderStreamEvent,
} from "./finder/server/finder-stream-types";

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
	randomizePathExitParams: boolean;
	exitStrategyOverrideEnabled: boolean;
	tradeFilterEnabled: boolean;
	minTrades: number;
	maxTradesText: string;
	polymarketScoringEnabled: boolean;
	polymarketRankMode: PolymarketFinderRankMode;
	polymarketMinScoredPredictions: number;
	polymarketLockOffset: boolean;
	polymarketAfterTakeProfitOnly: boolean;
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
	assetOpportunityOosIgnoreLastBars: number;
	assetOpportunityOosHorizons: string;
};

const FINDER_UI_STORAGE = {
	key: "playground_finder_ui",
	schema: "finder.ui",
	version: 1,
} as const;
const FINDER_RESULTS_STORAGE = {
	key: "playground_finder_latest_results",
	schema: "finder.latest_results",
	version: 1,
} as const;
/**
 * Persisted active server-run id for Symbol Universe reattachment. Written
 * BEFORE `fetch('/api/finder/universe-run')` so a tab reload during a run
 * can identify the same server job and poll `/api/finder/status?runId=...`
 * to recover progress + final results. Cleared only after a matching
 * terminal response, explicit Stop, or a confirmed missing server job.
 *
 * Schema version 1: just the run id + the scope that initiated it (so a
 * current-chart reload cannot adopt a universe server snapshot).
 */
const FINDER_ACTIVE_SERVER_RUN_STORAGE = {
	key: "playground_finder_active_server_run",
	schema: "finder.active_server_run",
	version: 1,
} as const;

type FinderPersistedResultsState = {
	savedAt: number;
	symbol: string;
	interval: string;
	results: FinderLatestResults;
};

type FinderPersistedActiveServerRun = {
	runId: string;
	scope: 'symbol_universe' | 'asset_opportunity';
	startedAt: number;
};

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
	randomizePathExitParams: false,
	exitStrategyOverrideEnabled: false,
	tradeFilterEnabled: true,
	minTrades: 40,
	maxTradesText: "",
	polymarketScoringEnabled: false,
	polymarketRankMode: "balanced",
	polymarketMinScoredPredictions: 100,
	polymarketLockOffset: false,
	polymarketAfterTakeProfitOnly: false,
	oosValidationEnabled: false,
	universeSymbolsText: "",
	universeMinActiveSymbols: 2,
	universeMinTotalTrades: 40,
	universeMinProfitableActiveRatio: 0.5,
	universeSort: "robustUniverseScore",
	universeSortSecondary: "windowStabilityScore",
	assetOpportunityCandidatePoolSize: 10,
	assetOpportunityMinFreshSupport: 2,
	assetOpportunityOosIgnoreLastBars: 0,
	assetOpportunityOosHorizons: DEFAULT_FINDER_ASSET_OOS_HORIZONS.join(","),
};

const UNIVERSE_SORT_OPTIONS: readonly FinderUniverseMetric[] = [
    "robustUniverseScore",
    "windowStabilityScore",
    "profitableActiveRatio",
    "medianExpectancy",
    "medianExpectancyWeightedTrades",
    "medianSharpe",
    "medianProfitFactor",
    "medianProfitFactorWeightedTrades",
    "medianCompositeEdgeRatio",
    "worstMaxDrawdownPercent",
    "medianMaxDrawdownPercent",
    "medianReturnDrawdownRatio",
    "worstNetProfit",
    "totalTrades",
    "activeSymbols",
] as const;
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
	return value === "symbol_universe" || value === "asset_opportunity" || value === "strategy_quality"
		? value
		: "current_chart";
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
	const assetOpportunityCandidatePoolSize = typeof source.assetOpportunityCandidatePoolSize === "number"
		? Math.max(1, Math.min(50, Math.round(source.assetOpportunityCandidatePoolSize)))
		: DEFAULT_FINDER_UI_STATE.assetOpportunityCandidatePoolSize;
	const assetOpportunityMinFreshSupport = typeof source.assetOpportunityMinFreshSupport === "number"
		? Math.max(1, Math.min(50, Math.round(source.assetOpportunityMinFreshSupport)))
		: DEFAULT_FINDER_UI_STATE.assetOpportunityMinFreshSupport;
	const assetOpportunityOosIgnoreLastBars = normalizeFinderAssetOosIgnoreLastBars(
		source.assetOpportunityOosIgnoreLastBars,
	);
	const assetOpportunityOosHorizons = normalizeFinderAssetOosHorizons(
		source.assetOpportunityOosHorizons,
	).join(",");

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
		randomizePathExitParams: source.randomizePathExitParams === true,
		exitStrategyOverrideEnabled: source.exitStrategyOverrideEnabled === true,
		tradeFilterEnabled: source.tradeFilterEnabled !== false,
		minTrades: Math.round(normalizeNumber(source.minTrades, DEFAULT_FINDER_UI_STATE.minTrades, 0)),
		maxTradesText: normalizeOptionalNumberText(source.maxTradesText),
		polymarketScoringEnabled: source.polymarketScoringEnabled === true,
		polymarketRankMode: normalizePolymarketRankMode(source.polymarketRankMode),
		polymarketMinScoredPredictions: Math.round(normalizeNumber(source.polymarketMinScoredPredictions, DEFAULT_FINDER_UI_STATE.polymarketMinScoredPredictions, 0)),
		polymarketLockOffset: source.polymarketLockOffset === true,
		polymarketAfterTakeProfitOnly: source.polymarketAfterTakeProfitOnly === true,
		oosValidationEnabled: source.oosValidationEnabled === true,
		universeSymbolsText: typeof source.universeSymbolsText === "string" ? source.universeSymbolsText : "",
		universeMinActiveSymbols: minActiveSymbols,
		universeMinTotalTrades: minTotalTrades,
		universeMinProfitableActiveRatio: minProfitableActiveRatio,
		universeSort: normalizeFinderUniverseMetric(source.universeSort, DEFAULT_FINDER_UI_STATE.universeSort),
		universeSortSecondary: normalizeFinderUniverseMetric(source.universeSortSecondary, DEFAULT_FINDER_UI_STATE.universeSortSecondary),
		assetOpportunityCandidatePoolSize,
		assetOpportunityMinFreshSupport,
		assetOpportunityOosIgnoreLastBars,
		assetOpportunityOosHorizons,
	};
}

export class FinderManager {
	private isRunning = false;
	private isCancelled = false;
	private latestResults: FinderLatestResults = { scope: "current_chart", results: [] };
	/** Full scalar Asset Opportunity rows for the current run. */
	private assetOpportunityRunResults: FinderAssetOpportunityResult[] = [];
	/** Default-order full rows used when the re-sort control is reset. */
	private assetOpportunityDefaultResults: FinderAssetOpportunityResult[] = [];
	/**
	 * Snapshot of the run-time sorted results before any post-run re-sort was
	 * applied. Used to restore the original ordering when the re-sort dropdown
	 * is reset to "Run Sort". Set on every run completion and cleared on start.
	 */
	private originalLatestResults: FinderLatestResults | null = null;
	private latestDiagnostics: FinderDiagnostics | null = null;
	private latestAssetOpportunityDiagnostics: FinderDiagnostics['assetOpportunity'] | null = null;
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
	/**
	 * Active server-run id for the Symbol Universe job currently in flight
	 * (or null). Acts as the ownership token: every stream + poll callback
	 * checks `this.activeServerRunId === runId` before mutating UI state so a
	 * stale tab cannot clobber a newer run.
	 */
	private activeServerRunId: string | null = null;
	/**
	 * Reattach poller state. `reattachPollingStopped` is the cancel token;
	 * `reattachTimerResolve` lets Stop / a new Run unblock a pending poll
	 * sleep immediately.
	 */
	private reattachPollingStopped = false;
	private reattachTimer: ReturnType<typeof setTimeout> | null = null;
	private reattachTimerResolve: (() => void) | null = null;

	private getDom(): FinderManagerDom {
		return this.dom ??= createFinderManagerDom();
	}

	public invalidateLocalDataCaches(): void {
		// Universe synthetic leg/pair caches now live in the Vite server. Keep
		// the existing invalidation contract used by IBKR/Crypto data sync so a
		// subsequent Finder run cannot reuse an in-memory series built before the
		// local files changed. Disk entries remain fingerprint-validated.
		void fetch('/api/finder/invalidate-cache', { method: 'POST' }).catch((error) => {
			debugLogger.warn('finder.server.dataset_cache_invalidation_failed', {
				error: error instanceof Error ? error.message : String(error),
			});
		});
	}

	private getScope(): FinderScope {
		return this.uiState.scope;
	}

	private isUniverseScope(): boolean {
		return this.getScope() === "symbol_universe";
	}

	private isAssetOpportunityScope(): boolean {
		return this.getScope() === "asset_opportunity";
	}

	private isStrategyQualityScope(): boolean {
		return this.getScope() === "strategy_quality";
	}

	private usesUniverseStrategySelection(): boolean {
		return this.isUniverseScope() || this.isStrategyQualityScope();
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

	private loadPersistedLatestResults(): void {
		const snapshot = readPersistedJson<FinderPersistedResultsState | null>({
			...FINDER_RESULTS_STORAGE,
			fallback: null,
			migrate: ({ data }) => {
				if (!data || typeof data !== "object" || Array.isArray(data)) {
					return null;
				}
				const source = data as Partial<FinderPersistedResultsState>;
				const results = normalizeFinderLatestResultsSnapshot(source.results);
				if (!results || results.results.length === 0) {
					return null;
				}
				return {
					savedAt: typeof source.savedAt === "number" ? source.savedAt : 0,
					symbol: typeof source.symbol === "string" ? source.symbol : "",
					interval: typeof source.interval === "string" ? source.interval : "",
					results,
				};
			},
			onError: (error) => {
				debugLogger.error("finder.latest_results_load_failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			},
		});
		if (!snapshot) return;

		this.latestResults = snapshot.results;
		if (snapshot.results.scope === 'asset_opportunity') {
			this.assetOpportunityRunResults = [...snapshot.results.results];
			this.assetOpportunityDefaultResults = [...snapshot.results.results];
		}
		debugLogger.event("finder.latest_results_restored", {
			scope: snapshot.results.scope,
			count: snapshot.results.results.length,
			symbol: snapshot.symbol,
			interval: snapshot.interval,
			savedAt: snapshot.savedAt,
		});
	}

	private saveLatestResultsSnapshot(results: FinderLatestResults): void {
		if (results.results.length === 0) {
			return;
		}
		const snapshot: FinderPersistedResultsState = {
			savedAt: Date.now(),
			symbol: state.currentSymbol,
			interval: state.currentInterval,
			results: compactFinderLatestResults(results),
		};
		writePersistedJson({
			...FINDER_RESULTS_STORAGE,
			data: snapshot,
			onError: (error) => {
				debugLogger.error("finder.latest_results_save_failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			},
		});
	}

	private clearLatestResultsSnapshot(): void {
		writePersistedJson({
			...FINDER_RESULTS_STORAGE,
			data: null,
			onError: (error) => {
				debugLogger.error("finder.latest_results_clear_failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			},
		});
	}

	/**
	 * Generate a unique browser-side run id for a server Finder job. Used
	 * as the ownership token + persisted before fetch so a reload can
	 * identify the same server job.
	 */
	private generateServerRunId(): string {
		const rand = Math.random().toString(36).slice(2, 10);
		return `finder-${Date.now().toString(36)}-${rand}`;
	}

	/** Persist the active run id BEFORE fetch so a reload can reattach. */
	private persistActiveServerRun(runId: string, startTime: number, scope: FinderScope): void {
		writePersistedJson({
			...FINDER_ACTIVE_SERVER_RUN_STORAGE,
			data: { runId, scope: scope as 'symbol_universe' | 'asset_opportunity', startedAt: startTime },
			onError: (error) => {
				debugLogger.warn("finder.active_server_run_save_failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			},
		});
	}

	/** Clear the persisted active-run record (terminal / stop / missing). */
	private clearActiveServerRun(): void {
		writePersistedJson({
			...FINDER_ACTIVE_SERVER_RUN_STORAGE,
			data: null,
			onError: (error) => {
				debugLogger.warn("finder.active_server_run_clear_failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			},
		});
	}

	/** Read the persisted active-run record (or null). */
	private loadPersistedActiveServerRun(): FinderPersistedActiveServerRun | null {
		return readPersistedJson<FinderPersistedActiveServerRun | null>({
			...FINDER_ACTIVE_SERVER_RUN_STORAGE,
			fallback: null,
			migrate: ({ data }) => {
				if (!data || typeof data !== "object" || Array.isArray(data)) return null;
				const source = data as Partial<FinderPersistedActiveServerRun>;
				if (typeof source.runId !== "string" || !source.runId) return null;
				if (source.scope !== "symbol_universe" && source.scope !== "asset_opportunity") return null;
				return {
					runId: source.runId,
					scope: source.scope,
					startedAt: typeof source.startedAt === "number" ? source.startedAt : Date.now(),
				};
			},
			onError: () => {
				// Persisted-json read failures are non-fatal for reattach; just
				// skip reattachment. Don't spam the console on a missing key.
			},
		});
	}

	/** Cancel any in-flight reattach poll loop immediately. */
	private stopReattachPoll(): void {
		this.reattachPollingStopped = true;
		if (this.reattachTimer) {
			clearTimeout(this.reattachTimer);
			this.reattachTimer = null;
		}
		if (this.reattachTimerResolve) {
			this.reattachTimerResolve();
			this.reattachTimerResolve = null;
		}
	}

	private async stopActiveServerRun(runId: string): Promise<void> {
		try {
			const response = await fetch('/api/finder/stop', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ runId }),
			});
			if (!response.ok) {
				throw new Error(`status ${response.status}`);
			}
			// The matching run was stopped or no longer owns the server.
			this.clearActiveServerRun();
		} catch (error) {
			debugLogger.warn('finder.server.stop_failed', {
				runId,
				error: error instanceof Error ? error.message : String(error),
			});
			this.setStatus('Finder Stop could not reach the server; reload to reattach.');
		}
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


	private async populateUniverseWithLocalDailySeeds(): Promise<void> {
		const dom = this.getDom();
		dom.finderUniverseUseLocalSp500.disabled = true;

		try {
			const assets = (await getLocalDailyAssets()).filter((asset) => asset.provider !== "ibkr-local");
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
		dom.finderRandomizePathExitToggle.checked = this.uiState.randomizePathExitParams;
		dom.finderExitStrategyOverrideToggle.checked = this.uiState.exitStrategyOverrideEnabled;
		dom.finderTradesToggle.checked = this.uiState.tradeFilterEnabled;
		dom.finderTradesMin.value = String(this.uiState.minTrades);
		dom.finderTradesMax.value = this.uiState.maxTradesText;
		dom.finderPolymarketToggle.checked = this.uiState.polymarketScoringEnabled;
		dom.finderPolymarketRankMode.value = this.uiState.polymarketRankMode;
		dom.finderPolymarketMinScored.value = String(this.uiState.polymarketMinScoredPredictions);
		dom.finderPolymarketLockOffset.checked = this.uiState.polymarketLockOffset;
		dom.finderPolymarketAfterTakeProfitOnly.checked = this.uiState.polymarketAfterTakeProfitOnly;
		dom.finderOosValidationToggle.checked = this.uiState.oosValidationEnabled;
		dom.finderUniverseSymbols.value = this.uiState.universeSymbolsText;
		dom.finderUniverseMinActiveSymbols.value = String(this.uiState.universeMinActiveSymbols);
		dom.finderUniverseMinTotalTrades.value = String(this.uiState.universeMinTotalTrades);
		dom.finderUniverseMinProfitableActiveRatio.value = String(this.uiState.universeMinProfitableActiveRatio);
		dom.finderAssetCandidatePoolSize.value = String(this.uiState.assetOpportunityCandidatePoolSize);
		dom.finderAssetMinFreshSupport.value = String(this.uiState.assetOpportunityMinFreshSupport);
		dom.finderAssetOosIgnoreLastBars.value = String(this.uiState.assetOpportunityOosIgnoreLastBars);
		dom.finderAssetOosHorizons.value = this.uiState.assetOpportunityOosHorizons;
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
			// Cancel any in-flight reattach poll immediately so Stop changes UI
			// ownership before the next poll iteration.
			this.stopReattachPoll();
			// Server-owned Finder Universe: the job lives in the dev server, so
			// `this.isCancelled` alone does NOT stop it — the server checks
			// ownership loss + abort via POST /api/finder/stop with the active
			// run id (Stop is scoped by run id so a stale tab cannot cancel a
			// newer run). Fire-and-forget; only POST when a run is in flight
			// AND the active run id is known.
			const activeRunId = this.activeServerRunId;
			if (this.isRunning && activeRunId) {
				// Drop local ownership immediately so late stream callbacks cannot
				// mutate the stopped view. Keep the persisted marker until the server
				// confirms Stop; on a network failure a reload can still reattach.
				this.activeServerRunId = null;
				void this.stopActiveServerRun(activeRunId);
			}
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
			if (this.latestResults.scope === "asset_opportunity") {
				const assetResult = this.latestResults.results[index];
				if (assetResult) {
					void this.applyAssetOpportunityResult(assetResult);
				}
				return;
			}
			if (this.latestResults.scope === "strategy_quality") {
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
		this.initOosValidationUI();
		this.getDom().finderResort.addEventListener("change", () => this.applyResort());
		this.applyScopeUi();
		this.loadPersistedLatestResults();
		this.renderLatestResults();
		// Reattach to an in-flight or terminal server-owned Universe job after
		// a tab reload. Finder is lazy-loaded, so this runs on first Finder
		// activation (not global startup). No-op when there is no persisted
		// active run id.
		void this.reattachToActiveServerRun();
	}

	private initOosValidationUI(): void {
		const dom = this.getDom();
		const refresh = () => this.syncOosValidationControlState();
		dom.finderDataSlice.addEventListener('change', refresh);
		dom.finderPolymarketToggle.addEventListener('change', refresh);
		refresh();
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
			this.uiState.scope = normalizeFinderScope(dom.finderScope.value);
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
		const assetOpportunityScope = this.isAssetOpportunityScope();
		const qualityScope = this.isStrategyQualityScope();
		const multiAssetScope = universeScope || assetOpportunityScope || qualityScope;
		const modeInput = dom.finderMode;

		dom.finderChartSortSection.style.display = multiAssetScope ? "none" : "";
		dom.finderUniverseSortSection.style.display = universeScope ? "" : "none";
		dom.finderUniverseSectionHeader.style.display = multiAssetScope ? "" : "none";
		dom.finderUniverseSection.style.display = multiAssetScope ? "" : "none";
		dom.finderUniverseFilters.style.display = universeScope ? "" : "none";
		dom.finderAssetOpportunitySettings.style.display = assetOpportunityScope ? "" : "none";
		dom.finderQualitySettings.style.display = qualityScope ? "" : "none";
		dom.finderPolymarketSection.style.display = multiAssetScope ? "none" : "";
		dom.finderTradeFilterSection.style.display = universeScope ? "none" : "";
		dom.finderModeRow.classList.toggle("is-disabled", multiAssetScope);
		dom.finderStepsRow.style.display = multiAssetScope ? "none" : "";
		dom.finderDataSliceRow.style.display = "";
		dom.finderStrategyActions.classList.remove("is-disabled");
		dom.finderStrategiesToggleAll.disabled = false;
		dom.finderStrategySelectAll.disabled = false;
		dom.finderStrategySelectNone.disabled = false;
		dom.finderStrategyInvertVisible.disabled = this.getVisibleStrategyKeys().length === 0;
		dom.finderStrategySelectVisible.disabled = this.getVisibleStrategyKeys().length === 0;
		modeInput.disabled = multiAssetScope;
		if (multiAssetScope) {
			modeInput.value = "random";
		}
		setVisible("finderBlockBadge", !multiAssetScope && Boolean(state.blockRange));
		this.setTradeFilterControlsEnabled(this.isTradeFilterControlsEnabled());
		this.updateTimingSortControlState();
		this.syncOosValidationControlState();
		this.populateResortOptions();
	}

	/**
	 * Keeps the OOS Validation toggle visually + functionally in step with the
	 * conditions it depends on. OOS only applies to half data windows and is
	 * inert under Polymarket scoring, so the toggle is disabled otherwise to
	 * make the silent-ignore obvious (the prior behavior silently dropped the
	 * flag, which made it impossible to tell whether OOS was active).
	 */
	private syncOosValidationControlState(): void {
		const dom = this.getDom();
		const dataSlice = normalizeFinderDataSlice(dom.finderDataSlice.value);
		const halfWindowActive = dataSlice === 'half_oldest' || dataSlice === 'half_newest';
		const polymarketOn = dom.finderPolymarketToggle.checked;
		const applicable = halfWindowActive && !polymarketOn;
		dom.finderOosValidationToggle.disabled = !applicable;
		dom.finderOosValidationRow.classList.toggle('is-disabled', !applicable);
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
		return !this.isUniverseScope() && !this.isStrategyQualityScope() && dom.finderTradesToggle.checked;
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
			dom.finderRandomizePathExitToggle,
			dom.finderExitStrategyOverrideToggle,
			dom.finderTradesToggle,
			dom.finderTradesMin,
			dom.finderTradesMax,
			dom.finderPolymarketToggle,
			dom.finderPolymarketRankMode,
			dom.finderPolymarketMinScored,
			dom.finderPolymarketLockOffset,
			dom.finderPolymarketAfterTakeProfitOnly,
			dom.finderOosValidationToggle,
			dom.finderAssetCandidatePoolSize,
			dom.finderAssetMinFreshSupport,
			dom.finderAssetOosIgnoreLastBars,
			dom.finderAssetOosHorizons,
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
		this.uiState.randomizePathExitParams = dom.finderRandomizePathExitToggle.checked;
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
		this.uiState.oosValidationEnabled = dom.finderOosValidationToggle.checked;
		this.uiState.assetOpportunityCandidatePoolSize = Math.max(1, Math.min(50, Math.round(this.readFinderNumberInput(
			dom.finderAssetCandidatePoolSize,
			DEFAULT_FINDER_UI_STATE.assetOpportunityCandidatePoolSize,
			1,
		))));
		this.uiState.assetOpportunityMinFreshSupport = Math.max(1, Math.min(50, Math.round(this.readFinderNumberInput(
			dom.finderAssetMinFreshSupport,
			DEFAULT_FINDER_UI_STATE.assetOpportunityMinFreshSupport,
			1,
		))));
		this.uiState.assetOpportunityOosIgnoreLastBars = normalizeFinderAssetOosIgnoreLastBars(
			this.readFinderNumberInput(
				dom.finderAssetOosIgnoreLastBars,
				DEFAULT_FINDER_UI_STATE.assetOpportunityOosIgnoreLastBars,
				0,
			),
		);
		this.uiState.assetOpportunityOosHorizons = normalizeFinderAssetOosHorizons(
			dom.finderAssetOosHorizons.value,
		).join(",");
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
			|| this.isStrategyQualityScope()
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
		return this.usesUniverseStrategySelection()
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

		const selected = this.usesUniverseStrategySelection()
			? this.getUniverseSelectedStrategyKeys()
			: this.getCurrentChartSelectedStrategyKeys();
		if (checkbox.checked) {
			selected.add(strategyKey);
		} else {
			selected.delete(strategyKey);
		}
		if (this.usesUniverseStrategySelection()) {
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
		const selected = this.usesUniverseStrategySelection()
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
		if (this.usesUniverseStrategySelection()) {
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
		const selected = this.usesUniverseStrategySelection()
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
		if (this.usesUniverseStrategySelection()) {
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
		// Starting a new run cancels any stale reattach poll before changing
		// UI ownership so late poll updates cannot mutate the new run's state.
		this.stopReattachPoll();
		this.activeServerRunId = null;
		if (!this.isUniverseScope() && !this.isAssetOpportunityScope() && !this.isStrategyQualityScope() && state.ohlcvData.length === 0) {
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
		this.latestAssetOpportunityDiagnostics = null;
		this.originalLatestResults = null;
		this.assetOpportunityRunResults = [];
		this.assetOpportunityDefaultResults = [];
		this.clearLatestResultsSnapshot();

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
			if (typeof document !== 'undefined') {
				document.body.classList.toggle('finder-running', running);
			}
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
			scope: options.scope === 'symbol_universe'
				? 'symbol_universe'
				: options.scope === 'asset_opportunity'
					? 'asset_opportunity'
					: options.scope === 'strategy_quality' ? 'strategy_quality' : 'current_chart',
			results: [],
		});
		this.renderLatestResults();

		try {
			const completed = options.scope === 'symbol_universe'
				? await this.runUniverseFinder(options, startTime)
				: options.scope === 'asset_opportunity'
					? await this.runAssetOpportunityFinder(options, startTime)
					: options.scope === 'strategy_quality'
						? await this.runStrategyQualityFinder(options, startTime)
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
					// latestDiagnostics stays null on any mid-run failure, which
					// silently disables the Copy Diagnostics button exactly when
					// the user needs it most. Build a minimal diagnostics so the
					// user can copy and share why the run failed. Universe load
					// failures carry a per-symbol loadFailures map (richer detail);
					// any other failure (engine throw, OOS re-load error, etc.)
					// gets a minimal diagnostics with the error reason surfaced as
					// a bottleneck line.
					const loadFailures = (error as Error & { loadFailures?: Map<string, { error?: string }> }).loadFailures;
					if (loadFailures && loadFailures.size > 0) {
						this.latestDiagnostics = this.buildLoadFailureDiagnostics({
							options,
							elapsedMs: performance.now() - startTime,
							loadFailures,
						});
					} else {
						this.latestDiagnostics = this.buildRunFailureDiagnostics({
							options,
							elapsedMs: performance.now() - startTime,
							error: message,
						});
					}
					this.getDom().finderCopyDiagnostics.disabled = !this.latestDiagnostics;
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
		const exitStrategyCandidates = await this.resolveExitStrategyCandidates(options, selectedStrategies);
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
		const oosReport = await this.applyOosValidationIfNeeded({
			results: sortedResults,
			blockSlicedData,
			selectedStrategies,
			settings,
			capitalSettings,
			options,
			startTime,
		});
		const finalResults = oosReport?.filtered ?? sortedResults;
		this.setLatestResults({ scope: 'current_chart', results: finalResults });
		this.latestDiagnostics = output.diagnostics ?? this.buildFallbackDiagnostics({
			options,
			results: finalResults,
			selectedStrategies,
			ohlcvData,
			elapsedMs: performance.now() - startTime,
			requiresTsEngine,
		});
		this.getDom().finderCopyDiagnostics.disabled = !this.latestDiagnostics;
		this.stashAndResetResort();
		this.renderLatestResults();
		this.ui.renderRandomBenchmark(options.mode, output.randomBenchmark);

		if (!this.isCancelled) {
			const elapsed = Math.round(performance.now() - startTime);
			if (oosReport && oosReport.removedCount > 0) {
				this.setStatus(
					`Finder complete. ${finalResults.length} result${finalResults.length === 1 ? '' : 's'}`
					+ ` (${oosReport.removedCount} filtered by OOS gate) in ${elapsed}ms.`
				);
			} else {
				this.setStatus(`Finder complete. ${finalResults.length} result${finalResults.length === 1 ? '' : 's'} in ${elapsed}ms.`);
			}
		}
		return true;
	}

	/**
	 * Out-of-sample gate. After the normal Finder ranking produces its top-N survivors,
	 * each survivor is re-backtested on the complementary half of the data window. Any
	 * candidate that degrades (netProfit < 0 or profitFactor < 1.0) is filtered out;
	 * inconclusive OOS runs (too few trades) are kept and flagged. Returns null when the
	 * gate is not applicable (toggle off, non-half window, polymarket mode, cancelled).
	 *
	 * Delegates to the extracted `runCandidateOosPass` leaf so the Asset Opportunity
	 * server job reuses the identical OOS semantics.
	 */
	private async applyOosValidationIfNeeded(args: {
		results: FinderResult[];
		blockSlicedData: OHLCVData[];
		selectedStrategies: FinderSelectedStrategy[];
		settings: BacktestSettings;
		capitalSettings: CapitalSettings;
		options: FinderOptions;
		startTime: number;
	}): Promise<{ filtered: FinderResult[]; removedCount: number } | null> {
		const { results, blockSlicedData, selectedStrategies, settings, capitalSettings, options } = args;
		const dataSlice = options.dataSlice ?? 'all';
		if (!options.oosValidationEnabled) return null;
		const oosSlice = resolveOosDataSlice(dataSlice);
		if (!oosSlice) return null;
		if (results.length === 0) return { filtered: results, removedCount: 0 };

		const oosWindowData = sliceFinderDataWindow(blockSlicedData, oosSlice);
		const oosData = buildFinderEvaluationData(oosWindowData, state.currentInterval, settings);
		if (oosData.length === 0) {
			return { filtered: results, removedCount: 0 };
		}

		const strategyByKey = new Map(selectedStrategies.map((item) => [item.key, item.strategy]));
		const exitCandidatesForOos = await this.resolveExitStrategyCandidates(options, selectedStrategies);
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
			isCancelled: () => this.isCancelled,
			onProgress: (percent, text) => this.setProgress(true, percent, text),
			yieldControl: () => this.taskYielder.yieldControl(),
		});

		if (!report.applied) return null;
		return { filtered: report.filtered, removedCount: report.removedCount };
	}

	/**
	 * Reattach to an in-flight or terminal server-owned Finder job after a
	 * tab reload. Called from `init()` (Finder is lazy-loaded, so reattach
	 * begins when Finder initializes — not at global startup). Reads the
	 * persisted active run id; if the server still has a matching job,
	 * restores progress + Stop state, then polls summary-only status at a
	 * bounded interval (Batch's reattach pattern) until terminal. On terminal,
	 * adopts the authoritative candidate slice + diagnostics, renders,
	 * persists through the completed-results snapshot, and clears the
	 * active-run record.
	 *
	 * Reattach only survives a browser reload while the same Vite process
	 * remains alive; a Vite restart loses the in-memory job and the reattach
	 * clears its record.
	 */
	private async reattachToActiveServerRun(): Promise<void> {
		const persisted = this.loadPersistedActiveServerRun();
		if (!persisted) return;
		const runId = persisted.runId;

		// Probe whether the server still has this job.
		let initial: FinderRunStatusSnapshot | null = null;
		let confirmedMissing = false;
		try {
			const response = await fetch(`/api/finder/status?runId=${encodeURIComponent(runId)}`, { cache: "no-store" });
			if (response.ok) {
				initial = parseJsonPreservingNonFinite(await response.text()) as FinderRunStatusSnapshot;
			} else if (response.status === 404) {
				confirmedMissing = true;
			} else {
				return;
			}
		} catch {
			// Transient network error on the probe — leave the persisted record
			// intact; the user can reload again. Do not claim completion.
			return;
		}
		if (confirmedMissing || !initial || !initial.ok) {
			// Server has no matching job (Vite restart, or a different run
			// already completed). Clear the stale record so reattach doesn't
			// loop forever.
			this.clearActiveServerRun();
			return;
		}

		// The server job exists. Adopt it as the active run.
		this.activeServerRunId = runId;
		this.isRunning = true;
		this.isCancelled = false;
		this.reattachPollingStopped = false;
		const dom = this.getDom();
		// The persisted ownership record identifies the job kind. Restore
		// that scope before any terminal snapshot is adopted so it cannot replace
		// a current-chart view while the UI still claims current-chart scope.
		if (this.uiState.scope !== persisted.scope) {
			this.uiState.scope = persisted.scope;
			dom.finderScope.value = persisted.scope;
			this.applyScopeUi();
			this.saveUiState();
		}
		dom.runFinder.disabled = true;
		dom.stopFinder.style.display = "";
		// The persisted result snapshot belongs to the previous completed view,
		// not to this server job. Clear it before showing reattach progress so a
		// reload cannot display stale asset rows while the job is still running.
		this.originalLatestResults = null;
		this.assetOpportunityRunResults = [];
		this.assetOpportunityDefaultResults = [];
		this.clearLatestResultsSnapshot();
		this.setLatestResults({
			scope: persisted.scope,
			results: [],
		});
		this.renderLatestResults();
		debugLogger.event("finder.server.reattach_started", {
			runId,
			phase: initial.phase,
			terminal: initial.terminal,
		});

		const setRunningUI = (running: boolean) => {
			dom.runFinder.disabled = running;
			dom.runFinder.classList.toggle("is-loading", running);
			dom.runFinder.setAttribute("aria-busy", running ? "true" : "false");
			dom.stopFinder.style.display = running ? "" : "none";
		};

		this.setProgress(true, initial.progressPercent, initial.statusText);
		const jobLabel = persisted.scope === 'asset_opportunity' ? 'Asset Opportunity' : 'Universe Finder';
		this.setStatus(`Reattached to ${jobLabel}: ${initial.statusText}`);
		let clearPersistedRecord = false;
		let terminalReached = false;
		const applyTerminalSnapshot = (snapshot: FinderRunStatusSnapshot): void => {
			if (!snapshot.terminal || this.activeServerRunId !== runId) return;
			terminalReached = true;
			clearPersistedRecord = true;
			if (persisted.scope === 'asset_opportunity' && snapshot.terminalAssets) {
				this.assetOpportunityRunResults = sortAssetOpportunityResults([...snapshot.terminalAssets]);
				this.assetOpportunityDefaultResults = [...this.assetOpportunityRunResults];
				this.setLatestResults({
					scope: "asset_opportunity",
					results: this.assetOpportunityRunResults.slice(0, Math.max(1, this.uiState.topN)),
				});
				this.stashAndResetResort();
				this.renderLatestResults();
				this.latestDiagnostics = snapshot.diagnostics;
				this.latestAssetOpportunityDiagnostics = snapshot.assetDiagnostics ?? (snapshot.assetTotals
					? {
						totalAssets: snapshot.assetTotals.totalAssets,
						assetsWithFreshEntry: snapshot.assetTotals.assetsWithFreshEntry,
						assetsWithNoFreshEntry: Math.max(0, snapshot.assetTotals.totalAssets - snapshot.assetTotals.assetsWithFreshEntry - snapshot.assetTotals.failedAssets),
						selectGradeAssets: snapshot.assetTotals.selectGradeAssets,
						watchGradeAssets: snapshot.assetTotals.watchGradeAssets,
						rejectGradeAssets: snapshot.assetTotals.rejectGradeAssets,
						failedAssets: [],
						...(snapshot.assetTotals.engineUsage ? { engineUsage: snapshot.assetTotals.engineUsage } : {}),
					}
					: null);
				dom.finderCopyDiagnostics.disabled = !snapshot.diagnostics && !this.latestAssetOpportunityDiagnostics;
			} else if (snapshot.phase === "done" && snapshot.terminalCandidates) {
				// The server slice is already sorted and bounded with the original
				// run options. Those options are not available after a reload.
				this.setLatestResults({
					scope: "symbol_universe",
					results: [...snapshot.terminalCandidates],
				});
				this.renderLatestResults();
				this.latestDiagnostics = snapshot.diagnostics;
				dom.finderCopyDiagnostics.disabled = !snapshot.diagnostics;
			}
			this.setStatus(snapshot.error ?? snapshot.summary ?? snapshot.statusText);
			debugLogger.event("finder.server.reattach_terminal", {
				runId,
				phase: snapshot.phase,
				candidates: snapshot.terminalCandidates?.length ?? 0,
				assets: snapshot.terminalAssets?.length ?? 0,
			});
		};
		applyTerminalSnapshot(initial);

		const POLL_INTERVAL_MS = 2000;
		const LONG_POLL_INTERVAL_MS = 5000;
		const FAST_POLL_COUNT = 150; // 5 min at 2s before stepping down
		const FAILURE_BACKOFF_MS = [2_000, 5_000, 10_000, 15_000] as const;
		const MAX_REATTACH_CONSECUTIVE_FAILURES = 20;
		let consecutiveFailures = 0;

		const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => {
			this.reattachTimerResolve = resolve;
			this.reattachTimer = setTimeout(resolve, ms);
		});

		for (let poll = 0; !terminalReached; poll += 1) {
			if (this.reattachPollingStopped || this.activeServerRunId !== runId) break;
			const delay = poll >= FAST_POLL_COUNT ? LONG_POLL_INTERVAL_MS : POLL_INTERVAL_MS;
			await sleep(delay);
			if (this.reattachPollingStopped || this.activeServerRunId !== runId) break;

			let snapshot: FinderRunStatusSnapshot | null = null;
			try {
				const response = await fetch(`/api/finder/status?runId=${encodeURIComponent(runId)}`, { cache: "no-store" });
				if (!response.ok) {
					// 404 means the server job is gone (restart). Stop polling
					// and clear the record; don't claim completion.
					if (response.status === 404) {
						clearPersistedRecord = true;
						this.setStatus("Server Finder run lost (dev server restarted).");
						break;
					}
					throw new Error(`status ${response.status}`);
				}
				snapshot = parseJsonPreservingNonFinite(await response.text()) as FinderRunStatusSnapshot;
			} catch (error) {
				if (this.reattachPollingStopped || this.activeServerRunId !== runId) break;
				consecutiveFailures += 1;
				debugLogger.warn("finder.server.reattach_poll_failed", {
					runId,
					consecutive: consecutiveFailures,
					error: error instanceof Error ? error.message : String(error),
				});
				if (consecutiveFailures > MAX_REATTACH_CONSECUTIVE_FAILURES) {
					this.setStatus("Server connection lost — reload to retry Universe Finder reattach.");
					break;
				}
				const backoffIndex = Math.min(consecutiveFailures - 1, FAILURE_BACKOFF_MS.length - 1);
				poll -= 1; // don't advance into long-poll step-down due to retries
				await sleep(FAILURE_BACKOFF_MS[backoffIndex]!);
				continue;
			}

			consecutiveFailures = 0;
			if (!snapshot || !snapshot.ok) {
				// Server no longer has this run id — stop and clear.
				clearPersistedRecord = true;
				this.setStatus("Server Finder run no longer active.");
				break;
			}

			// Update progress from the summary-only snapshot (no candidate
			// payload while running).
			this.setProgress(true, snapshot.progressPercent, snapshot.statusText);
			this.setStatus(`${jobLabel}: ${snapshot.statusText}`);

			applyTerminalSnapshot(snapshot);
		}

		// Teardown: only the reattach path that still owns the run id clears it.
		if (this.activeServerRunId === runId) {
			this.activeServerRunId = null;
			if (clearPersistedRecord) {
				this.clearActiveServerRun();
			}
		}
		this.reattachTimer = null;
		this.reattachTimerResolve = null;
		this.isRunning = false;
		this.isCancelled = false;
		setRunningUI(false);
		this.setProgress(false, 0, "");
	}

	/**
	 * Recover the initiating tab when its NDJSON connection ends before the
	 * terminal event. The server job keeps running, so poll the scoped status
	 * endpoint instead of treating provisional streamed candidates as final or
	 * allowing a replacement run to orphan the active server job.
	 */
	private async recoverActiveServerRun(
		runId: string,
		jobKind: 'symbol_universe' | 'asset_opportunity',
	): Promise<FinderRunStatusSnapshot | null> {
		const FAILURE_BACKOFF_MS = [2_000, 5_000, 10_000, 15_000] as const;
		const MAX_CONSECUTIVE_FAILURES = 20;
		let consecutiveFailures = 0;

		while (this.activeServerRunId === runId) {
			try {
				const response = await fetch(`/api/finder/status?runId=${encodeURIComponent(runId)}`, { cache: "no-store" });
				if (response.status === 404) return null;
				if (!response.ok) throw new Error(`status ${response.status}`);
				const snapshot = parseJsonPreservingNonFinite(await response.text()) as FinderRunStatusSnapshot;
				if (!snapshot.ok) return null;
				consecutiveFailures = 0;
				if (snapshot.terminal) {
					debugLogger.warn("finder.server.stream_recovered_via_status", {
						runId,
						phase: snapshot.phase,
						candidates: snapshot.terminalCandidates?.length ?? 0,
						assets: snapshot.terminalAssets?.length ?? 0,
					});
					return snapshot;
				}
				this.setProgress(true, snapshot.progressPercent, snapshot.statusText);
				this.setStatus(`${jobKind === 'asset_opportunity' ? 'Asset Opportunity' : 'Universe Finder'}: ${snapshot.statusText}`);
				await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
			} catch (error) {
				consecutiveFailures += 1;
				debugLogger.warn("finder.server.stream_recovery_poll_failed", {
					runId,
					consecutive: consecutiveFailures,
					error: error instanceof Error ? error.message : String(error),
				});
				if (consecutiveFailures > MAX_CONSECUTIVE_FAILURES) return null;
				const backoffIndex = Math.min(consecutiveFailures - 1, FAILURE_BACKOFF_MS.length - 1);
				await new Promise<void>((resolve) => setTimeout(resolve, FAILURE_BACKOFF_MS[backoffIndex]!));
			}
		}
		return null;
	}

	private async runAssetOpportunityFinder(options: FinderOptions, startTime: number): Promise<boolean> {
		const selectedStrategies = await this.getSelectedStrategies();
		if (selectedStrategies.length === 0) {
			this.setStatus('Select at least one strategy for Asset Opportunity mode.');
			return false;
		}
		const symbols = options.assetOpportunity?.symbols ?? [];
		if (symbols.length === 0) {
			this.setStatus('Add at least one symbol for Asset Opportunity mode.');
			return false;
		}

		const exitStrategyCandidates = await this.resolveExitStrategyCandidates(options, selectedStrategies);
		const runId = this.generateServerRunId();
		this.activeServerRunId = runId;
		this.persistActiveServerRun(runId, startTime, 'asset_opportunity');

		const outcome = await this.runAssetOpportunityFinderServer(
			options,
			selectedStrategies,
			exitStrategyCandidates,
			runId,
			startTime,
		);

		if (this.activeServerRunId === runId) {
			this.activeServerRunId = null;
			this.clearActiveServerRun();
		}
		this.latestDiagnostics = outcome.diagnostics;
		this.latestAssetOpportunityDiagnostics = outcome.assetDiagnostics ?? {
			totalAssets: symbols.length,
			assetsWithFreshEntry: outcome.assetsWithFreshEntry,
			assetsWithNoFreshEntry: Math.max(0, symbols.length - outcome.assetsWithFreshEntry - outcome.failedAssets),
			selectGradeAssets: 0,
			watchGradeAssets: 0,
			rejectGradeAssets: 0,
			failedAssets: [],
		};
		this.getDom().finderCopyDiagnostics.disabled = !this.latestDiagnostics && !this.latestAssetOpportunityDiagnostics;
		this.ui.renderRandomBenchmark('random');

		if (!this.isCancelled && this.activeServerRunId === null) {
			const terminalAssetDiagnostics = outcome.assetDiagnostics;
			const totalAssets = terminalAssetDiagnostics?.totalAssets ?? symbols.length;
			const freshAssets = terminalAssetDiagnostics?.assetsWithFreshEntry ?? outcome.assetsWithFreshEntry;
			const failedAssets = terminalAssetDiagnostics?.failedAssets.length ?? outcome.failedAssets;
			this.setStatus(
				`Asset Opportunity complete. ${outcome.results.length}/${totalAssets} fresh opportunities` +
				` | ${freshAssets} fresh assets | ${failedAssets} failed` +
				` | ${Math.round(performance.now() - startTime)}ms`,
			);
		}
		return true;
	}

	private async runAssetOpportunityFinderServer(
		options: FinderOptions,
		selectedStrategies: FinderSelectedStrategy[],
		exitStrategyCandidates: FinderSelectedStrategy[] | undefined,
		runId: string,
		startTime: number,
	): Promise<ServerAssetOpportunityRunOutcome> {
		const settings = backtestService.getBacktestSettings();
		const capitalSettings = backtestService.getCapitalSettings();
		const symbols = options.assetOpportunity?.symbols ?? [];
		const providerBySymbol: Record<string, string> = {};
		for (const symbol of symbols) {
			providerBySymbol[symbol] = dataManager.getProvider(symbol);
		}
		const allStrategies = [...selectedStrategies, ...(exitStrategyCandidates ?? [])];
		for (const selected of allStrategies) {
			const secondarySymbol = resolveCrossSymbolSecondaryForStrategy(selected.strategy, settings);
			if (secondarySymbol) {
				providerBySymbol[secondarySymbol] = dataManager.getProvider(secondarySymbol);
			}
		}

		const response = await fetch('/api/finder/asset-opportunity-run', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				runId,
				symbols,
				interval: state.currentInterval,
				options,
				settings,
				capitalSettings,
				strategyKeys: selectedStrategies.map((candidate) => candidate.key),
				exitStrategyKeys: exitStrategyCandidates?.map((candidate) => candidate.key),
				useRustEnginePreference: shouldUseRustEngine(),
				providerBySymbol,
			}),
		});
		if (response.status === 404 || response.status === 405) {
			throw new Error("Asset Opportunity requires a Vite server runtime; static-only deployments are unsupported.");
		}
		if (!response.ok || !response.body) {
			const text = await response.text();
			let payload: { error?: string } = {};
			try { payload = JSON.parse(text); } catch { /* ignore */ }
			throw new Error(payload.error ?? `Server Asset Opportunity run failed (${response.status}).`);
		}

		const isStillActive = (): boolean => this.activeServerRunId === runId;
		const submittedAssetSymbols = new Set(symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean));
		const provisionalAssetResults = new Map<string, FinderAssetOpportunityResult>();
		const assetResultKey = (result: FinderAssetOpportunityResult): string =>
			`${result.symbol.trim().toUpperCase()}\u0000${result.strategyKey}`;
		const retainSubmittedAssetResults = (
			results: readonly FinderAssetOpportunityResult[],
		): FinderAssetOpportunityResult[] => {
			const retained = retainAssetOpportunityResultsForSymbols(results, submittedAssetSymbols);
			if (retained.length !== results.length) {
				debugLogger.warn("finder.asset_opportunity.stale_result_ignored", {
					runId,
					ignoredSymbols: results
						.filter((result) => !submittedAssetSymbols.has(result.symbol.trim().toUpperCase()))
						.map((result) => result.symbol),
				});
			}
			return retained;
		};
		let terminalResults: FinderAssetOpportunityResult[] | null = null;
		let terminalDiagnostics: FinderDiagnostics | null = null;
		let assetDiagnostics: FinderDiagnostics['assetOpportunity'] | null = null;
		let assetsWithFreshEntry = 0;
		let failedAssets = 0;
		let streamError: unknown = null;
		try {
			await consumeNdjsonStream<FinderAssetOpportunityStreamEvent>(response.body, {
					onAssetStart: (event) => {
						if (isStillActive()) this.setStatus(`Asset Opportunity: ${event.strategyNames.join(', ')}, 0/${event.totalAssets} assets`);
				},
				onAssetProgress: (event) => {
					if (!isStillActive()) return;
					this.setProgress(true, event.percent, event.text);
					this.setStatus(`Asset Opportunity: ${event.status}`);
				},
				onAssetComplete: (event) => {
					if (!isStillActive()) return;
					if (!submittedAssetSymbols.has(event.asset.symbol.trim().toUpperCase())) {
						debugLogger.warn("finder.asset_opportunity.stale_result_ignored", {
							runId,
							ignoredSymbols: [event.asset.symbol],
						});
						return;
					}
					assetsWithFreshEntry += 1;
					provisionalAssetResults.set(assetResultKey(event.asset), event.asset);
					this.assetOpportunityRunResults = sortAssetOpportunityResults([
						...provisionalAssetResults.values(),
					]);
					this.setLatestResults({
						scope: 'asset_opportunity',
						results: this.assetOpportunityRunResults.slice(0, Math.max(1, options.topN)),
					});
					this.renderLatestResults();
				},
				onAssetDone: (event) => {
					if (event.runId !== runId) return;
					terminalResults = retainSubmittedAssetResults(event.assets ?? []);
					terminalDiagnostics = event.diagnostics;
					assetDiagnostics = event.assetDiagnostics;
					assetsWithFreshEntry = event.totals.assetsWithFreshEntry;
					failedAssets = event.totals.failedAssets;
					if (isStillActive()) {
						this.assetOpportunityRunResults = sortAssetOpportunityResults([...(terminalResults ?? [])]);
						this.assetOpportunityDefaultResults = [...this.assetOpportunityRunResults];
						this.setLatestResults({
							scope: 'asset_opportunity',
							results: this.assetOpportunityRunResults.slice(0, Math.max(1, options.topN)),
						});
						this.stashAndResetResort();
						this.renderLatestResults();
					}
				},
				onAssetFatal: (event) => {
					throw new Error(event.error);
				},
			}, { requireTerminal: true, terminalTypes: ['asset_done', 'asset_fatal'] });
		} catch (error) {
			streamError = error;
		}

		if (streamError) {
			if (isStillActive()) {
				const recovered = await this.recoverActiveServerRun(runId, 'asset_opportunity');
				if (recovered?.terminalAssets) {
					terminalResults = retainSubmittedAssetResults(recovered.terminalAssets);
					terminalDiagnostics = recovered.diagnostics;
					assetDiagnostics = recovered.assetDiagnostics ?? (recovered.assetTotals
						? {
							totalAssets: recovered.assetTotals.totalAssets,
							assetsWithFreshEntry: recovered.assetTotals.assetsWithFreshEntry,
							assetsWithNoFreshEntry: Math.max(0, recovered.assetTotals.totalAssets - recovered.assetTotals.assetsWithFreshEntry - recovered.assetTotals.failedAssets),
							selectGradeAssets: recovered.assetTotals.selectGradeAssets,
							watchGradeAssets: recovered.assetTotals.watchGradeAssets,
							rejectGradeAssets: recovered.assetTotals.rejectGradeAssets,
							failedAssets: [],
							...(recovered.assetTotals.engineUsage ? { engineUsage: recovered.assetTotals.engineUsage } : {}),
						}
						: null);
					assetsWithFreshEntry = recovered.assetTotals?.assetsWithFreshEntry ?? terminalResults.length;
					failedAssets = recovered.assetTotals?.failedAssets ?? 0;
					this.assetOpportunityRunResults = sortAssetOpportunityResults([...terminalResults]);
					this.assetOpportunityDefaultResults = [...this.assetOpportunityRunResults];
					this.setLatestResults({
						scope: 'asset_opportunity',
						results: this.assetOpportunityRunResults.slice(0, Math.max(1, options.topN)),
					});
					this.stashAndResetResort();
					this.renderLatestResults();
				} else if (!this.isCancelled) {
					throw streamError;
				}
			}
		}

		const results = terminalResults ?? this.getAssetOpportunityResults();
		if (!this.isCancelled && isStillActive()) {
			this.setStatus(`Server Asset Opportunity: ${results.length} opportunities (${Math.round(performance.now() - startTime)}ms)`);
		}
		if (terminalDiagnostics && assetDiagnostics) {
			terminalDiagnostics.assetOpportunity = assetDiagnostics;
		}
		return { results, diagnostics: terminalDiagnostics, assetDiagnostics, assetsWithFreshEntry, failedAssets };
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
		const exitStrategyCandidates = await this.resolveExitStrategyCandidates(options, selectedStrategies);

		// ONE server job owns all selected strategies: IS evaluation, survivor
		// merge, and the optional OOS pass all run server-side. The browser is
		// the control + rendering layer. Persist the active run id before fetch
		// so a tab reload can reattach to the same server job.
		const runId = this.generateServerRunId();
		this.activeServerRunId = runId;
		this.persistActiveServerRun(runId, startTime, 'symbol_universe');

		const outcome = await this.runUniverseFinderServer(
			options,
			selectedStrategies,
			exitStrategyCandidates,
			runId,
			startTime,
		);

		// A stale run that lost ownership (Stop, newer run) must not persist
		// its active-run record or overwrite rendered state. The stream
		// consumer already guards against stale run ids; this clears the
		// record only when THIS run is still the active one.
		if (this.activeServerRunId === runId) {
			this.activeServerRunId = null;
			this.clearActiveServerRun();
		}

		this.latestDiagnostics = outcome.diagnostics;
		this.getDom().finderCopyDiagnostics.disabled = !this.latestDiagnostics;
		this.ui.renderRandomBenchmark(options.mode);

		if (!this.isCancelled && this.activeServerRunId === null) {
			const totalSymbols = options.universe.symbols.length;
			const survivors = this.getUniverseResults().length;
			const segments = [
				`Universe Finder complete. ${survivors} survivor${survivors === 1 ? '' : 's'}`,
				`${selectedStrategies.length} strateg${selectedStrategies.length === 1 ? 'y' : 'ies'}`,
				`${outcome.loadedSymbols}/${totalSymbols} symbols loaded`,
			];
			if (outcome.oosRemoved > 0) {
				segments.push(`${outcome.oosRemoved} filtered by OOS gate`);
			}
			if (outcome.failedSymbolCount > 0) {
				segments.push(`${outcome.failedSymbolCount} load failure${outcome.failedSymbolCount === 1 ? '' : 's'}`);
			}
			segments.push(`${Math.round(performance.now() - startTime)}ms`);
			this.setStatus(segments.join(' | '));
		}
		return true;
	}

	/**
	 * Server-owned Finder Universe path: POST ONE request containing all
	 * selected entry strategy keys + a browser-generated runId, consume the
	 * NDJSON stream of scalar survivor candidates, and adopt the server's
	 * authoritative terminal slice + diagnostics. The server sequences
	 * strategies, merges survivors, runs OOS, and publishes one terminal
	 * snapshot; the browser only renders.
	 *
	 * `runId` guards every stream + poll callback so a stale tab cannot
	 * mutate newer Finder state (the active-server-run token). Disconnecting
	 * the initiating stream does not cancel the server job — reattach polling
	 * on Finder init recovers an in-flight or terminal job after reload.
	 */
	private async runUniverseFinderServer(
		options: FinderOptions,
		selectedStrategies: FinderSelectedStrategy[],
		exitStrategyCandidates: FinderSelectedStrategy[] | undefined,
		runId: string,
		startTime: number,
	): Promise<ServerUniverseRunOutcome> {
		const settings = backtestService.getBacktestSettings();
		const capitalSettings = backtestService.getCapitalSettings();
		// Send a symbol -> provider map so the server's cross-symbol mismatch
		// guard matches the browser's `dataManager.getProvider` classification.
		const universeSymbols = options.universe?.symbols ?? [];
		const providerBySymbol: Record<string, string> = {};
		for (const symbol of universeSymbols) {
			providerBySymbol[symbol] = dataManager.getProvider(symbol);
		}
		// Include cross-symbol secondaries for every entry and sampled exit
		// strategy so provider-mismatch checks stay identical server-side.
		for (const selected of [...selectedStrategies, ...(exitStrategyCandidates ?? [])]) {
			const secondarySymbol = resolveCrossSymbolSecondaryForStrategy(selected.strategy, settings);
			if (secondarySymbol) {
				providerBySymbol[secondarySymbol] = dataManager.getProvider(secondarySymbol);
			}
		}
		const response = await fetch('/api/finder/universe-run', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				runId,
				symbols: universeSymbols,
				interval: state.currentInterval,
				options,
				settings,
				capitalSettings,
				strategyKeys: selectedStrategies.map((s) => s.key),
				exitStrategyKeys: exitStrategyCandidates?.map((c) => c.key),
				useRustEnginePreference: shouldUseRustEngine(),
				providerBySymbol,
			}),
		});

		if (response.status === 404 || response.status === 405) {
			throw new Error("Finder Universe requires a Vite server runtime; static-only deployments are unsupported.");
		}
		if (!response.ok || !response.body) {
			const text = await response.text();
			let payload: { error?: string } = {};
			try { payload = JSON.parse(text); } catch { /* ignore */ }
			throw new Error(payload.error ?? `Server Finder run failed (${response.status}).`);
		}

		// runId guard: every callback checks `this.activeServerRunId === runId`
		// before mutating UI state, so a stale tab (or a stale stream consumed
		// after a newer run started) cannot clobber the current view.
		const isStillActive = (): boolean => this.activeServerRunId === runId;
		const survivorByKey = new Map<string, FinderUniverseCandidate>();
		const identityKey = (c: FinderUniverseCandidate) =>
			`${c.strategyKey}|${JSON.stringify(c.params)}|${c.exitStrategyKey ?? ''}|${JSON.stringify(c.exitStrategyParams ?? {})}`;
		const sortPriority = options.universe?.sortPriority ?? [];
		let terminalDiagnostics: FinderDiagnostics | null = null;
		let terminalCandidates: FinderUniverseCandidate[] | null = null;
		let loadedSymbols = 0;
		let failedSymbolCount = 0;
		let oosRemoved = 0;

		const renderMerged = (): void => {
			if (!isStillActive()) return;
			const merged = sortFinderUniverseCandidates([...survivorByKey.values()], sortPriority)
				.slice(0, options.topN);
			// Candidate events are incremental, but a candidate displaced from the
			// topN can never return under the fixed comparator. Release its large
			// per-symbol metrics array instead of retaining every provisional row.
			survivorByKey.clear();
			for (const candidate of merged) {
				survivorByKey.set(identityKey(candidate), candidate);
			}
			this.setLatestResults({ scope: 'symbol_universe', results: merged });
			this.renderLatestResults();
		};
		// Coalesce candidate arrivals into one render per animation frame. The
		// server dedups identities, but a throttled snapshot can ship several
		// candidate events back-to-back in one chunk. `finalized` guards the
		// race where a candidate event in the SAME chunk as `done` would defer
		// a render that fires AFTER the authoritative terminal slice render.
		let renderScheduled = false;
		let finalized = false;
		const scheduleRender = (): void => {
			if (renderScheduled || finalized) return;
			renderScheduled = true;
			const flush = (): void => {
				renderScheduled = false;
				if (finalized) return;
				renderMerged();
			};
			if (typeof requestAnimationFrame === 'function') {
				requestAnimationFrame(flush);
			} else {
				Promise.resolve().then(flush);
			}
		};

		let streamError: unknown = null;
		try {
			await consumeNdjsonStream<FinderStreamEvent>(response.body, {
				onStart: (event) => {
					if (!isStillActive()) return;
					const strategyCount = event.strategyCount ?? selectedStrategies.length;
					this.setStatus(`Universe Finder: ${strategyCount} strateg${strategyCount === 1 ? 'y' : 'ies'}, 0/${event.totalSymbols} symbols (evaluating ~${event.totalCandidates} candidates)...`);
				},
				onProgress: (event) => {
					if (!isStillActive()) return;
					this.setProgress(true, event.percent, event.text);
					const si = event.strategyIndex ?? 0;
					const sc = event.strategyCount ?? selectedStrategies.length;
					const phaseLabel = event.phase === 'oos' ? 'OOS' : `${Math.min(si + 1, sc)}/${sc}`;
					this.setStatus(`Universe Finder [${phaseLabel}]: ${event.status}`);
				},
				onCandidate: (event) => {
					if (!isStillActive()) return;
					survivorByKey.set(identityKey(event.candidate), event.candidate);
					scheduleRender();
				},
				onSymbolFailed: (event) => {
					debugLogger.warn('finder.server.symbol_failed', { symbol: event.symbol, error: event.error });
				},
				onDone: (event) => {
					terminalDiagnostics = event.diagnostics;
					loadedSymbols = event.totals?.loadedSymbols ?? 0;
					failedSymbolCount = event.totals?.failedSymbols ?? 0;
					oosRemoved = event.totals?.oosRemoved ?? 0;
					// Adopt the authoritative terminal slice (server-owned IS
					// + OOS). The merged map is provisional; done.candidates is
					// the source of truth including OOS fields.
					terminalCandidates = event.candidates ?? null;
					if (terminalCandidates && isStillActive()) {
						const displayed = sortFinderUniverseCandidates(terminalCandidates, sortPriority)
							.slice(0, options.topN);
						this.setLatestResults({ scope: 'symbol_universe', results: displayed });
						this.stashAndResetResort();
						this.renderLatestResults();
					}
					finalized = true;
				},
				onFatal: (event) => {
					throw new Error(event.error);
				},
			}, { requireTerminal: true });
		} catch (error) {
			streamError = error;
		}

		if (streamError !== null && terminalCandidates === null && isStillActive()) {
			const recovered = await this.recoverActiveServerRun(runId, 'symbol_universe');
			if (recovered?.phase === "fatal") {
				throw new Error(recovered.error ?? recovered.summary ?? recovered.statusText);
			}
			if (recovered?.terminalCandidates) {
				terminalCandidates = recovered.terminalCandidates;
				terminalDiagnostics = recovered.diagnostics;
				loadedSymbols = recovered.totals?.loadedSymbols ?? 0;
				failedSymbolCount = recovered.totals?.failedSymbols ?? 0;
				oosRemoved = recovered.totals?.oosRemoved ?? 0;
				finalized = true;
				if (isStillActive()) {
					this.setLatestResults({ scope: "symbol_universe", results: [...terminalCandidates] });
					this.stashAndResetResort();
					this.renderLatestResults();
				}
			}
		}

		if (streamError !== null && terminalCandidates === null) {
			if (this.isCancelled && !isStillActive()) {
				throw new Error("Finder stopped.");
			}
			const message = streamError instanceof Error ? streamError.message : String(streamError);
			if (isStillActive()) {
				this.setStatus(`Server Finder failed: ${message}`);
			}
			throw streamError;
		}

		const finalResults = terminalCandidates
			?? sortFinderUniverseCandidates([...survivorByKey.values()], sortPriority).slice(0, options.topN);

		if (!this.isCancelled && isStillActive()) {
			this.setStatus(`Server Finder: ${finalResults.length} survivors (${Math.round(performance.now() - startTime)}ms)`);
		}

		return {
			results: finalResults,
			diagnostics: terminalDiagnostics,
			loadedSymbols,
			failedSymbolCount,
			oosRemoved,
		};
	}

	private async runStrategyQualityFinder(options: FinderOptions, startTime: number): Promise<boolean> {
		const selectedStrategies = await this.getUniverseSelectedStrategies();
		if (selectedStrategies.length === 0) {
			this.setStatus('Select at least one strategy for Strategy Quality Audit mode.');
			return false;
		}
		const symbols = options.universe?.symbols ?? [];
		if (symbols.length === 0) {
			this.setStatus('Add at least one symbol for Strategy Quality Audit mode.');
			return false;
		}
		this.setStatus('Resolving local dataset providers...');
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
			oosValidationEnabled: options.oosValidationEnabled === true,
			settings: qualitySettings,
			capitalSettings: backtestService.getCapitalSettings(),
			loadDataset: (symbol, interval) => loadBatchDataset(symbol, interval),
			getProvider: (symbol) => dataManager.getProvider(symbol),
			getDatasetCacheStats: () => getBatchDatasetCacheStats(),
			yieldControl: () => this.taskYielder.yieldControl(),
			isCancelled: () => this.isCancelled,
			setProgress: (percent, text) => this.setProgress(true, percent, text),
			setStatus: (text) => this.setStatus(text),
		});

		const results = [...output.results].sort((a, b) =>
			b.averageExpectancy - a.averageExpectancy
			|| b.profitFactor - a.profitFactor
			|| b.activeSymbols - a.activeSymbols
			|| a.strategyName.localeCompare(b.strategyName),
		);
		this.setLatestResults({ scope: 'strategy_quality', results });
		output.performance.timingsMs.providerResolution = Number(providerResolutionMs.toFixed(2));
		this.latestDiagnostics = this.buildStrategyQualityDiagnostics({
			options,
			results,
			performance: output.performance,
			failedSymbolDetails: output.failedSymbolDetails,
			elapsedMs: performance.now() - startTime,
		});
		this.getDom().finderCopyDiagnostics.disabled = !this.latestDiagnostics;
		this.stashAndResetResort();
		this.renderLatestResults();

		if (!this.isCancelled) {
			const oosLabel = options.oosValidationEnabled && (options.dataSlice === 'half_oldest' || options.dataSlice === 'half_newest')
				? ' | OOS included'
				: '';
			const statusPrefix = output.loadedSymbols === 0 ? 'Quality Audit failed.' : 'Quality Audit complete.';
			const diagnosticSuffix = output.failedSymbols > 0
				? ' Copy Diagnostics for load details and performance.'
				: ' Copy Diagnostics for performance.';
			this.setStatus(
				`${statusPrefix} ${results.length} strateg${results.length === 1 ? 'y' : 'ies'}, `
				+ `${output.loadedSymbols}/${symbols.length} symbols loaded${oosLabel} `
				+ `in ${Math.round(performance.now() - startTime)}ms.${diagnosticSuffix}`,
			);
		}
		return true;
	}

	private buildStrategyQualityDiagnostics(args: {
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

	private readOptions(backtestSettings: Pick<ReturnType<typeof settingsManager.getBacktestSettings>, 'polymarketExitMode' | 'polymarketSignalExitAllowMultipleTradesPerEvent' | 'executionModel' | 'polymarketEntryDelayBars' | 'polymarketEntryPriceFilterCents' | 'polymarketBacktestSlippageCents' | 'polymarketPostSignalLimitEntryEnabled' | 'polymarketPostSignalLimitEntryMode' | 'polymarketPostSignalLimitEntryPriceCents' | 'polymarketPostSignalLimitEntryOffsetCents' | 'polymarketPostSignalLimitExitEnabled' | 'polymarketPostSignalLimitExitMode' | 'polymarketPostSignalLimitExitPriceCents' | 'polymarketPostSignalLimitExitOffsetCents' | 'disableSignalExits' | 'exitStrategyOverrideEnabled'>): FinderOptions {
		const dom = this.getDom();
		const scope = this.getScope();
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
		const mode = scope === 'current_chart' ? dom.finderMode.value as FinderMode : 'random';
		const dataSlice = normalizeFinderDataSlice(dom.finderDataSlice.value);
		const topN = Math.round(this.readFinderNumberInput(dom.finderTopN, DEFAULT_FINDER_UI_STATE.topN, 1));
		const steps = Math.round(this.readFinderNumberInput(dom.finderSteps, DEFAULT_FINDER_UI_STATE.steps, 2));
		const rangePercent = this.readFinderNumberInput(dom.finderRange, DEFAULT_FINDER_UI_STATE.rangePercent, 0);
		const maxRuns = Math.round(this.readFinderNumberInput(dom.finderMaxRuns, DEFAULT_FINDER_UI_STATE.maxRuns, 1));
		const tradeFilterEnabled = scope !== 'symbol_universe'
			&& scope !== 'strategy_quality'
			&& dom.finderTradesToggle.checked;
		const minTrades = tradeFilterEnabled ? Math.round(this.readFinderNumberInput(dom.finderTradesMin, DEFAULT_FINDER_UI_STATE.minTrades, 0)) : 0;
		const maxTrades = tradeFilterEnabled
			? Math.round(this.readFinderNumberInput(dom.finderTradesMax, Number.POSITIVE_INFINITY, 0))
			: Number.POSITIVE_INFINITY;
		const freezeRiskManagement = dom.finderFreezeRiskManagementToggle.checked;
		const randomizePathExitParams = dom.finderRandomizePathExitToggle.checked;
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

		const effectiveExitMode = resolveEffectivePolymarketExitMode({
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
			randomizePathExitParams,
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
		if (scope === 'symbol_universe' || scope === 'strategy_quality') {
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
		} else if (scope === 'asset_opportunity') {
			options.assetOpportunity = {
				symbols: this.parseUniverseSymbols(dom.finderUniverseSymbols.value),
				candidatePoolSize: Math.max(1, Math.min(50, Math.round(this.readFinderNumberInput(
					dom.finderAssetCandidatePoolSize,
					DEFAULT_FINDER_UI_STATE.assetOpportunityCandidatePoolSize,
					1,
				)))),
				minFreshSupport: Math.max(1, Math.min(50, Math.round(this.readFinderNumberInput(
					dom.finderAssetMinFreshSupport,
					DEFAULT_FINDER_UI_STATE.assetOpportunityMinFreshSupport,
					1,
				)))),
				oosIgnoreLastBars: normalizeFinderAssetOosIgnoreLastBars(this.readFinderNumberInput(
					dom.finderAssetOosIgnoreLastBars,
					DEFAULT_FINDER_UI_STATE.assetOpportunityOosIgnoreLastBars,
					0,
				)),
				oosHorizons: normalizeFinderAssetOosHorizons(dom.finderAssetOosHorizons.value),
			};
		}

		// OOS gate: half-window only, not under polymarket scoring. Applies to
		// both current_chart and symbol_universe scopes.
		const oosWindowActive = dataSlice === 'half_oldest' || dataSlice === 'half_newest';
		if (oosWindowActive && !polymarketScoringEnabled) {
			options.oosValidationEnabled = dom.finderOosValidationToggle.checked;
		}

		return options;
	}

	private generateParamSets(defaultParams: StrategyParams, options: FinderOptions): StrategyParams[] {
		return this.paramSpace.generateParamSets(defaultParams, options);
	}

	private async resolveExitStrategyCandidates(
		options: FinderOptions,
		selectedStrategies: FinderSelectedStrategy[]
	): Promise<FinderSelectedStrategy[] | undefined> {
		if (!options.exitStrategyOverrideEnabled) {
			return undefined;
		}
		if (selectedStrategies.length === 0) {
			options.exitStrategyOverrideEnabled = false;
			return undefined;
		}
		// Exit-side sampling must draw from the FULL strategy library, not just the
		// entry selection. Returning `selectedStrategies` here previously pinned the
		// exit pool to whatever the user ticked as entries, so e.g. a 2-entry run
		// could only ever sample between those same 2 libs on the exit side.
		const library = getStrategyList();
		await ensureStrategyKeysLoaded(library.map((entry) => entry.key));
		const candidates: FinderSelectedStrategy[] = [];
		for (const entry of library) {
			const strategy = strategyRegistry.get(entry.key);
			if (strategy) {
				candidates.push({ key: entry.key, name: strategy.name, strategy });
			}
		}
		return candidates.length > 0 ? candidates : undefined;
	}

	private setLatestResults(results: FinderLatestResults): void {
		this.latestResults = results;
		this.saveLatestResultsSnapshot(results);
	}

	private getCurrentChartResults(): FinderResult[] {
		return this.latestResults.scope === 'current_chart' ? this.latestResults.results : [];
	}

	private getUniverseResults(): FinderUniverseCandidate[] {
		return this.latestResults.scope === 'symbol_universe' ? this.latestResults.results : [];
	}

	private getAssetOpportunityResults(): FinderAssetOpportunityResult[] {
		return this.latestResults.scope === 'asset_opportunity' ? this.latestResults.results : [];
	}

	private getStrategyQualityResults(): FinderStrategyQualityResult[] {
		return this.latestResults.scope === 'strategy_quality' ? this.latestResults.results : [];
	}

	/**
	 * Minimal diagnostics for the "No universe symbols could be loaded" path.
	 * The full diagnostics builder lives deep inside the runner and never runs
	 * when the universe load throws, so without this the Copy Diagnostics
	 * button stays disabled and the user has no way to share why symbols
	 * failed. Populates `universe.failedSymbols` from the thrown error's
	 * attached loadFailures map.
	 */
	private buildLoadFailureDiagnostics(args: {
		options: FinderOptions;
		elapsedMs: number;
		loadFailures: Map<string, { error?: string }>;
		totalSymbols?: number;
		loadedSymbols?: number;
	}): FinderDiagnostics {
		const failedSymbols = [...args.loadFailures.entries()].map(([symbol, result]) => ({
			symbol,
			reason: result.error ?? 'unknown error',
		}));
		const timings = createEmptyFinderDiagnosticsTimings();
		timings.total = args.elapsedMs;
		timings.dataLoading = args.elapsedMs;
		const engineMode = args.options.polymarketScoringEnabled
			? (isSecondMarketPolymarketSupported(state.currentSymbol, state.currentInterval) ? 'second_market_polymarket' : 'polymarket')
			: args.options.mode === 'genetic'
				? 'genetic'
				: 'typescript';
		return buildFinderDiagnostics({
			runId: createFinderRunId('finder-load-failure'),
			symbol: state.currentSymbol,
			interval: state.currentInterval,
			mode: args.options.mode,
			engineMode,
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
			universeDiagnostics: {
				totalSymbols: args.totalSymbols ?? failedSymbols.length,
				loadedSymbols: args.loadedSymbols ?? 0,
				failedSymbols,
			},
		});
	}

	/**
	 * Minimal diagnostics for any non-load failure path (engine throw, OOS
	 * re-load error, etc.). Without this, latestDiagnostics stays null on a
	 * mid-run failure and the Copy Diagnostics button is silently disabled.
	 * The error reason is surfaced as the first bottleneck line so the user
	 * can copy and share why the run failed.
	 */
	private buildRunFailureDiagnostics(args: {
		options: FinderOptions;
		elapsedMs: number;
		error: string;
	}): FinderDiagnostics {
		const timings = createEmptyFinderDiagnosticsTimings();
		timings.total = args.elapsedMs;
		const engineMode = args.options.polymarketScoringEnabled
			? (isSecondMarketPolymarketSupported(state.currentSymbol, state.currentInterval) ? 'second_market_polymarket' : 'polymarket')
			: args.options.mode === 'genetic'
				? 'genetic'
				: 'typescript';
		const truncatedError = args.error.length > 220 ? `${args.error.slice(0, 217)}...` : args.error;
		const universeDiagnostics = (args.options.scope === 'symbol_universe' || args.options.scope === 'strategy_quality') && args.options.universe
			? {
				totalSymbols: args.options.universe.symbols.length,
				loadedSymbols: 0,
				failedSymbols: [] as Array<{ symbol: string; reason: string }>,
			}
			: undefined;
		const base = buildFinderDiagnostics({
			runId: createFinderRunId('finder-run-failure'),
			symbol: state.currentSymbol,
			interval: state.currentInterval,
			mode: args.options.mode,
			engineMode,
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
		// buildFinderDiagnostics already emits a fallback bottleneck line; prepend
		// the error reason so it is the first thing the user sees when copying.
		base.bottlenecks = [`Finder run failed: ${truncatedError}`, ...base.bottlenecks];
		return base;
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


	/**
	 * Populate the post-run re-sort dropdown options for the current scope.
	 * Each scope offers the same metrics its pre-run sort offers. Called on
	 * scope change and run completion.
	 */
	private populateResortOptions(): void {
		const dom = this.getDom();
		const scope = this.getScope();
		const options: Array<{ value: string; label: string }> = [];
		if (scope === 'symbol_universe') {
			for (const metric of UNIVERSE_SORT_OPTIONS) {
				options.push({ value: metric, label: UNIVERSE_METRIC_FULL_LABELS[metric] });
			}
		} else if (scope === 'asset_opportunity') {
			for (const metric of getAssetOpportunityResortMetrics()) {
				options.push({ value: metric, label: METRIC_FULL_LABELS[metric] });
			}
		} else {
			for (const metric of FINDER_SORT_OPTIONS) {
				options.push({ value: metric, label: METRIC_FULL_LABELS[metric] });
			}
		}
		// Preserve the current selection if it's still valid for this scope.
		const previousValue = dom.finderResort.value;
		dom.finderResort.innerHTML = '<option value="">Run Sort</option>';
		for (const opt of options) {
			const el = document.createElement("option");
			el.value = opt.value;
			el.textContent = opt.label;
			dom.finderResort.appendChild(el);
		}
		// Reset to default on scope change; the previous metric may not apply.
		dom.finderResort.value = "";
		void previousValue;
	}

	/**
	 * Apply the selected re-sort metric to the retained results and re-render.
	 * When the metric is empty ("Run Sort"), restore the original run-time
	 * ordering from the stashed snapshot.
	 */
	private applyResort(): void {
		const dom = this.getDom();
		const metric = dom.finderResort.value;
		const scope = this.latestResults.scope;

		// "Run Sort" — restore original run-time ordering.
		if (!metric) {
			if (scope === 'asset_opportunity' && this.assetOpportunityDefaultResults.length > 0) {
				this.assetOpportunityRunResults = [...this.assetOpportunityDefaultResults];
				this.setLatestResults({
					scope: 'asset_opportunity',
					results: this.assetOpportunityRunResults.slice(0, Math.max(1, this.uiState.topN)),
				});
			} else if (this.originalLatestResults && this.originalLatestResults.scope === scope) {
				this.setLatestResults(this.originalLatestResults);
			}
			this.renderLatestResults();
			return;
		}

		if (scope === 'current_chart') {
			const results = this.latestResults.results;
			const sorted = sortFinderResults(results, [metric as FinderMetric]);
			this.setLatestResults({ scope: 'current_chart', results: sorted });
		} else if (scope === 'symbol_universe') {
			const results = this.latestResults.results;
			const sorted = sortFinderUniverseCandidates(results, [metric as FinderUniverseMetric]);
			this.setLatestResults({ scope: 'symbol_universe', results: sorted });
		} else if (scope === 'asset_opportunity') {
			const results = this.assetOpportunityRunResults.length > 0
				? this.assetOpportunityRunResults
				: this.latestResults.results;
			const sorted = sortAssetOpportunityResultsByMetric(results, metric as FinderMetric);
			this.assetOpportunityRunResults = sorted;
			this.setLatestResults({
				scope: 'asset_opportunity',
				results: sorted.slice(0, Math.max(1, this.uiState.topN)),
			});
		}
		this.renderLatestResults();
	}

	/**
	 * Reset the re-sort dropdown to "Run Sort" and stash the current results
	 * as the run-time baseline. Called at run completion.
	 */
	private stashAndResetResort(): void {
		const dom = this.getDom();
		dom.finderResort.value = "";
		this.originalLatestResults = this.latestResults;
	}

	private renderLatestResults(): void {
		if (this.getScope() === 'symbol_universe') {
			const results = this.latestResults.scope === 'symbol_universe' ? this.latestResults.results : [];
			this.ui.renderUniverseResults(results);
			return;
		}
		if (this.getScope() === 'asset_opportunity') {
			const results = this.latestResults.scope === 'asset_opportunity' ? this.latestResults.results : [];
			this.ui.renderAssetOpportunityResults(results);
			return;
		}
		if (this.getScope() === 'strategy_quality') {
			const results = this.latestResults.scope === 'strategy_quality' ? this.latestResults.results : [];
			this.ui.renderStrategyQualityResults(results);
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
				medianSharpeAvailable: result.medianSharpeAvailable,
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
					drawdownAvailable: symbolResult.result.drawdownAvailable === true,
					winningTrades: symbolResult.result.winningTrades,
					losingTrades: symbolResult.result.losingTrades,
					avgWin: symbolResult.result.avgWin,
					avgLoss: symbolResult.result.avgLoss,
					sharpeRatio: symbolResult.result.sharpeRatio,
					sharpeRatioAvailable: symbolResult.result.sharpeRatioAvailable === true,
				} : null,
			})),
		};
	}

	private buildAssetOpportunityMetadataPayload(result: FinderAssetOpportunityResult, rank: number) {
		const strategy = strategyRegistry.get(result.strategyKey);
		return {
			scope: 'asset_opportunity' as const,
			rank,
			symbol: result.symbol,
			strategyId: result.strategyKey,
			strategyName: result.strategyName,
			interval: state.currentInterval,
			params: result.params,
			metadata: strategy?.metadata ?? null,
			direction: result.direction,
			freshStatus: result.freshStatus,
			latestSignalTime: result.latestSignalTime,
			signalAgeBars: result.signalAgeBars,
			fillTiming: result.fillTiming,
			historicalRank: result.historicalRank,
			totalCandidatesEvaluated: result.totalCandidatesEvaluated,
			selectionMetrics: result.selectionResult,
			support: result.support,
			grade: result.grade,
			oos: result.oosResult && result.oosVerdict
				? { metrics: result.oosResult, verdict: result.oosVerdict }
				: null,
			oosHorizonMetrics: result.oosHorizonMetrics ?? null,
			exitStrategy: result.exitStrategyKey ? {
				key: result.exitStrategyKey,
				name: result.exitStrategyName ?? null,
				params: result.exitStrategyParams ?? {},
			} : null,
		};
	}

	private async copyTopResultsMetadata(): Promise<void> {
		const chartResults = this.getCurrentChartResults();
		const universeResults = this.getUniverseResults();
		const assetResults = this.getAssetOpportunityResults();
		const qualityResults = this.getStrategyQualityResults();
		if (chartResults.length === 0 && universeResults.length === 0 && assetResults.length === 0 && qualityResults.length === 0) {
			uiManager.showToast('No results to copy', 'info');
			return;
		}

		const payload = this.latestResults.scope === 'current_chart'
			? chartResults.map((result, index) => this.buildCurrentChartMetadataPayload(result, index + 1))
			: this.latestResults.scope === 'asset_opportunity'
				? assetResults.map((result, index) => this.buildAssetOpportunityMetadataPayload(result, index + 1))
				: this.latestResults.scope === 'strategy_quality'
					? qualityResults.map((result, index) => ({
						scope: 'strategy_quality' as const,
						rank: index + 1,
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
					}))
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
		if (this.latestResults.scope === 'asset_opportunity' && this.latestAssetOpportunityDiagnostics) {
			try {
				await this.copyTextToClipboard(JSON.stringify({
					scope: 'asset_opportunity',
					assetOpportunity: this.latestAssetOpportunityDiagnostics,
				}, null, 2));
				uiManager.showToast('Asset Opportunity diagnostics copied', 'success');
			} catch (error) {
				debugLogger.error('finder.copy_diagnostics_failed', { error: error instanceof Error ? error.message : String(error) });
				uiManager.showToast('Copy failed - check browser permissions', 'error');
			}
			return;
		}

		if (!this.latestDiagnostics) {
			if (!this.latestAssetOpportunityDiagnostics) {
				uiManager.showToast('No Finder diagnostics to copy', 'info');
				return;
			}
			try {
				await this.copyTextToClipboard(JSON.stringify({
					scope: 'asset_opportunity',
					assetOpportunity: this.latestAssetOpportunityDiagnostics,
				}, null, 2));
				uiManager.showToast('Asset Opportunity diagnostics copied', 'success');
			} catch (error) {
				debugLogger.error('finder.copy_diagnostics_failed', { error: error instanceof Error ? error.message : String(error) });
				uiManager.showToast('Copy failed - check browser permissions', 'error');
			}
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
	private async resolveFinderResultStrategy(strategyKey: string): Promise<NonNullable<ReturnType<typeof strategyRegistry.get>> | null> {
		const strategy = strategyRegistry.get(strategyKey)
			?? await loadBuiltInStrategyByKey(strategyKey);
		return strategy ?? null;
	}

	private async applyCurrentChartResult(result: FinderResult): Promise<void> {
		const isPolymarketResult = Boolean(result.polymarketEval);

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
		setCurrentStrategyKey(result.key);
		uiManager.updateStrategyDropdown(result.key);
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
		setCurrentStrategyKey(candidate.strategyKey);
		uiManager.updateStrategyDropdown(candidate.strategyKey);

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

	/**
	 * Apply an Asset Opportunity result. Sets the selected asset as the current
	 * symbol, selects the winning strategy, applies its parameters through the
	 * existing state/settings actions, and runs the normal backtest. Mirrors the
	 * universe Apply path.
	 */
	private async applyAssetOpportunityResult(result: FinderAssetOpportunityResult): Promise<void> {
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
		setCurrentStrategyKey(result.strategyKey);
		uiManager.updateStrategyDropdown(result.strategyKey);
		paramManager.render(strategy);
		paramManager.setValues(strategy, result.params);
		this.applyFinderBacktestSettings(result.params, undefined, result.exitStrategyKey, result.exitStrategyParams);
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
	private async loadAssetForApply(symbol: string): Promise<void> {
		if (symbol === state.currentSymbol) return;
		await dataManager.loadData(symbol, state.currentInterval);
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

	public getLatestCandidate(): FinderResult | FinderUniverseCandidate | FinderAssetOpportunityResult | FinderStrategyQualityResult | null {
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








