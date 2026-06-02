import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildEfficiencyRatio } from "./price-action-statistics-core";
import { buildRollingValueArea } from "./value-area-acceptance-core";

// #COMPLETION_DRIVE: Assuming low path efficiency identifies high-probability sweeps prone to value re-entry.
// #SUGGEST_VERIFY: Verify that maxEfficiency bounds [0, 1] are respected and cover range spikes.
function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 50))),
        maxEfficiency: Math.max(0.01, Math.min(1.0, Number(params.maxEfficiency ?? 0.35))),
    };
}

export const volume_weighted_spread_efficiency_fade: Strategy = {
    name: "Volume Weighted Spread Efficiency Fade",
    description: "Fades value area boundary breakouts when path efficiency is low and price crosses back inside the Value Area.",
    defaultParams: {
        lookback: 50,
        maxEfficiency: 0.35,
    },
    paramLabels: {
        lookback: "Lookback",
        maxEfficiency: "Max Efficiency",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const maxEfficiency = p.maxEfficiency as number;
        if (cleanData.length < lookback + 2) return [];

        const closes = getCloses(cleanData);
        const { vah, val } = buildRollingValueArea(cleanData, lookback);
        const efficiency = buildEfficiencyRatio(cleanData, lookback);

        return createSignalLoop(cleanData, [vah, val, efficiency], (i) => {
            const currentClose = closes[i];
            const prevClose = closes[i - 1];
            const currentVal = val[i];
            const prevVal = val[i - 1];
            const currentVah = vah[i];
            const prevVah = vah[i - 1];
            const eff = efficiency[i];

            if (
                currentVal === null ||
                prevVal === null ||
                currentVah === null ||
                prevVah === null ||
                eff === null
            ) {
                return null;
            }

            // Buy: Close crosses above VAL (re-entering from below) while efficiency is low
            const crossedAboveVal = prevClose <= prevVal && currentClose > currentVal;
            if (crossedAboveVal && eff < maxEfficiency) {
                return createBuySignal(
                    cleanData,
                    i,
                    `Low efficiency (${eff.toFixed(3)} < ${maxEfficiency}) reclaim above VAL (${currentVal.toFixed(2)})`
                );
            }

            // Sell: Close crosses below VAH (re-entering from above) while efficiency is low
            const crossedBelowVah = prevClose >= prevVah && currentClose < currentVah;
            if (crossedBelowVah && eff < maxEfficiency) {
                return createSellSignal(
                    cleanData,
                    i,
                    `Low efficiency (${eff.toFixed(3)} < ${maxEfficiency}) reject below VAH (${currentVah.toFixed(2)})`
                );
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "maxEfficiency"],
    },
};
