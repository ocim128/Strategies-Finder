import { DEFAULT_SORT_PRIORITY, getPolymarketSortPriority } from "./constants";
import type { FinderMetric, FinderMode, FinderOptions, PolymarketFinderRankMode } from "../types/finder";

export interface FinderOptionsInput {
    useAdvancedSort: boolean;
    advancedSortValues: readonly (FinderMetric | undefined)[];
    primarySort: FinderMetric;
    secondarySort: FinderMetric;
    mode: FinderMode;
    multiTimeframeRequested: boolean;
    isMockSymbol: boolean;
    selectedTimeframes: readonly string[];
    maxMultiTimeframes: number;
    topN: number;
    steps: number;
    robustSeed: number;
    rangePercent: number;
    maxRuns: number;
    tradeFilterEnabled: boolean;
    minTrades: number;
    maxTrades: number;
    freezeRiskManagement: boolean;
    comboEnabled: boolean;
    comboPrimaryConfigName?: string;
    polymarketScoringEnabled: boolean;
    polymarketRankMode: PolymarketFinderRankMode;
    polymarketMinScoredPredictions: number;
}

export type FinderTimeframeSelectionResult =
    | { status: "added"; normalized: string; selected: string[] }
    | { status: "removed"; selected: string[] }
    | { status: "invalid"; selected: string[] }
    | { status: "duplicate"; normalized: string; selected: string[] }
    | { status: "limit_reached"; selected: string[] };

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
    const multiTimeframeEnabled = input.multiTimeframeRequested && !input.isMockSymbol;
    const minTrades = input.tradeFilterEnabled ? input.minTrades : 0;
    const maxTrades = input.tradeFilterEnabled ? Math.max(minTrades, input.maxTrades) : Number.POSITIVE_INFINITY;

    return {
        mode: input.mode,
        sortPriority: resolveFinderSortPriority(input),
        useAdvancedSort: input.useAdvancedSort,
        robustSeed: input.robustSeed,
        multiTimeframeEnabled,
        timeframes: multiTimeframeEnabled
            ? input.selectedTimeframes.slice(0, input.maxMultiTimeframes)
            : [],
        topN: input.topN,
        steps: input.steps,
        rangePercent: input.rangePercent,
        maxRuns: input.maxRuns,
        tradeFilterEnabled: input.tradeFilterEnabled,
        minTrades,
        maxTrades,
        freezeRiskManagement: input.freezeRiskManagement || input.polymarketScoringEnabled,
        comboEnabled: input.comboEnabled,
        comboPrimaryConfigName: input.comboEnabled ? input.comboPrimaryConfigName : undefined,
        polymarketScoringEnabled: input.polymarketScoringEnabled,
        polymarketRankMode: input.polymarketRankMode,
        polymarketMinScoredPredictions: Math.max(0, input.polymarketMinScoredPredictions),
    };
}

export function addFinderTimeframeSelection(
    selectedTimeframes: readonly string[],
    rawInterval: string,
    maxTimeframes: number,
    normalizeInterval: (rawInterval: string) => string | null
): FinderTimeframeSelectionResult {
    const normalized = normalizeInterval(rawInterval);
    if (!normalized) {
        return { status: "invalid", selected: [...selectedTimeframes] };
    }
    if (selectedTimeframes.includes(normalized)) {
        return { status: "duplicate", normalized, selected: [...selectedTimeframes] };
    }
    if (selectedTimeframes.length >= maxTimeframes) {
        return { status: "limit_reached", selected: [...selectedTimeframes] };
    }
    return {
        status: "added",
        normalized,
        selected: [...selectedTimeframes, normalized],
    };
}

export function removeFinderTimeframeSelection(
    selectedTimeframes: readonly string[],
    interval: string
): FinderTimeframeSelectionResult {
    const next = selectedTimeframes.filter((value) => value !== interval);
    return { status: "removed", selected: next };
}
