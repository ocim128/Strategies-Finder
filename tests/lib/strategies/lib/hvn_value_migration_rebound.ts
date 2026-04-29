import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { calculateVolumeProfile } from "../indicators";

const HVN_PROFILE_BINS = 20;

function normalizeHvnValueMigrationReboundParams(params: StrategyParams): StrategyParams {
    const pocLookback = Math.max(5, Math.round(Number(params.poc_lookback ?? 20)));
    const profileLookback = Math.max(pocLookback + 1, Math.round(Number(params.profile_lookback ?? 63)));
    return {
        ...params,
        profile_lookback: profileLookback,
        poc_lookback: pocLookback,
    };
}

export const hvn_value_migration_rebound: Strategy = {
    name: "HVN Value Migration Rebound",
    description:
        "Compares shorter and longer volume-profile POCs so entries only occur once value has clearly migrated and price is already holding on the same side of both anchors.",
    defaultParams: {
        profile_lookback: 63,
        poc_lookback: 20,
    },
    paramLabels: {
        profile_lookback: "Profile Lookback",
        poc_lookback: "POC Lookback",
    },
    normalizeParams: normalizeHvnValueMigrationReboundParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeHvnValueMigrationReboundParams(params);
        if (cleanData.length < (p.profile_lookback as number)) return [];

        const historicalProfile = calculateVolumeProfile(cleanData, p.profile_lookback as number, HVN_PROFILE_BINS);
        const recentProfile = calculateVolumeProfile(cleanData, p.poc_lookback as number, HVN_PROFILE_BINS);

        return createSignalLoop(cleanData, [historicalProfile.poc, recentProfile.poc], (i) => {
            const historicalPoc = historicalProfile.poc[i];
            const recentPoc = recentProfile.poc[i];
            if (historicalPoc === null || recentPoc === null) return null;

            const close = cleanData[i].close;
            if (recentPoc > historicalPoc && close > recentPoc && close > historicalPoc) {
                return createBuySignal(cleanData, i, "Recent POC migrated above historical POC and price is above both");
            }
            if (recentPoc < historicalPoc && close < recentPoc && close < historicalPoc) {
                return createSellSignal(cleanData, i, "Recent POC migrated below historical POC and price is below both");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["profile_lookback", "poc_lookback"],
    },
};
