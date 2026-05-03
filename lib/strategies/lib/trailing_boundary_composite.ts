import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildCloseLocationSeries, buildRangeSeries, buildTrailingHighLow } from "./price-action-frequency-core";
import { buildRollingStdDev } from "./price-action-statistics-core";

function normalizeTrailingBoundaryCompositeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        boundary_lookback: Math.max(2, Math.round(Number(params.boundary_lookback ?? 126))),
        extreme_threshold: Math.max(0.5, Math.min(0.99, Number(params.extreme_threshold ?? 0.85))),
    };
}

export const trailing_boundary_composite: Strategy = {
    name: "Trailing Boundary Composite",
    description:
        "Combines trailing range-position acceptance and expanding boundary momentum into independent completed-bar boundary signals.",
    defaultParams: {
        boundary_lookback: 126,
        extreme_threshold: 0.85,
    },
    paramLabels: {
        boundary_lookback: "Boundary Lookback",
        extreme_threshold: "Extreme Threshold",
    },
    normalizeParams: normalizeTrailingBoundaryCompositeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeTrailingBoundaryCompositeParams(params);
        const lookback = p.boundary_lookback as number;
        const threshold = p.extreme_threshold as number;
        if (cleanData.length < lookback + 2) return [];

        const closes = getCloses(cleanData);
        const { highest, lowest } = buildTrailingHighLow(cleanData, lookback);
        const closeLocation = buildCloseLocationSeries(cleanData);
        const rangeStdDev = buildRollingStdDev(buildRangeSeries(cleanData), lookback);

        return createSignalLoop(cleanData, [highest, lowest, rangeStdDev], (i) => {
            const hi = highest[i];
            const lo = lowest[i];
            const currentStdDev = rangeStdDev[i];
            const previousStdDev = rangeStdDev[i - 1];
            if (hi === null || lo === null || currentStdDev === null || previousStdDev === null) return null;

            const range = hi - lo;
            if (range <= 0) return null;
            const position = (closes[i] - lo) / range;
            const expandingRange = currentStdDev > previousStdDev;

            const longBranch =
                (position >= threshold && closeLocation[i] >= 0.65) ||
                (closeLocation[i] >= threshold && expandingRange);
            const shortBranch =
                (position <= 1 - threshold && closeLocation[i] <= 0.35) ||
                (closeLocation[i] <= 1 - threshold && expandingRange);

            if (longBranch && !shortBranch) {
                return createBuySignal(cleanData, i, `Upper boundary composite at ${(position * 100).toFixed(0)}%`);
            }
            if (shortBranch && !longBranch) {
                return createSellSignal(cleanData, i, `Lower boundary composite at ${(position * 100).toFixed(0)}%`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["boundary_lookback", "extreme_threshold"],
    },
};
