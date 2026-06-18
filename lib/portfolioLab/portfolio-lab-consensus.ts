import { timeKey, type Signal, type Trade } from "../strategies";
import { isIndependentPeer, resolveLatestPortfolioSignalType } from "./portfolio-lab-helpers";
import type {
    ConsensusAnalysis,
    ConsensusBucketSummary,
    ConsensusTradeSample,
    PairAnalysisRow,
    PairConsensusProfile,
    PairRankingRow,
    PairRunArtifacts,
} from "./portfolio-lab-types";

export function buildConsensusAnalysis(
    rows: PairAnalysisRow[],
    artifactsBySymbol: Map<string, PairRunArtifacts>,
    lagBars: number,
    minSamples: number
): ConsensusAnalysis {
    const allSamples: ConsensusTradeSample[] = [];
    const samplesBySymbol = new Map<string, ConsensusTradeSample[]>();
    const relevantArtifacts = new Map<string, PairRunArtifacts>();

    for (const row of rows) {
        const artifacts = artifactsBySymbol.get(row.symbol);
        if (artifacts) {
            relevantArtifacts.set(row.symbol, artifacts);
        }
    }

    for (const row of rows) {
        const targetArtifacts = relevantArtifacts.get(row.symbol);
        if (!targetArtifacts) {
            continue;
        }

        for (const trade of row.result.trades) {
            const sample = buildConsensusTradeSample(row.symbol, trade, relevantArtifacts, targetArtifacts, lagBars);
            if (!sample) {
                continue;
            }
            allSamples.push(sample);
            const symbolSamples = samplesBySymbol.get(row.symbol);
            if (symbolSamples) {
                symbolSamples.push(sample);
            } else {
                samplesBySymbol.set(row.symbol, [sample]);
            }
        }
    }

    const maxSameCount = allSamples.reduce((max, sample) => Math.max(max, sample.sameCount), 0);
    const bucketMap = new Map<string, { sortValue: number; samples: ConsensusTradeSample[] }>();

    for (const sample of allSamples) {
        const bucket = getConsensusBucket(sample.sameCount, maxSameCount);
        const existing = bucketMap.get(bucket.label);
        if (existing) {
            existing.samples.push(sample);
        } else {
            bucketMap.set(bucket.label, { sortValue: bucket.sortValue, samples: [sample] });
        }
    }

    const summaries = Array.from(bucketMap.entries())
        .map(([label, value]) => summarizeConsensusBucket(label, value.sortValue, value.samples))
        .sort((a, b) => a.sortValue - b.sortValue);
    const qualifyingBuckets = summaries.filter((bucket) => bucket.samples >= minSamples);
    const qualifyingSampleCount = qualifyingBuckets.reduce((sum, bucket) => sum + bucket.samples, 0);
    const baselineBucket = qualifyingBuckets.find((bucket) => bucket.sortValue === 0) ?? null;
    const bestBucket = qualifyingBuckets.slice().sort(compareConsensusBuckets)[0] ?? null;
    const bestLongBucket = qualifyingBuckets
        .filter((bucket) => bucket.longSamples >= minSamples)
        .sort((a, b) => compareDirectionBuckets(a.longWinRate, a.avgExpectancy, b.longWinRate, b.avgExpectancy))[0] ?? null;
    const bestShortBucket = qualifyingBuckets
        .filter((bucket) => bucket.shortSamples >= minSamples)
        .sort((a, b) => compareDirectionBuckets(a.shortWinRate, a.avgExpectancy, b.shortWinRate, b.avgExpectancy))[0] ?? null;
    const profilesBySymbol = new Map<string, PairConsensusProfile>();

    for (const [symbol, samples] of samplesBySymbol.entries()) {
        const summary = summarizeSymbolBuckets(samples, minSamples);
        profilesBySymbol.set(symbol, {
            symbol,
            qualifyingBuckets: summary.qualifyingBuckets,
            baselineBucket: summary.baselineBucket,
            strongestBucket: summary.strongestBucket,
            bestBucket: summary.bestBucket,
        });
    }

    return {
        qualifyingBuckets,
        allSamples,
        samplesBySymbol,
        qualifyingSampleCount,
        lagBars,
        minSamples,
        bestBucket,
        bestLongBucket,
        bestShortBucket,
        baselineBucket,
        profilesBySymbol,
    };
}

