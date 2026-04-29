import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { calculateVolumeProfile } from "../indicators";

const ROLLING_POC_DISPLACEMENT_BINS = 20;

function normalizeRollingPocDisplacementAlignmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        poc_lookback: Math.max(5, Math.round(Number(params.poc_lookback ?? 63))),
        migration_lookback: Math.max(1, Math.round(Number(params.migration_lookback ?? 20))),
    };
}

export const rolling_poc_displacement_alignment: Strategy = {
    name: "Rolling POC Displacement Alignment",
    description:
        "Uses migration of the rolling volume-profile point of control as a value-anchor trend filter and aligns entries with both price and POC direction.",
    defaultParams: {
        poc_lookback: 63,
        migration_lookback: 20,
    },
    paramLabels: {
        poc_lookback: "POC Lookback",
        migration_lookback: "Migration Lookback",
    },
    normalizeParams: normalizeRollingPocDisplacementAlignmentParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeRollingPocDisplacementAlignmentParams(params);
        const pocLookback = p.poc_lookback as number;
        const migrationLookback = p.migration_lookback as number;
        if (cleanData.length < pocLookback + migrationLookback) return [];

        const profile = calculateVolumeProfile(cleanData, pocLookback, ROLLING_POC_DISPLACEMENT_BINS);

        return createSignalLoop(cleanData, [profile.poc], (i) => {
            const currentPoc = profile.poc[i];
            const priorPoc = profile.poc[i - migrationLookback];
            if (currentPoc === null || priorPoc === null) return null;

            const close = cleanData[i].close;
            if (close > currentPoc && currentPoc > priorPoc) {
                return createBuySignal(cleanData, i, "Close above rising rolling POC");
            }
            if (close < currentPoc && currentPoc < priorPoc) {
                return createSellSignal(cleanData, i, "Close below falling rolling POC");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["poc_lookback", "migration_lookback"],
    },
};
