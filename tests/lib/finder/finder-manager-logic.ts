import { DEFAULT_SORT_PRIORITY, getPolymarketSortPriority } from "./constants";
import type { FinderMetric, FinderMode, FinderOptions, PolymarketFinderRankMode } from "../types/finder";

export interface FinderOptionsInput {
    useAdvancedSort: boolean;
    advancedSortValues: readonly (FinderMetric | undefined)[];
    primarySort: FinderMetric;
    secondarySort: FinderMetric;
    mode: FinderMode;
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

export function buildFinderOptions(input: FinderOptionsInput): FinderOptions {
    const minTrades = input.tradeFilterEnabled ? input.minTrades : 0;
    const maxTrades = input.tradeFilterEnabled ? Math.max(minTrades, input.maxTrades) : Number.POSITIVE_INFINITY;

    return {
        mode: input.mode,
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
    };
}
