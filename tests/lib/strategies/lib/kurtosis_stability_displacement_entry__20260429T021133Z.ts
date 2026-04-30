import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import {
    buildRateOfChange,
    buildRollingKurtosis,
    buildRollingMedian,
    buildRollingStdDev,
} from "./price-action-statistics-core";

function normalizeKurtosisStabilityDisplacementEntryParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        window: Math.max(4, Math.round(params.window ?? 126)),
        kurtosisCap: Number(params.kurtosisCap ?? 2),
    };
}

export const kurtosis_stability_displacement_entry: Strategy = {
    name: "Kurtosis Stability Displacement Entry",
    description:
        "Filters for lower-kurtosis return regimes, then enters only when price crosses a one-standard-deviation displacement away from its rolling median anchor.",
    defaultParams: {
        window: 126,
        kurtosisCap: 2,
    },
    paramLabels: {
        window: "Window",
        kurtosisCap: "Kurtosis Cap",
    },
    normalizeParams: normalizeKurtosisStabilityDisplacementEntryParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeKurtosisStabilityDisplacementEntryParams(params);
        const window = p.window as number;
        if (cleanData.length < window + 1) return [];

        const closes = getCloses(cleanData);
        const returns = buildRateOfChange(closes, 1).map((value) => value ?? 0);
        const kurtosis = buildRollingKurtosis(returns, window);
        const median = buildRollingMedian(closes, window);
        const stddev = buildRollingStdDev(closes, window);

        return createSignalLoop(cleanData, [kurtosis, median, stddev], (i) => {
            if (i < window) return null;

            const k = kurtosis[i];
            const m = median[i];
            const sd = stddev[i];
            const prevMedian = median[i - 1];
            const prevStdDev = stddev[i - 1];
            if (
                k === null
                || m === null
                || sd === null
                || prevMedian === null
                || prevStdDev === null
                || k >= (p.kurtosisCap as number)
            ) {
                return null;
            }

            const upper = m + sd;
            const lower = m - sd;
            const prevUpper = prevMedian + prevStdDev;
            const prevLower = prevMedian - prevStdDev;

            if (closes[i - 1] <= prevUpper && closes[i] > upper) {
                return createBuySignal(cleanData, i, `Low-kurtosis bullish displacement above median + 1 stdev (${k.toFixed(3)})`);
            }
            if (closes[i - 1] >= prevLower && closes[i] < lower) {
                return createSellSignal(cleanData, i, `Low-kurtosis bearish displacement below median - 1 stdev (${k.toFixed(3)})`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["window", "kurtosisCap"],
    },
};
