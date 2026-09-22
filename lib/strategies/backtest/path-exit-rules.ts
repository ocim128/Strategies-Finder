import { OHLCVData } from '../../types/index';
import { NormalizedSettings, PositionState } from '../../types/backtest';
import { directionFactorFor } from './backtest-utils';
import { PositionExitTrigger } from './exit-handlers';

export interface PathExitLearningState {
    hazardSamples: Map<string, { count: number; sum: number }>;
    barrierSamples: Map<string, { count: number; sum: number }>;
    /** First barrier hits reused by every closed trade in this backtest. */
    tripleBarrierHits?: Map<string, TripleBarrierFirstHitIndices>;
}

export interface TripleBarrierFirstHitIndices {
    favorable: Int32Array;
    adverse: Int32Array;
    /** Set only for the lazy cache used by the backtest learner. */
    computed?: Uint8Array;
}

export interface PathExitEvaluationContext {
    data: OHLCVData[];
    barIndex: number;
    atrValue: number | null | undefined;
    learningState?: PathExitLearningState;
}

function getBarsHeldBucket(bars: number): number {
    if (bars <= 2) return 0;
    if (bars <= 5) return 1;
    if (bars <= 10) return 2;
    if (bars <= 20) return 3;
    return 4;
}

function getPercentBucket(pct: number): number {
    if (pct < -1.0) return 0;
    if (pct < 0.0) return 1;
    if (pct <= 1.0) return 2;
    if (pct <= 3.0) return 3;
    return 4;
}

function getMfeBucket(pct: number): number {
    if (pct < 1.0) return 0;
    if (pct <= 3.0) return 1;
    return 2;
}

function normalizeBarrierHeightPercent(threshold: number): number {
    return threshold <= 0 ? 1.0 : (threshold > 100 ? 100 : threshold);
}

/**
 * Precompute the first favorable and adverse barrier hit for every possible
 * start bar. The original learner performed the same forward scan once per
 * held bar of every closed trade; this keeps the exact first-hit semantics but
 * shares each start-bar scan across all trades in one backtest.
 */
export function buildTripleBarrierFirstHitIndices(
    data: OHLCVData[],
    directionFactor: number,
    barrierHeightPercent: number,
    horizon: number,
): TripleBarrierFirstHitIndices {
    const favorable = new Int32Array(data.length);
    const adverse = new Int32Array(data.length);
    favorable.fill(-1);
    adverse.fill(-1);

    const isShortPosition = directionFactor < 0;
    for (let i = 0; i < data.length; i++) {
        const hits = computeTripleBarrierFirstHitAt(
            data,
            i,
            directionFactor,
            barrierHeightPercent,
            horizon,
            isShortPosition,
        );
        favorable[i] = hits.favorable;
        adverse[i] = hits.adverse;
    }
    return { favorable, adverse };
}

function computeTripleBarrierFirstHitAt(
    data: OHLCVData[],
    startIndex: number,
    directionFactor: number,
    barrierHeightPercent: number,
    horizon: number,
    isShortPosition = directionFactor < 0,
): { favorable: number; adverse: number } {
    const candle = data[startIndex];
    if (!candle) return { favorable: -1, adverse: -1 };
    const targetProfitPrice = candle.close * (1 + directionFactor * (barrierHeightPercent / 100));
    const stopLossPrice = candle.close * (1 - directionFactor * (barrierHeightPercent / 100));
    const maxForwardIdx = Math.min(data.length - 1, startIndex + horizon);
    let favorable = -1;
    let adverse = -1;
    for (let j = startIndex + 1; j <= maxForwardIdx; j++) {
        const fCandle = data[j];
        if (!fCandle) continue;

        const hitFavorable = isShortPosition
            ? fCandle.low <= targetProfitPrice
            : fCandle.high >= targetProfitPrice;
        const hitAdverse = isShortPosition
            ? fCandle.high >= stopLossPrice
            : fCandle.low <= stopLossPrice;
        if (hitFavorable && favorable === -1) favorable = j;
        if (hitAdverse && adverse === -1) adverse = j;
        if (favorable !== -1 && adverse !== -1) break;
    }
    return { favorable, adverse };
}

