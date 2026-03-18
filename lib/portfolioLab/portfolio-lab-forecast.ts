import { getOpenPositionForScanner } from "../strategies/backtest/signal-preparation";
import { timeKey, type OHLCVData, type Signal, type Time, type Trade } from "../strategies";
import { parseTimeToUnixSeconds } from "../time-normalization";
import { formatPercent, toDisplaySymbol } from "./portfolio-lab-formatters";
import { resolveLatestPortfolioSignalType } from "./portfolio-lab-helpers";
import {
    average,
    computeAdverseExcursionAtr,
    computeAtrAt,
    computeDirectionalAtrDistance,
    computeDirectionalPercentMove,
    computeDirectionalReturnAtIndex,
    computeDirectionalReturnAtTime,
    standardDeviation,
} from "./portfolio-lab-statistics";
import type {
    ForecastBreadthSnapshot,
    ForecastCandidateSample,
    ForecastSnapshot,
    OpenTradeForecast,
    PairAnalysisRow,
    PairRunArtifacts,
    PortfolioRunContext,
    TradeRange,
} from "./portfolio-lab-types";

export function buildTradeRanges(
    trades: Trade[],
    data: OHLCVData[],
    timeIndex: Map<string, number>
): TradeRange[] {
    return trades
        .map((trade) => {
            const entryIndex = resolveDataIndexForTime(data, timeIndex, trade.entryTime);
            const exitIndex = resolveDataIndexForTime(data, timeIndex, trade.exitTime);
            if (entryIndex === null || exitIndex === null || exitIndex < entryIndex) {
                return null;
            }
            return { trade, entryIndex, exitIndex };
        })
        .filter((range): range is TradeRange => Boolean(range));
}

export function resolveDataIndexForTime(
    data: OHLCVData[],
    timeIndex: Map<string, number>,
    rawTime: Time
): number | null {
    const direct = timeIndex.get(timeKey(rawTime));
    if (typeof direct === "number") {
        return direct;
    }
    const targetTime = parseTimeToUnixSeconds(rawTime);
    if (targetTime === null) {
        return null;
    }
    for (let index = 0; index < data.length; index += 1) {
        const candleTime = parseTimeToUnixSeconds(data[index].time);
        if (candleTime === targetTime) {
            return index;
        }
    }
    return null;
}

export function findTradeRangeByEntryTime(tradeRanges: TradeRange[], rawTime: Time): TradeRange | null {
    const entryKey = timeKey(rawTime);
    return tradeRanges.find((range) => timeKey(range.trade.entryTime) === entryKey) ?? null;
}

export function findTradeRangeAtIndex(tradeRanges: TradeRange[], barIndex: number): TradeRange | null {
    for (let index = tradeRanges.length - 1; index >= 0; index -= 1) {
        const range = tradeRanges[index];
        const isOpenAtIndex = barIndex >= range.entryIndex
            && (
                barIndex < range.exitIndex
                || (barIndex === range.exitIndex && range.trade.exitReason === "end_of_data")
            );
        if (isOpenAtIndex) {
            return range;
        }
    }
    return null;
}

export function buildOpenTradeForecast(
    context: PortfolioRunContext,
    rows: PairAnalysisRow[],
    anchorSymbol: string
): OpenTradeForecast {
    const targetArtifacts = context.runCache.get(context.benchmarkSymbol);
    const targetData = context.dataCache.get(context.benchmarkSymbol)?.data ?? [];
    if (!targetArtifacts || targetData.length === 0) {
        return createEmptyForecast(context.benchmarkSymbol, anchorSymbol);
    }

    const peerWeights = buildForecastPeerWeights(rows, context.benchmarkSymbol);
    const openPosition = getOpenPositionForScanner(targetData, targetArtifacts.fullSignals, context.settings);
    if (openPosition) {
        const openTradeRange = findTradeRangeByEntryTime(targetArtifacts.tradeRanges, openPosition.entryTime)
            ?? findTradeRangeAtIndex(targetArtifacts.tradeRanges, targetData.length - 1);
        if (openTradeRange) {
            const snapshot = buildForecastSnapshotForOpenTrade(
                context,
                targetData,
                targetArtifacts,
                openTradeRange,
                targetData.length - 1,
                anchorSymbol,
                peerWeights
            );
            if (snapshot) {
                return finalizeOpenTradeForecast(
                    context,
                    snapshot,
                    buildHistoricalOpenTradeForecastCandidates(context, targetData, targetArtifacts, anchorSymbol, peerWeights),
                    anchorSymbol
                );
            }
        }
    }

    const latestSignal = findLatestSignalReference(targetArtifacts);
    if (!latestSignal) {
        return createEmptyForecast(context.benchmarkSymbol, anchorSymbol);
    }

    const latestSignalSnapshot = buildForecastSnapshotForLatestSignal(
        context,
        targetData,
        targetArtifacts,
        latestSignal.barIndex,
        latestSignal.signal,
        anchorSymbol,
        peerWeights
    );
    if (!latestSignalSnapshot) {
        return createEmptyForecast(context.benchmarkSymbol, anchorSymbol);
    }

    return finalizeOpenTradeForecast(
        context,
        latestSignalSnapshot,
        buildHistoricalSignalForecastCandidates(context, targetData, targetArtifacts, anchorSymbol, peerWeights),
        anchorSymbol
    );
}

