
import { BacktestSettings, OHLCVData, Signal, Time, TradeDirection } from '../../types/index';
import { NormalizedSettings } from '../../types/backtest';
import { toTimeKey } from '../../time-key';
import { parseTimeToUnixSeconds } from '../../time-normalization';
import { ADAPTIVE_TAKE_PROFIT_DEFAULTS, resolveTakeProfitMode } from '../../take-profit-settings';

export function toNumberOr(value: number | undefined, fallback: number): number {
    return Number.isFinite(value) ? value! : fallback;
}

export function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function hasActiveChartTakeProfitOrStopLoss(config: Pick<NormalizedSettings,
    'riskMode'
    | 'stopLossAtr'
    | 'takeProfitAtr'
    | 'stopLossEnabled'
    | 'stopLossPercent'
    | 'takeProfitEnabled'
    | 'takeProfitPercent'
    | 'historicalLevelTakeProfitEnabled'
    | 'historicalLevelStopLossEnabled'
    | 'historicalLevelLookbackBars'
>): boolean {
    if (
        (config.historicalLevelTakeProfitEnabled || config.historicalLevelStopLossEnabled)
        && config.historicalLevelLookbackBars > 0
    ) {
        return true;
    }
    if (config.riskMode === 'percentage') {
        return (config.stopLossEnabled && config.stopLossPercent > 0)
            || (config.takeProfitEnabled && config.takeProfitPercent > 0);
    }
    return config.stopLossAtr > 0 || config.takeProfitAtr > 0;
}

