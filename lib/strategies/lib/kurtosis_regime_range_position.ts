import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRollingKurtosis } from "./price-action-statistics-core";
import { buildTrailingHighLow } from "./price-action-frequency-core";

function normalizeKurtosisRegimeRangePositionParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(params.lookback ?? 50)),
        kurtosis_threshold: Number(params.kurtosis_threshold ?? 3.0),
    };
}

export const kurtosis_regime_range_position: Strategy = {
    name: "Kurtosis Regime Range Position",
    description: "Low rolling kurtosis flags a flatter, more compressed distribution. Within that compression regime, where the close sits inside the trailing range indicates which side of value is being accepted before resolution.",
    defaultParams: {
        lookback: 50,
        kurtosis_threshold: 3.0,
    },
    paramLabels: {
        lookback: "Lookback",
        kurtosis_threshold: "Kurtosis Threshold",
    },
    normalizeParams: normalizeKurtosisRegimeRangePositionParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeKurtosisRegimeRangePositionParams(params);
        const lookback = p.lookback as number;
        const threshold = p.kurtosis_threshold as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const excessKurtosis = buildRollingKurtosis(closes, lookback);
        const { highest, lowest } = buildTrailingHighLow(cleanData, lookback, false);

        return createSignalLoop(cleanData, [excessKurtosis, highest, lowest], (i) => {
            const excess = excessKurtosis[i];
            const hi = highest[i];
            const lo = lowest[i];
            if (excess === null || hi === null || lo === null) return null;

            const rawKurtosis = excess + 3;
            if (rawKurtosis >= threshold) return null;

            const span = hi - lo;
            if (span <= 0) return null;
            const position = (closes[i] - lo) / span;

            if (position > 0.5) {
                return createBuySignal(cleanData, i, `Kurtosis ${rawKurtosis.toFixed(2)} < ${threshold} and range position ${(position * 100).toFixed(1)}%`);
            }
            if (position < 0.5) {
                return createSellSignal(cleanData, i, `Kurtosis ${rawKurtosis.toFixed(2)} < ${threshold} and range position ${(position * 100).toFixed(1)}%`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "kurtosis_threshold"],
    },
};
