import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
} from "../strategy-helpers";
import { calculateDonchianChannels } from "../indicators";
import { buildRateOfChange, buildRollingSkewness } from "./price-action-statistics-core";

function normalizeSkewnessBiasedDonchianRouterParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        horizon: Math.max(4, Math.round(Number(params.horizon ?? 55))),
    };
}

export const skewness_biased_donchian_router: Strategy = {
    name: "Skewness Biased Donchian Router",
    description:
        "Routes positive return skew to Donchian breakout logic and negative skew to midpoint-biased defensive alignment.",
    defaultParams: {
        horizon: 55,
    },
    paramLabels: {
        horizon: "Horizon",
    },
    normalizeParams: normalizeSkewnessBiasedDonchianRouterParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeSkewnessBiasedDonchianRouterParams(params);
        const horizon = p.horizon as number;
        if (cleanData.length < horizon + 2) return [];

        const closes = getCloses(cleanData);
        const returns = buildRateOfChange(closes, 1).map((value) => value ?? 0);
        const skewness = buildRollingSkewness(returns, horizon);
        const donchian = calculateDonchianChannels(getHighs(cleanData), getLows(cleanData), horizon);

        return createSignalLoop(cleanData, [skewness, donchian.upper, donchian.lower, donchian.middle], (i) => {
            const skew = skewness[i];
            const previousSkew = skewness[i - 1];
            const priorUpper = donchian.upper[i - 1];
            const priorLower = donchian.lower[i - 1];
            const midpoint = donchian.middle[i];
            if (skew === null || previousSkew === null || priorUpper === null || priorLower === null || midpoint === null) return null;

            if (skew > 0) {
                if (closes[i - 1] <= priorUpper && closes[i] > priorUpper) {
                    return createBuySignal(cleanData, i, `Positive-skew Donchian breakout skew=${skew.toFixed(2)}`);
                }
                if (closes[i - 1] >= priorLower && closes[i] < priorLower) {
                    return createSellSignal(cleanData, i, `Positive-skew Donchian breakdown skew=${skew.toFixed(2)}`);
                }
                return null;
            }

            if (closes[i] > midpoint && skew > previousSkew) {
                return createBuySignal(cleanData, i, `Negative-skew midpoint recovery skew=${skew.toFixed(2)}`);
            }
            if (closes[i] < midpoint && skew < previousSkew) {
                return createSellSignal(cleanData, i, `Negative-skew midpoint failure skew=${skew.toFixed(2)}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["horizon"],
    },
};
