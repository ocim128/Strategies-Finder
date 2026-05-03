import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildCloseLocationSeries, buildTrailingHighLow } from "./price-action-frequency-core";
import { buildRollingZScore } from "./price-action-statistics-core";

function normalizeRollingZscoreBoundaryReversionParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        zscore_threshold: Math.max(0, Number(params.zscore_threshold ?? 2)),
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 63))),
    };
}

export const rolling_zscore_boundary_reversion: Strategy = {
    name: "Rolling Zscore Boundary Reversion",
    description:
        "Fades large rolling close z-score deviations only when price is also stretched to the edge of its trailing daily range.",
    defaultParams: {
        zscore_threshold: 2,
        lookback: 63,
    },
    paramLabels: {
        zscore_threshold: "Z-Score Threshold",
        lookback: "Lookback",
    },
    normalizeParams: normalizeRollingZscoreBoundaryReversionParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeRollingZscoreBoundaryReversionParams(params);
        const threshold = p.zscore_threshold as number;
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const zScore = buildRollingZScore(closes, lookback);
        const closeLocation = buildCloseLocationSeries(cleanData);
        const { highest, lowest } = buildTrailingHighLow(cleanData, lookback);

        return createSignalLoop(cleanData, [zScore, highest, lowest], (i) => {
            const z = zScore[i];
            const hi = highest[i];
            const lo = lowest[i];
            if (z === null || hi === null || lo === null) return null;

            const range = hi - lo;
            if (range <= 0) return null;
            const position = (closes[i] - lo) / range;

            if (z <= -threshold && position <= 0.2 && closeLocation[i] <= 0.35) {
                return createBuySignal(cleanData, i, `Lower boundary z-score reversion z=${z.toFixed(2)}`);
            }
            if (z >= threshold && position >= 0.8 && closeLocation[i] >= 0.65) {
                return createSellSignal(cleanData, i, `Upper boundary z-score reversion z=${z.toFixed(2)}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["zscore_threshold", "lookback"],
    },
};
