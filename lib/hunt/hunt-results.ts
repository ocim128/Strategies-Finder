import { strategyRegistry } from "../../strategyRegistry";
import { METRIC_FULL_LABELS } from "../finder/constants";
import { getFinderMetricValue, sortFinderResults } from "../finder/finder-engine";
import { buildFinderOptions } from "../finder/finder-manager-logic";
import type { FinderMetric, FinderOptions, FinderResult } from "../types/finder";
import {
    buildStableParamKey,
    createTaggedProfileRunResult,
    isBetterMetricValue,
    normalizeHuntPolymarketRankMode,
    stableNormalizeParams,
    type HuntProfile,
    type HuntProfileRunResult,
    type HuntRunSettings,
    type HuntSurvivorGroup,
} from "./hunt-model";

function median(values: readonly number[]): number {
    if (values.length === 0) {
        return 0;
    }
    const sorted = [...values].sort((left, right) => left - right);
    const midpoint = Math.floor(sorted.length / 2);
    if ((sorted.length & 1) === 1) {
        return sorted[midpoint] ?? 0;
    }
    return ((sorted[midpoint - 1] ?? 0) + (sorted[midpoint] ?? 0)) / 2;
}

function normalizeStrategyParamsForGrouping(strategyKey: string, params: Record<string, number>): Record<string, number> {
    const strategy = strategyRegistry.get(strategyKey);
    const normalized = strategy?.normalizeParams ? strategy.normalizeParams({ ...params }) : { ...params };
    return stableNormalizeParams(normalized);
}

function formatCurrency(value: number): string {
    const sign = value >= 0 ? "+" : "";
    return `${sign}$${value.toFixed(2)}`;
}

function formatPolymarketCents(value: number): string {
    const sign = value > 0 ? "+" : value < 0 ? "-" : "";
    return `${sign}${(Math.abs(value) * 100).toFixed(1)}c`;
}

function formatFractionPercent(value: number): string {
    return `${(value * 100).toFixed(1)}%`;
}

export function formatHuntMetricValue(metric: FinderMetric, value: number): string {
    if (!Number.isFinite(value)) {
        return value > 0 ? "Inf" : "n/a";
    }

    switch (metric) {
        case "netProfit":
        case "expectancy":
        case "averageGain":
        case "polyExpectancyBalance":
        case "polySizedNet":
            return formatCurrency(value);
        case "netProfitPercent":
        case "winRate":
        case "maxDrawdownPercent":
            return `${value.toFixed(2)}%`;
        case "polyScore":
        case "polyWinRate":
        case "polyCoverage":
            return formatFractionPercent(value);
        case "polyExpectancy":
            return formatPolymarketCents(value);
        case "totalTrades":
        case "polyWins":
        case "polyPredictions":
            return `${Math.round(value)}`;
        default:
            return value.toFixed(2);
    }
}

export function buildHuntFinderOptions(runSettings: HuntRunSettings): FinderOptions {
    const normalizedRankMode = normalizeHuntPolymarketRankMode(
        runSettings.polymarketRankMode,
        runSettings.polymarketExitMode
    );

    return buildFinderOptions({
        useAdvancedSort: false,
        advancedSortValues: [],
        primarySort: "expectancy",
        secondarySort: "profitFactor",
        mode: "random",
        topN: runSettings.perProfileKeepN,
        steps: 3,
        rangePercent: runSettings.rangePercent,
        maxRuns: runSettings.maxRunsPerStrategy,
        tradeFilterEnabled: runSettings.tradeCountFilterEnabled,
        minTrades: runSettings.minTrades,
        maxTrades: runSettings.maxTrades,
        freezeRiskManagement: runSettings.freezeRiskManagement,
        polymarketScoringEnabled: runSettings.polymarketScoringEnabled,
        polymarketRankMode: normalizedRankMode,
        polymarketMinScoredPredictions: runSettings.polymarketMinScoredPredictions,
        polymarketLockOffset: runSettings.polymarketLockOffset,
        polymarketAfterTakeProfitOnly: runSettings.polymarketAfterTakeProfitOnly,
        polymarketExitMode: runSettings.polymarketExitMode,
        polymarketSignalExitAllowMultipleTradesPerEvent: runSettings.polymarketSignalExitAllowMultipleTradesPerEvent,
    });
}

export function getHuntPrimaryMetric(options: FinderOptions): FinderMetric {
    return options.sortPriority[0] ?? "expectancy";
}

export function getFinderMetricLabel(metric: FinderMetric): string {
    return METRIC_FULL_LABELS[metric] ?? metric;
}

