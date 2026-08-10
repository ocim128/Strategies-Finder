import { DEFAULT_SORT_PRIORITY, getPolymarketSortPriority } from "./constants";
import type {
    FinderMetric,
    FinderMode,
    FinderOptions,
    FinderDataSlice,
    FinderOosVerdict,
    FinderUniverseMetric,
    FinderUniverseOptions,
    PolymarketFinderRankMode,
} from "../types/finder";
import { isSameEventPolymarketExitMode, type PolymarketExitMode } from "../polymarket-exit-mode";
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
    randomizePathExitParams?: boolean;
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
    exitStrategyOverrideEnabled?: boolean;
    exitStrategyKey?: string;
    exitStrategyBaseParams?: import("../types/strategies").StrategyParams;
}

export function normalizeFinderDataSlice(value: unknown): FinderDataSlice {
    return value === "1" || value === "2" || value === "3" || value === "4" || value === "5"
        || value === "half_oldest" || value === "half_newest"
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

    if (dataSlice === "half_oldest") {
        return data.slice(0, Math.floor(data.length / 2));
    }
    if (dataSlice === "half_newest") {
        return data.slice(Math.floor(data.length / 2));
    }

    const sliceIndex = Number(dataSlice) - 1;
    const start = Math.floor((sliceIndex * data.length) / 5);
    const end = dataSlice === "5"
        ? data.length
        : Math.floor(((sliceIndex + 1) * data.length) / 5);
    return data.slice(start, end);
}

/**
 * Returns the data-slice value for the OOS (complementary) window, or null when
 * OOS validation is not applicable to the given IS slice. Only half-windows have
 * a well-defined single complementary half; fifth-windows do not.
 */
export function resolveOosDataSlice(dataSlice: FinderDataSlice): FinderDataSlice | null {
    if (dataSlice === "half_oldest") return "half_newest";
    if (dataSlice === "half_newest") return "half_oldest";
    return null;
}

/**
 * IS/OOS gate verdict. Pass requires non-negative OOS net profit and an OOS
 * profit factor of at least 1.0. Returns `inconclusive` (not rejected) when the
 * OOS run produced fewer trades than the IS minTrades floor.
 */
export function computeFinderOosVerdict(args: {
    oosNetProfit: number;
    oosProfitFactor: number;
    oosTotalTrades: number;
    minTrades: number;
}): FinderOosVerdict {
    if (args.oosTotalTrades < Math.max(1, args.minTrades)) {
        return "inconclusive";
    }
    return args.oosNetProfit >= 0 && args.oosProfitFactor >= 1.0
        ? "pass"
        : "fail";
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
        randomizePathExitParams: !input.polymarketScoringEnabled
            && input.randomizePathExitParams === true,
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
        exitStrategyOverrideEnabled: input.exitStrategyOverrideEnabled === true,
        exitStrategyKey: input.exitStrategyOverrideEnabled === true ? input.exitStrategyKey : undefined,
        exitStrategyBaseParams: input.exitStrategyOverrideEnabled === true ? input.exitStrategyBaseParams : undefined,
    };
}

/**
 * Apply the Finder trade-count eligibility gate to one completed result.
 *
 * `Infinity` is serialized as `null` in the Asset Opportunity request body,
 * so a non-finite max is the wire representation of an unbounded maximum.
 */
export function matchesFinderTradeCountFilter(
    totalTrades: number,
    filter: Pick<FinderOptions, "tradeFilterEnabled" | "minTrades" | "maxTrades">,
): boolean {
    if (!filter.tradeFilterEnabled) return true;
    if (!Number.isFinite(totalTrades)) return false;

    const minTrades = Number.isFinite(filter.minTrades)
        ? Math.max(0, filter.minTrades)
        : 0;
    const maxTrades = Number.isFinite(filter.maxTrades)
        ? Math.max(minTrades, filter.maxTrades)
        : Number.POSITIVE_INFINITY;
    return totalTrades >= minTrades && totalTrades <= maxTrades;
}
