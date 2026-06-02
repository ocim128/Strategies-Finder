import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getHighs, getLows, getCloses, getVolumes } from "../strategy-helpers";
import { calculateCMF } from "../indicators";
import { extractBarMetricSeries } from "./price-action-frequency-core";
import { buildRollingZScore } from "./price-action-statistics-core";

// #COMPLETION_DRIVE: Assuming closeMidpointDev metric can be extracted and its z-score combined with opposite money flow isolates short-term reversion.
// #SUGGEST_VERIFY: Verify closeMidpointDev is normalized or bounds check is stable in flat/consolidation markets.
function normalizeCloseMidpointDeviationZScoreReversionParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 35))),
        zThreshold: Math.max(0.1, Number(params.zThreshold ?? 2.3)),
    };
}

export const close_midpoint_deviation_zscore_reversion: Strategy = {
    name: "Close-Midpoint Deviation Z-Score Reversion",
    description: "Reversion signals triggered when the Z-score of close-midpoint deviation reaches extreme levels while Chaikin Money Flow diverges.",
    defaultParams: {
        lookback: 35,
        zThreshold: 2.3,
    },
    paramLabels: {
        lookback: "Lookback Window",
        zThreshold: "Z-Score Threshold",
    },
    normalizeParams: normalizeCloseMidpointDeviationZScoreReversionParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeCloseMidpointDeviationZScoreReversionParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 5) return [];

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);
        const volumes = getVolumes(cleanData);

        const devSeries = extractBarMetricSeries(cleanData, "closeMidpointDev");
        const devZScore = buildRollingZScore(devSeries, lookback);
        const cmf = calculateCMF(highs, lows, closes, volumes, lookback);

        return createSignalLoop(cleanData, [devZScore, cmf], (i) => {
            if (i < lookback) return null;
            const currentZ = devZScore[i];
            const currentCmf = cmf[i];

            if (currentZ === null || currentCmf === null) return null;

            // Buy logic: Z-score of closeMidpointDev is < -zThreshold while CMF is positive
            if (currentZ < -p.zThreshold && currentCmf > 0) {
                return createBuySignal(cleanData, i, `Bullish Midpoint Reversion (z=${currentZ.toFixed(2)}, CMF=${currentCmf.toFixed(3)})`);
            }

            // Sell logic: Z-score of closeMidpointDev is > zThreshold while CMF is negative
            if (currentZ > p.zThreshold && currentCmf < 0) {
                return createSellSignal(cleanData, i, `Bearish Midpoint Reversion (z=${currentZ.toFixed(2)}, CMF=${currentCmf.toFixed(3)})`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "zThreshold"],
    },
};
