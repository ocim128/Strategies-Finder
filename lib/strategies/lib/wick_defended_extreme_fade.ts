import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseLocationSeries, extractBarMetricSeries } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

const PLACEMENT_LOW_BAND = 0.15;
const PLACEMENT_HIGH_BAND = 0.85;
const WICK_DEFENDED_HIGH_BAND = 0.8;
const WICK_DEFENDED_LOW_BAND = 0.2;

function normalizeWickDefendedExtremeFadeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 40))),
    };
}

export const wick_defended_extreme_fade: Strategy = {
    name: "Wick Defended Extreme Fade",
    description: "Fades closes pinned at a range extreme when the wick imbalance shows the opposite side was defended within the bar.",
    defaultParams: {
        lookback: 40,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeWickDefendedExtremeFadeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeWickDefendedExtremeFadeParams(params).lookback as number;
        if (cleanData.length < lookback) return [];

        const wickPct = buildPercentileRank(extractBarMetricSeries(cleanData, "wickImbalance"), lookback);
        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [wickPct], (i) => {
            if (i < lookback) return null;
            const wickRank = wickPct[i];
            if (wickRank === null) return null;

            if (closeLocation[i] < PLACEMENT_LOW_BAND && wickRank > WICK_DEFENDED_HIGH_BAND) {
                return createBuySignal(cleanData, i, `Wick defended buy: close location ${closeLocation[i].toFixed(2)} with lows defended (wick rank ${wickRank.toFixed(2)})`);
            }
            if (closeLocation[i] > PLACEMENT_HIGH_BAND && wickRank < WICK_DEFENDED_LOW_BAND) {
                return createSellSignal(cleanData, i, `Wick defended sell: close location ${closeLocation[i].toFixed(2)} with highs defended (wick rank ${wickRank.toFixed(2)})`);
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
