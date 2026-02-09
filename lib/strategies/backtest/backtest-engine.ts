
import { BacktestResult, BacktestSettings, OHLCVData, Signal, Time, Trade } from '../types';
import { calculateADX, calculateATR, calculateEMA, calculateRSI, calculateSMA } from '../indicators';
import { calculateSharpeRatioFromMoments, calculateSharpeRatioFromReturns } from '../performance-metrics';
import { ensureCleanData, getCloses, getHighs, getLows, getVolumes } from '../strategy-helpers';
import { IndicatorSeries, PositionState, PrecomputedIndicators, TradeSizingConfig } from './backtest-types';
import { allowsSignalAsEntry, applySlippage, compareTime, directionFactorFor, directionToSignalType, entrySideForDirection, exitSideForDirection, normalizeBacktestSettings, normalizeTradeDirection, signalToPositionDirection } from './backtest-utils';
import { resolveTrendPeriod } from './trade-filters';
import { prepareSignals } from './signal-preparation';

/**
 * Pre-computes all indicators needed for backtesting based on settings.
 * Call this ONCE before running multiple backtests with the same settings.
 * This dramatic optimization prevents recalculating indicators for each
 * parameter combination in the finder.
 * 
 * @param data OHLCV data array
 * @param settings Backtest settings that determine which indicators are needed
 * @returns Pre-computed indicators that can be passed to runBacktestCompact
 */
export function precomputeIndicators(
    data: OHLCVData[],
    settings: BacktestSettings = {}
): PrecomputedIndicators {
    const config = normalizeBacktestSettings(settings);

    const highs = getHighs(data);
    const lows = getLows(data);
    const closes = getCloses(data);
    const volumes = getVolumes(data);

    const needsAtr =
        config.stopLossAtr > 0 ||
        config.takeProfitAtr > 0 ||
        config.trailingAtr > 0 ||
        config.atrPercentMin > 0 ||
        config.atrPercentMax > 0 ||
        config.partialTakeProfitAtR > 0 ||
        config.breakEvenAtR > 0;

    const atr = needsAtr ? calculateATR(highs, lows, closes, config.atrPeriod) : [];
    const trendPeriod = resolveTrendPeriod(config);
    const emaTrend = trendPeriod > 0 ? calculateEMA(closes, trendPeriod) : [];

    const useAdx = config.tradeFilterMode === 'adx' || config.adxMin > 0 || config.adxMax > 0;
    const adxPeriod = useAdx ? Math.max(1, config.adxPeriod) : 0;
    const adx = useAdx ? calculateADX(highs, lows, closes, adxPeriod) : [];

    const volumeSma = config.tradeFilterMode === 'volume'
        ? calculateSMA(volumes, config.volumeSmaPeriod)
        : [];
    const rsi = config.tradeFilterMode === 'rsi'
        ? calculateRSI(closes, config.rsiPeriod)
        : [];

    return {
        atr,
        emaTrend,
        adx,
        volumeSma,
        rsi,
        dataLength: data.length
    };
}

