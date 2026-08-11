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
import { calculateATR } from "../indicators";

const TREND_BAND = 2;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(10, Math.round(Number(params.lookback ?? 45))),
    };
}

export const vol_scaled_momentum: Strategy = {
    name: "Vol Scaled Momentum",
    description: "Trades time-series momentum scaled by its own volatility, entering when the lookback move crosses two ATRs.",
    defaultParams: {
        lookback: 45,
    },
    paramLabels: {
        lookback: "Momentum Horizon",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const atr = calculateATR(getHighs(cleanData), getLows(cleanData), closes, lookback);

        // Momentum in ATR price units: (close[i] - close[i-lookback]) / atr[i].
        // Computing the raw price difference keeps the numerator in price units.
        const scaledMove = (i: number): number | null => {
            const atrNow = atr[i];
            if (atrNow === null || atrNow <= 0) return null;
            return (closes[i] - closes[i - lookback]) / atrNow;
        };

        return createSignalLoop(cleanData, [atr], (i) => {
            // Both the crossing bar and its predecessor must be measurable.
            if (i < lookback + 1) return null;
            const prev = scaledMove(i - 1);
            const curr = scaledMove(i);
            if (prev === null || curr === null) return null;

            if (prev < TREND_BAND && curr >= TREND_BAND) {
                return createBuySignal(cleanData, i, `Vol-scaled momentum buy: ${curr.toFixed(2)} ATR move crossed above band`);
            }
            if (prev > -TREND_BAND && curr <= -TREND_BAND) {
                return createSellSignal(cleanData, i, `Vol-scaled momentum sell: ${curr.toFixed(2)} ATR move crossed below band`);
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
