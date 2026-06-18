import { DEFAULT_SORT_PRIORITY, getPolymarketSortPriority } from "./constants";
import type {
    FinderMetric,
    FinderMode,
    FinderOptions,
    FinderDataSlice,
    FinderUniverseMetric,
    FinderUniverseOptions,
    PolymarketFinderRankMode,
} from "../types/finder";
import { isSameEventPolymarketExitMode, resolveEffectivePolymarketExitMode, type PolymarketExitMode } from "../polymarket-exit-mode";
import { clampPolymarketEntryDelayBars } from "../polymarket-entry-delay";
import { clampPolymarketEntryPriceFilterCents } from "../polymarket-entry-price-filter";
import { clampPolymarketBacktestSlippageCents } from "../polymarket-backtest-slippage";

export interface FinderOptionsInput {
    useAdvancedSort: boolean;
    advancedSortValues: readonly (FinderMetric | undefined)[];
    primarySort: FinderMetric;
    secondarySort: FinderMetric;
    mode: FinderMode;
    dataSlice?: FinderDataSlice;
    topN: number;
    steps: number;
    rangePercent: number;
    maxRuns: number;
    tradeFilterEnabled: boolean;
    minTrades: number;
    maxTrades: number;
    freezeRiskManagement: boolean;
    polymarketScoringEnabled: boolean;
    polymarketRankMode: PolymarketFinderRankMode;
    polymarketMinScoredPredictions: number;
    polymarketLockOffset: boolean;
    polymarketAfterTakeProfitOnly: boolean;
    polymarketEntryDelayBars?: number;
    polymarketEntryPriceFilterCents?: number;
    polymarketBacktestSlippageCents?: number;
    polymarketExitMode: PolymarketExitMode;
    polymarketSignalExitAllowMultipleTradesPerEvent?: boolean;
    polymarketPostSignalLimitEntryEnabled?: boolean;
    polymarketPostSignalLimitEntryMode?: "fixed_price" | "signal_offset" | "stale_signal_price";
    polymarketPostSignalLimitEntryPriceCents?: number;
    polymarketPostSignalLimitEntryOffsetCents?: number;
    polymarketPostSignalLimitExitEnabled?: boolean;
    polymarketPostSignalLimitExitMode?: "fixed_price" | "entry_offset";
    polymarketPostSignalLimitExitPriceCents?: number;
    polymarketPostSignalLimitExitOffsetCents?: number;
}

export function normalizeFinderDataSlice(value: unknown): FinderDataSlice {
    return value === "1" || value === "2" || value === "3" || value === "4" || value === "5"
        ? value
        : "all";
}

export function sliceFinderDataWindow<T>(data: readonly T[], dataSlice: FinderDataSlice): T[] {
    if (dataSlice === "all") {
        return data.slice();
    }
    if (data.length === 0) {
        return [];
    }

    const sliceIndex = Number(dataSlice) - 1;
    const start = Math.floor((sliceIndex * data.length) / 5);
    const end = dataSlice === "5"
        ? data.length
        : Math.floor(((sliceIndex + 1) * data.length) / 5);
    return data.slice(start, end);
}

export interface FinderUniverseOptionsInput {
    symbols: string[];
    minActiveSymbols: number;
    minTotalTrades: number;
    minProfitableActiveRatio: number;
    primarySort: FinderUniverseMetric;
    secondarySort: FinderUniverseMetric;
}

export function resolveFinderSortPriority(input: {
    useAdvancedSort: boolean;
    advancedSortValues: readonly (FinderMetric | undefined)[];
    primarySort: FinderMetric;
    secondarySort: FinderMetric;
    polymarketScoringEnabled: boolean;
    polymarketRankMode: PolymarketFinderRankMode;
}): FinderMetric[] {
    if (input.polymarketScoringEnabled) {
        return [...getPolymarketSortPriority(input.polymarketRankMode)];
    }

    if (input.useAdvancedSort) {
        const advancedPriority = input.advancedSortValues.filter((value): value is FinderMetric => Boolean(value));
        return advancedPriority.length > 0 ? advancedPriority : [...DEFAULT_SORT_PRIORITY];
    }

    const sortPriority: FinderMetric[] = [input.primarySort];
    if (input.primarySort !== input.secondarySort) {
        sortPriority.push(input.secondarySort);
    }
    if (!sortPriority.includes("netProfit")) {
        sortPriority.push("netProfit");
    }
    return sortPriority;
}

