import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRateOfChange, buildRollingZScore } from "./price-action-statistics-core";

function normalizeVelocityReversalShockParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        roc_lookback: Math.max(1, Math.round(params.roc_lookback ?? 5)),
        z_lookback: Math.max(3, Math.round(params.z_lookback ?? 30)),
        roc_z_extreme: Math.max(0, Number(params.roc_z_extreme ?? 2.5))
    };
}

export const velocity_reversal_shock: Strategy = {
    name: "Velocity Reversal Shock",
    description: "Retail buys short-dated options at peak price velocity. A sudden 5m flip from an extreme momentum Z-score to the opposite direction instantly triggers stop-losses.",
    defaultParams: {
        roc_lookback: 5,
        z_lookback: 30,
        roc_z_extreme: 2.5
    },
    paramLabels: {
        roc_lookback: "ROC Lookback",
        z_lookback: "Z-Score Lookback",
        roc_z_extreme: "ROC Z Extreme"
    },
    normalizeParams: normalizeVelocityReversalShockParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeVelocityReversalShockParams(params);
        const rocLookback = p.roc_lookback as number;
        const zLookback = p.z_lookback as number;
        
        if (cleanData.length < Math.max(rocLookback, zLookback) * 2) return [];

        const closes = getCloses(cleanData);
        const roc = buildRateOfChange(closes, rocLookback).map(v => v ?? 0);
        const rocZScore = buildRollingZScore(roc, zLookback);

        return createSignalLoop(cleanData, [rocZScore], (i) => {
            if (i < 1 || rocZScore[i] === null || rocZScore[i-1] === null) return null;
            
            const curr = cleanData[i];
            const currZ = rocZScore[i]!;
            const prevZ = rocZScore[i-1]!;
            const extreme = p.roc_z_extreme as number;

            if (prevZ < -extreme && currZ > 0 && curr.close > curr.open) {
                return createBuySignal(cleanData, i, `Reversal Shock: Prev Z ${prevZ.toFixed(2)} -> Curr Z ${currZ.toFixed(2)}`);
            }
            if (prevZ > extreme && currZ < 0 && curr.close < curr.open) {
                return createSellSignal(cleanData, i, `Reversal Shock: Prev Z ${prevZ.toFixed(2)} -> Curr Z ${currZ.toFixed(2)}`);
            }
            
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["roc_lookback", "z_lookback", "roc_z_extreme"]
    }
};





