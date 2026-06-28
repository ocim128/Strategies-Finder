import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildCloseLocationSeries, buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildRollingAutoCorrelation } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 30))),
        autocorrMin: Math.max(0.1, Math.min(0.95, Number(params.autocorrMin ?? 0.30))),
    };
}

export const close_location_deviation_autocorrelation: Strategy = {
    name: "Close Location Deviation Autocorrelation",
    description: "Follows persistent directional bar structure when close location deviation autocorrelates with efficiency confirmation.",
    defaultParams: {
        lookback: 30,
        autocorrMin: 0.30,
    },
    paramLabels: {
        lookback: "Lookback",
        autocorrMin: "Min Autocorrelation",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 3) return [];

        const closeLocation = buildCloseLocationSeries(cleanData);
        // Close location deviation from midpoint (0.5)
        const clDeviation = closeLocation.map(v => v - 0.5);
        const clAutocorr = buildRollingAutoCorrelation(clDeviation, lookback);
        const closeAcceptance = buildCloseAcceptanceSeries(cleanData);

        return createSignalLoop(cleanData, [clAutocorr], (i) => {
            const ac = clAutocorr[i];
            if (ac === null) return null;
            if (ac < (p.autocorrMin as number)) return null;

            const ca = closeAcceptance[i];
            if (ca > 0) {
                return createBuySignal(cleanData, i, `CL dev autocorr ${ac.toFixed(2)} bullish acceptance`);
            }
            if (ca < 0) {
                return createSellSignal(cleanData, i, `CL dev autocorr ${ac.toFixed(2)} bearish acceptance`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "autocorrMin"],
    },
};
