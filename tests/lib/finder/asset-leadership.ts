import type {
    AssetLeadershipAssetRow,
    AssetLeadershipDerivedMetric,
    AssetLeadershipObservation,
    AssetLeadershipPersistedRun,
    AssetLeadershipReport,
    AssetLeadershipOverview,
    FinderUniverseCandidate,
    FinderUniverseSymbolResult,
} from "../types/finder";

const DEFAULT_RECENT_RUN_LIMIT = 24;
const DEFAULT_RECENT_WINDOW_RUNS = 6;
const MIN_TRADES_FOR_RELIABLE_SIGNAL = 15;

type AssetAccumulator = {
    asset: string;
    observations: number;
    profitableObservations: number;
    topDecileObservations: number;
    sharpeSum: number;
    expectancySum: number;
    netProfitSum: number;
    profitFactorSum: number;
    rankSum: number;
    weightedScoreSum: number;
    recentWeightedScoreSum: number;
    previousWeightedScoreSum: number;
    runIds: Set<string>;
    recentRunIds: Set<string>;
    previousRunIds: Set<string>;
    partnerCounts: Map<string, number>;
    lastSeenAt: number;
    firstSeenAt: number;
    consecutiveRuns: number;
    latestRunScore: number;
    previousRunScore: number;
    appearanceTimeline: Array<{ index: number; score: number }>;
};

