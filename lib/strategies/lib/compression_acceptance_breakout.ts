import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildRateOfChange, buildRollingStdDev, buildPercentileRank } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 25))),
        volPercentileMax: Math.max(0.1, Math.min(0.9, Number(params.volPercentileMax ?? 0.30))),
    };
}

export const compression_acceptance_breakout: Strategy = {
    name: "Compression Acceptance Breakout",
    description: "Follows directional acceptance when prior volatility was in compression, capturing predictable regime transitions.",
    defaultParams: {
        lookback: 25,
        volPercentileMax: 0.30,
    },
    paramLabels: {
        lookback: "Lookback",
        volPercentileMax: "Max Vol Percentile",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 4) return [];

        const closes = getCloses(cleanData);
        const returns = buildRateOfChange(closes, 1);
        const returnsClean = returns.map(v => v ?? 0);
        const volStdDev = buildRollingStdDev(returnsClean, lookback);
        const volPctl = buildPercentileRank(volStdDev.map(v => v ?? 0), lookback);
        const closeAcceptance = buildCloseAcceptanceSeries(cleanData);

        return createSignalLoop(cleanData, [volPctl, closeAcceptance], (i) => {
            if (i < 3) return null;
            const ca = closeAcceptance[i];

            // Check if any of the prior 3 bars was in compression
            const volMax = p.volPercentileMax as number;
            let wasCompressed = false;
            for (let j = 1; j <= 3; j++) {
                const vp = volPctl[i - j];
                if (vp !== null && vp < volMax) {
                    wasCompressed = true;
                    break;
                }
            }
            if (!wasCompressed) return null;

            if (ca > 0) {
                return createBuySignal(cleanData, i, `Compression breakout bullish acceptance ${ca.toFixed(2)}`);
            }
            if (ca < 0) {
                return createSellSignal(cleanData, i, `Compression breakout bearish acceptance ${ca.toFixed(2)}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "volPercentileMax"],
    },
};
