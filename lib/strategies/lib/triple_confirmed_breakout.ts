import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getVolumes,
} from "../strategy-helpers";
import { buildCloseLocationSeries, buildTrailingHighLow } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

const UPPER_ACCEPTANCE = 0.7;
const LOWER_ACCEPTANCE = 0.3;
const VOLUME_PERCENTILE_GATE = 0.7;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
    };
}

export const triple_confirmed_breakout: Strategy = {
    name: "Triple Confirmed Breakout",
    description: "Continues breakouts that clear the prior-only boundary with far-side placement and elevated volume together.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeParams(params).lookback as number;
        if (cleanData.length <= lookback) return [];

        const { highest, lowest } = buildTrailingHighLow(cleanData, lookback, false);
        const closeLocation = buildCloseLocationSeries(cleanData);
        const volumeRank = buildPercentileRank(getVolumes(cleanData), lookback);

        return createSignalLoop(cleanData, [highest, lowest, volumeRank], (i) => {
            const boundaryHigh = highest[i];
            const boundaryLow = lowest[i];
            const participation = volumeRank[i];
            if (boundaryHigh === null || boundaryLow === null || participation === null) return null;
            if (participation <= VOLUME_PERCENTILE_GATE) return null;

            const bar = cleanData[i];
            if (bar.close > boundaryHigh && closeLocation[i] > UPPER_ACCEPTANCE) {
                return createBuySignal(cleanData, i, `Triple-confirmed break above: vol pctl ${participation.toFixed(2)}`);
            }
            if (bar.close < boundaryLow && closeLocation[i] < LOWER_ACCEPTANCE) {
                return createSellSignal(cleanData, i, `Triple-confirmed break below: vol pctl ${participation.toFixed(2)}`);
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
