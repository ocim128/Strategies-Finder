import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRollingAverage } from "./price-action-frequency-core";
import { buildRollingMedian, buildRollingStdDev } from "./price-action-statistics-core";

function normalizeStddevGatedMedianAlignmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 63))),
        compression_threshold: Math.max(0, Number(params.compression_threshold ?? 1)),
    };
}

export const stddev_gated_median_alignment: Strategy = {
    name: "StdDev Gated Median Alignment",
    description:
        "Uses relative compression in rolling close standard deviation to gate a simple trailing median alignment, only entering when volatility is quieter than its own baseline.",
    defaultParams: {
        lookback: 63,
        compression_threshold: 1,
    },
    paramLabels: {
        lookback: "Lookback",
        compression_threshold: "Compression Threshold",
    },
    normalizeParams: normalizeStddevGatedMedianAlignmentParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeStddevGatedMedianAlignmentParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const median = buildRollingMedian(closes, lookback);
        const stddev = buildRollingStdDev(closes, lookback);
        const stddevBaseline = buildRollingAverage(stddev.map((value) => value ?? 0), lookback);

        return createSignalLoop(cleanData, [median, stddev, stddevBaseline], (i) => {
            if (i < lookback - 1) return null;

            const med = median[i];
            const sd = stddev[i];
            const baseline = stddevBaseline[i];
            if (med === null || sd === null || baseline === null || sd >= baseline * (p.compression_threshold as number)) {
                return null;
            }

            if (closes[i] > med) {
                return createBuySignal(cleanData, i, `Compressed stddev ${sd.toFixed(4)} with close above median`);
            }
            if (closes[i] < med) {
                return createSellSignal(cleanData, i, `Compressed stddev ${sd.toFixed(4)} with close below median`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "compression_threshold"],
    },
};