function round(value: number, digits = 4): number {
    if (!Number.isFinite(value)) {
        return 0;
    }
    return Number(value.toFixed(digits));
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function normalizeSyntheticAsset(symbol: string): string {
    return symbol.trim().toUpperCase();
}

export function extractSyntheticAssets(pairSymbol: string): [string, string] | null {
    const parts = pairSymbol.split("+").map((part) => normalizeSyntheticAsset(part));
    if (parts.length !== 2 || !parts[0] || !parts[1] || parts[0] === parts[1]) {
        return null;
    }
    return [parts[0], parts[1]];
}

function getObservationWeight(args: {
    candidateRank: number;
    candidateCount: number;
    profitableActiveRatio: number;
    sharpeRatio: number;
    expectancy: number;
    totalTrades: number;
    profitable: boolean;
}): number {
    const rankPercentile = args.candidateCount <= 1
        ? 1
        : 1 - ((args.candidateRank - 1) / Math.max(1, args.candidateCount - 1));
    const rankWeight = 0.35 + (rankPercentile * 0.65);
    const breadthWeight = clamp(args.profitableActiveRatio, 0, 1);
    const sharpeWeight = clamp(args.sharpeRatio / 4, -1, 1);
    const expectancyWeight = clamp(args.expectancy / 100, -1, 1);
    const tradesWeight = clamp(args.totalTrades / 25, 0.2, 1);
    const profitabilityWeight = args.profitable ? 1 : -0.35;
    return round(
        (rankWeight * 0.35)
        + (breadthWeight * 0.2)
        + (sharpeWeight * 0.2)
        + (expectancyWeight * 0.15)
        + (tradesWeight * 0.1)
    , 6) * profitabilityWeight;
}

export function buildObservations(runs: readonly AssetLeadershipPersistedRun[]): AssetLeadershipObservation[] {
    const observations: AssetLeadershipObservation[] = [];
    for (const run of runs) {
        run.candidates.forEach((candidate, candidateIndex) => {
            const candidateCount = run.candidates.length;
            const topDecileCutoff = Math.max(1, Math.ceil(candidateCount * 0.1));
            candidate.symbols.forEach((symbolResult) => {
                const assets = extractSyntheticAssets(symbolResult.symbol);
                if (!assets || !symbolResult.result) {
                    return;
                }
                const profitable = symbolResult.result.netProfit > 0.0001;
                observations.push({
                    symbol: symbolResult.symbol,
                    assetA: assets[0],
                    assetB: assets[1],
                    status: symbolResult.status,
                    candidateRank: candidateIndex + 1,
                    strategyKey: candidate.strategyKey,
                    strategyName: candidate.strategyName,
                    interval: run.interval,
                    runId: run.runId,
                    runTimestamp: run.createdAt,
                    netProfit: symbolResult.result.netProfit,
                    expectancy: symbolResult.result.expectancy,
                    sharpeRatio: symbolResult.result.sharpeRatio,
                    profitFactor: Number.isFinite(symbolResult.result.profitFactor)
                        ? Math.min(symbolResult.result.profitFactor, 10)
                        : 0,
                    totalTrades: symbolResult.result.totalTrades,
                    profitableActiveRatio: candidate.profitableActiveRatio,
                    activeSymbols: candidate.activeSymbols,
                    totalUniverseTrades: candidate.totalTrades,
                    topDecile: candidateIndex < topDecileCutoff,
                    profitable,
                });
            });
        });
    }
    return observations;
}

function createAccumulator(asset: string): AssetAccumulator {
    return {
        asset,
        observations: 0,
        profitableObservations: 0,
        topDecileObservations: 0,
        sharpeSum: 0,
        expectancySum: 0,
        netProfitSum: 0,
        profitFactorSum: 0,
        rankSum: 0,
        weightedScoreSum: 0,
        recentWeightedScoreSum: 0,
        previousWeightedScoreSum: 0,
        runIds: new Set<string>(),
        recentRunIds: new Set<string>(),
        previousRunIds: new Set<string>(),
        partnerCounts: new Map<string, number>(),
        lastSeenAt: 0,
        firstSeenAt: Number.POSITIVE_INFINITY,
        consecutiveRuns: 0,
        latestRunScore: 0,
        previousRunScore: 0,
        appearanceTimeline: [],
    };
}

function toAssetRows(args: {
    observations: readonly AssetLeadershipObservation[];
    runs: readonly AssetLeadershipPersistedRun[];
    recentWindowRuns: number;
}): AssetLeadershipAssetRow[] {
    const accumulators = new Map<string, AssetAccumulator>();
    const recentRunIds = new Set(args.runs.slice(-args.recentWindowRuns).map((run) => run.runId));
    const previousRunIds = new Set(
        args.runs.slice(Math.max(0, args.runs.length - (args.recentWindowRuns * 2)), Math.max(0, args.runs.length - args.recentWindowRuns)).map((run) => run.runId)
    );
    const runOrder = new Map(args.runs.map((run, index) => [run.runId, index]));

    for (const observation of args.observations) {
        const assets = [observation.assetA, observation.assetB];
        const candidateCount = Math.max(1, args.runs.find((run) => run.runId === observation.runId)?.candidates.length ?? 1);
        const observationWeight = getObservationWeight({
            candidateRank: observation.candidateRank,
            candidateCount,
            profitableActiveRatio: observation.profitableActiveRatio,
            sharpeRatio: observation.sharpeRatio,
            expectancy: observation.expectancy,
            totalTrades: observation.totalTrades,
            profitable: observation.profitable,
        });

        for (const asset of assets) {
            let accumulator = accumulators.get(asset);
            if (!accumulator) {
                accumulator = createAccumulator(asset);
                accumulators.set(asset, accumulator);
            }
            const partner = assets[0] === asset ? assets[1] : assets[0];
            accumulator.observations += 1;
            accumulator.profitableObservations += observation.profitable ? 1 : 0;
            accumulator.topDecileObservations += observation.topDecile ? 1 : 0;
            accumulator.sharpeSum += observation.sharpeRatio;
            accumulator.expectancySum += observation.expectancy;
            accumulator.netProfitSum += observation.netProfit;
            accumulator.profitFactorSum += observation.profitFactor;
            accumulator.rankSum += observation.candidateRank;
            accumulator.weightedScoreSum += observationWeight;
            accumulator.runIds.add(observation.runId);
            accumulator.partnerCounts.set(partner, (accumulator.partnerCounts.get(partner) ?? 0) + 1);
            accumulator.lastSeenAt = Math.max(accumulator.lastSeenAt, observation.runTimestamp);
            accumulator.firstSeenAt = Math.min(accumulator.firstSeenAt, observation.runTimestamp);
            accumulator.appearanceTimeline.push({
                index: runOrder.get(observation.runId) ?? 0,
                score: observationWeight,
            });
            if (recentRunIds.has(observation.runId)) {
                accumulator.recentWeightedScoreSum += observationWeight;
                accumulator.recentRunIds.add(observation.runId);
            }
            if (previousRunIds.has(observation.runId)) {
                accumulator.previousWeightedScoreSum += observationWeight;
                accumulator.previousRunIds.add(observation.runId);
            }
        }
    }

    const latestRunId = args.runs.length > 0 ? args.runs[args.runs.length - 1]?.runId ?? null : null;
    const previousRunId = args.runs.length > 1 ? args.runs[args.runs.length - 2]?.runId ?? null : null;
    if (latestRunId) {
        for (const observation of args.observations) {
            if (observation.runId !== latestRunId && observation.runId !== previousRunId) {
                continue;
            }
            const candidateCount = Math.max(1, args.runs.find((run) => run.runId === observation.runId)?.candidates.length ?? 1);
            const score = getObservationWeight({
                candidateRank: observation.candidateRank,
                candidateCount,
                profitableActiveRatio: observation.profitableActiveRatio,
                sharpeRatio: observation.sharpeRatio,
                expectancy: observation.expectancy,
                totalTrades: observation.totalTrades,
                profitable: observation.profitable,
            });
            for (const asset of [observation.assetA, observation.assetB]) {
                const accumulator = accumulators.get(asset);
                if (!accumulator) continue;
                if (observation.runId === latestRunId) {
                    accumulator.latestRunScore += score;
                }
                if (previousRunId && observation.runId === previousRunId) {
                    accumulator.previousRunScore += score;
                }
            }
        }
    }

    const latestRunIdsDescending = [...args.runs].reverse().map((run) => run.runId);
    const accumulatorList = Array.from(accumulators.values());
    for (const accumulator of accumulatorList) {
        let streak = 0;
        for (const runId of latestRunIdsDescending) {
            if (accumulator.runIds.has(runId)) {
                streak += 1;
                continue;
            }
            break;
        }
        accumulator.consecutiveRuns = streak;
    }

    return accumulatorList.map((accumulator) => {
        const appearances = accumulator.observations;
        const totalRunsSeen = accumulator.runIds.size;
        const avgSharpe = appearances > 0 ? accumulator.sharpeSum / appearances : 0;
        const avgExpectancy = appearances > 0 ? accumulator.expectancySum / appearances : 0;
        const avgNetProfit = appearances > 0 ? accumulator.netProfitSum / appearances : 0;
        const avgProfitFactor = appearances > 0 ? accumulator.profitFactorSum / appearances : 0;
        const avgRank = appearances > 0 ? accumulator.rankSum / appearances : 0;
        const profitableRate = appearances > 0 ? accumulator.profitableObservations / appearances : 0;
        const topDecileRate = appearances > 0 ? accumulator.topDecileObservations / appearances : 0;
        const consistencyScore = profitableRate * clamp(avgProfitFactor / 2, 0, 1.5);
        const persistenceScore = args.runs.length > 0 ? totalRunsSeen / args.runs.length : 0;
        const score = (
            (profitableRate * 0.25)
            + (topDecileRate * 0.2)
            + (clamp(avgSharpe / 4, -1, 1) * 0.15)
            + (clamp(avgExpectancy / 100, -1, 1) * 0.15)
            + (persistenceScore * 0.15)
            + (clamp(accumulator.weightedScoreSum / Math.max(1, appearances), -1, 1) * 0.1)
        ) * 100;
        const recentWindowScore = accumulator.recentRunIds.size > 0
            ? accumulator.recentWeightedScoreSum / accumulator.recentRunIds.size
            : 0;
        const previousWindowScore = accumulator.previousRunIds.size > 0
            ? accumulator.previousWeightedScoreSum / accumulator.previousRunIds.size
            : 0;
        const scoreChange = (recentWindowScore - previousWindowScore) * 100;
        const trend = scoreChange > 2 ? "up" : scoreChange < -2 ? "down" : "flat";
        const strongestPartnerEntry = Array.from(accumulator.partnerCounts.entries())
            .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0];
        const timeline = [...accumulator.appearanceTimeline].sort((left, right) => left.index - right.index);
        let slope = 0;
        if (timeline.length > 1) {
            const first = timeline[0]!;
            const last = timeline[timeline.length - 1]!;
            slope = (last.score - first.score) / Math.max(1, last.index - first.index);
        }
        return {
            asset: accumulator.asset,
            score: round(score, 2),
            previousScore: round(previousWindowScore * 100, 2),
            scoreChange: round(scoreChange, 2),
            trend,
            appearances,
            profitableAppearances: accumulator.profitableObservations,
            topDecileAppearances: accumulator.topDecileObservations,
            profitableRate: round(profitableRate, 4),
            topDecileRate: round(topDecileRate, 4),
            avgSharpe: round(avgSharpe, 2),
            avgExpectancy: round(avgExpectancy, 2),
            avgNetProfit: round(avgNetProfit, 2),
            avgProfitFactor: round(avgProfitFactor, 2),
            avgRank: round(avgRank, 2),
            consistencyScore: round(consistencyScore * 100, 2),
            persistenceScore: round(persistenceScore * 100, 2),
            partnerDiversity: accumulator.partnerCounts.size,
            strongestPartner: strongestPartnerEntry?.[0] ?? null,
            strongestPartnerAppearances: strongestPartnerEntry?.[1] ?? 0,
            latestRunScore: round(accumulator.latestRunScore * 100, 2),
            previousWindowScore: round(previousWindowScore * 100, 2),
            recentSlope: round(slope * 100, 4),
            consecutiveRuns: accumulator.consecutiveRuns,
            totalRunsSeen,
            firstSeenAt: Number.isFinite(accumulator.firstSeenAt) ? accumulator.firstSeenAt : 0,
            lastSeenAt: accumulator.lastSeenAt,
        };
    });
}

