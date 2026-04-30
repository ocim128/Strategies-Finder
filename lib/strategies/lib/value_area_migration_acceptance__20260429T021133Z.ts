import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { calculateVolumeProfile } from "../indicators";

function normalizeValueAreaMigrationAcceptanceParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        profile_period: Math.max(5, Math.round(Number(params.profile_period ?? 63))),
        profile_bins: Math.max(5, Math.round(Number(params.profile_bins ?? 24))),
        migration_lookback: Math.max(1, Math.round(Number(params.migration_lookback ?? 10))),
    };
}

export const value_area_migration_acceptance: Strategy = {
    name: "Value Area Migration Acceptance",
    description:
        "Treats a close outside the rolling value area as meaningful only when the profile's own point of control is already migrating in the same direction.",
    defaultParams: {
        profile_period: 63,
        profile_bins: 24,
        migration_lookback: 10,
    },
    paramLabels: {
        profile_period: "Profile Period",
        profile_bins: "Profile Bins",
        migration_lookback: "Migration Lookback",
    },
    normalizeParams: normalizeValueAreaMigrationAcceptanceParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeValueAreaMigrationAcceptanceParams(params);
        const profilePeriod = p.profile_period as number;
        const migrationLookback = p.migration_lookback as number;
        const minLookback = profilePeriod + migrationLookback;
        if (cleanData.length < minLookback + 1) return [];

        const closes = getCloses(cleanData);
        const profile = calculateVolumeProfile(cleanData, profilePeriod, p.profile_bins as number);

        return createSignalLoop(cleanData, [profile.poc, profile.vah, profile.val], (i) => {
            if (i < minLookback) return null;

            const poc = profile.poc[i];
            const pastPoc = profile.poc[i - migrationLookback];
            const vah = profile.vah[i];
            const val = profile.val[i];
            if (poc === null || pastPoc === null || vah === null || val === null) return null;

            if (closes[i] > vah && poc > pastPoc) {
                return createBuySignal(cleanData, i, "Close above VAH with rising POC");
            }
            if (closes[i] < val && poc < pastPoc) {
                return createSellSignal(cleanData, i, "Close below VAL with falling POC");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["profile_period", "profile_bins", "migration_lookback"],
    },
};
