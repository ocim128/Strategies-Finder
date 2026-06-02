import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildTrailingHighLow, buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildRollingEntropy, extractBarMetricSeries } from "./price-action-statistics-core";

// #COMPLETION_DRIVE: Assuming low return entropy isolates clear, coordinated boundary breakouts.
// #SUGGEST_VERIFY: Verify entropyThreshold (<= 1.5) restricts breakouts to low-noise windows.
function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 50))),
        entropyThreshold: Math.max(0.1, Number(params.entropyThreshold ?? 0.4)),
    };
}

export const entropy_gated_boundary_acceptance: Strategy = {
    name: "Entropy Gated Boundary Acceptance",
    description: "Signals boundary breakouts when rolling return entropy is low, signifying coordinated institutional breakout.",
    defaultParams: {
        lookback: 50,
        entropyThreshold: 0.4,
    },
    paramLabels: {
        lookback: "Lookback",
        entropyThreshold: "Entropy Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const entropyThreshold = p.entropyThreshold as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        // IncludeCurrent = false to avoid look-ahead bias on trailing high/low
        const { highest, lowest } = buildTrailingHighLow(cleanData, lookback, false);
        const returns = extractBarMetricSeries(cleanData, "closeReturn");
        const entropy = buildRollingEntropy(returns, lookback);
        const acceptance = buildCloseAcceptanceSeries(cleanData);

        return createSignalLoop(cleanData, [highest, lowest, entropy, acceptance], (i) => {
            const currentClose = closes[i];
            const currentHigh = highest[i];
            const currentLow = lowest[i];
            const ent = entropy[i];
            const accept = acceptance[i];

            if (currentHigh === null || currentLow === null || ent === null) return null;

            // Buy: Close breaks above trailing high, low entropy, and close acceptance is positive
            if (currentClose > currentHigh && ent < entropyThreshold && accept > 0) {
                return createBuySignal(
                    cleanData,
                    i,
                    `Bullish breakout: close ${currentClose.toFixed(2)} > trailing high ${currentHigh.toFixed(2)} with low entropy (${ent.toFixed(3)} < ${entropyThreshold})`
                );
            }

            // Sell: Close breaks below trailing low, low entropy, and close acceptance is negative
            if (currentClose < currentLow && ent < entropyThreshold && accept < 0) {
                return createSellSignal(
                    cleanData,
                    i,
                    `Bearish breakout: close ${currentClose.toFixed(2)} < trailing low ${currentLow.toFixed(2)} with low entropy (${ent.toFixed(3)} < ${entropyThreshold})`
                );
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "entropyThreshold"],
    },
};
