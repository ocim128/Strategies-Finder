import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildBodySeries, buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildRollingZScore } from "./price-action-statistics-core";

function normalizeFomoChokeFadeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        body_lookback: Math.max(2, Math.round(params.body_lookback ?? 20)),
        body_z_threshold: Math.max(0, Number(params.body_z_threshold ?? 2.5)),
        trap_close_loc: Math.max(0, Math.min(1, Number(params.trap_close_loc ?? 0.25)))
    };
}

export const fomo_choke_fade: Strategy = {
    name: "FOMO Choke Fade",
    description: "Retail traders chase unusually large candle bodies. If a candle's body size hits a statistical extreme but closes poorly, the late chasers are instantly trapped.",
    defaultParams: {
        body_lookback: 20,
        body_z_threshold: 2.5,
        trap_close_loc: 0.25
    },
    paramLabels: {
        body_lookback: "Body Lookback",
        body_z_threshold: "Body Z-Score Threshold",
        trap_close_loc: "Trap Close Location"
    },
    normalizeParams: normalizeFomoChokeFadeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeFomoChokeFadeParams(params);
        if (cleanData.length < (p.body_lookback as number)) return [];

        const bodySeries = buildBodySeries(cleanData);
        const bodyZScore = buildRollingZScore(bodySeries, p.body_lookback as number);
        const closeLocSeries = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [bodyZScore], (i) => {
            if (i < (p.body_lookback as number)) return null;
            const bZ = bodyZScore[i];
            if (bZ === null) return null;

            const closeLoc = closeLocSeries[i];
            const isDownCandle = cleanData[i].close < cleanData[i].open;
            const isUpCandle = cleanData[i].close > cleanData[i].open;

            if (isDownCandle && bZ > (p.body_z_threshold as number) && closeLoc > (1.0 - (p.trap_close_loc as number))) {
                return createBuySignal(cleanData, i, `Down-candle body Z > ${p.body_z_threshold} and closeLoc > ${1.0 - (p.trap_close_loc as number)}`);
            }
            if (isUpCandle && bZ > (p.body_z_threshold as number) && closeLoc < (p.trap_close_loc as number)) {
                return createSellSignal(cleanData, i, `Up-candle body Z > ${p.body_z_threshold} and closeLoc < ${p.trap_close_loc}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["body_lookback", "body_z_threshold", "trap_close_loc"]
    }
};