export function normalizeBacktestSettings(settings?: BacktestSettings): NormalizedSettings {
    const rawExecutionModel = settings?.executionModel;
    const executionModel = rawExecutionModel === 'next_open' || rawExecutionModel === 'next_close' || rawExecutionModel === 'signal_close'
        ? rawExecutionModel
        : 'signal_close';
    const riskMode = settings?.riskMode === 'percentage' ? 'percentage' : 'simple';

    const config: NormalizedSettings = {
        atrPeriod: Math.max(1, toNumberOr(settings?.atrPeriod, 14)),
        stopLossAtr: Math.max(0, toNumberOr(settings?.stopLossAtr, 0)),
        takeProfitAtr: Math.max(0, toNumberOr(settings?.takeProfitAtr, 0)),
        trailingAtr: Math.max(0, toNumberOr(settings?.trailingAtr, 0)),
        partialTakeProfitAtR: 0,
        partialTakeProfitPercent: 0,
        breakEvenAtR: 0,
        breakEvenPercent: 0,
        timeStopBars: 0,

        riskMode,
        stopLossPercent: Math.max(0, toNumberOr(settings?.stopLossPercent, 0)),
        takeProfitPercent: Math.max(0, toNumberOr(settings?.takeProfitPercent, 0)),
        takeProfitMode: resolveTakeProfitMode(settings?.takeProfitMode),
        takeProfitMfeBootstrapPercentile: clamp(toNumberOr(settings?.takeProfitMfeBootstrapPercentile, 60), 1, 99),
        takeProfitAdaptiveLookbackTrades: Math.max(5, Math.round(toNumberOr(settings?.takeProfitAdaptiveLookbackTrades, ADAPTIVE_TAKE_PROFIT_DEFAULTS.takeProfitAdaptiveLookbackTrades))),
        takeProfitAdaptiveRecentWindow: Math.max(3, Math.round(toNumberOr(settings?.takeProfitAdaptiveRecentWindow, ADAPTIVE_TAKE_PROFIT_DEFAULTS.takeProfitAdaptiveRecentWindow))),
        takeProfitAdaptiveMinMultiplier: Math.max(0.1, toNumberOr(settings?.takeProfitAdaptiveMinMultiplier, ADAPTIVE_TAKE_PROFIT_DEFAULTS.takeProfitAdaptiveMinMultiplier)),
        takeProfitAdaptiveMaxMultiplier: Math.max(0.2, toNumberOr(settings?.takeProfitAdaptiveMaxMultiplier, ADAPTIVE_TAKE_PROFIT_DEFAULTS.takeProfitAdaptiveMaxMultiplier)),
        takeProfitAdaptiveGridSteps: Math.max(3, Math.round(toNumberOr(settings?.takeProfitAdaptiveGridSteps, ADAPTIVE_TAKE_PROFIT_DEFAULTS.takeProfitAdaptiveGridSteps))),
        takeProfitAdaptiveRegimeBlend: clamp(toNumberOr(settings?.takeProfitAdaptiveRegimeBlend, ADAPTIVE_TAKE_PROFIT_DEFAULTS.takeProfitAdaptiveRegimeBlend), 0, 1),
        takeProfitAdaptiveIcScale: clamp(toNumberOr(settings?.takeProfitAdaptiveIcScale, ADAPTIVE_TAKE_PROFIT_DEFAULTS.takeProfitAdaptiveIcScale), 0, 2),
        stopLossEnabled: settings?.stopLossEnabled ?? false,
        takeProfitEnabled: settings?.takeProfitEnabled ?? false,
        historicalLevelTakeProfitEnabled: settings?.historicalLevelTakeProfitEnabled ?? false,
        historicalLevelStopLossEnabled: settings?.historicalLevelStopLossEnabled ?? false,
        historicalLevelLookbackBars: Math.max(0, Math.round(toNumberOr(settings?.historicalLevelLookbackBars, 0))),
        riskMinHoldBars: Math.max(0, Math.round(toNumberOr(settings?.riskMinHoldBars, 0))),
        riskMinHoldEnabled: settings?.riskMinHoldEnabled ?? false,
        riskMaxHoldBars: Math.max(0, toNumberOr(settings?.riskMaxHoldBars, 0)),
        riskMaxHoldEnabled: settings?.riskMaxHoldEnabled ?? false,
        riskWinStreakStopLossEnabled: false,
        riskWinStreakStopLossAfterWins: 3,
        riskWinStreakStopLossPercent: 0,
        disableSignalExits: false,
        flipAfterConsecutiveLosses: Math.max(1, Math.round(toNumberOr(settings?.flipAfterConsecutiveLosses, 2))),
        flipCooldownTrades: Math.max(0, Math.round(toNumberOr(settings?.flipCooldownTrades, 0))),
        minTradesBeforeFirstFlip: Math.max(0, Math.round(toNumberOr(settings?.minTradesBeforeFirstFlip, 0))),

        trendEmaPeriod: Math.max(0, toNumberOr(settings?.trendEmaPeriod, 0)),
        trendEmaSlopeBars: Math.max(0, toNumberOr(settings?.trendEmaSlopeBars, 0)),
        atrPercentMin: Math.max(0, toNumberOr(settings?.atrPercentMin, 0)),
        atrPercentMax: Math.max(0, toNumberOr(settings?.atrPercentMax, 0)),
        adxPeriod: Math.max(0, toNumberOr(settings?.adxPeriod, 14)),
        adxMin: Math.max(0, toNumberOr(settings?.adxMin, 0)),
        adxMax: Math.max(0, toNumberOr(settings?.adxMax, 0)),

        marketMode: 'all',
        executionModel,
        allowSameBarExit: false,
        slippageBps: Math.max(0, toNumberOr(settings?.slippageBps, 0)),
        maxOpenTrades: clamp(Math.round(toNumberOr(settings?.maxOpenTrades, 1)), 1, 2),
    };
    config.disableSignalExits = settings?.disableSignalExits === true && hasActiveChartTakeProfitOrStopLoss(config);
    return config;
}

export function timeKey(time: Time): string {
    return toTimeKey(time);
}

export function canonicalTimeKey(time: Time): string {
    const unixSeconds = parseTimeToUnixSeconds(time);
    return unixSeconds !== null ? String(unixSeconds) : timeKey(time);
}

export function timeToNumber(time: Time): number | null {
    return parseTimeToUnixSeconds(time);
}

export function getTimeIndexValue(index: Map<string, number>, time: Time): number | undefined {
    return index.get(timeKey(time)) ?? index.get(canonicalTimeKey(time));
}

