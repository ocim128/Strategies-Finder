import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildEfficiencyRatio } from "./price-action-statistics-core";

function normalizeCloseLocationExtremeEfficiencyFadeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 20))),
        closeLocationMax: Math.max(0.5, Math.min(1, Number(params.closeLocationMax ?? 0.85))),
        efficiencyMax: Math.max(0, Math.min(1, Number(params.efficiencyMax ?? 0.30))),
    };
}

export const close_location_extreme_efficiency_fade: Strategy = {
    name: "Close Location Extreme Efficiency Fade",
    description: "Close location extreme with efficiency confirmation for mean reversion.",
    defaultParams: {
        lookback: 20,
        closeLocationMax: 0.85,
        efficiencyMax: 0.30,
    },
    paramLabels: {
        lookback: "Lookback",
        closeLocationMax: "Close Location Max",
        efficiencyMax: "Efficiency Max",
    },
    normalizeParams: normalizeCloseLocationExtremeEfficiencyFadeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeCloseLocationExtremeEfficiencyFadeParams(params);
        const lookback = p.lookback as number;
        const closeLocationMax = p.closeLocationMax as number;
        const efficiencyMax = p.efficiencyMax as number;
        if (cleanData.length < lookback + 1) return [];

        const closeLocation = buildCloseLocationSeries(cleanData);
        const efficiencyRatio = buildEfficiencyRatio(cleanData, lookback);

        return createSignalLoop(cleanData, [efficiencyRatio], (i) => {
            const eff = efficiencyRatio[i];
            if (eff === null) return null;

            const cl = closeLocation[i];
            if (eff < efficiencyMax) {
                if (cl < (1 - closeLocationMax)) {
                    return createBuySignal(
                        cleanData,
                        i,
                        `Close location ${cl.toFixed(2)} below threshold ${1 - closeLocationMax} with low efficiency ${eff.toFixed(2)}`
                    );
                }
                if (cl > closeLocationMax) {
                    return createSellSignal(
                        cleanData,
                        i,
                        `Close location ${cl.toFixed(2)} above threshold ${closeLocationMax} with low efficiency ${eff.toFixed(2)}`
                    );
                }
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "closeLocationMax", "efficiencyMax"],
    },
};
