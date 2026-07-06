import { OHLCVData } from '../../types/index';
import { NormalizedSettings, PositionState } from '../../types/backtest';
import { directionFactorFor } from './backtest-utils';
import { PositionExitTrigger } from './exit-handlers';

export interface PathExitLearningState {
    hazardSamples: Map<string, { count: number; sum: number }>;
    barrierSamples: Map<string, { count: number; sum: number }>;
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
        const threshold = config.pathExitThreshold;
        const barrierHeightPercent = threshold <= 0 ? 1.0 : (threshold > 100 ? 100 : threshold);
        const targetProfitPrice = candle.close * (1 + directionFactor * (barrierHeightPercent / 100));
        const stopLossPrice = candle.close * (1 - directionFactor * (barrierHeightPercent / 100));
        const horizon = config.pathExitHorizonBars;

        let label = 0;
        const maxForwardIdx = Math.min(exitBarIndex, i + horizon);

        for (let j = i + 1; j <= maxForwardIdx; j++) {
            const fCandle = data[j];
            if (!fCandle) continue;

            if (isShortPosition) {
                const hitFavorable = fCandle.low <= targetProfitPrice;
                const hitAdverse = fCandle.high >= stopLossPrice;
                if (hitFavorable && hitAdverse) {
                    label = 0;
                    break;
                } else if (hitFavorable) {
                    label = 1;
                    break;
                } else if (hitAdverse) {
                    label = -1;
                    break;
                }
            } else {
                const hitFavorable = fCandle.high >= targetProfitPrice;
                const hitAdverse = fCandle.low <= stopLossPrice;
                if (hitFavorable && hitAdverse) {
                    label = 0;
                    break;
                } else if (hitFavorable) {
                    label = 1;
                    break;
                } else if (hitAdverse) {
                    label = -1;
                    break;
                }
            }
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