function buildDerivedMetrics(rows: readonly AssetLeadershipAssetRow[], observations: readonly AssetLeadershipObservation[]): AssetLeadershipDerivedMetric[] {
    if (rows.length === 0) {
        return [];
    }
    const strongest = rows[0]!;
    const fragile = [...rows]
        .filter((row) => row.appearances > 0)
        .sort((left, right) => left.partnerDiversity - right.partnerDiversity || right.score - left.score)[0] ?? strongest;
    const mostReliable = [...rows]
        .sort((left, right) => right.consistencyScore - left.consistencyScore || right.score - left.score)[0] ?? strongest;
    const lowTradeCountShare = observations.length > 0
        ? observations.filter((obs) => obs.totalTrades < MIN_TRADES_FOR_RELIABLE_SIGNAL).length / observations.length
        : 0;
    return [
        {
            label: "Dominant asset",
            value: `${strongest.asset} (${strongest.score.toFixed(1)})`,
            description: "Highest composite leadership score across stored Finder universe runs.",
        },
        {
            label: "Most reliable leader",
            value: `${mostReliable.asset} (${mostReliable.consistencyScore.toFixed(1)})`,
            description: "Best blend of profitable frequency and healthy profit factor.",
        },
        {
            label: "Most pair-dependent",
            value: `${fragile.asset} (${fragile.partnerDiversity} partners)`,
            description: "Useful for spotting assets whose edge depends on very few counterparties.",
        },
        {
            label: "Thin-sample share",
            value: `${(lowTradeCountShare * 100).toFixed(1)}%`,
            description: "Share of asset observations with fewer than 15 trades; high values mean leadership is less trustworthy.",
        },
    ];
}

