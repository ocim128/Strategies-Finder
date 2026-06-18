import { getOpenPositionForScanner } from "../strategies/backtest/signal-preparation";
import { timeKey, type Trade } from "../strategies";
import { getConsensusBucket } from "./portfolio-lab-consensus";
import { buildSignalContextKey, buildSignalContexts } from "./portfolio-lab-sweep";
import { isIndependentPeer } from "./portfolio-lab-helpers";
import type {
    ConsensusAnalysis,
    ConsensusTradeSample,
    LiveContextOdds,
    LiveContextSnapshot,
    PairRunArtifacts,
    PortfolioRunContext,
    SignalContext,
} from "./portfolio-lab-types";

export function buildLiveContextSnapshot(
    context: PortfolioRunContext,
    consensus: ConsensusAnalysis
): LiveContextSnapshot {
    const targetArtifacts = context.runCache.get(context.benchmarkSymbol);
    const targetData = context.dataCache.get(context.benchmarkSymbol)?.data ?? [];
    if (!targetArtifacts || targetData.length === 0) {
        return emptyLiveContext(context.benchmarkSymbol, null);
    }

    const signalContexts = buildSignalContexts(
        context.benchmarkSymbol,
        targetArtifacts,
        context.runCache,
        context.lagBars
    );
    const openPosition = getOpenPositionForScanner(targetData, targetArtifacts.fullSignals, context.settings);
    const currentSetup = openPosition
        ? (() => {
            const currentContext = buildCurrentOpenPositionContext(context, openPosition.direction);
            return currentContext
                ? { basis: "open_trade" as const, direction: openPosition.direction, context: currentContext }
                : null;
        })()
        : findLatestSignalSetup(targetArtifacts, signalContexts);

    if (!currentSetup) {
        return emptyLiveContext(context.benchmarkSymbol, openPosition);
    }

    const odds = estimateLiveContextOdds(
        consensus.samplesBySymbol.get(context.benchmarkSymbol) ?? [],
        currentSetup.direction,
        currentSetup.context,
        consensus.minSamples
    );

    return {
        basis: currentSetup.basis,
        targetSymbol: context.benchmarkSymbol,
        direction: currentSetup.direction,
        agreementCount: currentSetup.context.sameCount,
        oppositionCount: currentSetup.context.oppositeCount,
        agreeingSymbols: currentSetup.context.agreeingSymbols,
        opposingSymbols: currentSetup.context.opposingSymbols,
        bucketLabel: getConsensusBucket(currentSetup.context.sameCount, currentSetup.context.sameCount).label,
        odds,
        openPosition,
    };
}

export function buildCurrentOpenPositionContext(
    context: PortfolioRunContext,
    targetDirection: Trade["type"]
): SignalContext | null {
    const targetArtifacts = context.runCache.get(context.benchmarkSymbol);
    if (!targetArtifacts || targetArtifacts.timeKeys.length === 0) {
        return null;
    }

    const agreeingSymbols: string[] = [];
    const opposingSymbols: string[] = [];
    let sameCount = 0;
    let oppositeCount = 0;

    for (const [symbol, artifacts] of context.runCache.entries()) {
        if (symbol === context.benchmarkSymbol) {
            continue;
        }
        if (!isIndependentPeer(context.benchmarkSymbol, symbol)) {
            continue;
        }

        const peerData = context.dataCache.get(symbol)?.data ?? [];
        if (peerData.length === 0) {
            continue;
        }

        const peerOpenPosition = getOpenPositionForScanner(peerData, artifacts.fullSignals, context.settings);
        if (!peerOpenPosition) {
            continue;
        }

        if (peerOpenPosition.direction === targetDirection) {
            sameCount += 1;
            agreeingSymbols.push(symbol);
        } else {
            oppositeCount += 1;
            opposingSymbols.push(symbol);
        }
    }

    return {
        timeKey: targetArtifacts.timeKeys[targetArtifacts.timeKeys.length - 1],
        signalType: targetDirection === "long" ? "buy" : "sell",
        sameCount,
        oppositeCount,
        agreeingSymbols,
        opposingSymbols,
    };
}

export function findLatestSignalSetup(
    targetArtifacts: PairRunArtifacts,
    signalContexts: Map<string, SignalContext>
): { basis: "latest_signal"; direction: Trade["type"]; context: SignalContext } | null {
    for (let index = targetArtifacts.fullSignals.length - 1; index >= 0; index -= 1) {
        const signal = targetArtifacts.fullSignals[index];
        const latestContext = signalContexts.get(buildSignalContextKey(timeKey(signal.time), signal.type));
        if (!latestContext) {
            continue;
        }

        return {
            basis: "latest_signal",
            direction: signal.type === "buy" ? "long" : "short",
            context: latestContext,
        };
    }
    return null;
}

export function estimateLiveContextOdds(
    samples: ConsensusTradeSample[],
    direction: Trade["type"],
    currentContext: SignalContext,
    minSamples: number
): LiveContextOdds | null {
    const exactDirectional = samples.filter((sample) =>
        sample.direction === direction &&
        sample.sameCount >= currentContext.sameCount &&
        sample.oppositeCount <= currentContext.oppositeCount
    );
    if (exactDirectional.length >= minSamples) {
        return summarizeLiveContextOdds(
            exactDirectional,
            `${direction.toUpperCase()} trades with >= ${currentContext.sameCount} agree and <= ${currentContext.oppositeCount} oppose`
        );
    }

    const bucketLabel = getConsensusBucket(currentContext.sameCount, currentContext.sameCount).label;
    const bucketDirectional = samples.filter((sample) =>
        sample.direction === direction &&
        getConsensusBucket(sample.sameCount, currentContext.sameCount).label === bucketLabel
    );
    if (bucketDirectional.length >= minSamples) {
        return summarizeLiveContextOdds(bucketDirectional, `${direction.toUpperCase()} trades in ${bucketLabel}`);
    }

    const bucketAll = samples.filter((sample) =>
        getConsensusBucket(sample.sameCount, currentContext.sameCount).label === bucketLabel
    );
    if (bucketAll.length >= minSamples) {
        return summarizeLiveContextOdds(bucketAll, `All ${bucketLabel} trades`);
    }

    return null;
}

export function summarizeLiveContextOdds(samples: ConsensusTradeSample[], label: string): LiveContextOdds {
    const wins = samples.filter((sample) => sample.isWin).length;
    return {
        sampleCount: samples.length,
        winRate: (wins / samples.length) * 100,
        lossRate: ((samples.length - wins) / samples.length) * 100,
        expectancy: samples.reduce((sum, sample) => sum + sample.pnl, 0) / samples.length,
        label,
    };
}

function emptyLiveContext(targetSymbol: string, openPosition: LiveContextSnapshot["openPosition"]): LiveContextSnapshot {
    return {
        basis: "none",
        targetSymbol,
        direction: null,
        agreementCount: 0,
        oppositionCount: 0,
        agreeingSymbols: [],
        opposingSymbols: [],
        bucketLabel: null,
        odds: null,
        openPosition,
    };
}