export function createEmptyForecast(targetSymbol: string, anchorSymbol: string): OpenTradeForecast {
    return {
        basis: "none",
        matchType: "none",
        targetSymbol,
        anchorSymbol,
        direction: null,
        confidenceLabel: null,
        confidenceScore: null,
        sampleCount: 0,
        candidateCount: 0,
        winProbability: null,
        lossProbability: null,
        expectedFinalPnlPercent: null,
        expectedRemainingPnlPercent: null,
        expectedMaePercent: null,
        expectedMfePercent: null,
        baselineWinProbability: null,
        baselineRemainingPnlPercent: null,
        suggestedExposure: null,
        suggestionLabel: null,
        avgDistance: null,
        currentSnapshot: null,
        analogs: [],
        rationale: [],
    };
}

export function finalizeOpenTradeForecast(
    context: PortfolioRunContext,
    currentSnapshot: ForecastSnapshot,
    candidates: ForecastCandidateSample[],
    anchorSymbol: string
): OpenTradeForecast {
    if (candidates.length === 0) {
        return {
            ...createEmptyForecast(context.benchmarkSymbol, anchorSymbol),
            basis: currentSnapshot.basis,
            matchType: "fallback",
            direction: currentSnapshot.direction,
            currentSnapshot,
            rationale: buildForecastRationale(currentSnapshot, null, null, null),
        };
    }

    const ranked = candidates
        .map((candidate) => ({
            candidate,
            distance: measureForecastDistance(currentSnapshot, candidate.snapshot),
        }))
        .sort((a, b) => a.distance - b.distance);
    const selectedCount = Math.min(Math.max(8, Math.round(Math.sqrt(ranked.length) * 2)), 24, ranked.length);
    const selected = ranked.slice(0, selectedCount);
    const totalWeight = selected.reduce((sum, item) => sum + getForecastDistanceWeight(item.distance), 0);
    const baselineWinProbability = average(candidates.map((candidate) => candidate.finalIsWin ? 100 : 0));
    const baselineRemainingPnlPercent = average(candidates.map((candidate) => candidate.remainingPnlPercent));
    const baselineFinalPnlPercent = average(candidates.map((candidate) => candidate.finalPnlPercent));
    const analogWinProbability = totalWeight > 0
        ? selected.reduce((sum, item) => sum + getForecastDistanceWeight(item.distance) * (item.candidate.finalIsWin ? 100 : 0), 0) / totalWeight
        : null;
    const analogRemainingPnlPercent = totalWeight > 0
        ? selected.reduce((sum, item) => sum + getForecastDistanceWeight(item.distance) * item.candidate.remainingPnlPercent, 0) / totalWeight
        : null;
    const analogFinalPnlPercent = totalWeight > 0
        ? selected.reduce((sum, item) => sum + getForecastDistanceWeight(item.distance) * item.candidate.finalPnlPercent, 0) / totalWeight
        : null;
    const analogMfePercent = totalWeight > 0
        ? selected.reduce((sum, item) => sum + getForecastDistanceWeight(item.distance) * (item.candidate.futureMfePercent ?? 0), 0) / totalWeight
        : null;
    const analogMaePercent = totalWeight > 0
        ? selected.reduce((sum, item) => sum + getForecastDistanceWeight(item.distance) * (item.candidate.futureMaePercent ?? 0), 0) / totalWeight
        : null;
    const shrink = selected.length / (selected.length + 10);
    const winProbability = baselineWinProbability !== null && analogWinProbability !== null
        ? baselineWinProbability + ((analogWinProbability - baselineWinProbability) * shrink)
        : analogWinProbability ?? baselineWinProbability;
    const expectedRemainingPnlPercent = baselineRemainingPnlPercent !== null && analogRemainingPnlPercent !== null
        ? baselineRemainingPnlPercent + ((analogRemainingPnlPercent - baselineRemainingPnlPercent) * shrink)
        : analogRemainingPnlPercent ?? baselineRemainingPnlPercent;
    const expectedFinalPnlPercent = baselineFinalPnlPercent !== null && analogFinalPnlPercent !== null
        ? baselineFinalPnlPercent + ((analogFinalPnlPercent - baselineFinalPnlPercent) * shrink)
        : analogFinalPnlPercent ?? baselineFinalPnlPercent;
    const avgDistance = average(selected.map((item) => item.distance));
    const confidenceScore = computeForecastConfidenceScore(selected.length, avgDistance);
    const confidenceLabel = confidenceScore >= 75 ? "High" : confidenceScore >= 50 ? "Medium" : "Low";
    const suggestedExposure = resolveForecastSuggestedExposure(
        winProbability,
        expectedRemainingPnlPercent,
        currentSnapshot,
        confidenceScore
    );

    return {
        basis: currentSnapshot.basis,
        matchType: selected.length >= 8 ? "nearest" : "fallback",
        targetSymbol: context.benchmarkSymbol,
        anchorSymbol,
        direction: currentSnapshot.direction,
        confidenceLabel,
        confidenceScore,
        sampleCount: selected.length,
        candidateCount: ranked.length,
        winProbability,
        lossProbability: typeof winProbability === "number" ? 100 - winProbability : null,
        expectedFinalPnlPercent,
        expectedRemainingPnlPercent,
        expectedMaePercent: analogMaePercent,
        expectedMfePercent: analogMfePercent,
        baselineWinProbability,
        baselineRemainingPnlPercent,
        suggestedExposure,
        suggestionLabel: resolveForecastSuggestionLabel(suggestedExposure, currentSnapshot.basis),
        avgDistance,
        currentSnapshot,
        analogs: selected.slice(0, 8).map(({ candidate, distance }) => ({
            timeKey: candidate.snapshot.timeKey,
            direction: candidate.snapshot.direction,
            barsHeld: candidate.snapshot.barsHeld,
            distance,
            agreementCount: candidate.snapshot.agreementCount,
            oppositionCount: candidate.snapshot.oppositionCount,
            targetVsAnchor3: candidate.snapshot.targetVsAnchor3,
            targetVsUniverse3: candidate.snapshot.targetVsUniverse3,
            finalIsWin: candidate.finalIsWin,
            finalPnlPercent: candidate.finalPnlPercent,
            remainingPnlPercent: candidate.remainingPnlPercent,
            futureMfePercent: candidate.futureMfePercent,
            futureMaePercent: candidate.futureMaePercent,
        })),
        rationale: buildForecastRationale(
            currentSnapshot,
            winProbability,
            baselineWinProbability,
            expectedRemainingPnlPercent
        ),
    };
}

