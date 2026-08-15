import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildEfficiencyRatio, buildPercentileRank } from "./price-action-statistics-core";

const EFFICIENCY_CEILING = 0.9;
const CLOSE_LOCATION_MID = 0.5;

function normalizeEfficiencyFailedExpansionFadeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
    };
}

export const efficiency_failed_expansion_fade: Strategy = {
    name: "Efficiency Failed Expansion Fade",
    description: "Fades high-efficiency directional attempts that close against their own direction at an extreme efficiency percentile.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeEfficiencyFailedExpansionFadeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeEfficiencyFailedExpansionFadeParams(params).lookback as number;
        if (cleanData.length < 2 * lookback) return [];

        const closes = getCloses(cleanData);
        // Efficiency is null during its own warm-up; a 0 fill keeps the
        // percentile rank usable (non-null) once enough real bars exist.
        const efficiency = buildEfficiencyRatio(cleanData, lookback).map((value) => value ?? 0);
        const pctRank = buildPercentileRank(efficiency, lookback);
        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [pctRank], (i) => {
            // Skip ranks whose windows still contain 0-filled warm-up values.
            if (i < 2 * lookback - 1) return null;
            const rank = pctRank[i];
            if (rank === null) return null;
            const netMove = closes[i] - closes[i - lookback];

            if (rank > EFFICIENCY_CEILING && netMove < 0 && closeLocation[i] > CLOSE_LOCATION_MID) {
                return createBuySignal(cleanData, i, `Failed expansion fade buy: efficiency rank ${rank.toFixed(2)}, down attempt closed upper-half`);
            }
            if (rank > EFFICIENCY_CEILING && netMove > 0 && closeLocation[i] < CLOSE_LOCATION_MID) {
                return createSellSignal(cleanData, i, `Failed expansion fade sell: efficiency rank ${rank.toFixed(2)}, up attempt closed lower-half`);
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
