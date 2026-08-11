import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildRollingAverage } from "./price-action-frequency-core";
import {
    buildRollingZScore,
    extractBarMetricSeries,
} from "./price-action-statistics-core";

const Z_FADE_DEPTH = 2;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(10, Math.round(Number(params.lookback ?? 20))),
    };
}

export const cumulative_gap_reversion: Strategy = {
    name: "Cumulative Gap Reversion",
    description: "Fades accumulated boundary-only repricing when the rolling sum of bar-open gap percentages reaches extreme z-scores.",
    defaultParams: {
        lookback: 20,
    },
    paramLabels: {
        lookback: "Lookback Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback * 2) return [];

        const gapPct = extractBarMetricSeries(cleanData, "gapPct");
        // Rolling sum of per-bar gaps: average over the window times its length.
        const avgGap = buildRollingAverage(gapPct, lookback);
        const gapSum = avgGap.map((v) => (v === null ? 0 : v * lookback));
        const sumZ = buildRollingZScore(gapSum, lookback);
        // The rolling sum needs lookback bars and its z-score another lookback.
        const firstValid = lookback * 2 - 2;

        return createSignalLoop(cleanData, [sumZ], (i) => {
            if (i < firstValid) return null;
            const z = sumZ[i];
            if (z === null) return null;

            if (z <= -Z_FADE_DEPTH) {
                return createBuySignal(cleanData, i, `Cumulative gap reversion buy: boundary sum z ${z.toFixed(2)}`);
            }
            if (z >= Z_FADE_DEPTH) {
                return createSellSignal(cleanData, i, `Cumulative gap reversion sell: boundary sum z ${z.toFixed(2)}`);
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
