import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
} from "../strategy-helpers";
import { calculateVWAP } from "../indicators";
import { buildPercentileRank } from "./price-action-statistics-core";
import { buildCloseLocationSeries, extractBarMetricSeries } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
        minRangePercentile: Number(params.minRangePercentile ?? 0.8),
    };
}

export const failed_vwap_breakout_reversion: Strategy = {
    name: "Failed VWAP Breakout Reversion",
    description: "Trades failed breakout attempts away from the VWAP center, utilizing close location gradient to confirm reversion entries.",
    defaultParams: {
        lookback: 30,
        minRangePercentile: 0.8,
    },
    paramLabels: {
        lookback: "Lookback Window",
        minRangePercentile: "Min Range Percentile",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const volumes = cleanData.map((d) => d.volume);

        const vwap = calculateVWAP(highs, lows, closes, volumes, lookback);
        const trueRange = extractBarMetricSeries(cleanData, "trueRange");
        const trPct = buildPercentileRank(trueRange, lookback);
        const closeLoc = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [vwap, trPct, closeLoc], (i) => {
            if (i < lookback || i < 1) return null;
            const currentVwap = vwap[i];
            const currentPct = trPct[i];
            if (currentVwap === null || currentPct === null) return null;

            const close = closes[i];
            const currGrad = closeLoc[i] - closeLoc[i - 1];

            const minPct = p.minRangePercentile as number;

            // Buy: price is below VWAP, true range percentile is high, and close location gradient reverses up
            if (close < currentVwap && currentPct > minPct && currGrad > 0) {
                return createBuySignal(cleanData, i, `Failed Breakout Reversion Buy: Close ${close.toFixed(4)}, VWAP ${currentVwap.toFixed(4)}, RangePct ${currentPct.toFixed(2)}`);
            }
            // Sell: price is above VWAP, true range percentile is high, and close location gradient reverses down
            if (close > currentVwap && currentPct > minPct && currGrad < 0) {
                return createSellSignal(cleanData, i, `Failed Breakout Reversion Sell: Close ${close.toFixed(4)}, VWAP ${currentVwap.toFixed(4)}, RangePct ${currentPct.toFixed(2)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "minRangePercentile"],
    },
};
