import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { calculateVolumeProfile } from "../indicators";

const FIXED_PROFILE_BINS = 20;

function normalizeDynamicValueAnchorMigrationParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        profileLookback: Math.max(5, Math.round(params.profileLookback ?? 63)),
        migrationWindow: Math.max(1, Math.round(params.migrationWindow ?? 10)),
    };
}

export const dynamic_value_anchor_migration: Strategy = {
    name: "Dynamic Value Anchor Migration",
    description:
        "Treats the prior-window value area as a structural anchor and only enters when price closes outside a value zone that is already migrating in the same direction.",
    defaultParams: {
        profileLookback: 63,
        migrationWindow: 10,
    },
    paramLabels: {
        profileLookback: "Profile Lookback",
        migrationWindow: "Migration Window",
    },
    normalizeParams: normalizeDynamicValueAnchorMigrationParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeDynamicValueAnchorMigrationParams(params);
        const profileLookback = p.profileLookback as number;
        const migrationWindow = p.migrationWindow as number;
        const minBars = profileLookback + migrationWindow;
        if (cleanData.length < minBars + 1) return [];

        const closes = getCloses(cleanData);
        const profile = calculateVolumeProfile(cleanData, profileLookback, FIXED_PROFILE_BINS);

        return createSignalLoop(cleanData, [profile.vah, profile.val], (i) => {
            if (i < minBars) return null;

            const currentVah = profile.vah[i];
            const currentVal = profile.val[i];
            const pastVah = profile.vah[i - migrationWindow];
            const pastVal = profile.val[i - migrationWindow];
            if (currentVah === null || currentVal === null || pastVah === null || pastVal === null) return null;

            if (closes[i] > currentVah && currentVah > pastVah) {
                return createBuySignal(cleanData, i, "Close accepted above rising value-area high");
            }
            if (closes[i] < currentVal && currentVal < pastVal) {
                return createSellSignal(cleanData, i, "Close accepted below falling value-area low");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["profileLookback", "migrationWindow"],
    },
};