export function runBacktestCompact(
    data: OHLCVData[],
    signals: Signal[],
    initialCapital: number,
    positionSizePercent: number,
    commissionPercent: number,
    settings: BacktestSettings = {},
    sizing?: Partial<TradeSizingConfig>,
    precomputed?: PrecomputedIndicators
): BacktestResult {
    // fast-fail for no signals
    if (signals.length === 0) {
        return {
            trades: [],
            netProfit: 0,
            netProfitPercent: 0,
            winRate: 0,
            expectancy: 0,
            avgTrade: 0,
            profitFactor: 0,
            maxDrawdown: 0,
            maxDrawdownPercent: 0,
            totalTrades: 0,
            winningTrades: 0,
            losingTrades: 0,
            avgWin: 0,
            avgLoss: 0,
            sharpeRatio: 0,
            equityCurve: []
        };
    }

    const config = normalizeBacktestSettings(settings);
    const tradeDirection = normalizeTradeDirection(settings);
    const sizingMode = sizing?.mode ?? 'percent';
    const fixedTradeAmount = Math.max(0, sizing?.fixedTradeAmount ?? 0);

    const highs = getHighs(data);
    const lows = getLows(data);
    const closes = getCloses(data);
    const volumes = getVolumes(data);
    const dataLen = data.length;

    const needsAtr =
        config.stopLossAtr > 0 ||
        config.takeProfitAtr > 0 ||
        config.trailingAtr > 0 ||
        config.atrPercentMin > 0 ||
        config.atrPercentMax > 0 ||
        config.partialTakeProfitAtR > 0 ||
        config.breakEvenAtR > 0;

    const atr = (precomputed?.atr?.length === dataLen)
        ? precomputed.atr
        : (needsAtr ? calculateATR(highs, lows, closes, config.atrPeriod) : []);

    const trendPeriod = resolveTrendPeriod(config);
    const emaTrend = (precomputed?.emaTrend?.length === dataLen && trendPeriod > 0) // Validation is tricky here, assuming precomputed logic matches
        ? precomputed.emaTrend
        : (trendPeriod > 0 ? calculateEMA(closes, trendPeriod) : []);

    const useAdx = config.tradeFilterMode === 'adx' || config.adxMin > 0 || config.adxMax > 0;
    const adxPeriod = useAdx ? Math.max(1, config.adxPeriod) : 0;
    const adx = (precomputed?.adx?.length === dataLen && useAdx)
        ? precomputed.adx
        : (useAdx ? calculateADX(highs, lows, closes, adxPeriod) : []);

    const volumeSma = (precomputed?.volumeSma?.length === dataLen && config.tradeFilterMode === 'volume')
        ? precomputed.volumeSma
        : (config.tradeFilterMode === 'volume'
            ? calculateSMA(volumes, config.volumeSmaPeriod)
            : []);

    const rsi = (precomputed?.rsi?.length === dataLen && config.tradeFilterMode === 'rsi')
        ? precomputed.rsi
        : (config.tradeFilterMode === 'rsi'
            ? calculateRSI(closes, config.rsiPeriod)
            : []);

    const indicatorSeries: IndicatorSeries = {
        atr,
        emaTrend,
        adx,
        volumeSma,
        rsi
    };

    const preparedSignals = prepareSignals(data, signals, config, indicatorSeries, tradeDirection);

    let capital = initialCapital;
    let position: PositionState | null = null;

    const commissionRate = commissionPercent / 100;
    const slippageRate = config.slippageBps / 10000;
    let signalIdx = 0;

    let totalTrades = 0;
    let winningTrades = 0;
    let losingTrades = 0;
    let totalProfit = 0;
    let totalLoss = 0;
    let avgReturn = 0;
    let returnM2 = 0;

    let peakEquity = initialCapital;
    let maxDrawdown = 0;
    let maxDrawdownPercent = 0;

    const updateDrawdown = (equity: number) => {
        if (equity > peakEquity) {
            peakEquity = equity;
            return;
        }
        const drawdown = peakEquity - equity;
        if (drawdown > maxDrawdown) {
            maxDrawdown = drawdown;
            maxDrawdownPercent = peakEquity > 0 ? (drawdown / peakEquity) * 100 : 0;
        }
    };

    const recordTrade = (totalPnl: number, pnlPercent: number) => {
        totalTrades += 1;
        if (totalPnl > 0) {
            winningTrades += 1;
            totalProfit += totalPnl;
        } else {
            losingTrades += 1;
            totalLoss += Math.abs(totalPnl);
        }

        const delta = pnlPercent - avgReturn;
        avgReturn += delta / totalTrades;
        const delta2 = pnlPercent - avgReturn;
        returnM2 += delta * delta2;
    };

    const exitPosition = (exitPrice: number, exitSize: number) => {
        if (!position || exitSize <= 0) return;

        const directionFactor = directionFactorFor(position.direction);
        const size = Math.min(exitSize, position.size);
        const exitValue = size * exitPrice;
        const entryValue = size * position.entryPrice;
        const commission = exitValue * commissionRate;
        const entryCommission = position.entryCommissionPerShare * size;

        const rawPnl = (exitValue - entryValue) * directionFactor;
        const totalPnl = rawPnl - entryCommission - commission;
        const pnlPercent = entryValue > 0 ? (rawPnl / entryValue) * 100 : 0;

        capital += rawPnl - commission;
        recordTrade(totalPnl, pnlPercent);

        position.size -= size;
        if (position.size <= 0) {
            position = null;
        }
    };

    const buildPositionFromSignal = (signal: Signal, barIndex: number): { nextPosition: PositionState; entryCommission: number } | null => {
        if (!allowsSignalAsEntry(signal.type, tradeDirection)) return null;

        const atrValue = needsAtr ? atr[barIndex] : null;

        const requiresAtrForEntry =
            config.stopLossAtr > 0 ||
            config.takeProfitAtr > 0 ||
            config.trailingAtr > 0 ||
            config.partialTakeProfitAtR > 0 ||
            config.breakEvenAtR > 0;

        if (requiresAtrForEntry && (atrValue === null || atrValue === undefined)) return null;

        const allocatedCapital = (sizingMode === 'fixed' && fixedTradeAmount > 0)
            ? fixedTradeAmount
            : capital * (positionSizePercent / 100);
        if (!Number.isFinite(allocatedCapital) || allocatedCapital <= 0) return null;

        const tradeValue = allocatedCapital / (1 + commissionRate);
        const entryCommission = tradeValue * commissionRate;
        const direction = signalToPositionDirection(signal.type);
        const directionFactor = directionFactorFor(direction);
        const entrySide = entrySideForDirection(direction);
        const entryFillPrice = applySlippage(signal.price, entrySide, slippageRate);

        if (!Number.isFinite(entryFillPrice) || entryFillPrice <= 0 || !Number.isFinite(tradeValue) || tradeValue <= 0) return null;

        const shares = tradeValue / entryFillPrice;
        if (!Number.isFinite(shares) || shares <= 0) return null;

        const stopLossPrice = (atrValue !== null && atrValue !== undefined)
            ? (config.stopLossAtr > 0
                ? entryFillPrice - directionFactor * config.stopLossAtr * atrValue
                : config.trailingAtr > 0
                    ? entryFillPrice - directionFactor * config.trailingAtr * atrValue
                    : null)
            : null;

        const takeProfitPrice = (atrValue !== null && atrValue !== undefined && config.takeProfitAtr > 0)
            ? entryFillPrice + directionFactor * config.takeProfitAtr * atrValue
            : null;

        let riskPerShare = 0;
        if (config.riskMode === 'percentage') {
            if (config.stopLossEnabled && config.stopLossPercent > 0) {
                riskPerShare = entryFillPrice * (config.stopLossPercent / 100);
            }
        } else if (atrValue !== null && atrValue !== undefined && config.stopLossAtr > 0) {
            riskPerShare = config.stopLossAtr * atrValue;
        }

        const partialTargetPrice = (riskPerShare > 0 && config.partialTakeProfitAtR > 0)
            ? entryFillPrice + directionFactor * riskPerShare * config.partialTakeProfitAtR
            : null;

        let finalStopLossPrice = stopLossPrice;
        let finalTakeProfitPrice = takeProfitPrice;

        if (config.riskMode === 'percentage') {
            if (config.stopLossEnabled && config.stopLossPercent > 0) {
                finalStopLossPrice = entryFillPrice * (1 - directionFactor * (config.stopLossPercent / 100));
            }
            if (config.takeProfitEnabled && config.takeProfitPercent > 0) {
                finalTakeProfitPrice = entryFillPrice * (1 + directionFactor * (config.takeProfitPercent / 100));
            }
        }

        return {
            nextPosition: {
                direction,
                entryTime: signal.time,
                entryPrice: entryFillPrice,
                size: shares,
                entryCommissionPerShare: shares > 0 ? entryCommission / shares : 0,
                stopLossPrice: finalStopLossPrice,
                takeProfitPrice: finalTakeProfitPrice,
                riskPerShare,
                barsInTrade: 0,
                extremePrice: entryFillPrice,
                partialTargetPrice,
                partialTaken: false,
                breakEvenApplied: false
            },
            entryCommission
        };
    };

    for (let i = 0; i < data.length; i++) {
        const candle = data[i];

        if (position) {
            position.barsInTrade += 1;
            const positionDirection = position.direction;
            const directionFactor = directionFactorFor(positionDirection);
            const isShortPosition = positionDirection === 'short';
            const exitSide = exitSideForDirection(positionDirection);

            // Check stop loss
            const stopLoss = position.stopLossPrice;
            if (stopLoss !== null) {
                const stopHit = isShortPosition ? candle.high >= stopLoss : candle.low <= stopLoss;
                if (stopHit) {
                    const exitPrice = applySlippage(stopLoss, exitSide, slippageRate);
                    // Standard stop loss execution
                    exitPosition(exitPrice, position.size);
                }
            }

            // Check take profit (independent of stop loss)
            if (position && position.takeProfitPrice !== null) {
                const takeHit = isShortPosition ? candle.low <= position.takeProfitPrice : candle.high >= position.takeProfitPrice;
                if (takeHit) {
                    const exitPrice = applySlippage(position.takeProfitPrice, exitSide, slippageRate);
                    exitPosition(exitPrice, position.size);
                }
            }

            // Check partial take profit
            if (position && !position.partialTaken && position.partialTargetPrice !== null) {
                const partialHit = isShortPosition ? candle.low <= position.partialTargetPrice : candle.high >= position.partialTargetPrice;
                if (partialHit) {
                    const partialSize = position.size * (config.partialTakeProfitPercent / 100);
                    if (partialSize > 0) {
                        const exitPrice = applySlippage(position.partialTargetPrice, exitSide, slippageRate);
                        exitPosition(exitPrice, partialSize);
                        if (position) {
                            position.partialTaken = true;
                        }
                    }
                }
            }

            if (position && config.timeStopBars > 0 && position.barsInTrade >= config.timeStopBars) {
                const isLosing = isShortPosition ? candle.close >= position.entryPrice : candle.close <= position.entryPrice;
                if (!position.partialTaken && isLosing) {
                    const exitPrice = applySlippage(candle.close, exitSide, slippageRate);
                    exitPosition(exitPrice, position.size);
                }
            }

            if (position) {
                const atrValue = atr[i];
                if (atrValue !== null && atrValue !== undefined) {
                    if (config.breakEvenAtR > 0 && position.riskPerShare > 0 && !position.breakEvenApplied) {
                        const breakEvenTarget = position.entryPrice + directionFactor * position.riskPerShare * config.breakEvenAtR;
                        const breakEvenHit = isShortPosition ? candle.low <= breakEvenTarget : candle.high >= breakEvenTarget;
                        if (breakEvenHit) {
                            // Move stop to entry
                            position.stopLossPrice = position.stopLossPrice === null
                                ? position.entryPrice
                                : isShortPosition
                                    ? Math.min(position.stopLossPrice, position.entryPrice)
                                    : Math.max(position.stopLossPrice, position.entryPrice);
                            position.breakEvenApplied = true;
                        }
                    }

                    if (config.trailingAtr > 0) {
                        const trailStop = position.extremePrice - directionFactor * atrValue * config.trailingAtr;
                        const shouldUpdateStop = position.stopLossPrice === null
                            || (isShortPosition ? trailStop < position.stopLossPrice : trailStop > position.stopLossPrice);
                        if (shouldUpdateStop) {
                            position.stopLossPrice = trailStop;
                        }
                    }
                }

                position.extremePrice = isShortPosition
                    ? Math.min(position.extremePrice, candle.low)
                    : Math.max(position.extremePrice, candle.high);
            }
        }

        while (signalIdx < preparedSignals.length && compareTime(preparedSignals[signalIdx].time, candle.time) <= 0) {
            const signal = preparedSignals[signalIdx];

            if (compareTime(signal.time, candle.time) === 0) {
                if (!position) {
                    const opened = buildPositionFromSignal(signal, i);
                    if (opened) {
                        position = opened.nextPosition;
                        capital -= opened.entryCommission;
                    }
                } else {
                    const oppositeSignalType = directionToSignalType(position.direction === 'long' ? 'short' : 'long');
                    if (signal.type === oppositeSignalType) {
                        const blockedSameBarExit = !config.allowSameBarExit && compareTime(signal.time, position.entryTime) === 0;
                        if (!blockedSameBarExit) {
                            const exitPrice = applySlippage(signal.price, exitSideForDirection(position.direction), slippageRate);
                            exitPosition(exitPrice, position.size);
                            if (tradeDirection === 'both') {
                                const opened = buildPositionFromSignal(signal, i);
                                if (opened) {
                                    position = opened.nextPosition;
                                    capital -= opened.entryCommission;
                                }
                            }
                        }
                    }
                }
            }
            signalIdx++;
        }

        let currentEquity = capital;
        if (position) {
            const directionFactor = directionFactorFor(position.direction);
            const unrealizedPnL = (candle.close - position.entryPrice) * position.size * directionFactor;
            currentEquity += unrealizedPnL;
        }
        updateDrawdown(currentEquity);
    }

    if (position && data.length > 0) {
        const lastCandle = data[data.length - 1];
        const exitPrice = applySlippage(lastCandle.close, exitSideForDirection(position.direction), slippageRate);
        exitPosition(exitPrice, position.size);
        updateDrawdown(capital);
    }

    const netProfit = capital - initialCapital;
    const netProfitPercent = initialCapital > 0 ? (netProfit / initialCapital) * 100 : 0;
    const winRate = totalTrades > 0 ? (winningTrades / totalTrades) : 0;
    const lossRate = totalTrades > 0 ? (losingTrades / totalTrades) : 0;
    const avgWin = winningTrades > 0 ? totalProfit / winningTrades : 0;
    const avgLoss = losingTrades > 0 ? totalLoss / losingTrades : 0;
    const expectancy = (winRate * avgWin) - (lossRate * avgLoss);
    const avgTrade = totalTrades > 0 ? netProfit / totalTrades : 0;
    const profitFactor = totalLoss > 0 ? totalProfit / totalLoss : totalProfit > 0 ? Infinity : 0;
    const stdReturn = totalTrades > 1 ? Math.sqrt(returnM2 / (totalTrades - 1)) : 0;
    const sharpeRatio = calculateSharpeRatioFromMoments(avgReturn, stdReturn, totalTrades);

    return {
        trades: [],
        netProfit,
        netProfitPercent,
        winRate: winRate * 100,
        expectancy,
        avgTrade,
        profitFactor,
        maxDrawdown,
        maxDrawdownPercent,
        totalTrades,
        winningTrades,
        losingTrades,
        avgWin,
        avgLoss,
        sharpeRatio,
        equityCurve: []
    };
}

