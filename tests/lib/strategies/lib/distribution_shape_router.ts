import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { calculateVolumeProfile } from "../indicators";
import { buildRollingKurtosis, buildRollingMedian, buildRollingSkewness } from "./price-action-statistics-core";

const DISTRIBUTION_SHAPE_PROFILE_BINS = 24;
const DISTRIBUTION_SHAPE_HIGH_KURTOSIS = 1;

function normalizeDistributionShapeRouterParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 63))),
        skew_threshold: Math.max(0, Number(params.skew_threshold ?? 0.3)),
    };
}

export const distribution_shape_router: Strategy = {
    name: "Distribution Shape Router",
    description:
        "Routes symmetric high-kurtosis regimes to median alignment and asymmetric skew regimes to value-area extreme acceptance.",
    defaultParams: {
        lookback: 63,
        skew_threshold: 0.3,
    },
    paramLabels: {
        lookback: "Lookback",
        skew_threshold: "Skew Threshold",
    },
    normalizeParams: normalizeDistributionShapeRouterParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeDistributionShapeRouterParams(params);
        const lookback = p.lookback as number;
        const skewThreshold = p.skew_threshold as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const skewness = buildRollingSkewness(closes, lookback);
        const kurtosis = buildRollingKurtosis(closes, lookback);
        const median = buildRollingMedian(closes, lookback);
        const profile = calculateVolumeProfile(cleanData, lookback, DISTRIBUTION_SHAPE_PROFILE_BINS);

        return createSignalLoop(cleanData, [skewness, kurtosis, median, profile.vah, profile.val], (i) => {
            const skew = skewness[i];
            const kurt = kurtosis[i];
            const med = median[i];
            const vah = profile.vah[i];
            const val = profile.val[i];
            if (skew === null || kurt === null || med === null || vah === null || val === null) return null;

            if (Math.abs(skew) < skewThreshold && kurt > DISTRIBUTION_SHAPE_HIGH_KURTOSIS) {
                if (closes[i] > med) {
                    return createBuySignal(cleanData, i, `Symmetric high-kurtosis median long kurt=${kurt.toFixed(2)}`);
                }
                if (closes[i] < med) {
                    return createSellSignal(cleanData, i, `Symmetric high-kurtosis median short kurt=${kurt.toFixed(2)}`);
                }
                return null;
            }

            if (skew >= skewThreshold && closes[i] >= vah) {
                return createBuySignal(cleanData, i, `Positive-skew value-area extension skew=${skew.toFixed(2)}`);
            }
            if (skew <= -skewThreshold && closes[i] <= val) {
                return createSellSignal(cleanData, i, `Negative-skew value-area extension skew=${skew.toFixed(2)}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "skew_threshold"],
    },
};