export function summarizeSymbolBuckets(
    samples: ConsensusTradeSample[],
    minSamples: number
): {
    qualifyingBuckets: ConsensusBucketSummary[];
    baselineBucket: ConsensusBucketSummary | null;
    strongestBucket: ConsensusBucketSummary | null;
    bestBucket: ConsensusBucketSummary | null;
} {
    const maxSameCount = samples.reduce((max, sample) => Math.max(max, sample.sameCount), 0);
    const bucketMap = new Map<string, { sortValue: number; samples: ConsensusTradeSample[] }>();

    for (const sample of samples) {
        const bucket = getConsensusBucket(sample.sameCount, maxSameCount);
        const existing = bucketMap.get(bucket.label);
        if (existing) {
            existing.samples.push(sample);
        } else {
            bucketMap.set(bucket.label, { sortValue: bucket.sortValue, samples: [sample] });
        }
    }

    const summaries = Array.from(bucketMap.entries())
        .map(([label, value]) => summarizeConsensusBucket(label, value.sortValue, value.samples))
        .sort((a, b) => a.sortValue - b.sortValue);
    const qualifyingBuckets = summaries.filter((bucket) => bucket.samples >= minSamples);
    const baselineBucket = qualifyingBuckets.find((bucket) => bucket.sortValue === 0) ?? null;
    const strongestBucket = qualifyingBuckets.slice().sort((a, b) => b.sortValue - a.sortValue)[0] ?? null;
    const bestBucket = qualifyingBuckets.slice().sort(compareConsensusBuckets)[0] ?? null;

    return {
        qualifyingBuckets,
        baselineBucket,
        strongestBucket,
        bestBucket,
    };
}

export function buildConsensusTradeSample(
    targetSymbol: string,
    trade: Trade,
    artifactsBySymbol: Map<string, PairRunArtifacts>,
    targetArtifacts: PairRunArtifacts,
    lagBars: number
): ConsensusTradeSample | null {
    const entryKey = timeKey(trade.entryTime);
    const entryIndex = targetArtifacts.timeIndex.get(entryKey);
    if (entryIndex === undefined) {
        return null;
    }

    const startIndex = Math.max(0, entryIndex - lagBars);
    const windowKeys = targetArtifacts.timeKeys.slice(startIndex, entryIndex + 1);
    const targetSignalType: Signal["type"] = trade.type === "long" ? "buy" : "sell";
    let sameCount = 0;
    let oppositeCount = 0;

    for (const [symbol, artifacts] of artifactsBySymbol.entries()) {
        if (symbol === targetSymbol) {
            continue;
        }
        if (!isIndependentPeer(targetSymbol, symbol)) {
            continue;
        }

        const latestType = resolveLatestPortfolioSignalType(windowKeys, artifacts.signalPresenceByTime);
        if (!latestType) {
            continue;
        }
        if (latestType === targetSignalType) {
            sameCount += 1;
        } else {
            oppositeCount += 1;
        }
    }

    return {
        symbol: targetSymbol,
        direction: trade.type,
        isWin: trade.pnl > 0,
        pnl: trade.pnl,
        pnlPercent: trade.pnlPercent,
        sameCount,
        oppositeCount,
    };
}

export function getConsensusBucket(sameCount: number, maxSameCount: number): { label: string; sortValue: number } {
    if (maxSameCount >= 4 && sameCount >= 4) {
        return { label: "4+ agree", sortValue: 4 };
    }
    return { label: `${sameCount} agree`, sortValue: sameCount };
}