export function runBacktest(
    data: OHLCVData[],
    signals: Signal[],
    initialCapital: number,
    positionSizePercent: number,
    commissionPercent: number,
    settings: BacktestSettings = {},
    sizing?: Partial<TradeSizingConfig>,
    precomputed?: PrecomputedIndicators
): BacktestResult {
    // fast-fail for no signals
    if (signals.length === 0) {
        return {
            trades: [],
            netProfit: 0,
            netProfitPercent: 0,
            winRate: 0,
            expectancy: 0,
            avgTrade: 0,
            profitFactor: 0,
            maxDrawdown: 0,
            maxDrawdownPercent: 0,
            totalTrades: 0,
            winningTrades: 0,
            losingTrades: 0,
            avgWin: 0,
            avgLoss: 0,
            sharpeRatio: 0,
            equityCurve: []
        };
    }

    // Clean input data to handle potential undefined/null elements
    data = ensureCleanData(data);

    const trades: Trade[] = [];
    const equityCurve: { time: Time; value: number }[] = [];
    const config = normalizeBacktestSettings(settings);
    const tradeDirection = normalizeTradeDirection(settings);
    const sizingMode = sizing?.mode ?? 'percent';
    const fixedTradeAmount = Math.max(0, sizing?.fixedTradeAmount ?? 0);

    const highs = getHighs(data);
    const lows = getLows(data);
    const closes = getCloses(data);
    const volumes = getVolumes(data);
    const dataLen = data.length;

    const needsAtr =
        config.stopLossAtr > 0 ||
        config.takeProfitAtr > 0 ||
        config.trailingAtr > 0 ||
        config.atrPercentMin > 0 ||
        config.atrPercentMax > 0 ||
        config.partialTakeProfitAtR > 0 ||
        config.breakEvenAtR > 0;

    const atr = (precomputed?.atr?.length === dataLen)
        ? precomputed.atr
        : (needsAtr ? calculateATR(highs, lows, closes, config.atrPeriod) : []);

    const trendPeriod = resolveTrendPeriod(config);
    const emaTrend = (precomputed?.emaTrend?.length === dataLen && trendPeriod > 0)
        ? precomputed.emaTrend
        : (trendPeriod > 0 ? calculateEMA(closes, trendPeriod) : []);

    const useAdx = config.tradeFilterMode === 'adx' || config.adxMin > 0 || config.adxMax > 0;
    const adxPeriod = useAdx ? Math.max(1, config.adxPeriod) : 0;
    const adx = (precomputed?.adx?.length === dataLen && useAdx)
        ? precomputed.adx
        : (useAdx ? calculateADX(highs, lows, closes, adxPeriod) : []);

    const volumeSma = (precomputed?.volumeSma?.length === dataLen && config.tradeFilterMode === 'volume')
        ? precomputed.volumeSma
        : (config.tradeFilterMode === 'volume'
            ? calculateSMA(volumes, config.volumeSmaPeriod)
            : []);

    const rsi = (precomputed?.rsi?.length === dataLen && config.tradeFilterMode === 'rsi')
        ? precomputed.rsi
        : (config.tradeFilterMode === 'rsi'
            ? calculateRSI(closes, config.rsiPeriod)
            : []);

    const indicatorSeries: IndicatorSeries = {
        atr,
        emaTrend,
        adx,
        volumeSma,
        rsi
    };

    const preparedSignals = prepareSignals(data, signals, config, indicatorSeries, tradeDirection);

    let capital = initialCapital;
    let position: PositionState | null = null;
    let tradeId = 0;

    const commissionRate = commissionPercent / 100;
    const slippageRate = config.slippageBps / 10000;
    let signalIdx = 0;

    const exitPosition = (exitPrice: number, exitTime: Time, exitSize: number, exitReason: Trade['exitReason'] = 'signal') => {
        if (!position || exitSize <= 0) return;

        const positionDirection = position.direction;
        const directionFactor = directionFactorFor(positionDirection);
        const size = Math.min(exitSize, position.size);
        const exitValue = size * exitPrice;
        const entryValue = size * position.entryPrice;
        const commission = exitValue * commissionRate;
        const entryCommission = position.entryCommissionPerShare * size;

        const rawPnl = (exitValue - entryValue) * directionFactor;
        const totalPnl = rawPnl - entryCommission - commission;
        const pnlPercent = entryValue > 0 ? (rawPnl / entryValue) * 100 : 0;

        capital += rawPnl - commission;

        trades.push({
            id: ++tradeId,
            type: positionDirection,
            entryTime: position.entryTime,
            entryPrice: position.entryPrice,
            exitTime,
            exitPrice,
            pnl: totalPnl,
            pnlPercent,
            size,
            fees: entryCommission + commission,
            exitReason
        });

        position.size -= size;
        if (position.size <= 0) {
            position = null;
        }
    };

    const buildPositionFromSignal = (signal: Signal, barIndex: number): { nextPosition: PositionState; entryCommission: number } | null => {
        if (!allowsSignalAsEntry(signal.type, tradeDirection)) return null;

        const atrValue = needsAtr ? atr[barIndex] : null;
        const requiresAtrForEntry =
            config.stopLossAtr > 0 ||
            config.takeProfitAtr > 0 ||
            config.trailingAtr > 0 ||
            config.partialTakeProfitAtR > 0 ||
            config.breakEvenAtR > 0;

        if (requiresAtrForEntry && (atrValue === null || atrValue === undefined)) return null;

        const allocatedCapital = (sizingMode === 'fixed' && fixedTradeAmount > 0)
            ? fixedTradeAmount
            : capital * (positionSizePercent / 100);
        if (!Number.isFinite(allocatedCapital) || allocatedCapital <= 0) return null;

        const tradeValue = allocatedCapital / (1 + commissionRate);
        const entryCommission = tradeValue * commissionRate;
        const direction = signalToPositionDirection(signal.type);
        const directionFactor = directionFactorFor(direction);
        const entrySide = entrySideForDirection(direction);
        const entryFillPrice = applySlippage(signal.price, entrySide, slippageRate);
        if (!Number.isFinite(entryFillPrice) || entryFillPrice <= 0 || !Number.isFinite(tradeValue) || tradeValue <= 0) return null;

        const shares = tradeValue / entryFillPrice;
        if (!Number.isFinite(shares) || shares <= 0) return null;

        const stopLossPrice = (atrValue !== null && atrValue !== undefined)
            ? (config.stopLossAtr > 0
                ? entryFillPrice - directionFactor * config.stopLossAtr * atrValue
                : config.trailingAtr > 0
                    ? entryFillPrice - directionFactor * config.trailingAtr * atrValue
                    : null)
            : null;

        const takeProfitPrice = (atrValue !== null && atrValue !== undefined && config.takeProfitAtr > 0)
            ? entryFillPrice + directionFactor * config.takeProfitAtr * atrValue
            : null;

        let riskPerShare = 0;
        if (config.riskMode === 'percentage') {
            if (config.stopLossEnabled && config.stopLossPercent > 0) {
                riskPerShare = entryFillPrice * (config.stopLossPercent / 100);
            }
        } else if (atrValue !== null && atrValue !== undefined && config.stopLossAtr > 0) {
            riskPerShare = config.stopLossAtr * atrValue;
        }

        const partialTargetPrice = (riskPerShare > 0 && config.partialTakeProfitAtR > 0)
            ? entryFillPrice + directionFactor * riskPerShare * config.partialTakeProfitAtR
            : null;

        let finalStopLossPrice = stopLossPrice;
        let finalTakeProfitPrice = takeProfitPrice;

        if (config.riskMode === 'percentage') {
            if (config.stopLossEnabled && config.stopLossPercent > 0) {
                finalStopLossPrice = entryFillPrice * (1 - directionFactor * (config.stopLossPercent / 100));
            }
            if (config.takeProfitEnabled && config.takeProfitPercent > 0) {
                finalTakeProfitPrice = entryFillPrice * (1 + directionFactor * (config.takeProfitPercent / 100));
            }
        }

        return {
            nextPosition: {
                direction,
                entryTime: signal.time,
                entryPrice: entryFillPrice,
                size: shares,
                entryCommissionPerShare: shares > 0 ? entryCommission / shares : 0,
                stopLossPrice: finalStopLossPrice,
                takeProfitPrice: finalTakeProfitPrice,
                riskPerShare,
                barsInTrade: 0,
                extremePrice: entryFillPrice,
                partialTargetPrice,
                partialTaken: false,
                breakEvenApplied: false
            },
            entryCommission
        };
    };

    for (let i = 0; i < data.length; i++) {
        const candle = data[i];

        if (position) {
            position.barsInTrade += 1;
            const positionDirection = position.direction;
            const directionFactor = directionFactorFor(positionDirection);
            const isShortPosition = positionDirection === 'short';
            const exitSide = exitSideForDirection(positionDirection);

            // Check stop loss
            const stopLoss = position.stopLossPrice;
            if (stopLoss !== null) {
                const stopHit = isShortPosition ? candle.high >= stopLoss : candle.low <= stopLoss;
                if (stopHit) {
                    const exitPrice = applySlippage(stopLoss, exitSide, slippageRate);
                    exitPosition(exitPrice, candle.time, position.size, 'stop_loss');
                }
            }

            // Check take profit (independent of stop loss)
            if (position && position.takeProfitPrice !== null) {
                const takeHit = isShortPosition ? candle.low <= position.takeProfitPrice : candle.high >= position.takeProfitPrice;
                if (takeHit) {
                    const exitPrice = applySlippage(position.takeProfitPrice, exitSide, slippageRate);
                    exitPosition(exitPrice, candle.time, position.size, 'take_profit');
                }
            }

            // Check partial take profit
            if (position && !position.partialTaken && position.partialTargetPrice !== null) {
                const partialHit = isShortPosition ? candle.low <= position.partialTargetPrice : candle.high >= position.partialTargetPrice;
                if (partialHit) {
                    const partialSize = position.size * (config.partialTakeProfitPercent / 100);
                    if (partialSize > 0) {
                        const exitPrice = applySlippage(position.partialTargetPrice, exitSide, slippageRate);
                        exitPosition(exitPrice, candle.time, partialSize, 'partial');
                        if (position) {
                            position.partialTaken = true;
                        }
                    }
                }
            }

            if (position && config.timeStopBars > 0 && position.barsInTrade >= config.timeStopBars) {
                const isLosing = isShortPosition ? candle.close >= position.entryPrice : candle.close <= position.entryPrice;
                if (!position.partialTaken && isLosing) {
                    const exitPrice = applySlippage(candle.close, exitSide, slippageRate);
                    exitPosition(exitPrice, candle.time, position.size, 'time_stop');
                }
            }

            if (position) {
                const atrValue = atr[i];
                if (atrValue !== null && atrValue !== undefined) {
                    if (config.breakEvenAtR > 0 && position.riskPerShare > 0 && !position.breakEvenApplied) {
                        const breakEvenTarget = position.entryPrice + directionFactor * position.riskPerShare * config.breakEvenAtR;
                        const breakEvenHit = isShortPosition ? candle.low <= breakEvenTarget : candle.high >= breakEvenTarget;
                        if (breakEvenHit) {
                            position.stopLossPrice = position.stopLossPrice === null
                                ? position.entryPrice
                                : isShortPosition
                                    ? Math.min(position.stopLossPrice, position.entryPrice)
                                    : Math.max(position.stopLossPrice, position.entryPrice);
                            position.breakEvenApplied = true;
                        }
                    }

                    if (config.trailingAtr > 0) {
                        const trailStop = position.extremePrice - directionFactor * atrValue * config.trailingAtr;
                        const shouldUpdateStop = position.stopLossPrice === null
                            || (isShortPosition ? trailStop < position.stopLossPrice : trailStop > position.stopLossPrice);
                        if (shouldUpdateStop) {
                            position.stopLossPrice = trailStop;
                        }
                    }
                }

                position.extremePrice = isShortPosition
                    ? Math.min(position.extremePrice, candle.low)
                    : Math.max(position.extremePrice, candle.high);
            }
        }

        while (signalIdx < preparedSignals.length && compareTime(preparedSignals[signalIdx].time, candle.time) <= 0) {
            const signal = preparedSignals[signalIdx];

            if (compareTime(signal.time, candle.time) === 0) {
                if (!position) {
                    const opened = buildPositionFromSignal(signal, i);
                    if (opened) {
                        position = opened.nextPosition;
                        capital -= opened.entryCommission;
                    }
                } else {
                    const oppositeSignalType = directionToSignalType(position.direction === 'long' ? 'short' : 'long');
                    if (signal.type === oppositeSignalType) {
                        const blockedSameBarExit = !config.allowSameBarExit && compareTime(signal.time, position.entryTime) === 0;
                        if (!blockedSameBarExit) {
                            const exitPrice = applySlippage(signal.price, exitSideForDirection(position.direction), slippageRate);
                            exitPosition(exitPrice, signal.time, position.size, 'signal');
                            if (tradeDirection === 'both') {
                                const opened = buildPositionFromSignal(signal, i);
                                if (opened) {
                                    position = opened.nextPosition;
                                    capital -= opened.entryCommission;
                                }
                            }
                        }
                    }
                }
            }
            signalIdx++;
        }

        let currentEquity = capital;
        if (position) {
            const directionFactor = directionFactorFor(position.direction);
            const unrealizedPnL = (candle.close - position.entryPrice) * position.size * directionFactor;
            currentEquity += unrealizedPnL;
        }
        equityCurve.push({ time: candle.time, value: currentEquity });
    }

    if (position && data.length > 0) {
        const lastCandle = data[data.length - 1];
        const exitPrice = applySlippage(lastCandle.close, exitSideForDirection(position.direction), slippageRate);
        exitPosition(exitPrice, lastCandle.time, position.size, 'end_of_data');

        if (equityCurve.length > 0) {
            equityCurve[equityCurve.length - 1].value = capital;
        }
    }

    const { maxDrawdown, maxDrawdownPercent } = calculateMaxDrawdown(equityCurve, initialCapital);

    return calculateBacktestStats(trades, equityCurve, initialCapital, capital, maxDrawdown, maxDrawdownPercent);
}

