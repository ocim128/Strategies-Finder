import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildExtremeAgeSeries } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        delta_age_max: Math.max(0, Math.floor(Number(params.delta_age_max ?? 3))),
    };
}

export const extreme_age_symmetric_age_convergence_break: Strategy = {
    name: "Extreme Age Symmetric Age Convergence Break",
    description: "Enters directional breakout when high and low extreme ages converge symmetrically at mid-window before breaking out.",
    defaultParams: {
        delta_age_max: 3,
    },
    paramLabels: {
        delta_age_max: "Max Age Difference",
    },
    normalizeParams,
    execute(data: OHLCVData[], rawParams: StrategyParams = {}) {
        const cleanData = ensureCleanData(data);
        const params = normalizeParams(rawParams);
        const deltaAgeMax = Number(params.delta_age_max);

        const { sinceHigh, sinceLow } = buildExtremeAgeSeries(cleanData, 24);

        return createSignalLoop(cleanData, [sinceHigh, sinceLow], (i) => {
            if (i < 1) return null;
            const sh = sinceHigh[i];
            const sl = sinceLow[i];
            if (sh === null || sl === null) return null;

            if (Math.abs(sh - sl) <= deltaAgeMax && sh >= 8 && sl >= 8) {
                if (cleanData[i].close > cleanData[i - 1].high) {
                    return createBuySignal(cleanData, i, `Bullish symmetric age convergence breakout: |ageH - ageL| = |${sh} - ${sl}| <= ${deltaAgeMax}, close > high[i-1]`);
                }
                if (cleanData[i].close < cleanData[i - 1].low) {
                    return createSellSignal(cleanData, i, `Bearish symmetric age convergence breakout: |ageH - ageL| = |${sh} - ${sl}| <= ${deltaAgeMax}, close < low[i-1]`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["delta_age_max"],
    },
};
