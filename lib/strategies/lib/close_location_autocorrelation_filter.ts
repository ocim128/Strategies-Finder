import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildRateOfChange, buildRollingAutoCorrelation } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 25))),
        closeLocationMax: Math.max(0.7, Math.min(0.99, Number(params.closeLocationMax ?? 0.85))),
        autocorrMax: Math.max(-0.9, Math.min(0.5, Number(params.autocorrMax ?? 0.0))),
    };
}

export const close_location_autocorrelation_filter: Strategy = {
    name: "Close Location Autocorrelation Filter",
    description: "Fades close location extremes only when autocorrelation confirms a mean-reverting regime.",
    defaultParams: {
        lookback: 25,
        closeLocationMax: 0.85,
        autocorrMax: 0.0,
    },
    paramLabels: {
        lookback: "Lookback",
        closeLocationMax: "Max Close Location",
        autocorrMax: "Max Autocorrelation",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 3) return [];

        const closes = getCloses(cleanData);
        const returns = buildRateOfChange(closes, 1);
        const returnsClean = returns.map(v => v ?? 0);
        const autocorr = buildRollingAutoCorrelation(returnsClean, lookback);
        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [autocorr], (i) => {
            const ac = autocorr[i];
            if (ac === null) return null;
            if (ac >= (p.autocorrMax as number)) return null;

            const cl = closeLocation[i];
            const clMax = p.closeLocationMax as number;

            // Buy: close at bottom of bar in mean-reverting regime
            if (cl < (1 - clMax)) {
                return createBuySignal(cleanData, i, `CL extreme ${cl.toFixed(2)} autocorr ${ac.toFixed(2)} reversion buy`);
            }
            // Sell: close at top of bar in mean-reverting regime
            if (cl > clMax) {
                return createSellSignal(cleanData, i, `CL extreme ${cl.toFixed(2)} autocorr ${ac.toFixed(2)} reversion sell`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "closeLocationMax", "autocorrMax"],
    },
};
