import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getVolumes,
} from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

function normalizeParticipationSurgeAfterQuietParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
    };
}

export const participation_surge_after_quiet: Strategy = {
    name: "Participation Surge After Quiet",
    description: "Follows the directional bar that takes proxy volume from a quiet percentile straight to an active percentile.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeParticipationSurgeAfterQuietParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParticipationSurgeAfterQuietParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const volumes = getVolumes(cleanData);
        const volPct = buildPercentileRank(volumes, lookback);
        const bodyDirection = extractBarMetricSeries(cleanData, "bodyDirection");

        return createSignalLoop(cleanData, [volPct], (i) => {
            if (i < lookback || i < 1) return null;
            const currPct = volPct[i];
            const prevPct = volPct[i - 1];
            if (currPct === null || prevPct === null) return null;

            if (currPct > 0.6 && prevPct < 0.3 && bodyDirection[i] > 0) {
                return createBuySignal(cleanData, i, `Volume percentile jumps ${prevPct.toFixed(2)} to ${currPct.toFixed(2)} on an up bar`);
            }
            if (currPct > 0.6 && prevPct < 0.3 && bodyDirection[i] < 0) {
                return createSellSignal(cleanData, i, `Volume percentile jumps ${prevPct.toFixed(2)} to ${currPct.toFixed(2)} on a down bar`);
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