export function tagProfileResults(
    profile: HuntProfile,
    results: readonly FinderResult[],
    finderOptions: FinderOptions,
    perProfileKeepN: number
): HuntProfileRunResult[] {
    const sorted = sortFinderResults(results, finderOptions.sortPriority).slice(0, Math.max(1, perProfileKeepN));
    return sorted.map((result, index) => createTaggedProfileRunResult(profile, result, index + 1));
}

export function sortHuntProfileResults(results: readonly HuntProfileRunResult[]): HuntProfileRunResult[] {
    return [...results].sort((left, right) => {
        const profileCompare = left.profileName.localeCompare(right.profileName);
        if (profileCompare !== 0) {
            return profileCompare;
        }
        if (left.localRank !== right.localRank) {
            return left.localRank - right.localRank;
        }
        return left.result.name.localeCompare(right.result.name);
    });
}

export function groupHuntSurvivors(
    results: readonly HuntProfileRunResult[],
    primaryMetric: FinderMetric
): HuntSurvivorGroup[] {
    const grouped = new Map<string, HuntSurvivorGroup>();

    for (const candidate of results) {
        const normalizedParams = normalizeStrategyParamsForGrouping(candidate.result.key, candidate.result.params);
        const groupKey = `${candidate.result.key}::${buildStableParamKey(normalizedParams)}`;
        const metricValue = getFinderMetricValue(candidate.result, primaryMetric);
        const existing = grouped.get(groupKey);

        if (!existing) {
            grouped.set(groupKey, {
                groupKey,
                strategyKey: candidate.result.key,
                strategyName: candidate.result.name,
                params: normalizedParams,
                appearances: 1,
                profileIds: [candidate.profileId],
                profileNames: [candidate.profileName],
                bestLocalRank: candidate.localRank,
                medianLocalRank: candidate.localRank,
                bestPrimaryMetric: metricValue,
                medianPrimaryMetric: metricValue,
                bestCandidate: candidate,
                candidates: [candidate],
            });
            continue;
        }

        existing.candidates.push(candidate);

        if (!existing.profileIds.includes(candidate.profileId)) {
            existing.profileIds.push(candidate.profileId);
        }
        if (!existing.profileNames.includes(candidate.profileName)) {
            existing.profileNames.push(candidate.profileName);
        }

        existing.appearances = existing.profileIds.length;
        existing.bestLocalRank = Math.min(existing.bestLocalRank, candidate.localRank);

        const currentBestMetric = getFinderMetricValue(existing.bestCandidate.result, primaryMetric);
        if (
            isBetterMetricValue(primaryMetric, metricValue, currentBestMetric)
            || (Math.abs(metricValue - currentBestMetric) <= 0.0001 && candidate.localRank < existing.bestCandidate.localRank)
        ) {
            existing.bestCandidate = candidate;
        }
    }

    const groups = [...grouped.values()].map((group) => {
        const localRanks = group.candidates.map((candidate) => candidate.localRank);
        const metricValues = group.candidates.map((candidate) => getFinderMetricValue(candidate.result, primaryMetric));
        const bestMetric = metricValues.reduce((best, value) => {
            return isBetterMetricValue(primaryMetric, value, best) ? value : best;
        }, metricValues[0] ?? 0);

        return {
            ...group,
            profileIds: [...group.profileIds].sort((left, right) => left.localeCompare(right)),
            profileNames: [...group.profileNames].sort((left, right) => left.localeCompare(right)),
            candidates: sortHuntProfileResults(group.candidates),
            medianLocalRank: median(localRanks),
            bestPrimaryMetric: bestMetric,
            medianPrimaryMetric: median(metricValues),
        };
    });

    return groups.sort((left, right) => {
        if (left.appearances !== right.appearances) {
            return right.appearances - left.appearances;
        }
        if (Math.abs(left.medianLocalRank - right.medianLocalRank) > 0.0001) {
            return left.medianLocalRank - right.medianLocalRank;
        }
        if (left.bestLocalRank !== right.bestLocalRank) {
            return left.bestLocalRank - right.bestLocalRank;
        }

        const leftMetric = left.bestPrimaryMetric;
        const rightMetric = right.bestPrimaryMetric;
        if (Math.abs(leftMetric - rightMetric) > 0.0001) {
            return primaryMetric === "maxDrawdownPercent" ? leftMetric - rightMetric : rightMetric - leftMetric;
        }

        return left.strategyName.localeCompare(right.strategyName);
    });
}

export function buildHuntProfileLookup(profiles: readonly HuntProfile[]): Map<string, HuntProfile> {
    return new Map(profiles.map((profile) => [profile.id, profile]));
}
