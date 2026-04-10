import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getVolumes } from "../strategy-helpers";
import { buildRollingAverage } from "./price-action-frequency-core";

function normalizeVolumeExhaustionDecayParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        fast_vol_window: Math.max(1, Math.round(params.fast_vol_window ?? 3)),
        slow_vol_window: Math.max(2, Math.round(params.slow_vol_window ?? 20)),
        decay_ratio_threshold: Math.max(0, Number(params.decay_ratio_threshold ?? 0.5))
    };
}

export const volume_exhaustion_decay: Strategy = {
    name: "Volume Exhaustion Decay",
    description: "By comparing a fast rolling volume sum to a slow sum, we can mathematically pinpoint the exact bar where a frenzied buying/selling surge completely runs out of participants.",
    defaultParams: {
        fast_vol_window: 3,
        slow_vol_window: 20,
        decay_ratio_threshold: 0.5
    },
    paramLabels: {
        fast_vol_window: "Fast Volume Window",
        slow_vol_window: "Slow Volume Window",
        decay_ratio_threshold: "Decay Ratio Threshold"
    },
    normalizeParams: normalizeVolumeExhaustionDecayParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeVolumeExhaustionDecayParams(params);
        const slowW = p.slow_vol_window as number;
        if (cleanData.length < slowW * 2) return [];

        const vols = getVolumes(cleanData);
        const fastVol = buildRollingAverage(vols, p.fast_vol_window as number);
        const slowVol = buildRollingAverage(vols, slowW);
        
        const ratioArray = new Array(cleanData.length).fill(null);
        for(let i=0; i<cleanData.length; i++) {
            if(fastVol[i] !== null && slowVol[i] !== null && slowVol[i]! > 0) {
                ratioArray[i] = fastVol[i]! / slowVol[i]!;
            }
        }

        return createSignalLoop(cleanData, [ratioArray], (i) => {
            if (i < slowW) return null;
            const ratio = ratioArray[i];
            if (ratio === null) return null;

            const thresh = p.decay_ratio_threshold as number;
            const currentClose = cleanData[i].close;
            const currentOpen = cleanData[i].open;
            const prevClose = cleanData[i - 1].close;
            const prevOpen = cleanData[i - 1].open;

            const isDownCandle = currentClose < currentOpen;
            const isUpCandle = currentClose > currentOpen;
            const prevWasDeeplyDown = prevClose < prevOpen && (prevOpen - prevClose) > (cleanData[i - 1].high - cleanData[i - 1].low) * 0.5;
            const prevWasDeeplyUp = prevClose > prevOpen && (prevClose - prevOpen) > (cleanData[i - 1].high - cleanData[i - 1].low) * 0.5;

            if (ratio < thresh && isUpCandle && prevWasDeeplyDown) {
                return createBuySignal(cleanData, i, `Volume decay ratio < ${thresh} after deeply down bar`);
            }
            if (ratio < thresh && isDownCandle && prevWasDeeplyUp) {
                return createSellSignal(cleanData, i, `Volume decay ratio < ${thresh} after deeply up bar`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["fast_vol_window", "slow_vol_window", "decay_ratio_threshold"]
    }
};
