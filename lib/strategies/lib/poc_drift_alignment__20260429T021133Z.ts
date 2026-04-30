import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { calculateVolumeProfile } from "../indicators";

function normalizePocDriftAlignmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        profile_period: Math.max(5, Math.round(Number(params.profile_period ?? 63))),
        profile_bins: Math.max(5, Math.round(Number(params.profile_bins ?? 24))),
        slope_lookback: Math.max(1, Math.round(Number(params.slope_lookback ?? 10))),
    };
}

export const poc_drift_alignment: Strategy = {
    name: "POC Drift Alignment",
    description:
        "Uses the rolling point of control as a causal value anchor and only enters when the completed close agrees with the current side of POC while that anchor is already drifting the same way.",
    defaultParams: {
        profile_period: 63,
        profile_bins: 24,
        slope_lookback: 10,
    },
    paramLabels: {
        profile_period: "Profile Period",
        profile_bins: "Profile Bins",
        slope_lookback: "POC Drift Lookback",
    },
    normalizeParams: normalizePocDriftAlignmentParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizePocDriftAlignmentParams(params);
        const profilePeriod = p.profile_period as number;
        const slopeLookback = p.slope_lookback as number;
        const minLookback = profilePeriod + slopeLookback;
        if (cleanData.length < minLookback + 1) return [];

        const closes = getCloses(cleanData);
        const profile = calculateVolumeProfile(cleanData, profilePeriod, p.profile_bins as number);

        return createSignalLoop(cleanData, [profile.poc], (i) => {
            if (i < minLookback) return null;

            const currentPoc = profile.poc[i];
            const pastPoc = profile.poc[i - slopeLookback];
            if (currentPoc === null || pastPoc === null) return null;

            if (closes[i] > currentPoc && currentPoc > pastPoc) {
                return createBuySignal(cleanData, i, "Close above rising POC");
            }
            if (closes[i] < currentPoc && currentPoc < pastPoc) {
                return createSellSignal(cleanData, i, "Close below falling POC");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["profile_period", "profile_bins", "slope_lookback"],
    },
};
