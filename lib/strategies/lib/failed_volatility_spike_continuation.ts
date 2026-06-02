import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getHighs, getLows, getCloses } from "../strategy-helpers";
import { calculateATR } from "../indicators";
import { buildRollingMedian, buildRollingZScore } from "./price-action-statistics-core";

// #COMPLETION_DRIVE: Assuming counter-trend volatility spike followed by immediate contracting resumption represents an exhaustion block.
// #SUGGEST_VERIFY: Verify ATR Z-score and trend alignment logic do not produce off-by-one future leaks.
function normalizeFailedVolatilitySpikeContinuationParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 40))),
        zThreshold: Math.max(0.1, Number(params.zThreshold ?? 2.0)),
    };
}

export const failed_volatility_spike_continuation: Strategy = {
    name: "Failed Volatility Spike Continuation",
    description: "Enters on the resumption of the primary trend following a failed, counter-trend ATR volatility spike that immediately contracts.",
    defaultParams: {
        lookback: 40,
        zThreshold: 2.0,
    },
    paramLabels: {
        lookback: "Lookback Window",
        zThreshold: "Spike Z-Score Threshold",
    },
    normalizeParams: normalizeFailedVolatilitySpikeContinuationParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeFailedVolatilitySpikeContinuationParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 5) return [];

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);

        const median = buildRollingMedian(closes, lookback);
        const atr = calculateATR(highs, lows, closes, lookback);
        const atrClean = atr.map(v => v ?? 0);
        const atrZ = buildRollingZScore(atrClean, lookback);

        return createSignalLoop(cleanData, [median, atr, atrZ], (i) => {
            if (i < lookback + 2) return null;
            
            const currentClose = closes[i];
            const currentOpen = cleanData[i].open;
            const currentMedian = median[i];
            const currentAtr = atr[i];
            
            const prevClose = closes[i - 1];
            const prevOpen = cleanData[i - 1].open;
            const prevAtr = atr[i - 1];
            const prevAtrZ = atrZ[i - 1];

            if (currentMedian === null || currentAtr === null || prevAtr === null || prevAtrZ === null) return null;

            // Trend check based on current close relative to median
            const isTrendUp = currentClose > currentMedian;
            const isTrendDown = currentClose < currentMedian;

            // Spike check on prior bar i-1 (counter-trend spike)
            const wasSpike = prevAtrZ > p.zThreshold;

            if (isTrendUp) {
                // Bullish: prior bar was a spike down (prevClose < prevOpen), current bar closes up (currentClose > currentOpen) with ATR contracting
                const wasSpikeDown = wasSpike && prevClose < prevOpen;
                const isContractsUp = currentClose > currentOpen && currentAtr < prevAtr;
                if (wasSpikeDown && isContractsUp) {
                    return createBuySignal(cleanData, i, `Resuming Uptrend after Vol Spike (prevZ=${prevAtrZ.toFixed(2)}, ATR=${currentAtr.toFixed(4)})`);
                }
            }

            if (isTrendDown) {
                // Bearish: prior bar was a spike up (prevClose > prevOpen), current bar closes down (currentClose < currentOpen) with ATR contracting
                const wasSpikeUp = wasSpike && prevClose > prevOpen;
                const isContractsDown = currentClose < currentOpen && currentAtr < prevAtr;
                if (wasSpikeUp && isContractsDown) {
                    return createSellSignal(cleanData, i, `Resuming Downtrend after Vol Spike (prevZ=${prevAtrZ.toFixed(2)}, ATR=${currentAtr.toFixed(4)})`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "zThreshold"],
    },
};
