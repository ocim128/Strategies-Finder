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
import { buildRollingAverage } from "./price-action-frequency-core";
import { buildRollingMedian } from "./price-action-statistics-core";

const VALUE_AREA_VOLUME_PROFILE_BINS = 24;

function normalizeValueAreaVolumeCompositeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        profile_window: Math.max(5, Math.round(Number(params.profile_window ?? 20))),
    };
}

export const value_area_volume_composite: Strategy = {
    name: "Value Area Volume Composite",
    description:
        "OR-combines signed-volume value-area migration and volume-confirmed POC acceptance from the rolling profile.",
    defaultParams: {
        profile_window: 20,
    },
    paramLabels: {
        profile_window: "Profile Window",
    },
    normalizeParams: normalizeValueAreaVolumeCompositeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeValueAreaVolumeCompositeParams(params);
        const profileWindow = p.profile_window as number;
        if (cleanData.length < profileWindow + 2) return [];

        const closes = getCloses(cleanData);
        const volumes = getVolumes(cleanData);
        const profile = calculateVolumeProfile(cleanData, profileWindow, VALUE_AREA_VOLUME_PROFILE_BINS);
        const averageVolume = buildRollingAverage(volumes, profileWindow);
        const closeMedian = buildRollingMedian(closes, profileWindow);
        const signedVolume = cleanData.map((bar) => {
            if (bar.close > bar.open) return bar.volume;
            if (bar.close < bar.open) return -bar.volume;
            return 0;
        });

        return createSignalLoop(cleanData, [profile.poc, profile.vah, profile.val, averageVolume, closeMedian], (i) => {
            if (i < profileWindow + 1) return null;

            const poc = profile.poc[i];
            const priorPoc = profile.poc[i - 1];
            const vah = profile.vah[i];
            const priorVah = profile.vah[i - 1];
            const val = profile.val[i];
            const priorVal = profile.val[i - 1];
            const avgVolume = averageVolume[i];
            const median = closeMedian[i];
            if (
                poc === null ||
                priorPoc === null ||
                vah === null ||
                priorVah === null ||
                val === null ||
                priorVal === null ||
                avgVolume === null ||
                median === null
            ) {
                return null;
            }

            const valueSpan = Math.max(vah - val, Math.abs(median) * 0.001);
            const nearPoc = Math.abs(closes[i] - poc) <= valueSpan * 0.25;
            const volumeDelta = signedVolume[i] - signedVolume[i - 1];

            const migrationLong = vah > priorVah && closes[i - 1] <= priorVah && closes[i] >= vah && volumeDelta > 0;
            const migrationShort = val < priorVal && closes[i - 1] >= priorVal && closes[i] <= val && volumeDelta < 0;
            const pocLong = nearPoc && volumes[i] > avgVolume && poc > priorPoc;
            const pocShort = nearPoc && volumes[i] > avgVolume && poc < priorPoc;

            const longSignal = migrationLong || pocLong;
            const shortSignal = migrationShort || pocShort;
            if (longSignal && !shortSignal) {
                return createBuySignal(cleanData, i, "Value area volume composite long");
            }
            if (shortSignal && !longSignal) {
                return createSellSignal(cleanData, i, "Value area volume composite short");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["profile_window"],
    },
};