export function compareTime(a: Time, b: Time): number {
    const aNum = timeToNumber(a);
    const bNum = timeToNumber(b);
    if (aNum !== null && bNum !== null) return aNum - bNum;

    const aKey = timeKey(a);
    const bKey = timeKey(b);
    if (aKey === bKey) return 0;
    return aKey < bKey ? -1 : 1;
}

export function getExecutionShift(config: NormalizedSettings): number {
    return config.executionModel === 'signal_close' ? 0 : 1;
}

export function resolveExecutionPrice(
    data: OHLCVData[],
    signal: Signal,
    signalIndex: number,
    executionIndex: number,
    config: NormalizedSettings
): number {
    if (config.executionModel === 'signal_close' && executionIndex === signalIndex) {
        return signal.price;
    }
    const candle = data[executionIndex];
    return config.executionModel === 'next_open' ? candle.open : candle.close;
}

export function applySlippage(price: number, side: 'buy' | 'sell', slippageRate: number): number {
    if (!Number.isFinite(slippageRate) || slippageRate <= 0) return price;
    return side === 'buy' ? price * (1 + slippageRate) : price * (1 - slippageRate);
}

export function normalizeTradeDirection(settings?: BacktestSettings): TradeDirection {
    return settings?.tradeDirection === 'short'
        || settings?.tradeDirection === 'both'
        || settings?.tradeDirection === 'both_flip_loss_2'
        || settings?.tradeDirection === 'combined'
        ? settings.tradeDirection
        : 'long';
}

export function shouldInvertSignals(settings?: BacktestSettings): boolean {
    return settings?.invertSignals === true;
}

export function applySignalPolarity(signals: Signal[], settings?: BacktestSettings): Signal[] {
    if (!shouldInvertSignals(settings) || signals.length === 0) {
        return signals;
    }

    return signals.map((signal) => {
        if (signal.type === 'buy') {
            return { ...signal, type: 'sell' };
        }
        if (signal.type === 'sell') {
            return { ...signal, type: 'buy' };
        }
        return signal;
    });
}

export function isBothLikeTradeDirection(
    tradeDirection: TradeDirection
): tradeDirection is 'both' | 'both_flip_loss_2' | 'combined' {
    return tradeDirection === 'both'
        || tradeDirection === 'both_flip_loss_2'
        || tradeDirection === 'combined';
}

export function isLossStreakFlipTradeDirection(tradeDirection: TradeDirection): boolean {
    return tradeDirection === 'both_flip_loss_2';
}

export function signalToPositionDirection(type: Signal['type']): 'long' | 'short' {
    return type === 'buy' ? 'long' : 'short';
}

export function directionToSignalType(direction: 'long' | 'short'): Signal['type'] {
    return direction === 'short' ? 'sell' : 'buy';
}

export function entrySideForDirection(direction: 'long' | 'short'): 'buy' | 'sell' {
    return direction === 'short' ? 'sell' : 'buy';
}

export function exitSideForDirection(direction: 'long' | 'short'): 'buy' | 'sell' {
    return direction === 'short' ? 'buy' : 'sell';
}

export function directionFactorFor(direction: 'long' | 'short'): number {
    return direction === 'short' ? -1 : 1;
}

export function allowsSignalAsEntry(signalType: Signal['type'], tradeDirection: TradeDirection): boolean {
    if (isBothLikeTradeDirection(tradeDirection)) return true;
    if (tradeDirection === 'short') return signalType === 'sell';
    return signalType === 'buy';
}

export const timeIndexCache = new WeakMap<OHLCVData[], Map<string, number>>();

export function getTimeIndex(data: OHLCVData[]): Map<string, number> {
    let cached = timeIndexCache.get(data);
    if (!cached) {
        cached = new Map<string, number>();
        data.forEach((candle, index) => {
            cached!.set(timeKey(candle.time), index);
            cached!.set(canonicalTimeKey(candle.time), index);
        });
        timeIndexCache.set(data, cached);
    }
    return cached;
}




