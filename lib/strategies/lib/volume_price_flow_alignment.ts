import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getVolumes } from "../strategy-helpers";
import { buildRateOfChange, buildRollingCorrelation } from "./price-action-statistics-core";

function normalizeVolumePriceFlowAlignmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 25))),
        correlationMin: Math.max(-1, Math.min(1, Number(params.correlationMin ?? 0.25))),
    };
}

export const volume_price_flow_alignment: Strategy = {
    name: "Volume Price Flow Alignment",
    description: "Volume-price correlation as order flow confirmation.",
    defaultParams: {
        lookback: 25,
        correlationMin: 0.25,
    },
    paramLabels: {
        lookback: "Lookback",
        correlationMin: "Correlation Min",
    },
    normalizeParams: normalizeVolumePriceFlowAlignmentParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeVolumePriceFlowAlignmentParams(params);
        const lookback = p.lookback as number;
        const correlationMin = p.correlationMin as number;
        if (cleanData.length < lookback + 2) return [];

        const closes = getCloses(cleanData);
        const returns = buildRateOfChange(closes, 1);
        const cleanReturns = returns.map(r => r ?? 0);
        const volumes = getVolumes(cleanData);
        const volPriceCorr = buildRollingCorrelation(cleanReturns, volumes, lookback);

        return createSignalLoop(cleanData, [volPriceCorr, returns], (i) => {
            const corr = volPriceCorr[i];
            const ret = returns[i];
            if (corr === null || ret === null) return null;

            if (corr > correlationMin) {
                if (ret > 0) {
                    return createBuySignal(
                        cleanData,
                        i,
                        `Volume confirmed uptrend: correlation ${corr.toFixed(2)}`
                    );
                }
                if (ret < 0) {
                    return createSellSignal(
                        cleanData,
                        i,
                        `Volume confirmed downtrend: correlation ${corr.toFixed(2)}`
                    );
                }
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "correlationMin"],
    },
};
