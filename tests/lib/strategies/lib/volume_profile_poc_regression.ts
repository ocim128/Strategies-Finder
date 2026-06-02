import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getHighs, getLows, getCloses } from "../strategy-helpers";
import { calculateATR } from "../indicators";
import { buildEfficiencyRatio } from "./price-action-statistics-core";
import { buildRollingValueArea } from "./value-area-acceptance-core";

// #COMPLETION_DRIVE: Assuming volume profile POC represents high liquidity equilibrium and efficiency ratio gates trend exhaustion.
// #SUGGEST_VERIFY: Verify ATR value is above zero to avoid division-by-zero errors.
function normalizeVolumeProfilePocRegressionParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 60))),
        distanceThreshold: Math.max(0.1, Number(params.distanceThreshold ?? 2.5)),
    };
}

export const volume_profile_poc_regression: Strategy = {
    name: "Volume Profile POC Regression",
    description: "Reverts to POC high-liquidity zones when close is at extreme ATR-normalized distance and efficiency ratio shows lack of trend conviction.",
    defaultParams: {
        lookback: 60,
        distanceThreshold: 2.5,
    },
    paramLabels: {
        lookback: "Profile Lookback",
        distanceThreshold: "POC Distance Threshold (ATR)",
    },
    normalizeParams: normalizeVolumeProfilePocRegressionParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeVolumeProfilePocRegressionParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 5) return [];

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);

        const { poc } = buildRollingValueArea(cleanData, lookback);
        const atr = calculateATR(highs, lows, closes, lookback);
        const efficiency = buildEfficiencyRatio(cleanData, lookback);

        return createSignalLoop(cleanData, [poc, atr, efficiency], (i) => {
            if (i < lookback) return null;
            const currentClose = closes[i];
            const currentPoc = poc[i];
            const currentAtr = atr[i];
            const eff = efficiency[i];

            if (currentPoc === null || currentAtr === null || eff === null || currentAtr <= 0) return null;

            const distance = currentClose - currentPoc;
            const normalizedDistance = distance / currentAtr;

            // Buy logic: Close is below the POC by more than distanceThreshold times ATR, and rolling efficiency ratio is below 0.35.
            if (normalizedDistance < -(p.distanceThreshold as number) && eff < 0.35) {
                return createBuySignal(cleanData, i, `POC Regression Bullish (dist=${normalizedDistance.toFixed(2)}x ATR, eff=${eff.toFixed(3)})`);
            }

            // Sell logic: Close is above the POC by more than distanceThreshold times ATR, and rolling efficiency ratio is below 0.35.
            if (normalizedDistance > p.distanceThreshold && eff < 0.35) {
                return createSellSignal(cleanData, i, `POC Regression Bearish (dist=${normalizedDistance.toFixed(2)}x ATR, eff=${eff.toFixed(3)})`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "distanceThreshold"],
    },
};
