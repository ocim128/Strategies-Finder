import { calculateATR } from "./strategies/indicators";
import { hasUiToggleSettings, resolveBacktestSettingsFromRaw } from "./backtest-settings-resolver";
import {
    directionFactorFor,
    normalizeBacktestSettings,
    timeKey,
} from "./strategies/backtest/backtest-utils";
import { resolveHistoricalLevelTargets } from "./strategies/backtest/historical-levels";
import type { BacktestSettings, OHLCVData, Time } from "./types/strategies";

export interface EntryRiskTargets {
    stopLossPrice: number | null;
    takeProfitPrice: number | null;
    stopLossPercent: number | null;
    takeProfitPercent: number | null;
}

interface ResolveEntryRiskTargetsParams {
    candles: OHLCVData[];
    entryTime: Time;
    entryPrice: number;
    direction: "long" | "short";
    settings: BacktestSettings;
    entryBarIndex?: number | null;
}

function resolveEntryBarIndex(
    candles: OHLCVData[],
    entryTime: Time,
    explicitBarIndex?: number | null
): number | null {
    if (Number.isFinite(explicitBarIndex as number)) {
        const barIndex = Math.trunc(explicitBarIndex as number);
        if (barIndex >= 0 && barIndex < candles.length) {
            return barIndex;
        }
    }

    const entryKey = timeKey(entryTime);
    for (let i = candles.length - 1; i >= 0; i--) {
        if (timeKey(candles[i].time) === entryKey) {
            return i;
        }
    }

    return null;
}

function toTargetPercent(entryPrice: number, targetPrice: number | null): number | null {
    if (
        !Number.isFinite(entryPrice) ||
        entryPrice <= 0 ||
        targetPrice === null ||
        !Number.isFinite(targetPrice)
    ) {
        return null;
    }

    return Math.abs(((targetPrice - entryPrice) / entryPrice) * 100);
}

export function resolveEntryRiskTargets(params: ResolveEntryRiskTargetsParams): EntryRiskTargets {
    const { candles, entryTime, entryPrice, direction, settings, entryBarIndex } = params;
    const normalizedSource = hasUiToggleSettings(settings as Record<string, unknown>)
        ? resolveBacktestSettingsFromRaw(settings)
        : settings;
    const config = normalizeBacktestSettings(normalizedSource);
    const directionFactor = directionFactorFor(direction);

    let stopLossPrice: number | null = null;
    let takeProfitPrice: number | null = null;

    if (config.riskMode === "percentage") {
        if (config.stopLossEnabled && config.stopLossPercent > 0) {
            stopLossPrice = entryPrice * (1 - directionFactor * (config.stopLossPercent / 100));
        }
        if (config.takeProfitEnabled && config.takeProfitPercent > 0) {
            takeProfitPrice = entryPrice * (1 + directionFactor * (config.takeProfitPercent / 100));
        }
    } else {
        const usesAtrTargets =
            config.stopLossAtr > 0 ||
            config.trailingAtr > 0 ||
            config.takeProfitAtr > 0;

        if (usesAtrTargets && candles.length > 0) {
            const resolvedEntryBarIndex = resolveEntryBarIndex(candles, entryTime, entryBarIndex);
            const atrBarIndex = resolvedEntryBarIndex === null
                ? null
                : config.executionModel === "next_open"
                    ? resolvedEntryBarIndex - 1
                    : resolvedEntryBarIndex;

            if (atrBarIndex !== null && atrBarIndex >= 0 && atrBarIndex < candles.length) {
                const highs = candles.map((candle) => candle.high);
                const lows = candles.map((candle) => candle.low);
                const closes = candles.map((candle) => candle.close);
                const atr = calculateATR(highs, lows, closes, config.atrPeriod);
                const atrValue = atr[atrBarIndex];

                if (atrValue !== null && atrValue !== undefined && Number.isFinite(atrValue)) {
                    if (config.stopLossAtr > 0) {
                        stopLossPrice = entryPrice - directionFactor * config.stopLossAtr * atrValue;
                    } else if (config.trailingAtr > 0) {
                        stopLossPrice = entryPrice - directionFactor * config.trailingAtr * atrValue;
                    }

                    if (config.takeProfitAtr > 0) {
                        takeProfitPrice = entryPrice + directionFactor * config.takeProfitAtr * atrValue;
                    }
                }
            }
        }
    }

    if (
        (config.historicalLevelTakeProfitEnabled || config.historicalLevelStopLossEnabled) &&
        config.historicalLevelLookbackBars > 0
    ) {
        const resolvedEntryBarIndex = resolveEntryBarIndex(candles, entryTime, entryBarIndex);
        if (resolvedEntryBarIndex === null) {
            return {
                stopLossPrice,
                takeProfitPrice,
                stopLossPercent: toTargetPercent(entryPrice, stopLossPrice),
                takeProfitPercent: toTargetPercent(entryPrice, takeProfitPrice),
            };
        }
        const highs = candles.map((candle) => candle.high);
        const lows = candles.map((candle) => candle.low);
        const closes = candles.map((candle) => candle.close);
        const atr = calculateATR(highs, lows, closes, config.atrPeriod);
        const historicalTargets = resolveHistoricalLevelTargets({
            data: candles,
            entryBarIndex: resolvedEntryBarIndex,
            entryPrice,
            direction,
            config,
            atrArray: atr,
            baseStopLossPrice: stopLossPrice,
            baseTakeProfitPrice: takeProfitPrice,
        });
        stopLossPrice = historicalTargets.stopLossPrice;
        takeProfitPrice = historicalTargets.takeProfitPrice;
    }

    return {
        stopLossPrice,
        takeProfitPrice,
        stopLossPercent: toTargetPercent(entryPrice, stopLossPrice),
        takeProfitPercent: toTargetPercent(entryPrice, takeProfitPrice),
    };
}