export function buildHistoricalOpenTradeForecastCandidates(
    context: PortfolioRunContext,
    targetData: OHLCVData[],
    targetArtifacts: PairRunArtifacts,
    anchorSymbol: string,
    peerWeights: Map<string, number>
): ForecastCandidateSample[] {
    const samples: ForecastCandidateSample[] = [];
    for (const tradeRange of targetArtifacts.tradeRanges) {
        if (tradeRange.trade.exitReason === "end_of_data") {
            continue;
        }
        const step = getForecastSamplingStep(tradeRange.exitIndex - tradeRange.entryIndex);
        for (let barIndex = tradeRange.entryIndex; barIndex < tradeRange.exitIndex; barIndex += step) {
            const snapshot = buildForecastSnapshotForOpenTrade(
                context,
                targetData,
                targetArtifacts,
                tradeRange,
                barIndex,
                anchorSymbol,
                peerWeights
            );
            if (!snapshot) {
                continue;
            }
            samples.push({
                snapshot,
                ...buildForecastOutcomeFromState(targetData, tradeRange, barIndex),
            });
        }
    }
    return samples;
}

export function buildHistoricalSignalForecastCandidates(
    context: PortfolioRunContext,
    targetData: OHLCVData[],
    targetArtifacts: PairRunArtifacts,
    anchorSymbol: string,
    peerWeights: Map<string, number>
): ForecastCandidateSample[] {
    return targetArtifacts.tradeRanges
        .filter((tradeRange) => tradeRange.trade.exitReason !== "end_of_data")
        .map((tradeRange) => {
            const signalType: Signal["type"] = tradeRange.trade.type === "long" ? "buy" : "sell";
            const snapshot = buildForecastSnapshotForLatestSignal(
                context,
                targetData,
                targetArtifacts,
                tradeRange.entryIndex,
                {
                    time: targetData[tradeRange.entryIndex]?.time ?? tradeRange.trade.entryTime,
                    type: signalType,
                    price: tradeRange.trade.entryPrice,
                },
                anchorSymbol,
                peerWeights
            );
            if (!snapshot) {
                return null;
            }
            return {
                snapshot,
                ...buildForecastOutcomeFromState(targetData, tradeRange, tradeRange.entryIndex),
            };
        })
        .filter((sample): sample is ForecastCandidateSample => Boolean(sample));
}

