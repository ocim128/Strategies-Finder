import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { calculateVolumeProfile } from "../indicators";

const POC_DISPLACEMENT_BINS = 24;
const POC_DISPLACEMENT_LAG = 5;

function normalizePocDisplacementTrendAnchorParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 63))),
    };
}

export const poc_displacement_trend_anchor: Strategy = {
    name: "POC Displacement Trend Anchor",
    description:
        "Aligns the completed close with the rolling point of control and only enters when the POC itself is migrating in that direction.",
    defaultParams: {
        lookback: 63,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizePocDisplacementTrendAnchorParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizePocDisplacementTrendAnchorParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + POC_DISPLACEMENT_LAG + 1) return [];

        const closes = getCloses(cleanData);
        const profile = calculateVolumeProfile(cleanData, lookback, POC_DISPLACEMENT_BINS);

        return createSignalLoop(cleanData, [profile.poc], (i) => {
            if (i < lookback + POC_DISPLACEMENT_LAG) return null;

            const poc = profile.poc[i];
            const laggedPoc = profile.poc[i - POC_DISPLACEMENT_LAG];
            if (poc === null || laggedPoc === null) return null;

            if (closes[i] > poc && poc > laggedPoc) {
                return createBuySignal(cleanData, i, "Close above rising POC anchor");
            }
            if (closes[i] < poc && poc < laggedPoc) {
                return createSellSignal(cleanData, i, "Close below falling POC anchor");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback"],
    },
};
