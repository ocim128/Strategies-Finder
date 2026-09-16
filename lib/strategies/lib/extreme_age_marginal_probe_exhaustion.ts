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
        penetration_max: Math.max(0.001, Math.min(0.5, Number(params.penetration_max ?? 0.06))),
    };
}

export const extreme_age_marginal_probe_exhaustion: Strategy = {
    name: "Extreme Age Marginal Probe Exhaustion",
    description: "Fades micro-penetration probe traps when a new extreme barely breaches the prior high/low before closing in reverse.",
    defaultParams: {
        penetration_max: 0.06,
    },
    paramLabels: {
        penetration_max: "Max Penetration Fraction",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const penetration_max = p.penetration_max as number;
        if (cleanData.length < 24 + 1) return [];

        const { sinceHigh, sinceLow } = buildExtremeAgeSeries(cleanData, 24);

        return createSignalLoop(cleanData, [sinceHigh, sinceLow], (i) => {
            if (i < 1) return null;
            const sH = sinceHigh[i];
            const sL = sinceLow[i];
            const r = cleanData[i].high - cleanData[i].low;
            if (r <= 0) return null;

            if (sL !== null && sL === 0 && (cleanData[i - 1].low - cleanData[i].low) <= r * penetration_max && cleanData[i].close > cleanData[i].open) {
                return createBuySignal(cleanData, i, `Bullish marginal probe exhaustion: fresh low (0) penetrated prior low by <= ${(penetration_max * 100).toFixed(1)}% of range, closed bull`);
            }
            if (sH !== null && sH === 0 && (cleanData[i].high - cleanData[i - 1].high) <= r * penetration_max && cleanData[i].close < cleanData[i].open) {
                return createSellSignal(cleanData, i, `Bearish marginal probe exhaustion: fresh high (0) penetrated prior high by <= ${(penetration_max * 100).toFixed(1)}% of range, closed bear`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["penetration_max"],
    },
};