export function buildForecastSnapshotForOpenTrade(
    context: PortfolioRunContext,
    targetData: OHLCVData[],
    targetArtifacts: PairRunArtifacts,
    tradeRange: TradeRange,
    barIndex: number,
    anchorSymbol: string,
    peerWeights: Map<string, number>
): ForecastSnapshot | null {
    const candle = targetData[barIndex];
    if (!candle || barIndex < tradeRange.entryIndex || barIndex >= targetData.length) {
        return null;
    }

    const breadth = buildForecastOpenBreadthContext(
        context.benchmarkSymbol,
        tradeRange.trade.type,
        timeKey(candle.time),
        context.runCache,
        peerWeights
    );
    const persistence = computeOpenBreadthPersistence(
        context,
        targetArtifacts,
        tradeRange.trade.type,
        barIndex,
        peerWeights
    );
    const strength = buildDirectionalStrengthSnapshot(context, targetData, barIndex, tradeRange.trade.type, anchorSymbol);
    const currentPnlPercent = computeDirectionalPercentMove(
        tradeRange.trade.entryPrice,
        candle.close,
        tradeRange.trade.type
    );
    const atr = computeAtrAt(targetData, barIndex) ?? (tradeRange.trade.entryPrice * 0.01);

    return {
        basis: "open_trade",
        targetSymbol: context.benchmarkSymbol,
        anchorSymbol,
        direction: tradeRange.trade.type,
        timeKey: timeKey(candle.time),
        barIndex,
        entryIndex: tradeRange.entryIndex,
        barsHeld: Math.max(0, barIndex - tradeRange.entryIndex),
        currentPrice: candle.close,
        entryPrice: tradeRange.trade.entryPrice,
        currentPnlPercent,
        openPnlAtr: computeDirectionalAtrDistance(tradeRange.trade.entryPrice, candle.close, tradeRange.trade.type, atr),
        distanceFromEntryAtr: computeDirectionalAtrDistance(tradeRange.trade.entryPrice, candle.close, tradeRange.trade.type, atr),
        adverseExcursionAtr: computeAdverseExcursionAtr(targetData, tradeRange.entryIndex, barIndex, tradeRange.trade.type, tradeRange.trade.entryPrice, atr),
        agreementCount: breadth.sameCount,
        oppositionCount: breadth.oppositeCount,
        activePeerCount: breadth.activePeerCount,
        weightedAgreementRatio: breadth.totalPeerWeight > 0 ? breadth.weightedSame / breadth.totalPeerWeight : 0,
        weightedOppositionRatio: breadth.totalPeerWeight > 0 ? breadth.weightedOpposite / breadth.totalPeerWeight : 0,
        breadthRatio: breadth.activePeerCount > 0 ? breadth.sameCount / breadth.activePeerCount : 0,
        breadthPersistence: persistence,
        targetVsAnchor1: strength.targetVsAnchor1,
        targetVsAnchor3: strength.targetVsAnchor3,
        targetVsAnchor5: strength.targetVsAnchor5,
        targetVsUniverse1: strength.targetVsUniverse1,
        targetVsUniverse3: strength.targetVsUniverse3,
        targetVsUniverse5: strength.targetVsUniverse5,
        dispersion1: strength.dispersion1,
        leaderGap1: strength.leaderGap1,
        agreeingSymbols: breadth.agreeingSymbols,
        opposingSymbols: breadth.opposingSymbols,
    };
}

export function buildForecastSnapshotForLatestSignal(
    context: PortfolioRunContext,
    targetData: OHLCVData[],
    targetArtifacts: PairRunArtifacts,
    barIndex: number,
    signal: Pick<Signal, "time" | "type" | "price">,
    anchorSymbol: string,
    peerWeights: Map<string, number>
): ForecastSnapshot | null {
    const candle = targetData[barIndex];
    if (!candle) {
        return null;
    }

    const direction: Trade["type"] = signal.type === "buy" ? "long" : "short";
    const breadth = buildForecastSignalBreadthContext(
        context.benchmarkSymbol,
        targetArtifacts,
        barIndex,
        signal.type,
        context.runCache,
        context.lagBars,
        peerWeights
    );
    const persistence = computeSignalBreadthPersistence(
        context,
        targetArtifacts,
        barIndex,
        signal.type,
        peerWeights
    );
    const strength = buildDirectionalStrengthSnapshot(context, targetData, barIndex, direction, anchorSymbol);

    return {
        basis: "latest_signal",
        targetSymbol: context.benchmarkSymbol,
        anchorSymbol,
        direction,
        timeKey: timeKey(signal.time),
        barIndex,
        entryIndex: barIndex,
        barsHeld: 0,
        currentPrice: candle.close,
        entryPrice: signal.price || candle.close,
        currentPnlPercent: 0,
        openPnlAtr: 0,
        distanceFromEntryAtr: 0,
        adverseExcursionAtr: 0,
        agreementCount: breadth.sameCount,
        oppositionCount: breadth.oppositeCount,
        activePeerCount: breadth.activePeerCount,
        weightedAgreementRatio: breadth.totalPeerWeight > 0 ? breadth.weightedSame / breadth.totalPeerWeight : 0,
        weightedOppositionRatio: breadth.totalPeerWeight > 0 ? breadth.weightedOpposite / breadth.totalPeerWeight : 0,
        breadthRatio: breadth.activePeerCount > 0 ? breadth.sameCount / breadth.activePeerCount : 0,
        breadthPersistence: persistence,
        targetVsAnchor1: strength.targetVsAnchor1,
        targetVsAnchor3: strength.targetVsAnchor3,
        targetVsAnchor5: strength.targetVsAnchor5,
        targetVsUniverse1: strength.targetVsUniverse1,
        targetVsUniverse3: strength.targetVsUniverse3,
        targetVsUniverse5: strength.targetVsUniverse5,
        dispersion1: strength.dispersion1,
        leaderGap1: strength.leaderGap1,
        agreeingSymbols: breadth.agreeingSymbols,
        opposingSymbols: breadth.opposingSymbols,
    };
}