function sortByCurrentLeadership(rows: readonly AssetLeadershipAssetRow[]): AssetLeadershipAssetRow[] {
    return [...rows].sort((left, right) => (
        right.score - left.score
        || right.topDecileAppearances - left.topDecileAppearances
        || right.avgSharpe - left.avgSharpe
        || left.asset.localeCompare(right.asset)
    ));
}

function sortByEmergence(rows: readonly AssetLeadershipAssetRow[]): AssetLeadershipAssetRow[] {
    return [...rows]
        .filter((row) => row.scoreChange > 0)
        .sort((left, right) => (
            right.scoreChange - left.scoreChange
            || right.recentSlope - left.recentSlope
            || right.score - left.score
            || left.asset.localeCompare(right.asset)
        ));
}

function sortByFalling(rows: readonly AssetLeadershipAssetRow[]): AssetLeadershipAssetRow[] {
    return [...rows]
        .filter((row) => row.scoreChange < 0)
        .sort((left, right) => (
            left.scoreChange - right.scoreChange
            || left.recentSlope - right.recentSlope
            || right.previousScore - left.previousScore
            || left.asset.localeCompare(right.asset)
        ));
}

function sortByConsistency(rows: readonly AssetLeadershipAssetRow[]): AssetLeadershipAssetRow[] {
    return [...rows].sort((left, right) => (
        right.consecutiveRuns - left.consecutiveRuns
        || right.consistencyScore - left.consistencyScore
        || right.score - left.score
        || left.asset.localeCompare(right.asset)
    ));
}

