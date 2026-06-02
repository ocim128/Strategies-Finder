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
import { buildCloseLocationSeries, buildRollingAverage } from "./price-action-frequency-core";
import { buildRollingMedian } from "./price-action-statistics-core";

// #COMPLETION_DRIVE: Assuming low close-location dispersion coupled with low ATR isolates institutional quiet accumulation.
// #SUGGEST_VERIFY: Verify minClsLoc threshold aligns symmetrically (e.g. 0.70 high, 0.30 low).
function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 30))),
        minClsLoc: Math.max(0.51, Math.min(0.99, Number(params.minClsLoc ?? 0.7))),
    };
}

export const close_location_distribution_regime: Strategy = {
    name: "Close Location Distribution Regime",
    description: "Captures accumulation/distribution by checking extreme rolling average close location when ATR is low.",
    defaultParams: {
        lookback: 30,
        minClsLoc: 0.7,
    },
    paramLabels: {
        lookback: "Lookback",
        minClsLoc: "Min Close Location",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const minClsLoc = p.minClsLoc as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);

        const closeLocation = buildCloseLocationSeries(cleanData);
        const avgClsLoc = buildRollingAverage(closeLocation, lookback);
        const atr = calculateATR(highs, lows, closes, lookback);

        // Sanitize ATR nulls to 0
        const sanitizedAtr = atr.map(v => v ?? 0);
        const atrMedian = buildRollingMedian(sanitizedAtr, lookback);

        return createSignalLoop(cleanData, [avgClsLoc, atrMedian, atr], (i) => {
            const acl = avgClsLoc[i];
            const am = atrMedian[i];
            const currentAtr = atr[i];

            if (acl === null || am === null || currentAtr === null) return null;

            // Gate: Volatility must be below its rolling median
            if (currentAtr < am) {
                // Buy: Rolling average close location is extreme high (quiet buying/accumulation)
                if (acl > minClsLoc) {
                    return createBuySignal(
                        cleanData,
                        i,
                        `Bullish quiet accumulation: average close location (${acl.toFixed(2)} > ${minClsLoc}) with low ATR (${currentAtr.toFixed(4)} < ${am.toFixed(4)})`
                    );
                }
                // Sell: Rolling average close location is extreme low (quiet selling/distribution)
                if (acl < 1.0 - minClsLoc) {
                    return createSellSignal(
                        cleanData,
                        i,
                        `Bearish quiet distribution: average close location (${acl.toFixed(2)} < ${(1.0 - minClsLoc).toFixed(2)}) with low ATR (${currentAtr.toFixed(4)} < ${am.toFixed(4)})`
                    );
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "minClsLoc"],
    },
};