export function buildForecastOutcomeFromState(
    targetData: OHLCVData[],
    tradeRange: TradeRange,
    barIndex: number
): Omit<ForecastCandidateSample, "snapshot"> {
    const basisPrice = targetData[barIndex]?.close ?? tradeRange.trade.entryPrice;
    const direction = tradeRange.trade.type;
    const remainingPnlPercent = computeDirectionalPercentMove(basisPrice, tradeRange.trade.exitPrice, direction);
    let futureMfePercent: number | null = null;
    let futureMaePercent: number | null = null;

    if (barIndex <= tradeRange.exitIndex) {
        let bestFavorable = -Infinity;
        let bestAdverse = Infinity;
        for (let index = barIndex; index <= tradeRange.exitIndex; index += 1) {
            const candle = targetData[index];
            if (!candle) {
                continue;
            }
            const favorablePrice = direction === "long" ? candle.high : candle.low;
            const adversePrice = direction === "long" ? candle.low : candle.high;
            bestFavorable = Math.max(bestFavorable, computeDirectionalPercentMove(basisPrice, favorablePrice, direction));
            bestAdverse = Math.min(bestAdverse, computeDirectionalPercentMove(basisPrice, adversePrice, direction));
        }
        futureMfePercent = Number.isFinite(bestFavorable) ? bestFavorable : null;
        futureMaePercent = Number.isFinite(bestAdverse) ? bestAdverse : null;
    }

    return {
        finalIsWin: tradeRange.trade.pnl > 0,
        finalPnlPercent: tradeRange.trade.pnlPercent,
        remainingPnlPercent,
        futureMfePercent,
        futureMaePercent,
    };
}

export function buildForecastOpenBreadthContext(
    targetSymbol: string,
    targetDirection: Trade["type"],
    timeKeyValue: string,
    artifactsBySymbol: Map<string, PairRunArtifacts>,
    peerWeights: Map<string, number>
): ForecastBreadthSnapshot {
    let sameCount = 0;
    let oppositeCount = 0;
    let activePeerCount = 0;
    let weightedSame = 0;
    let weightedOpposite = 0;
    let totalPeerWeight = 0;
    const agreeingSymbols: string[] = [];
    const opposingSymbols: string[] = [];

    for (const [symbol, artifacts] of artifactsBySymbol.entries()) {
        if (symbol === targetSymbol) {
            continue;
        }
        const peerBarIndex = artifacts.timeIndex.get(timeKeyValue);
        if (peerBarIndex === undefined) {
            continue;
        }
        const openTradeRange = findTradeRangeAtIndex(artifacts.tradeRanges, peerBarIndex);
        if (!openTradeRange) {
            continue;
        }

        activePeerCount += 1;
        const weight = peerWeights.get(symbol) ?? 1;
        totalPeerWeight += weight;
        if (openTradeRange.trade.type === targetDirection) {
            sameCount += 1;
            weightedSame += weight;
            agreeingSymbols.push(symbol);
        } else {
            oppositeCount += 1;
            weightedOpposite += weight;
            opposingSymbols.push(symbol);
        }
    }

    return {
        sameCount,
        oppositeCount,
        activePeerCount,
        weightedSame,
        weightedOpposite,
        totalPeerWeight,
        agreeingSymbols,
        opposingSymbols,
    };
}

export function buildForecastSignalBreadthContext(
    targetSymbol: string,
    targetArtifacts: PairRunArtifacts,
    barIndex: number,
    signalType: Signal["type"],
    artifactsBySymbol: Map<string, PairRunArtifacts>,
    lagBars: number,
    peerWeights: Map<string, number>
): ForecastBreadthSnapshot {
    const startIndex = Math.max(0, barIndex - lagBars);
    const windowKeys = targetArtifacts.timeKeys.slice(startIndex, barIndex + 1);
    let sameCount = 0;
    let oppositeCount = 0;
    let activePeerCount = 0;
    let weightedSame = 0;
    let weightedOpposite = 0;
    let totalPeerWeight = 0;
    const agreeingSymbols: string[] = [];
    const opposingSymbols: string[] = [];

    for (const [symbol, artifacts] of artifactsBySymbol.entries()) {
        if (symbol === targetSymbol) {
            continue;
        }
        const latestType = resolveLatestPortfolioSignalType(windowKeys, artifacts.signalPresenceByTime);
        if (!latestType) {
            continue;
        }
        activePeerCount += 1;
        const weight = peerWeights.get(symbol) ?? 1;
        totalPeerWeight += weight;
        if (latestType === signalType) {
            sameCount += 1;
            weightedSame += weight;
            agreeingSymbols.push(symbol);
        } else {
            oppositeCount += 1;
            weightedOpposite += weight;
            opposingSymbols.push(symbol);
        }
    }

    return {
        sameCount,
        oppositeCount,
        activePeerCount,
        weightedSame,
        weightedOpposite,
        totalPeerWeight,
        agreeingSymbols,
        opposingSymbols,
    };
}