export function resolveFinderPolymarketExitMode(input: {
    requestedMode?: PolymarketExitMode;
    interval: string;
    executionModel?: string;
    polymarketAnnotationEnabled: boolean;
}): PolymarketExitMode {
    return resolveEffectivePolymarketExitMode(input);
}

export function resolveFinderUniverseSortPriority(input: {
    primarySort: FinderUniverseMetric;
    secondarySort: FinderUniverseMetric;
}): FinderUniverseMetric[] {
    const sortPriority: FinderUniverseMetric[] = [input.primarySort];
    if (input.secondarySort !== input.primarySort) {
        sortPriority.push(input.secondarySort);
    }
    for (const fallback of ["worstNetProfit", "totalTrades"] as const) {
        if (!sortPriority.includes(fallback)) {
            sortPriority.push(fallback);
        }
    }
    return sortPriority;
}

export function buildFinderUniverseOptions(input: FinderUniverseOptionsInput): FinderUniverseOptions {
    const minActiveSymbols = Math.max(1, Math.round(input.minActiveSymbols));
    const minTotalTrades = Math.max(0, Math.round(input.minTotalTrades));
    const minProfitableActiveRatio = Math.max(0, Math.min(1, input.minProfitableActiveRatio));

    return {
        symbols: input.symbols,
        minActiveSymbols,
        minTotalTrades,
        minProfitableActiveRatio,
        sortPriority: resolveFinderUniverseSortPriority(input),
    };
}

export function buildFinderOptions(input: FinderOptionsInput): FinderOptions {
    const minTrades = input.tradeFilterEnabled ? input.minTrades : 0;
    const maxTrades = input.tradeFilterEnabled ? Math.max(minTrades, input.maxTrades) : Number.POSITIVE_INFINITY;

    return {
        mode: input.mode,
        dataSlice: normalizeFinderDataSlice(input.dataSlice),
        sortPriority: resolveFinderSortPriority(input),
        useAdvancedSort: input.useAdvancedSort,
        topN: input.topN,
        steps: input.steps,
        rangePercent: input.rangePercent,
        maxRuns: input.maxRuns,
        tradeFilterEnabled: input.tradeFilterEnabled,
        minTrades,
        maxTrades,
        freezeRiskManagement: input.freezeRiskManagement || input.polymarketScoringEnabled,
        polymarketScoringEnabled: input.polymarketScoringEnabled,
        polymarketRankMode: input.polymarketRankMode,
        polymarketMinScoredPredictions: Math.max(0, input.polymarketMinScoredPredictions),
        polymarketLockOffset: input.polymarketScoringEnabled && input.polymarketLockOffset,
        polymarketAfterTakeProfitOnly: input.polymarketScoringEnabled && input.polymarketAfterTakeProfitOnly,
        polymarketEntryDelayBars: input.polymarketScoringEnabled
            ? clampPolymarketEntryDelayBars(input.polymarketEntryDelayBars)
            : 0,
        polymarketEntryPriceFilterCents: input.polymarketScoringEnabled
            ? clampPolymarketEntryPriceFilterCents(input.polymarketEntryPriceFilterCents)
            : 0,
        polymarketBacktestSlippageCents: input.polymarketScoringEnabled
            ? clampPolymarketBacktestSlippageCents(input.polymarketBacktestSlippageCents)
            : 0,
        polymarketExitMode: input.polymarketExitMode,
        polymarketSignalExitAllowMultipleTradesPerEvent: input.polymarketScoringEnabled
            && isSameEventPolymarketExitMode(input.polymarketExitMode)
            && input.polymarketSignalExitAllowMultipleTradesPerEvent === true,
        polymarketPostSignalLimitEntryEnabled: input.polymarketScoringEnabled && input.polymarketPostSignalLimitEntryEnabled === true,
        polymarketPostSignalLimitEntryMode: input.polymarketPostSignalLimitEntryMode,
        polymarketPostSignalLimitEntryPriceCents: input.polymarketPostSignalLimitEntryPriceCents,
        polymarketPostSignalLimitEntryOffsetCents: input.polymarketPostSignalLimitEntryOffsetCents,
        polymarketPostSignalLimitExitEnabled: input.polymarketScoringEnabled && input.polymarketPostSignalLimitExitEnabled === true,
        polymarketPostSignalLimitExitMode: input.polymarketPostSignalLimitExitMode,
        polymarketPostSignalLimitExitPriceCents: input.polymarketPostSignalLimitExitPriceCents,
        polymarketPostSignalLimitExitOffsetCents: input.polymarketPostSignalLimitExitOffsetCents,
    };
}
