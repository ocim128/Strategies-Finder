import { Strategy, OHLCVData, Signal, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRateOfChange, buildRollingStdDev } from "./price-action-statistics-core";

function lowerBound(sorted: number[], value: number): number {
    let low = 0;
    let high = sorted.length;
    while (low < high) {
        const mid = (low + high) >> 1;
        if (sorted[mid] < value) low = mid + 1;
        else high = mid;
    }
    return low;
}

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 30))),
        volPercentileMax: Math.max(0.1, Math.min(0.9, Number(params.volPercentileMax ?? 0.30))),
        rangePercentileMin: Math.max(0.5, Math.min(0.99, Number(params.rangePercentileMin ?? 0.75))),
    };
}

export const compression_close_location_expansion: Strategy = {
    name: "Compression Close Location Expansion",
    description: "Follows directional breakouts from compression regimes when range expands with close location acceptance.",
    defaultParams: {
        lookback: 30,
        volPercentileMax: 0.30,
        rangePercentileMin: 0.75,
    },
    paramLabels: {
        lookback: "Lookback",
        volPercentileMax: "Max Vol Percentile",
        rangePercentileMin: "Min Range Percentile",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 2) return [];

        const closes = getCloses(cleanData);

        // Return volatility
        const returns = buildRateOfChange(closes, 1);
        const returnsClean = returns.map(v => v ?? 0);
        const volStdDev = buildRollingStdDev(returnsClean, lookback);
        const volValues = volStdDev.map(v => v ?? 0);
        const ranges = cleanData.map(bar => Math.max(0, bar.high - bar.low));
        const volWindow: number[] = [];
        const rangeWindow: number[] = [];
        const signals: Signal[] = [];
        const volPercentileMax = p.volPercentileMax as number;
        const rangePercentileMin = p.rangePercentileMin as number;

        for (let i = 0; i < cleanData.length; i++) {
            const volatility = volValues[i];
            const range = ranges[i];
            if (Number.isFinite(volatility)) {
                volWindow.splice(lowerBound(volWindow, volatility), 0, volatility);
            }
            if (Number.isFinite(range)) {
                rangeWindow.splice(lowerBound(rangeWindow, range), 0, range);
            }

            if (i >= lookback) {
                const removedVolatility = volValues[i - lookback];
                const removedRange = ranges[i - lookback];
                if (Number.isFinite(removedVolatility)) {
                    volWindow.splice(lowerBound(volWindow, removedVolatility), 1);
                }
                if (Number.isFinite(removedRange)) {
                    rangeWindow.splice(lowerBound(rangeWindow, removedRange), 1);
                }
            }
            if (
                i < lookback - 1
                || !Number.isFinite(volatility)
                || !Number.isFinite(range)
                || volWindow.length < 2
                || rangeWindow.length < 2
            ) continue;

            const vp = lowerBound(volWindow, volatility) / (volWindow.length - 1);
            const rp = lowerBound(rangeWindow, range) / (rangeWindow.length - 1);
            if (vp >= volPercentileMax || rp < rangePercentileMin) continue;

            const bar = cleanData[i];
            const cl = range <= 0
                ? 0.5
                : Math.max(0, Math.min(1, (bar.close - bar.low) / range));
            // Buy: compression + range expansion + bullish close location
            if (cl > 0.60) {
                signals.push(createBuySignal(cleanData, i, `Compression break vol pctl ${vp.toFixed(2)} range pctl ${rp.toFixed(2)} bullish CL ${cl.toFixed(2)}`));
                continue;
            }
            // Sell: compression + range expansion + bearish close location
            if (cl < 0.40) {
                signals.push(createSellSignal(cleanData, i, `Compression break vol pctl ${vp.toFixed(2)} range pctl ${rp.toFixed(2)} bearish CL ${cl.toFixed(2)}`));
            }
        }
        return signals;
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "volPercentileMax", "rangePercentileMin"],
    },
};
