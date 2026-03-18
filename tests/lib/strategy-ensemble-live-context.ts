import { countDistinctFamilies } from "./strategy-ensemble-engine";
import { buildContextCountsForTimeKey, rulePasses } from "./strategy-ensemble-rules";
import { timeKey, type OHLCVData, type Trade } from "./strategies";
import {
    getOpenPositionForScanner,
} from "./strategies/backtest/signal-preparation";
import type {
    ConfigRunArtifact,
    CurrentContextReference,
    EnsembleLiveContext,
    EnsembleRunContext,
    EnsembleTradeSample,
} from "./strategy-ensemble-types";

export function resolveCurrentContextReference(
    targetArtifact: ConfigRunArtifact,
    candles: OHLCVData[]
): CurrentContextReference {
    const openPosition = getOpenPositionForScanner(candles, targetArtifact.rawSignals, targetArtifact.backtestSettings);
    const latestPreparedSignal = targetArtifact.entrySignals[targetArtifact.entrySignals.length - 1] ?? null;

    if (openPosition) {
        return {
            basis: "open_trade",
            direction: openPosition.direction,
            timeKey: timeKey(openPosition.entryTime),
            openPosition,
        };
    }

    if (latestPreparedSignal) {
        return {
            basis: "latest_signal",
            direction: latestPreparedSignal.type === "buy" ? "long" : "short",
            timeKey: timeKey(latestPreparedSignal.time),
            openPosition,
        };
    }

    return {
        basis: "none",
        direction: null,
        timeKey: null,
        openPosition,
    };
}

export function buildLiveContext(
    targetArtifact: ConfigRunArtifact,
    contextArtifacts: ConfigRunArtifact[],
    candles: OHLCVData[],
    tradeSamples: EnsembleTradeSample[],
    minSamples: number
): EnsembleLiveContext {
    const currentContextReference = resolveCurrentContextReference(targetArtifact, candles);
    const contextFamilyCount = countDistinctFamilies(contextArtifacts);

    if (!currentContextReference.direction || !currentContextReference.timeKey) {
        return {
            basis: "none",
            direction: null,
            agreeCount: 0,
            opposeCount: 0,
            neutralCount: contextFamilyCount,
            conflictedCount: 0,
            rawAgreeCount: 0,
            rawOpposeCount: 0,
            rawNeutralCount: contextArtifacts.length,
            agreeingConfigs: [],
            opposingConfigs: [],
            agreeingFamilies: [],
            opposingFamilies: [],
            neutralFamilies: [],
            conflictedFamilies: [],
            odds: null,
            openPosition: currentContextReference.openPosition,
        };
    }

    const counts = buildContextCountsForTimeKey(
        currentContextReference.direction,
        currentContextReference.timeKey,
        contextArtifacts
    );
    const matchingSamples = tradeSamples.filter(
        (sample) => sample.direction === currentContextReference.direction
            && sample.agreeCount === counts.agreeCount
            && sample.opposeCount === counts.opposeCount
    );

    let odds: EnsembleLiveContext["odds"] = null;
    if (matchingSamples.length >= Math.max(3, minSamples)) {
        const wins = matchingSamples.filter((sample) => sample.isWin).length;
        odds = {
            sampleCount: matchingSamples.length,
            winRate: (wins / matchingSamples.length) * 100,
            lossRate: 100 - (wins / matchingSamples.length) * 100,
            expectancy: matchingSamples.reduce((sum, sample) => sum + sample.pnl, 0) / matchingSamples.length,
            label: `${currentContextReference.direction} | familyAgree=${counts.agreeCount}, familyOppose=${counts.opposeCount}`,
            matchType: "exact",
        };
    } else {
        odds = findNearestContextOdds(
            tradeSamples,
            currentContextReference.direction,
            counts.agreeCount,
            counts.opposeCount,
            minSamples
        );
    }

    return {
        basis: currentContextReference.basis,
        direction: currentContextReference.direction,
        agreeCount: counts.agreeCount,
        opposeCount: counts.opposeCount,
        neutralCount: counts.neutralCount,
        conflictedCount: counts.conflictedCount,
        rawAgreeCount: counts.rawAgreeCount,
        rawOpposeCount: counts.rawOpposeCount,
        rawNeutralCount: counts.rawNeutralCount,
        agreeingConfigs: counts.agreeingConfigs,
        opposingConfigs: counts.opposingConfigs,
        agreeingFamilies: counts.agreeingFamilies,
        opposingFamilies: counts.opposingFamilies,
        neutralFamilies: counts.neutralFamilies,
        conflictedFamilies: counts.conflictedFamilies,
        odds,
        openPosition: currentContextReference.openPosition,
    };
}