export function computeOpenBreadthPersistence(
    context: PortfolioRunContext,
    targetArtifacts: PairRunArtifacts,
    direction: Trade["type"],
    barIndex: number,
    peerWeights: Map<string, number>
): number {
    let persistence = 0;
    for (let offset = 0; offset < 5; offset += 1) {
        const index = barIndex - offset;
        if (index < 0) {
            break;
        }
        const breadth = buildForecastOpenBreadthContext(
            context.benchmarkSymbol,
            direction,
            targetArtifacts.timeKeys[index],
            context.runCache,
            peerWeights
        );
        if (breadth.sameCount < breadth.oppositeCount) {
            break;
        }
        persistence += 1;
    }
    return persistence;
}

export function computeSignalBreadthPersistence(
    context: PortfolioRunContext,
    targetArtifacts: PairRunArtifacts,
    barIndex: number,
    signalType: Signal["type"],
    peerWeights: Map<string, number>
): number {
    let persistence = 0;
    for (let offset = 0; offset < 5; offset += 1) {
        const index = barIndex - offset;
        if (index < 0) {
            break;
        }
        const breadth = buildForecastSignalBreadthContext(
            context.benchmarkSymbol,
            targetArtifacts,
            index,
            signalType,
            context.runCache,
            context.lagBars,
            peerWeights
        );
        if (breadth.sameCount < breadth.oppositeCount) {
            break;
        }
        persistence += 1;
    }
    return persistence;
}

export function buildDirectionalStrengthSnapshot(
    context: PortfolioRunContext,
    targetData: OHLCVData[],
    barIndex: number,
    direction: Trade["type"],
    anchorSymbol: string
): {
    targetVsAnchor1: number | null;
    targetVsAnchor3: number | null;
    targetVsAnchor5: number | null;
    targetVsUniverse1: number | null;
    targetVsUniverse3: number | null;
    targetVsUniverse5: number | null;
    dispersion1: number | null;
    leaderGap1: number | null;
} {
    const targetCandle = targetData[barIndex];
    if (!targetCandle) {
        return {
            targetVsAnchor1: null,
            targetVsAnchor3: null,
            targetVsAnchor5: null,
            targetVsUniverse1: null,
            targetVsUniverse3: null,
            targetVsUniverse5: null,
            dispersion1: null,
            leaderGap1: null,
        };
    }

    const timeKeyValue = timeKey(targetCandle.time);
    const directionFactor = direction === "long" ? 1 : -1;
    const anchorData = context.dataCache.get(anchorSymbol)?.data ?? [];
    const targetVsAnchor1 = computeRelativeStrength(targetData, anchorData, barIndex, timeKeyValue, 1, directionFactor);
    const targetVsAnchor3 = computeRelativeStrength(targetData, anchorData, barIndex, timeKeyValue, 3, directionFactor);
    const targetVsAnchor5 = computeRelativeStrength(targetData, anchorData, barIndex, timeKeyValue, 5, directionFactor);
    const targetVsUniverse1 = computeUniverseRelativeStrength(context, targetData, barIndex, 1, directionFactor);
    const targetVsUniverse3 = computeUniverseRelativeStrength(context, targetData, barIndex, 3, directionFactor);
    const targetVsUniverse5 = computeUniverseRelativeStrength(context, targetData, barIndex, 5, directionFactor);
    const peerReturns: number[] = [];

    for (const symbol of context.selectedSymbols) {
        if (symbol === context.benchmarkSymbol) {
            continue;
        }
        const peerData = context.dataCache.get(symbol)?.data ?? [];
        const value = computeDirectionalReturnAtTime(peerData, timeKeyValue, 1, directionFactor);
        if (typeof value === "number") {
            peerReturns.push(value);
        }
    }

    const targetReturn1 = computeDirectionalReturnAtIndex(targetData, barIndex, 1, directionFactor);
    const leaderGap1 = typeof targetReturn1 === "number" && peerReturns.length > 0
        ? targetReturn1 - Math.max(...peerReturns)
        : null;

    return {
        targetVsAnchor1,
        targetVsAnchor3,
        targetVsAnchor5,
        targetVsUniverse1,
        targetVsUniverse3,
        targetVsUniverse5,
        dispersion1: peerReturns.length > 1 ? standardDeviation(peerReturns) : null,
        leaderGap1,
    };
}