export function summarizeConsensusBucket(
    label: string,
    sortValue: number,
    samples: ConsensusTradeSample[]
): ConsensusBucketSummary {
    const wins = samples.filter((sample) => sample.isWin).length;
    const longs = samples.filter((sample) => sample.direction === "long");
    const shorts = samples.filter((sample) => sample.direction === "short");
    const longWins = longs.filter((sample) => sample.isWin).length;
    const shortWins = shorts.filter((sample) => sample.isWin).length;

    return {
        label,
        sortValue,
        samples: samples.length,
        winRate: (wins / samples.length) * 100,
        lossRate: ((samples.length - wins) / samples.length) * 100,
        avgExpectancy: samples.reduce((sum, sample) => sum + sample.pnl, 0) / samples.length,
        avgNetPct: samples.reduce((sum, sample) => sum + sample.pnlPercent, 0) / samples.length,
        avgOppose: samples.reduce((sum, sample) => sum + sample.oppositeCount, 0) / samples.length,
        longWinRate: longs.length > 0 ? (longWins / longs.length) * 100 : null,
        shortWinRate: shorts.length > 0 ? (shortWins / shorts.length) * 100 : null,
        longSamples: longs.length,
        shortSamples: shorts.length,
    };
}

export function compareConsensusBuckets(a: ConsensusBucketSummary, b: ConsensusBucketSummary): number {
    if (b.winRate !== a.winRate) {
        return b.winRate - a.winRate;
    }
    if (b.avgExpectancy !== a.avgExpectancy) {
        return b.avgExpectancy - a.avgExpectancy;
    }
    return b.samples - a.samples;
}

export function compareDirectionBuckets(
    aWinRate: number | null,
    aExpectancy: number,
    bWinRate: number | null,
    bExpectancy: number
): number {
    const safeA = aWinRate ?? -1;
    const safeB = bWinRate ?? -1;
    if (safeB !== safeA) {
        return safeB - safeA;
    }
    return bExpectancy - aExpectancy;
}

export function buildRankingRows(
    rows: PairAnalysisRow[],
    consensus: ConsensusAnalysis,
    benchmarkSymbol: string
): PairRankingRow[] {
    return rows
        .map((row) => {
            const profile = consensus.profilesBySymbol.get(row.symbol);
            const breadthLift = computeBreadthWinLift(profile);
            const breadthExpectancyLift = computeBreadthExpectancyLift(profile);
            return {
                row,
                role: classifyPairRole(row, profile, benchmarkSymbol),
                breadthLift,
                breadthExpectancyLift,
            };
        })
        .sort((a, b) => {
            if (b.row.result.expectancy !== a.row.result.expectancy) {
                return b.row.result.expectancy - a.row.result.expectancy;
            }
            return Math.abs(a.row.result.maxDrawdownPercent) - Math.abs(b.row.result.maxDrawdownPercent);
        });
}

export function computeBreadthWinLift(profile: PairConsensusProfile | undefined): number | null {
    if (!profile?.baselineBucket || !profile.strongestBucket) {
        return null;
    }
    return profile.strongestBucket.winRate - profile.baselineBucket.winRate;
}

export function computeBreadthExpectancyLift(profile: PairConsensusProfile | undefined): number | null {
    if (!profile?.baselineBucket || !profile.strongestBucket) {
        return null;
    }
    return profile.strongestBucket.avgExpectancy - profile.baselineBucket.avgExpectancy;
}

export function classifyPairRole(
    row: PairAnalysisRow,
    profile: PairConsensusProfile | undefined,
    benchmarkSymbol: string
): string {
    if (row.symbol === benchmarkSymbol) {
        return "Target";
    }

    const marketCorr = Math.abs(row.marketCorrelation ?? 0);
    const strategyCorr = Math.abs(row.strategyCorrelation ?? 0);
    const breadthLift = computeBreadthExpectancyLift(profile) ?? 0;

    if (marketCorr <= 0.5 && strategyCorr <= 0.3 && row.result.expectancy > 0) {
        return "Diversifier";
    }
    if (breadthLift >= 2) {
        return "Responder";
    }
    if (row.result.expectancy >= 0 && Math.abs(row.result.maxDrawdownPercent) <= 6) {
        return "Core";
    }
    return "Satellite";
}
