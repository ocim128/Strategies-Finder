import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getVolumes,
} from "../strategy-helpers";
import { calculateVolumeProfile } from "../indicators";
import { buildCloseAcceptanceSeries, buildRollingAverage } from "./price-action-frequency-core";
import { extractBarMetricSeries } from "./price-action-statistics-core";

const VOLUME_PROFILE_POC_MIGRATION_BINS = 24;
const VOLUME_PROFILE_POC_ACCEPTANCE_ATR_FRACTION = 0.5;

function normalizeVolumeProfilePocMigrationParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        profile_lookback: Math.max(5, Math.round(Number(params.profile_lookback ?? 20))),
        migration_threshold: Math.max(0, Number(params.migration_threshold ?? 0.015)),
    };
}

export const volume_profile_poc_migration: Strategy = {
    name: "Volume Profile POC Migration",
    description:
        "Combines rolling profile point-of-control migration with close acceptance and above-average volume to identify value-area displacement.",
    defaultParams: {
        profile_lookback: 20,
        migration_threshold: 0.015,
    },
    paramLabels: {
        profile_lookback: "Profile Lookback",
        migration_threshold: "Migration Threshold",
    },
    normalizeParams: normalizeVolumeProfilePocMigrationParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeVolumeProfilePocMigrationParams(params);
        const profileLookback = p.profile_lookback as number;
        const migrationThreshold = p.migration_threshold as number;
        if (cleanData.length < profileLookback + 2) return [];

        const closes = getCloses(cleanData);
        const volumes = getVolumes(cleanData);
        const profile = calculateVolumeProfile(cleanData, profileLookback, VOLUME_PROFILE_POC_MIGRATION_BINS);
        const trueRange = extractBarMetricSeries(cleanData, "trueRange");
        const avgTrueRange = buildRollingAverage(trueRange, profileLookback);
        const avgVolume = buildRollingAverage(volumes, profileLookback);
        const closeAcceptance = buildCloseAcceptanceSeries(cleanData);

        return createSignalLoop(cleanData, [profile.poc, profile.vah, profile.val, avgTrueRange, avgVolume], (i) => {
            if (i < profileLookback + 1) return null;

            const poc = profile.poc[i];
            const priorPoc = profile.poc[i - 1];
            const vah = profile.vah[i];
            const priorVah = profile.vah[i - 1];
            const val = profile.val[i];
            const priorVal = profile.val[i - 1];
            const atr = avgTrueRange[i];
            const volumeAverage = avgVolume[i];
            if (
                poc === null ||
                priorPoc === null ||
                vah === null ||
                priorVah === null ||
                val === null ||
                priorVal === null ||
                atr === null ||
                atr <= 0 ||
                volumeAverage === null
            ) {
                return null;
            }

            const pocShiftInAtr = (poc - priorPoc) / atr;
            const acceptsPoc = Math.abs(closes[i] - poc) <= atr * VOLUME_PROFILE_POC_ACCEPTANCE_ATR_FRACTION;
            const risingValueArea = vah > priorVah && closes[i - 1] <= priorVah && closes[i] >= vah && volumes[i] > volumeAverage;
            const fallingValueArea = val < priorVal && closes[i - 1] >= priorVal && closes[i] <= val && volumes[i] > volumeAverage;

            const longBranch =
                (pocShiftInAtr >= migrationThreshold && acceptsPoc && closeAcceptance[i] > 0) ||
                risingValueArea;
            const shortBranch =
                (pocShiftInAtr <= -migrationThreshold && acceptsPoc && closeAcceptance[i] < 0) ||
                fallingValueArea;

            if (longBranch && !shortBranch) {
                return createBuySignal(cleanData, i, `POC migration long ${pocShiftInAtr.toFixed(3)} ATR`);
            }
            if (shortBranch && !longBranch) {
                return createSellSignal(cleanData, i, `POC migration short ${pocShiftInAtr.toFixed(3)} ATR`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["profile_lookback", "migration_threshold"],
    },
};
