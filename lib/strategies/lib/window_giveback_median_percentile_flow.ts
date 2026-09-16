import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import {
    buildCloseLocationSeries,
    buildWindowGivebackRatio,
} from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
    };
}

export const window_giveback_median_percentile_flow: Strategy = {
    name: "Window Giveback Median Percentile Flow",
    description: "Trades trend continuation when the rolling giveback percentile stays locked in the 40-60% balanced flow channel.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Percentile Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < Math.max(lookback, 20) + 1) return [];

        const giveback = buildWindowGivebackRatio(cleanData, 20);
        const givebackValues = giveback.map((v) => (v !== null ? v : NaN));
        const pctGb = buildPercentileRank(givebackValues, lookback);
        const clsLoc = buildCloseLocationSeries(cleanData);
        const closes = getCloses(cleanData);

        return createSignalLoop(cleanData, [pctGb, clsLoc], (i) => {
            if (i < 20) return null;
            const pctl = pctGb[i];
            const cl = clsLoc[i];
            if (pctl === null || cl === null) return null;
            if (pctl < 0.40 || pctl > 0.60) return null;

            if (closes[i] > closes[i - 20] && cl >= 0.75) {
                return createBuySignal(cleanData, i, `Bullish median giveback flow: pctl ${pctl.toFixed(2)} in [0.40, 0.60], closeLocation ${cl.toFixed(2)} >= 0.75, close > close[i-20]`);
            }
            if (closes[i] < closes[i - 20] && cl <= 0.25) {
                return createSellSignal(cleanData, i, `Bearish median giveback flow: pctl ${pctl.toFixed(2)} in [0.40, 0.60], closeLocation ${cl.toFixed(2)} <= 0.25, close < close[i-20]`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback"],
    },
};
