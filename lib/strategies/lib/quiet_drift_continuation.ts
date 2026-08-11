import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRangeSeries } from "./price-action-frequency-core";
import { buildEfficiencyRatio, buildPercentileRank } from "./price-action-statistics-core";

const EFFICIENCY_MIN = 0.5;
const RANGE_RANK_MAX = 0.4;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(10, Math.round(Number(params.lookback ?? 30))),
    };
}

export const quiet_drift_continuation: Strategy = {
    name: "Quiet Drift Continuation",
    description: "Rides high-efficiency, low-range directional grinds, entering only when the joint state first becomes true.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Drift Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const efficiency = buildEfficiencyRatio(cleanData, lookback);
        const rangeRank = buildPercentileRank(buildRangeSeries(cleanData), lookback);

        // Joint state; a null reading (warm-up) counts as not-yet-active so the
        // first certified bar still registers as a state entry.
        const state = (j: number): { up: boolean; down: boolean } => {
            const eff = efficiency[j];
            const rank = rangeRank[j];
            if (eff === null || rank === null) return { up: false, down: false };
            const quiet = eff >= EFFICIENCY_MIN && rank <= RANGE_RANK_MAX;
            return {
                up: quiet && closes[j] > closes[j - lookback],
                down: quiet && closes[j] < closes[j - lookback],
            };
        };

        return createSignalLoop(cleanData, [], (i) => {
            if (i < lookback) return null;
            const now = state(i);
            const prev = state(i - 1);

            if (now.up && !prev.up) {
                return createBuySignal(cleanData, i, `Quiet drift buy: efficiency ${efficiency[i]!.toFixed(2)}, range rank ${rangeRank[i]!.toFixed(2)}`);
            }
            if (now.down && !prev.down) {
                return createSellSignal(cleanData, i, `Quiet drift sell: efficiency ${efficiency[i]!.toFixed(2)}, range rank ${rangeRank[i]!.toFixed(2)}`);
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