export function computeRelativeStrength(
    targetData: OHLCVData[],
    anchorData: OHLCVData[],
    targetBarIndex: number,
    timeKeyValue: string,
    lookbackBars: number,
    directionFactor: number
): number | null {
    const targetReturn = computeDirectionalReturnAtIndex(targetData, targetBarIndex, lookbackBars, directionFactor);
    const anchorReturn = computeDirectionalReturnAtTime(anchorData, timeKeyValue, lookbackBars, directionFactor);
    if (typeof targetReturn !== "number" || typeof anchorReturn !== "number") {
        return null;
    }
    return targetReturn - anchorReturn;
}

export function computeUniverseRelativeStrength(
    context: PortfolioRunContext,
    targetData: OHLCVData[],
    targetBarIndex: number,
    lookbackBars: number,
    directionFactor: number
): number | null {
    const targetCandle = targetData[targetBarIndex];
    if (!targetCandle) {
        return null;
    }
    const targetReturn = computeDirectionalReturnAtIndex(targetData, targetBarIndex, lookbackBars, directionFactor);
    if (typeof targetReturn !== "number") {
        return null;
    }

    const peerReturns: number[] = [];
    const timeKeyValue = timeKey(targetCandle.time);
    for (const symbol of context.selectedSymbols) {
        if (symbol === context.benchmarkSymbol) {
            continue;
        }
        const peerData = context.dataCache.get(symbol)?.data ?? [];
        const peerReturn = computeDirectionalReturnAtTime(peerData, timeKeyValue, lookbackBars, directionFactor);
        if (typeof peerReturn === "number") {
            peerReturns.push(peerReturn);
        }
    }

    if (peerReturns.length === 0) {
        return null;
    }
    return targetReturn - (peerReturns.reduce((sum, value) => sum + value, 0) / peerReturns.length);
}

export function measureForecastDistance(current: ForecastSnapshot, candidate: ForecastSnapshot): number {
    const parts = [
        measureForecastPart(current.breadthRatio, candidate.breadthRatio, 0.2, 1.3),
        measureForecastPart(current.weightedAgreementRatio, candidate.weightedAgreementRatio, 0.18, 1.2),
        measureForecastPart(current.weightedOppositionRatio, candidate.weightedOppositionRatio, 0.18, 1.2),
        measureForecastPart(current.breadthPersistence, candidate.breadthPersistence, 1.5, 0.9),
        measureForecastPart(current.targetVsAnchor1, candidate.targetVsAnchor1, 1, 1),
        measureForecastPart(current.targetVsAnchor3, candidate.targetVsAnchor3, 2, 1.2),
        measureForecastPart(current.targetVsAnchor5, candidate.targetVsAnchor5, 3, 0.8),
        measureForecastPart(current.targetVsUniverse1, candidate.targetVsUniverse1, 1, 1),
        measureForecastPart(current.targetVsUniverse3, candidate.targetVsUniverse3, 2, 1.2),
        measureForecastPart(current.targetVsUniverse5, candidate.targetVsUniverse5, 3, 0.8),
        measureForecastPart(current.dispersion1, candidate.dispersion1, 1.2, 0.7),
        measureForecastPart(current.leaderGap1, candidate.leaderGap1, 1.2, 0.8),
        measureForecastPart(current.barsHeld, candidate.barsHeld, Math.max(2, current.barsHeld + 2), current.basis === "open_trade" ? 1.4 : 0.4),
        measureForecastPart(current.openPnlAtr, candidate.openPnlAtr, 0.9, current.basis === "open_trade" ? 1.5 : 0.2),
        measureForecastPart(current.adverseExcursionAtr, candidate.adverseExcursionAtr, 0.8, current.basis === "open_trade" ? 1.1 : 0.2),
    ].filter((value): value is number => value !== null);

    if (parts.length === 0) {
        return 999;
    }
    return parts.reduce((sum, value) => sum + value, 0) / parts.length;
}

export function measureForecastPart(
    current: number | null,
    candidate: number | null,
    scale: number,
    weight: number
): number | null {
    if (typeof current !== "number" || !Number.isFinite(current) || typeof candidate !== "number" || !Number.isFinite(candidate)) {
        return null;
    }
    return (Math.abs(current - candidate) / Math.max(scale, 0.0001)) * weight;
}

export function getForecastDistanceWeight(distance: number): number {
    return 1 / (0.35 + Math.max(0, distance));
}

export function computeForecastConfidenceScore(sampleCount: number, avgDistance: number | null): number {
    const sampleComponent = Math.min(1, sampleCount / 24) * 60;
    const distanceComponent = avgDistance === null ? 0 : Math.max(0, 1 - (avgDistance / 2.5)) * 40;
    return Math.max(0, Math.min(100, sampleComponent + distanceComponent));
}

