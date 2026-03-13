import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { calculateSessionVWAP } from "../indicators";
import { buildRollingZScore } from "./price-action-statistics-core";

export const vwap_zscore_reversion: Strategy = {
    name: "VWAP Z-Score Reversion",
    description: "Computes the rolling z-score of the distance between price and the Session VWAP. Trades extreme statistical deviations from the volume-weighted mean, banking on intra-session mean reversion.",
    defaultParams: {
        zscoreLookback: 50,
        zscoreThreshold: 2.5,
    },
    paramLabels: {
        zscoreLookback: "Z-Score Lookback",
        zscoreThreshold: "Z-Score Threshold",
    },
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length < (params.zscoreLookback as number)) return [];

        const vwap = calculateSessionVWAP(cleanData);
        const distanceSeries = new Array(cleanData.length).fill(0);
        let validBarsInSession = 0;
        let lastDay = -1;

        for (let i = 0; i < cleanData.length; i++) {
            const time = cleanData[i].time;
            const currentDay = typeof time === 'number' ? new Date(time > 1e12 ? time : time * 1000).getUTCDate() : (typeof time === 'string' ? new Date(time).getUTCDate() : time.day);
            if (currentDay !== lastDay) {
                lastDay = currentDay;
                validBarsInSession = 1;
            } else {
                validBarsInSession++;
            }

            if (vwap[i] !== null && validBarsInSession > Math.min(10, (params.zscoreLookback as number) / 2)) {
                distanceSeries[i] = cleanData[i].close - vwap[i]!;
            } else {
                distanceSeries[i] = 0;
            }
        }

        const zscore = buildRollingZScore(distanceSeries, params.zscoreLookback as number);

        return createSignalLoop(cleanData, [], (i) => {
            if (i < (params.zscoreLookback as number)) return null;
            const z = zscore[i];
            if (z === null) return null;

            if (z < -(params.zscoreThreshold as number)) {
                return createBuySignal(cleanData, i, "Z-Score drops below negative threshold");
            }
            if (z > (params.zscoreThreshold as number)) {
                return createSellSignal(cleanData, i, "Z-Score exceeds positive threshold");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["zscoreLookback", "zscoreThreshold"],
    },
};