export function calculateMaxDrawdown(equityCurve: { time: Time; value: number }[], initialCapital: number) {
    let peak = initialCapital;
    let maxDrawdown = 0;
    let maxDrawdownPercent = 0;

    for (const point of equityCurve) {
        if (point.value > peak) peak = point.value;
        const drawdown = peak - point.value;
        if (drawdown > maxDrawdown) {
            maxDrawdown = drawdown;
            maxDrawdownPercent = peak > 0 ? (drawdown / peak) * 100 : 0;
        }
    }

    return { maxDrawdown, maxDrawdownPercent };
}

export function calculateBacktestStats(
    trades: Trade[],
    equityCurve: { time: Time; value: number }[],
    initialCapital: number,
    finalCapital: number,
    maxDrawdown: number,
    maxDrawdownPercent: number
): BacktestResult {
    const winningTrades = trades.filter(t => t.pnl > 0);
    const losingTrades = trades.filter(t => t.pnl <= 0);

    const totalProfit = winningTrades.reduce((sum, t) => sum + t.pnl, 0);
    const totalLoss = Math.abs(losingTrades.reduce((sum, t) => sum + t.pnl, 0));

    const avgWin = winningTrades.length > 0 ? totalProfit / winningTrades.length : 0;
    const avgLoss = losingTrades.length > 0 ? totalLoss / losingTrades.length : 0;

    const netProfit = finalCapital - initialCapital;
    const netProfitPercent = initialCapital > 0 ? (netProfit / initialCapital) * 100 : 0;
    const winRate = trades.length > 0 ? (winningTrades.length / trades.length) : 0;
    const lossRate = trades.length > 0 ? (losingTrades.length / trades.length) : 0;
    const expectancy = (winRate * avgWin) - (lossRate * avgLoss);
    const avgTrade = trades.length > 0 ? netProfit / trades.length : 0;
    const profitFactor = totalLoss > 0 ? totalProfit / totalLoss : totalProfit > 0 ? Infinity : 0;

    const returns = trades.map(t => t.pnlPercent);
    const sharpeRatio = calculateSharpeRatioFromReturns(returns);

    return {
        trades,
        netProfit,
        netProfitPercent,
        winRate: winRate * 100,
        expectancy,
        avgTrade,
        profitFactor,
        maxDrawdown,
        maxDrawdownPercent,
        totalTrades: trades.length,
        winningTrades: winningTrades.length,
        losingTrades: losingTrades.length,
        avgWin,
        avgLoss,
        sharpeRatio,
        equityCurve
    };
}