export function findNearestContextOdds(
    samples: EnsembleTradeSample[],
    direction: Trade["type"],
    agreeCount: number,
    opposeCount: number,
    minSamples: number
): EnsembleLiveContext["odds"] {
    const grouped = new Map<string, EnsembleTradeSample[]>();

    for (const sample of samples) {
        if (sample.direction !== direction) {
            continue;
        }
        const key = `${sample.agreeCount}|${sample.opposeCount}`;
        const bucket = grouped.get(key);
        if (bucket) {
            bucket.push(sample);
        } else {
            grouped.set(key, [sample]);
        }
    }

    let best:
        | {
            agreeCount: number;
            opposeCount: number;
            samples: EnsembleTradeSample[];
            distance: number;
        }
        | null = null;

    for (const [key, bucket] of grouped.entries()) {
        if (bucket.length < Math.max(3, minSamples)) {
            continue;
        }
        const [bucketAgreeRaw, bucketOpposeRaw] = key.split("|");
        const bucketAgree = Number.parseInt(bucketAgreeRaw, 10);
        const bucketOppose = Number.parseInt(bucketOpposeRaw, 10);
        const distance = Math.abs(bucketAgree - agreeCount) + Math.abs(bucketOppose - opposeCount);

        if (!best) {
            best = { agreeCount: bucketAgree, opposeCount: bucketOppose, samples: bucket, distance };
            continue;
        }

        if (distance !== best.distance) {
            if (distance < best.distance) {
                best = { agreeCount: bucketAgree, opposeCount: bucketOppose, samples: bucket, distance };
            }
            continue;
        }

        if (bucket.length > best.samples.length) {
            best = { agreeCount: bucketAgree, opposeCount: bucketOppose, samples: bucket, distance };
        }
    }

    if (!best) {
        return null;
    }

    const wins = best.samples.filter((sample) => sample.isWin).length;
    return {
        sampleCount: best.samples.length,
        winRate: (wins / best.samples.length) * 100,
        lossRate: 100 - (wins / best.samples.length) * 100,
        expectancy: best.samples.reduce((sum, sample) => sum + sample.pnl, 0) / best.samples.length,
        label: `${direction} | familyAgree=${best.agreeCount}, familyOppose=${best.opposeCount}`,
        matchType: "nearest",
    };
}

export function resolveLiveRecommendation(
    context: EnsembleRunContext,
    liveContext: EnsembleLiveContext
): { summary: string; detail: string; passes: boolean } | null {
    const selected = context.selectedRule;
    if (!selected) {
        return null;
    }

    const evaluation = rulePasses(selected.evaluation.rule, liveContext, context.contextFamilyCount);
    const validationLabel = selected.mode === "validated" ? "Validated" : "In-sample only";
    const validationDetail = selected.mode === "validated"
        ? `Validated on the held-out trade sample with ${selected.evaluation.validationSamples} validation trades.`
        : `No rule cleared validation. This is the strongest training-only candidate with ${selected.evaluation.trainSamples} training trades.`;

    return {
        summary: `${validationLabel}: ${selected.evaluation.rule.label} (${evaluation ? "PASS" : "BLOCK"})`,
        detail: `${validationDetail} Current context ${evaluation ? "passes" : "fails"} because familyAgree=${liveContext.agreeCount}, familyOppose=${liveContext.opposeCount}.`,
        passes: evaluation,
    };
}