export function resolveForecastSuggestedExposure(
    winProbability: number | null,
    expectedRemainingPnlPercent: number | null,
    snapshot: ForecastSnapshot,
    confidenceScore: number
): number | null {
    if (typeof winProbability !== "number" || typeof expectedRemainingPnlPercent !== "number") {
        return null;
    }
    if (expectedRemainingPnlPercent <= -0.2 || winProbability < 45) {
        return snapshot.basis === "open_trade" ? 0.25 : 0;
    }
    if (winProbability >= 58 && expectedRemainingPnlPercent > 0.3 && confidenceScore >= 75) {
        return 1;
    }
    if (winProbability >= 54 && expectedRemainingPnlPercent > 0.15) {
        return 0.75;
    }
    if (winProbability >= 50 && expectedRemainingPnlPercent >= 0) {
        return 0.5;
    }
    return snapshot.basis === "open_trade" ? 0.35 : 0.25;
}

export function resolveForecastSuggestionLabel(exposure: number | null, basis: ForecastSnapshot["basis"]): string | null {
    if (exposure === null) {
        return null;
    }
    if (basis === "open_trade") {
        if (exposure >= 0.95) return "Hold Full";
        if (exposure >= 0.7) return "Hold Heavy";
        if (exposure >= 0.45) return "Trim";
        return "Defensive Hold";
    }
    if (exposure >= 0.95) return "Full Size";
    if (exposure >= 0.7) return "Half-Heavy";
    if (exposure >= 0.45) return "Probe";
    return "Skip";
}

export function buildForecastRationale(
    snapshot: ForecastSnapshot,
    winProbability: number | null,
    baselineWinProbability: number | null,
    expectedRemainingPnlPercent: number | null
): string[] {
    const notes: string[] = [];
    if (typeof snapshot.targetVsAnchor3 === "number" && snapshot.targetVsAnchor3 > 0.4) {
        notes.push(`Target is outperforming ${toDisplaySymbol(snapshot.anchorSymbol)} on the 3-bar lookback.`);
    } else if (typeof snapshot.targetVsAnchor3 === "number" && snapshot.targetVsAnchor3 < -0.4) {
        notes.push(`Target is lagging ${toDisplaySymbol(snapshot.anchorSymbol)} on the 3-bar lookback.`);
    }
    if (typeof snapshot.targetVsUniverse3 === "number" && snapshot.targetVsUniverse3 > 0.35) {
        notes.push("Target is leading the selected universe rather than just following the basket.");
    } else if (typeof snapshot.targetVsUniverse3 === "number" && snapshot.targetVsUniverse3 < -0.35) {
        notes.push("Target is underperforming the selected universe, which weakens the setup.");
    }
    if (snapshot.weightedOppositionRatio <= 0.2) {
        notes.push("Weighted opposition is muted across peer pairs.");
    } else if (snapshot.weightedOppositionRatio >= 0.45) {
        notes.push("Weighted opposition is elevated across peer pairs.");
    }
    if (snapshot.breadthPersistence >= 3) {
        notes.push(`Breadth support has persisted for ${snapshot.breadthPersistence} bars.`);
    }
    if (typeof winProbability === "number" && typeof baselineWinProbability === "number") {
        notes.push(
            `${winProbability >= baselineWinProbability ? "Analog win rate is above" : "Analog win rate is below"} ` +
            `the directional baseline by ${(winProbability - baselineWinProbability).toFixed(1)} pts.`
        );
    }
    if (typeof expectedRemainingPnlPercent === "number") {
        notes.push(`Remaining-path expectancy from this state is ${formatPercent(expectedRemainingPnlPercent)}.`);
    }
    return notes.slice(0, 4);
}

export function findLatestSignalReference(targetArtifacts: PairRunArtifacts): { signal: Signal; barIndex: number } | null {
    for (let index = targetArtifacts.fullSignals.length - 1; index >= 0; index -= 1) {
        const signal = targetArtifacts.fullSignals[index];
        const barIndex = targetArtifacts.timeIndex.get(timeKey(signal.time));
        if (barIndex === undefined) {
            continue;
        }
        return { signal, barIndex };
    }
    return null;
}

export function buildForecastPeerWeights(rows: PairAnalysisRow[], benchmarkSymbol: string): Map<string, number> {
    const result = new Map<string, number>();
    const maxExpectancy = Math.max(1, ...rows.map((row) => Math.abs(row.result.expectancy)));

    for (const row of rows) {
        if (row.symbol === benchmarkSymbol) {
            continue;
        }
        const correlationScore = Math.abs(row.strategyCorrelation ?? row.marketCorrelation ?? 0);
        const expectancyScore = Math.max(-1, Math.min(1, row.result.expectancy / maxExpectancy));
        const weight = Math.max(
            0.35,
            Math.min(1.75, 0.65 + (correlationScore * 0.65) + (Math.max(0, expectancyScore) * 0.45))
        );
        result.set(row.symbol, weight);
    }

    return result;
}

export function getForecastSamplingStep(durationBars: number): number {
    if (durationBars <= 18) {
        return 1;
    }
    if (durationBars <= 45) {
        return 2;
    }
    return 3;
}
