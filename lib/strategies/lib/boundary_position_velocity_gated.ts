import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildTrailingHighLow } from "./price-action-frequency-core";
import { buildRateOfChange, buildPercentileRank } from "./price-action-statistics-core";

// #COMPLETION_DRIVE: Assuming high-velocity boundary breakouts isolate true structural shifts.
// #SUGGEST_VERIFY: Verify velocityPercentile (0.5 to 0.99) successfully identifies momentum spikes.
function normalizeParams(params: StrategyParams): StrategyParams {
    const rawPercentile = Number(params.velocityPercentile ?? 85);
    const normalizedPercentile = rawPercentile > 1 ? rawPercentile / 100 : rawPercentile;
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 30))),
        velocityPercentile: Math.max(0.5, Math.min(0.99, normalizedPercentile)),
    };
}

export const boundary_position_velocity_gated: Strategy = {
    name: "Boundary Position Velocity Gated",
    description: "Signals breakouts when price breaks trailing boundaries at high normalized return velocity.",
    defaultParams: {
        lookback: 30,
        velocityPercentile: 0.85,
    },
    paramLabels: {
        lookback: "Lookback",
        velocityPercentile: "Velocity Percentile",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const velocityPercentile = p.velocityPercentile as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        // IncludeCurrent = false to avoid look-ahead bias on trailing high/low
        const { highest, lowest } = buildTrailingHighLow(cleanData, lookback, false);
        const roc = buildRateOfChange(closes, 1);

        // Sanitize ROC nulls to 0
        const sanitizedRoc = roc.map(v => v ?? 0);
        const rocPercentiles = buildPercentileRank(sanitizedRoc, lookback);

        return createSignalLoop(cleanData, [highest, lowest, rocPercentiles], (i) => {
            const currentClose = closes[i];
            const currentHigh = highest[i];
            const currentLow = lowest[i];
            const rp = rocPercentiles[i];

            if (currentHigh === null || currentLow === null || rp === null) return null;

            const range = currentHigh - currentLow;
            if (range <= 0) return null;

            // Buy: Close is within 5% of trailing high, and rate of change percentile is extreme high
            const nearHigh = currentClose >= currentHigh - 0.05 * range;
            if (nearHigh && rp > velocityPercentile) {
                return createBuySignal(
                    cleanData,
                    i,
                    `Bullish velocity breakout: close ${currentClose.toFixed(2)} near high ${currentHigh.toFixed(2)} with ROC percentile ${(rp * 100).toFixed(0)}%`
                );
            }

            // Sell: Close is within 5% of trailing low, and rate of change percentile is extreme low (downward velocity)
            const nearLow = currentClose <= currentLow + 0.05 * range;
            if (nearLow && rp < 1.0 - velocityPercentile) {
                return createSellSignal(
                    cleanData,
                    i,
                    `Bearish velocity breakout: close ${currentClose.toFixed(2)} near low ${currentLow.toFixed(2)} with ROC percentile ${(rp * 100).toFixed(0)}%`
                );
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "velocityPercentile"],
    },
};
