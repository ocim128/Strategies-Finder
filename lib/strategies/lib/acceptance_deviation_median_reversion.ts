import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import {
    buildCloseAcceptanceSeries,
    buildRollingAverage,
} from "./price-action-frequency-core";
import { buildRollingZScore } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
        acceptanceThreshold: Math.max(0.5, Math.min(1.0, Number(params.acceptanceThreshold ?? 0.70))),
    };
}

export const acceptance_deviation_median_reversion: Strategy = {
    name: "Acceptance Deviation Median Reversion",
    description: "Fades deviations from the rolling median when close acceptance is heavily aligned against the deviation direction.",
    defaultParams: {
        lookback: 30,
        acceptanceThreshold: 0.70,
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

        const closes = getCloses(cleanData);
        const closeZ = buildRollingZScore(closes, lookback);

        const acceptance = buildCloseAcceptanceSeries(cleanData);
        // Map close acceptance from [-1, 1] range to [0, 1] range
        const mapped = acceptance.map((v) => (v + 1) / 2);
        const smoothedAcceptance = buildRollingAverage(mapped, lookback);

        return createSignalLoop(cleanData, [closeZ, smoothedAcceptance], (i) => {
            const z = closeZ[i];
            const acc = smoothedAcceptance[i];
            if (z === null || acc === null) return null;

            // Buy: close price is below median, and average close acceptance is high -> long reversion
            if (z < -1.5 && acc > p.acceptanceThreshold) {
                return createBuySignal(cleanData, i, `Acceptance dev buy: Z ${z.toFixed(2)}, acceptance ${acc.toFixed(2)}`);
            }
            // Sell: close price is above median, and average close acceptance is low -> short reversion
            if (z > 1.5 && acc < (1 - p.acceptanceThreshold)) {
                return createSellSignal(cleanData, i, `Acceptance dev sell: Z ${z.toFixed(2)}, acceptance ${acc.toFixed(2)}`);
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
