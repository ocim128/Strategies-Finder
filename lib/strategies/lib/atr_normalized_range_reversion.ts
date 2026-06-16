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
import { buildRangeSeries, buildCloseLocationSeries, extractBarMetricSeries } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 25))),
        shockPercentile: Math.max(0.5, Math.min(0.999, Number(params.shockPercentile ?? 0.93))),
    };
}

export const atr_normalized_range_reversion: Strategy = {
    name: "ATR Normalized Range Reversion",
    description: "Fades extreme shocks of range / ATR ratio using close location signatures.",
    defaultParams: {
        lookback: 25,
        shockPercentile: 0.93,
    },
    paramLabels: {
        lookback: "Lookback Window",
        shockPercentile: "Shock Percentile Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);

        const atr = calculateATR(highs, lows, closes, lookback);
        const ranges = buildRangeSeries(cleanData);

        const ratio = new Array<number>(cleanData.length).fill(0);
        for (let i = 0; i < cleanData.length; i++) {
            const a = atr[i];
            ratio[i] = a !== null && a > 0 ? ranges[i] / a : 0;
        }

        const ratioPct = buildPercentileRank(ratio, lookback);
        const closeLoc = buildCloseLocationSeries(cleanData);
        const closeReturn = extractBarMetricSeries(cleanData, "closeReturn");

        return createSignalLoop(cleanData, [ratioPct, atr], (i) => {
            const rp = ratioPct[i];
            const a = atr[i];
            if (rp === null || a === null) return null;

            const cr = closeReturn[i];
            const cl = closeLoc[i];

            // Buy: shockPercentile exceeded, close return negative, closeLocation > 0.5 (bottom recovery hammer)
            if (rp > p.shockPercentile && cr < 0 && cl > 0.5) {
                return createBuySignal(cleanData, i, `ATR normalized range shock buy: Ratio Pct ${rp.toFixed(2)}, CL ${cl.toFixed(2)}`);
            }
            // Sell: shockPercentile exceeded, close return positive, closeLocation < 0.5 (top rejection shooting star)
            if (rp > p.shockPercentile && cr > 0 && cl < 0.5) {
                return createSellSignal(cleanData, i, `ATR normalized range shock sell: Ratio Pct ${rp.toFixed(2)}, CL ${cl.toFixed(2)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "shockPercentile"],
    },
};
