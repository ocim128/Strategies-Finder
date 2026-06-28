import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildCloseLocationSeries, buildRangeSeries } from "./price-action-frequency-core";
import { buildRateOfChange, buildRollingStdDev, buildPercentileRank } from "./price-action-statistics-core";

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
        const closeLocation = buildCloseLocationSeries(cleanData);

        // Return volatility
        const returns = buildRateOfChange(closes, 1);
        const returnsClean = returns.map(v => v ?? 0);
        const volStdDev = buildRollingStdDev(returnsClean, lookback);
        const volPctl = buildPercentileRank(volStdDev.map(v => v ?? 0), lookback);

        // Range percentile
        const ranges = buildRangeSeries(cleanData);
        const rangePctl = buildPercentileRank(ranges, lookback);

        return createSignalLoop(cleanData, [volPctl, rangePctl], (i) => {
            const vp = volPctl[i];
            const rp = rangePctl[i];
            if (vp === null || rp === null) return null;
            if (vp >= (p.volPercentileMax as number)) return null;
            if (rp < (p.rangePercentileMin as number)) return null;

            const cl = closeLocation[i];
            // Buy: compression + range expansion + bullish close location
            if (cl > 0.60) {
                return createBuySignal(cleanData, i, `Compression break vol pctl ${vp.toFixed(2)} range pctl ${rp.toFixed(2)} bullish CL ${cl.toFixed(2)}`);
            }
            // Sell: compression + range expansion + bearish close location
            if (cl < 0.40) {
                return createSellSignal(cleanData, i, `Compression break vol pctl ${vp.toFixed(2)} range pctl ${rp.toFixed(2)} bearish CL ${cl.toFixed(2)}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "volPercentileMax", "rangePercentileMin"],
    },
};
