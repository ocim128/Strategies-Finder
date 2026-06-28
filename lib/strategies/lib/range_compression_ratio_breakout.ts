import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildCloseAcceptanceSeries, buildRangeSeries } from "./price-action-frequency-core";
import { buildRollingAverage } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 30))),
        compressionMax: Math.max(0.1, Math.min(0.9, Number(params.compressionMax ?? 0.40))),
        expansionMin: Math.max(1.0, Math.min(3.0, Number(params.expansionMin ?? 1.20))),
    };
}

export const range_compression_ratio_breakout: Strategy = {
    name: "Range Compression Ratio Breakout",
    description: "Follows directional breakouts when range ratio spikes from compression to expansion with close acceptance.",
    defaultParams: {
        lookback: 30,
        compressionMax: 0.40,
        expansionMin: 1.20,
    },
    paramLabels: {
        lookback: "Lookback",
        compressionMax: "Max Compression Ratio",
        expansionMin: "Min Expansion Ratio",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 4) return [];

        const ranges = buildRangeSeries(cleanData);
        const avgRange = buildRollingAverage(ranges, lookback);
        const closeAcceptance = buildCloseAcceptanceSeries(cleanData);

        // Compression ratio: current range / rolling average range
        const ratio = ranges.map((r, i) => {
            const avg = avgRange[i];
            if (avg === null || avg <= 0) return null;
            return r / avg;
        });

        return createSignalLoop(cleanData, [ratio], (i) => {
            if (i < 3) return null;
            const curr = ratio[i];
            if (curr === null) return null;
            if (curr < (p.expansionMin as number)) return null;

            // Check if any of the prior 3 bars was in compression
            const compMax = p.compressionMax as number;
            let wasCompressed = false;
            for (let j = 1; j <= 3; j++) {
                const prev = ratio[i - j];
                if (prev !== null && prev < compMax) {
                    wasCompressed = true;
                    break;
                }
            }
            if (!wasCompressed) return null;

            const ca = closeAcceptance[i];
            if (ca > 0) {
                return createBuySignal(cleanData, i, `Range ratio ${curr.toFixed(2)} from compression breakout bullish`);
            }
            if (ca < 0) {
                return createSellSignal(cleanData, i, `Range ratio ${curr.toFixed(2)} from compression breakout bearish`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "compressionMax", "expansionMin"],
    },
};