function getTripleBarrierFirstHitIndices(
    data: OHLCVData[],
    learningState: PathExitLearningState,
    directionFactor: number,
    threshold: number,
    horizon: number,
): TripleBarrierFirstHitIndices {
    const barrierHeightPercent = normalizeBarrierHeightPercent(threshold);
    const cache = learningState.tripleBarrierHits ??= new Map();
    const key = `${directionFactor}|${barrierHeightPercent}|${horizon}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const hits: TripleBarrierFirstHitIndices = {
        favorable: new Int32Array(data.length),
        adverse: new Int32Array(data.length),
        computed: new Uint8Array(data.length),
    };
    hits.favorable.fill(-1);
    hits.adverse.fill(-1);
    cache.set(key, hits);
    return hits;
}

export function getPathStateKey(barsInTrade: number, currentPnLPercent: number, mfePercent: number): string {
    return `${getBarsHeldBucket(barsInTrade)}_${getPercentBucket(currentPnLPercent)}_${getMfeBucket(mfePercent)}`;
}

export function learnFromClosedTrade(
    pos: PositionState,
    entryBarIndex: number,
    exitBarIndex: number,
    exitPrice: number,
    data: OHLCVData[],
    learningState: PathExitLearningState,
    config: NormalizedSettings
): void {
    const directionFactor = directionFactorFor(pos.direction);
    const isShortPosition = pos.direction === 'short';

    if (entryBarIndex >= exitBarIndex) return;

    const horizon = config.pathExitHorizonBars;
    const barrierHeightPercent = normalizeBarrierHeightPercent(config.pathExitThreshold);
    const tripleBarrierHits = getTripleBarrierFirstHitIndices(
        data,
        learningState,
        directionFactor,
        barrierHeightPercent,
        horizon,
    );

    let extremePrice = pos.entryPrice;

    for (let i = entryBarIndex; i < exitBarIndex; i++) {
        const candle = data[i];
        if (!candle) continue;
        const barsInTrade = i - entryBarIndex + 1;

        extremePrice = isShortPosition
            ? Math.min(extremePrice, candle.low)
            : Math.max(extremePrice, candle.high);

        const currentPnLPercent = (directionFactor * (candle.close - pos.entryPrice) / pos.entryPrice) * 100;
        const maxExcursion = directionFactor * (extremePrice - pos.entryPrice);
        const mfePercent = (maxExcursion / pos.entryPrice) * 100;

        const stateKey = getPathStateKey(barsInTrade, currentPnLPercent, mfePercent);

        // a. conditional_hazard
        const remainingReturn = directionFactor * ((exitPrice - candle.close) / candle.close) * 100;
        const hazardEntry = learningState.hazardSamples.get(stateKey) ?? { count: 0, sum: 0 };
        hazardEntry.count += 1;
        hazardEntry.sum += remainingReturn;
        learningState.hazardSamples.set(stateKey, hazardEntry);

        // b. triple_barrier_meta
        let label = 0;
        const maxForwardIdx = Math.min(exitBarIndex, i + horizon);
        const computed = tripleBarrierHits.computed!;
        if (computed[i] === 0) {
            const hits = computeTripleBarrierFirstHitAt(
                data,
                i,
                directionFactor,
                barrierHeightPercent,
                horizon,
                isShortPosition,
            );
            tripleBarrierHits.favorable[i] = hits.favorable;
            tripleBarrierHits.adverse[i] = hits.adverse;
            computed[i] = 1;
        }
        const favorableHit = tripleBarrierHits.favorable[i] ?? -1;
        const adverseHit = tripleBarrierHits.adverse[i] ?? -1;
        const favorableWithinTrade = favorableHit >= 0 && favorableHit <= maxForwardIdx;
        const adverseWithinTrade = adverseHit >= 0 && adverseHit <= maxForwardIdx;
        if (favorableWithinTrade && adverseWithinTrade) {
            label = favorableHit < adverseHit ? 1 : favorableHit > adverseHit ? -1 : 0;
        } else if (favorableWithinTrade) {
            label = 1;
        } else if (adverseWithinTrade) {
            label = -1;
        }

        const barrierEntry = learningState.barrierSamples.get(stateKey) ?? { count: 0, sum: 0 };
        barrierEntry.count += 1;
        barrierEntry.sum += label;
        learningState.barrierSamples.set(stateKey, barrierEntry);
    }
}

function canExitAfterMinimumHold(position: PositionState, config: NormalizedSettings): boolean {
    return !config.riskMinHoldEnabled
        || config.riskMinHoldBars <= 0
        || position.barsInTrade >= config.riskMinHoldBars;
}

export function evaluatePathExit(
    candle: OHLCVData,
    position: PositionState,
    config: NormalizedSettings,
    context?: PathExitEvaluationContext
): PositionExitTrigger | null {
    if (!config.pathExitEnabled || !context || config.pathExitMode === 'off') {
        return null;
    }

    // Gated by minimum hold guard
    if (!canExitAfterMinimumHold(position, config)) {
        return null;
    }
    if (position.barsInTrade < config.pathExitMinBars) {
        return null;
    }

    const directionFactor = directionFactorFor(position.direction);
    const isShortPosition = position.direction === 'short';

    if (config.pathExitMode === 'mfe_giveback') {
        // Track favorable extreme using existing position.extremePrice and current candle
        const currentExtreme = isShortPosition
            ? Math.min(position.extremePrice, candle.low)
            : Math.max(position.extremePrice, candle.high);

        // Compute MFE from entry to extreme
        const maxExcursion = directionFactor * (currentExtreme - position.entryPrice);
        if (maxExcursion <= 0) {
            return null;
        }

        const mfePercent = (maxExcursion / position.entryPrice) * 100;

        // Giveback amount (distance from extreme to close)
        const givebackAmount = directionFactor * (currentExtreme - candle.close);
        const givebackPercent = (givebackAmount / maxExcursion) * 100;

        if (mfePercent >= config.pathExitMinMfePercent && givebackPercent >= config.pathExitGivebackPercent) {
            return {
                exitPrice: candle.close,
                exitSize: position.size,
                exitReason: 'path_exit',
            };
        }
    }

    if (config.pathExitMode === 'profit_compression') {
        // Compute current signed profit percent and bars held
        const profitPercent = (directionFactor * (candle.close - position.entryPrice) / position.entryPrice) * 100;
        const barsHeld = position.barsInTrade;
        if (profitPercent <= 0 || barsHeld <= 0) {
            return null;
        }

        // MFE threshold check
        const currentExtreme = isShortPosition
            ? Math.min(position.extremePrice, candle.low)
            : Math.max(position.extremePrice, candle.high);
        const maxExcursion = directionFactor * (currentExtreme - position.entryPrice);
        const mfePercent = (maxExcursion / position.entryPrice) * 100;

        if (mfePercent < config.pathExitMinMfePercent) {
            return null;
        }

        // Decays below threshold
        const profitRate = profitPercent / barsHeld;
        if (profitRate >= config.pathExitThreshold) {
            return null;
        }

        // Check if trade is still accelerating/extending in the favorable direction
        const isNewExtreme = isShortPosition
            ? candle.low < position.extremePrice
            : candle.high > position.extremePrice;

        if (isNewExtreme) {
            return null;
        }

        return {
            exitPrice: candle.close,
            exitSize: position.size,
            exitReason: 'path_exit',
        };
    }

    if (config.pathExitMode === 'momentum_deceleration') {
        const lookback = config.pathExitLookbackBars;
        if (position.barsInTrade < lookback || context.barIndex < lookback + 1) {
            return null;
        }

        const profitPercent = (directionFactor * (candle.close - position.entryPrice) / position.entryPrice) * 100;
        if (profitPercent <= 0) {
            return null;
        }

        const currentClose = candle.close;
        const pastClose = context.data[context.barIndex - lookback].close;
        const momentum = directionFactor * ((currentClose - pastClose) / pastClose) * 100;

        const prevClose = context.data[context.barIndex - 1].close;
        const prevPastClose = context.data[context.barIndex - 1 - lookback].close;
        const prevMomentum = directionFactor * ((prevClose - prevPastClose) / prevPastClose) * 100;

        if (prevMomentum >= config.pathExitThreshold && momentum < config.pathExitThreshold) {
            return {
                exitPrice: candle.close,
                exitSize: position.size,
                exitReason: 'path_exit',
            };
        }
    }

    if (config.pathExitMode === 'capitulation_exhaustion') {
        const lookback = config.pathExitLookbackBars;
        if (context.barIndex < lookback + 1 || position.barsInTrade < 1) {
            return null;
        }

        const prevCandle = context.data[context.barIndex - 1];
        const isBullish = prevCandle.close > prevCandle.open;
        const isBearish = prevCandle.close < prevCandle.open;

        // Must be in trade direction
        if (isShortPosition && !isBearish) {
            return null;
        }
        if (!isShortPosition && !isBullish) {
            return null;
        }

        const prevRange = prevCandle.high - prevCandle.low;
        const prevBody = Math.abs(prevCandle.close - prevCandle.open);
        const prevVolume = prevCandle.volume;

        let rangeCount = 0;
        let bodyCount = 0;
        let volumeCount = 0;

        for (let k = context.barIndex - 1 - lookback; k <= context.barIndex - 2; k++) {
            const histCandle = context.data[k];
            const histRange = histCandle.high - histCandle.low;
            const histBody = Math.abs(histCandle.close - histCandle.open);
            if (histRange < prevRange) rangeCount++;
            if (histBody < prevBody) bodyCount++;
            if (histCandle.volume < prevVolume) volumeCount++;
        }

        const rangePct = rangeCount / lookback;
        const bodyPct = bodyCount / lookback;
        const volumePct = volumeCount / lookback;
        const maxPct = Math.max(rangePct, bodyPct, volumePct);

        const thresholdRaw = config.pathExitThreshold;
        const threshold = thresholdRaw <= 0 ? 0.90 : (thresholdRaw > 1 ? thresholdRaw / 100 : thresholdRaw);

        if (maxPct >= threshold) {
            // Capitulation detected on prevCandle. Check current candle for lack of follow-through.
            const midpoint = (prevCandle.open + prevCandle.close) / 2;
            const failsToExtend = isShortPosition
                ? candle.low >= prevCandle.low
                : candle.high <= prevCandle.high;
            const closesBack = isShortPosition
                ? candle.close > midpoint
                : candle.close < midpoint;

            if (failsToExtend || closesBack) {
                return {
                    exitPrice: candle.close,
                    exitSize: position.size,
                    exitReason: 'path_exit',
                };
            }
        }
    }

    if (config.pathExitMode === 'squeeze_pressure') {
        const lookback = config.pathExitLookbackBars;
        if (context.barIndex < lookback) {
            return null;
        }

        const isOppositeColor = isShortPosition
            ? candle.close > candle.open
            : candle.close < candle.open;

        const isCloseLocationAgainst = isShortPosition
            ? candle.close > (candle.high + candle.low) / 2
            : candle.close < (candle.high + candle.low) / 2;

        if (isOppositeColor && isCloseLocationAgainst) {
            // Calculate averages
            let totalRange = 0;
            let totalVolume = 0;
            let totalClose = 0;
            for (let k = 1; k <= lookback; k++) {
                const histCandle = context.data[context.barIndex - k];
                totalRange += histCandle.high - histCandle.low;
                totalVolume += histCandle.volume;
                totalClose += histCandle.close;
            }
            const avgRange = totalRange / lookback;
            const avgVolume = totalVolume / lookback;
            const sma = totalClose / lookback;

            const isExpansion = (candle.high - candle.low) > avgRange || candle.volume > avgVolume;
            const isSmaReclaimed = isShortPosition ? candle.close > sma : candle.close < sma;

            if (isExpansion || isSmaReclaimed) {
                // Check MFE or min bars guard
                const currentExtreme = isShortPosition
                    ? Math.min(position.extremePrice, candle.low)
                    : Math.max(position.extremePrice, candle.high);
                const maxExcursion = directionFactor * (currentExtreme - position.entryPrice);

                if (maxExcursion > 0 || position.barsInTrade >= config.pathExitMinBars) {
                    return {
                        exitPrice: candle.close,
                        exitSize: position.size,
                        exitReason: 'path_exit',
                    };
                }
            }
        }
    }

    if (config.pathExitMode === 'structure_reclaim') {
        const lookback = config.pathExitLookbackBars;
        const entryIdx = position.openedBarIndex ?? 0;
        const breakoutBarIndex = Math.max(0, config.executionModel === 'next_open' ? entryIdx - 1 : entryIdx);
        const breakoutCandle = context.data[breakoutBarIndex];
        const breakoutMidpoint = (breakoutCandle.open + breakoutCandle.close) / 2;

        let swingLevel = breakoutCandle.low;
        const startIdx = Math.max(0, breakoutBarIndex - lookback);
        if (isShortPosition) {
            swingLevel = breakoutCandle.high;
            for (let k = startIdx; k < breakoutBarIndex; k++) {
                swingLevel = Math.max(swingLevel, context.data[k].high);
            }
        } else {
            swingLevel = breakoutCandle.low;
            for (let k = startIdx; k < breakoutBarIndex; k++) {
                swingLevel = Math.min(swingLevel, context.data[k].low);
            }
        }

        const structureLevel = (breakoutMidpoint + swingLevel) / 2;
        const isReclaimed = isShortPosition
            ? candle.close > structureLevel
            : candle.close < structureLevel;

        if (isReclaimed) {
            return {
                exitPrice: candle.close,
                exitSize: position.size,
                exitReason: 'path_exit',
            };
        }
    }

    if (config.pathExitMode === 'conditional_hazard') {
        const barsInTrade = position.barsInTrade;
        const currentPnLPercent = (directionFactor * (candle.close - position.entryPrice) / position.entryPrice) * 100;
        const currentExtreme = isShortPosition
            ? Math.min(position.extremePrice, candle.low)
            : Math.max(position.extremePrice, candle.high);
        const maxExcursion = directionFactor * (currentExtreme - position.entryPrice);
        const mfePercent = (maxExcursion / position.entryPrice) * 100;

        const stateKey = getPathStateKey(barsInTrade, currentPnLPercent, mfePercent);
        const samples = context.learningState?.hazardSamples.get(stateKey);

        if (samples && samples.count >= config.pathExitMinSamples) {
            const expectancy = samples.sum / samples.count;

            if (expectancy <= 0) {
                return {
                    exitPrice: candle.close,
                    exitSize: position.size,
                    exitReason: 'path_exit',
                };
            }
        }
    }

    if (config.pathExitMode === 'triple_barrier_meta') {
        const barsInTrade = position.barsInTrade;
        const currentPnLPercent = (directionFactor * (candle.close - position.entryPrice) / position.entryPrice) * 100;
        const currentExtreme = isShortPosition
            ? Math.min(position.extremePrice, candle.low)
            : Math.max(position.extremePrice, candle.high);
        const maxExcursion = directionFactor * (currentExtreme - position.entryPrice);
        const mfePercent = (maxExcursion / position.entryPrice) * 100;

        const stateKey = getPathStateKey(barsInTrade, currentPnLPercent, mfePercent);
        const samples = context.learningState?.barrierSamples.get(stateKey);

        if (samples && samples.count >= config.pathExitMinSamples) {
            const expectancy = samples.sum / samples.count;

            if (expectancy <= 0) {
                return {
                    exitPrice: candle.close,
                    exitSize: position.size,
                    exitReason: 'path_exit',
                };
            }
        }
    }

    return null;
}
