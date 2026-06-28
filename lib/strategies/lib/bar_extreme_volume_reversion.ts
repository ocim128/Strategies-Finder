import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getVolumes } from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 25))),
        closeLocationMax: Math.max(0.7, Math.min(0.99, Number(params.closeLocationMax ?? 0.85))),
        volumePercentileMin: Math.max(0.1, Math.min(0.99, Number(params.volumePercentileMin ?? 0.50))),
    };
}

export const bar_extreme_volume_reversion: Strategy = {
    name: "Bar Extreme Volume Reversion",
    description: "Fades close location extremes when proxy volume confirms genuine overextension, not breakout.",
    defaultParams: {
        lookback: 25,
        closeLocationMax: 0.85,
        volumePercentileMin: 0.50,
    },
    paramLabels: {
        lookback: "Lookback",
        closeLocationMax: "Max Close Location",
        volumePercentileMin: "Min Volume Percentile",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 2) return [];

        const closeLocation = buildCloseLocationSeries(cleanData);
        const volumes = getVolumes(cleanData);
        const volPctl = buildPercentileRank(volumes, lookback);

        return createSignalLoop(cleanData, [volPctl], (i) => {
            const vp = volPctl[i];
            if (vp === null) return null;
            if (vp < (p.volumePercentileMin as number)) return null;

            const cl = closeLocation[i];
            const clMax = p.closeLocationMax as number;

            // Buy: close at bottom of bar with volume confirmation
            if (cl < (1 - clMax)) {
                return createBuySignal(cleanData, i, `CL extreme ${cl.toFixed(2)} vol pctl ${vp.toFixed(2)} fade buy`);
            }
            // Sell: close at top of bar with volume confirmation
            if (cl > clMax) {
                return createSellSignal(cleanData, i, `CL extreme ${cl.toFixed(2)} vol pctl ${vp.toFixed(2)} fade sell`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "closeLocationMax", "volumePercentileMin"],
    },
};
