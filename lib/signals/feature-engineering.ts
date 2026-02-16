import type { OHLCVData } from "../types/strategies";
import { calculateATR } from "../strategies/indicators";

export interface AdvancedFeatureConfig {
    atrPeriod?: number;
    volatilitySmaPeriod?: number;
    volumeSmaPeriod?: number;
    trendEfficiencyLookback?: number;
}

export interface AdvancedFeatureSet {
    atr: Array<number | null>;
    volatilityRatio: Array<number | null>;
    relativeVolume: Array<number | null>;
    trendEfficiency: Array<number | null>;
}

function rollingSma(values: number[], period: number): Array<number | null> {
    const output: Array<number | null> = new Array(values.length).fill(null);
    if (period <= 0 || values.length === 0) return output;

    let sum = 0;
    for (let i = 0; i < values.length; i++) {
        sum += values[i];
        if (i >= period) {
            sum -= values[i - period];
        }
        if (i >= period - 1) {
            output[i] = sum / period;
        }
    }
    return output;
}

function rollingSmaNullable(values: Array<number | null>, period: number): Array<number | null> {
    const output: Array<number | null> = new Array(values.length).fill(null);
    if (period <= 0 || values.length === 0) return output;

    let sum = 0;
    let valid = 0;

    for (let i = 0; i < values.length; i++) {
        const current = values[i];
        if (current !== null && Number.isFinite(current)) {
            sum += current;
            valid += 1;
        }

        if (i >= period) {
            const leaving = values[i - period];
            if (leaving !== null && Number.isFinite(leaving)) {
                sum -= leaving;
                valid -= 1;
            }
        }

        if (i >= period - 1 && valid === period) {
            output[i] = sum / period;
        }
    }

    return output;
}

export function calculateVolatilityRatio(
    data: OHLCVData[],
    atrPeriod = 14,
    volatilitySmaPeriod = 50
): { atr: Array<number | null>; ratio: Array<number | null> } {
    const highs = data.map((bar) => bar.high);
    const lows = data.map((bar) => bar.low);
    const closes = data.map((bar) => bar.close);

    const atr = calculateATR(highs, lows, closes, Math.max(1, Math.round(atrPeriod)));
    const atrSma = rollingSmaNullable(atr, Math.max(1, Math.round(volatilitySmaPeriod)));

    const ratio: Array<number | null> = new Array(data.length).fill(null);
    for (let i = 0; i < data.length; i++) {
        const atrNow = atr[i];
        const atrAvg = atrSma[i];
        if (atrNow === null || atrAvg === null || atrAvg <= 0) continue;
        ratio[i] = atrNow / atrAvg;
    }

    return { atr, ratio };
}

export function calculateRelativeVolume(data: OHLCVData[], volumeSmaPeriod = 20): Array<number | null> {
    const period = Math.max(1, Math.round(volumeSmaPeriod));
    const volumes = data.map((bar) => Math.max(0, bar.volume));
    const volumeSma = rollingSma(volumes, period);
    const relativeVolume: Array<number | null> = new Array(data.length).fill(null);

    for (let i = 0; i < data.length; i++) {
        const avg = volumeSma[i];
        if (avg === null || avg <= 0) continue;
        relativeVolume[i] = volumes[i] / avg;
    }

    return relativeVolume;
}

export function calculateTrendEfficiency(data: OHLCVData[], lookback = 20): Array<number | null> {
    const period = Math.max(1, Math.round(lookback));
    const closes = data.map((bar) => bar.close);
    const output: Array<number | null> = new Array(data.length).fill(null);
    if (closes.length <= period) return output;

    const absMovePrefix: number[] = new Array(closes.length).fill(0);
    for (let i = 1; i < closes.length; i++) {
        absMovePrefix[i] = absMovePrefix[i - 1] + Math.abs(closes[i] - closes[i - 1]);
    }

    for (let i = period; i < closes.length; i++) {
        const netChange = closes[i] - closes[i - period];
        const totalDistance = absMovePrefix[i] - absMovePrefix[i - period];
        output[i] = totalDistance > 0 ? netChange / totalDistance : 0;
    }

    return output;
}

export function buildAdvancedFeatureSet(
    data: OHLCVData[],
    config: AdvancedFeatureConfig = {}
): AdvancedFeatureSet {
    const atrPeriod = Math.max(1, Math.round(config.atrPeriod ?? 14));
    const volatilitySmaPeriod = Math.max(1, Math.round(config.volatilitySmaPeriod ?? 50));
    const volumeSmaPeriod = Math.max(1, Math.round(config.volumeSmaPeriod ?? 20));
    const trendEfficiencyLookback = Math.max(1, Math.round(config.trendEfficiencyLookback ?? 20));

    const { atr, ratio } = calculateVolatilityRatio(data, atrPeriod, volatilitySmaPeriod);
    const relativeVolume = calculateRelativeVolume(data, volumeSmaPeriod);
    const trendEfficiency = calculateTrendEfficiency(data, trendEfficiencyLookback);

    return {
        atr,
        volatilityRatio: ratio,
        relativeVolume,
        trendEfficiency,
    };
}

