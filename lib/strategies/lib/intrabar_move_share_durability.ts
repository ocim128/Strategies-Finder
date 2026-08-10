import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

function normalizeIntrabarMoveShareDurabilityParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
    };
}

export const intrabar_move_share_durability: Strategy = {
    name: "Intrabar Move Share Durability",
    description: "Follows bars whose move was made by the body rather than the open gap, on the thesis that body-made moves persist.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeIntrabarMoveShareDurabilityParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeIntrabarMoveShareDurabilityParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const bodyPct = extractBarMetricSeries(cleanData, "bodyPct");
        const gapPct = extractBarMetricSeries(cleanData, "gapPct");
        const bodyDirection = extractBarMetricSeries(cleanData, "bodyDirection");
        const absGap = gapPct.map((v) => Math.abs(v));
        const bodyRank = buildPercentileRank(bodyPct, lookback);
        const gapRank = buildPercentileRank(absGap, lookback);

        return createSignalLoop(cleanData, [bodyRank, gapRank], (i) => {
            if (i < lookback) return null;
            const bRank = bodyRank[i];
            const gRank = gapRank[i];
            if (bRank === null || gRank === null) return null;

            if (bRank > 0.7 && gRank < 0.5 && bodyDirection[i] > 0) {
                return createBuySignal(cleanData, i, `Body-made move: body percentile ${bRank.toFixed(2)} with gap percentile ${gRank.toFixed(2)}`);
            }
            if (bRank > 0.7 && gRank < 0.5 && bodyDirection[i] < 0) {
                return createSellSignal(cleanData, i, `Body-made move: body percentile ${bRank.toFixed(2)} with gap percentile ${gRank.toFixed(2)}`);
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
