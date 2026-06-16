import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildCloseLocationSeries, buildRangeSeries } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 25))),
        rangePercentile: Math.max(0, Math.min(1, Number(params.rangePercentile ?? 0.90))),
        clmThreshold: Math.max(0, Math.min(0.5, Number(params.clmThreshold ?? 0.15))),
    };
}

export const dislocation_rejection_fade: Strategy = {
    name: "Dislocation Rejection Fade",
    description: "Fades extreme intrabar ranges that close near the midpoint, signifying rejection of extremes.",
    defaultParams: {
        lookback: 25,
        rangePercentile: 0.90,
        clmThreshold: 0.15,
    },
    paramLabels: {
        lookback: "Lookback Window",
        rangePercentile: "Range Percentile Threshold",
        clmThreshold: "Midpoint Deviation Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 2) return [];

        const closes = getCloses(cleanData);
        const ranges = buildRangeSeries(cleanData);
        const rangePercentile = buildPercentileRank(ranges, lookback);
        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [rangePercentile], (i) => {
            const rp = rangePercentile[i];
            if (rp === null || i < 2) return null;

            const cl = closeLocation[i];
            const prevClose = closes[i - 1];
            const prevPrevClose = closes[i - 2];

            const dev = Math.abs(cl - 0.5);

            if (rp > p.rangePercentile && dev < p.clmThreshold) {
                // Buy: closeLocation slightly above midpoint, following a down-drift
                const isDownDrift = prevClose < prevPrevClose;
                if (cl >= 0.5 && cl < 0.5 + p.clmThreshold && isDownDrift) {
                    return createBuySignal(cleanData, i, `Dislocation rejection buy: range rank ${rp.toFixed(2)}, CL ${cl.toFixed(2)}`);
                }

                // Sell: closeLocation slightly below midpoint, following an up-drift
                const isUpDrift = prevClose > prevPrevClose;
                if (cl <= 0.5 && cl > 0.5 - p.clmThreshold && isUpDrift) {
                    return createSellSignal(cleanData, i, `Dislocation rejection sell: range rank ${rp.toFixed(2)}, CL ${cl.toFixed(2)}`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "rangePercentile", "clmThreshold"],
    },
};
