import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-frequency-core";
import { buildRollingRobustZScore } from "./price-action-statistics-core";

const BAND_INNER = 1.5;
const BAND_OUTER = 3.0;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(10, Math.round(Number(params.lookback ?? 20))),
    };
}

export const banded_robust_single_bar_fade: Strategy = {
    name: "Banded Robust Single-Bar Fade",
    description: "Fades moderate single-bar overreactions under a robust median/MAD z-score, skipping the extreme tails.",
    defaultParams: {
        lookback: 20,
    },
    paramLabels: {
        lookback: "Robust Z Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const returns = extractBarMetricSeries(cleanData, "closeReturn");
        const z = buildRollingRobustZScore(returns, lookback);

        return createSignalLoop(cleanData, [z], (i) => {
            const score = z[i];
            if (score === null) return null;

            // Fire only inside the middle band; scores beyond the outer level are
            // treated as genuine breakouts and skipped rather than faded.
            if (score <= -BAND_INNER && score >= -BAND_OUTER) {
                return createBuySignal(cleanData, i, `Banded fade buy: return z ${score.toFixed(2)} inside the ${BAND_INNER}-${BAND_OUTER} band`);
            }
            if (score >= BAND_INNER && score <= BAND_OUTER) {
                return createSellSignal(cleanData, i, `Banded fade sell: return z ${score.toFixed(2)} inside the ${BAND_INNER}-${BAND_OUTER} band`);
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
