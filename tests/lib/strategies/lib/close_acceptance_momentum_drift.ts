import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getVolumes,
} from "../strategy-helpers";
import {
    buildCloseAcceptanceSeries,
    buildRollingAverage,
} from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
        acceptanceThreshold: Math.max(0.5, Math.min(1.0, Number(params.acceptanceThreshold ?? 0.65))),
    };
}

export const close_acceptance_momentum_drift: Strategy = {
    name: "Close Acceptance Momentum Drift",
    description: "Enters trend following persistent close acceptance pressure confirmed by volume.",
    defaultParams: {
        lookback: 30,
        acceptanceThreshold: 0.65,
    },
    paramLabels: {
        lookback: "Lookback Window",
        acceptanceThreshold: "Acceptance Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const volumes = getVolumes(cleanData);
        const volPercentile = buildPercentileRank(volumes, lookback);

        const acceptance = buildCloseAcceptanceSeries(cleanData);
        // Map acceptance from [-1, 1] to [0, 1] range to match user threshold expectations
        const mappedAcceptance = acceptance.map((v) => (v + 1) / 2);
        const smoothedAcceptance = buildRollingAverage(mappedAcceptance, lookback);

        return createSignalLoop(cleanData, [smoothedAcceptance, volPercentile], (i) => {
            const smoothed = smoothedAcceptance[i];
            const vp = volPercentile[i];
            if (smoothed === null || vp === null) return null;

            if (vp > 0.5) {
                if (smoothed > p.acceptanceThreshold) {
                    return createBuySignal(cleanData, i, `Close acceptance drift buy: smoothed acceptance ${smoothed.toFixed(2)} with vol rank ${vp.toFixed(2)}`);
                }
                if (smoothed < (1 - p.acceptanceThreshold)) {
                    return createSellSignal(cleanData, i, `Close acceptance drift sell: smoothed acceptance ${smoothed.toFixed(2)} with vol rank ${vp.toFixed(2)}`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "acceptanceThreshold"],
    },
};