function buildOverview(args: {
    rows: readonly AssetLeadershipAssetRow[];
    observations: readonly AssetLeadershipObservation[];
    runs: readonly AssetLeadershipPersistedRun[];
    recentWindowRuns: number;
}): AssetLeadershipOverview {
    const currentLeader = args.rows[0] ?? null;
    const totalScore = args.rows.reduce((sum, row) => sum + Math.max(0, row.score), 0);
    return {
        totalRuns: args.runs.length,
        totalObservations: args.observations.length,
        totalAssets: args.rows.length,
        latestRunAt: args.runs.length > 0 ? args.runs[args.runs.length - 1]?.createdAt ?? null : null,
        recentWindowRuns: Math.min(args.runs.length, args.recentWindowRuns),
        previousWindowRuns: Math.min(Math.max(0, args.runs.length - Math.min(args.runs.length, args.recentWindowRuns)), args.recentWindowRuns),
        topDecileThresholdRank: 1,
        currentLeader: currentLeader?.asset ?? null,
        dominantAssetShare: totalScore > 0 && currentLeader ? round(currentLeader.score / totalScore, 4) : 0,
    };
}

export function buildAssetLeadershipReport(args: {
    runs: readonly AssetLeadershipPersistedRun[];
    recentRunLimit?: number;
    recentWindowRuns?: number;
}): AssetLeadershipReport {
    const recentRunLimit = Math.max(1, args.recentRunLimit ?? DEFAULT_RECENT_RUN_LIMIT);
    const recentWindowRuns = Math.max(1, args.recentWindowRuns ?? DEFAULT_RECENT_WINDOW_RUNS);
    const runs = [...args.runs]
        .sort((left, right) => left.createdAt - right.createdAt)
        .slice(-recentRunLimit);
    const observations = buildObservations(runs);
    const rows = sortByCurrentLeadership(toAssetRows({ observations, runs, recentWindowRuns }));
    const currentLeaders = rows.slice(0, 20);
    const emergingLeaders = sortByEmergence(rows).slice(0, 12);
    const fallingLeaders = sortByFalling(rows).slice(0, 12);
    const consistentLeaders = sortByConsistency(rows).slice(0, 12);
    return {
        overview: buildOverview({ rows, observations, runs, recentWindowRuns }),
        currentLeaders,
        emergingLeaders,
        fallingLeaders,
        consistentLeaders,
        derivedMetrics: buildDerivedMetrics(rows, observations),
        recentRuns: runs.map((run) => ({
            runId: run.runId,
            createdAt: run.createdAt,
            interval: run.interval,
            strategyCount: run.strategyCount,
            universeSymbolCount: run.universeSymbolCount,
            topN: run.topN,
        })),
    };
}

export function createAssetLeadershipPersistedRun(args: {
    runId: string;
    createdAt?: number;
    interval: string;
    strategyCount: number;
    universeSymbolCount: number;
    topN: number;
    candidates: FinderUniverseCandidate[];
}): AssetLeadershipPersistedRun {
    return {
        runId: args.runId,
        createdAt: args.createdAt ?? Date.now(),
        interval: args.interval,
        strategyCount: args.strategyCount,
        universeSymbolCount: args.universeSymbolCount,
        topN: args.topN,
        candidates: args.candidates.map((candidate) => ({
            ...candidate,
            params: { ...candidate.params },
            symbols: candidate.symbols.map((symbolResult: FinderUniverseSymbolResult) => ({
                ...symbolResult,
                result: symbolResult.result ? { ...symbolResult.result } : undefined,
            })),
        })),
    };
}
