import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildEfficiencyRatio } from "./price-action-statistics-core";
import { buildRollingValueArea } from "./value-area-acceptance-core";

// #COMPLETION_DRIVE: Assuming inefficient price extensions outside VAH/VAL are statistically rejected and revert to POC.
// #SUGGEST_VERIFY: Verify that VAH and VAL bounds are causal and efficiency ratio remains below maxEfficiency threshold.
function normalizeValueAreaAcceptanceReversionParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 50))),
        maxEfficiency: Math.max(0.01, Math.min(0.99, Number(params.maxEfficiency ?? 0.3))),
    };
}

export const value_area_acceptance_reversion: Strategy = {
    name: "Value Area Acceptance Reversion",
    description: "Reverts inefficient price breakouts back to Point of Control (POC) when price is outside VAH/VAL boundaries.",
    defaultParams: {
        lookback: 50,
        maxEfficiency: 0.3,
    },
    paramLabels: {
        lookback: "Lookback Window",
        maxEfficiency: "Max Efficiency",
    },
    normalizeParams: normalizeValueAreaAcceptanceReversionParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeValueAreaAcceptanceReversionParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 5) return [];

        const closes = getCloses(cleanData);
        const { vah, val } = buildRollingValueArea(cleanData, lookback);
        const efficiency = buildEfficiencyRatio(cleanData, lookback);

        return createSignalLoop(cleanData, [vah, val, efficiency], (i) => {
            if (i < lookback) return null;
            const currentClose = closes[i];
            const currentVah = vah[i];
            const currentVal = val[i];
            const eff = efficiency[i];

            if (currentVah === null || currentVal === null || eff === null) return null;
            if (eff >= p.maxEfficiency) return null;

            // Buy logic: Close price is below the Value Area Low (VAL), and rolling efficiency is low.
            if (currentClose < currentVal) {
                return createBuySignal(cleanData, i, `Bullish Value Area Rejection (VAL=${currentVal.toFixed(2)}, eff=${eff.toFixed(3)})`);
            }

            // Sell logic: Close price is above the Value Area High (VAH), and rolling efficiency is low.
            if (currentClose > currentVah) {
                return createSellSignal(cleanData, i, `Bearish Value Area Rejection (VAH=${currentVah.toFixed(2)}, eff=${eff.toFixed(3)})`);
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
