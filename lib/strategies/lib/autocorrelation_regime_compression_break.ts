import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildRollingAutoCorrelation, buildPercentileRank } from "./price-action-statistics-core";
import { buildCloseLocationSeries, extractBarMetricSeries } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
        compressionLimit: Number(params.compressionLimit ?? 0.35),
    };
}

export const autocorrelation_regime_compression_break: Strategy = {
    name: "Autocorrelation Regime Compression Break",
    description: "Transitions from a compressed, low-range state to an expanded, highly persistent trending state.",
    defaultParams: {
        lookback: 30,
        compressionLimit: 0.35,
    },
    paramLabels: {
        lookback: "Lookback Window",
        compressionLimit: "Compression Limit Pct",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const trueRange = extractBarMetricSeries(cleanData, "trueRange");
        const trPct = buildPercentileRank(trueRange, lookback);

        const returns = extractBarMetricSeries(cleanData, "closeReturn");
        const ac = buildRollingAutoCorrelation(returns, lookback, 1);
        const closeLoc = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [trPct, ac, closeLoc], (i) => {
            if (i < lookback || i < 1) return null;
            const prevPct = trPct[i - 1];
            const currPct = trPct[i];
            const currAc = ac[i];
            const currLoc = closeLoc[i];
            if (prevPct === null || currPct === null || currAc === null) return null;

            // Buy: prior range pct < compressionLimit, current range pct > 0.7, AC > 0.2, and close location > 0.7
            if (prevPct < (p.compressionLimit as number) && currPct > 0.7 && currAc > 0.2 && currLoc > 0.7) {
                return createBuySignal(cleanData, i, `AC Compress Break Buy: PrevPct ${prevPct.toFixed(2)}, CurrPct ${currPct.toFixed(2)}, AC ${currAc.toFixed(2)}`);
            }
            // Sell: prior range pct < compressionLimit, current range pct > 0.7, AC > 0.2, and close location < 0.3
            if (prevPct < (p.compressionLimit as number) && currPct > 0.7 && currAc > 0.2 && currLoc < 0.3) {
                return createSellSignal(cleanData, i, `AC Compress Break Sell: PrevPct ${prevPct.toFixed(2)}, CurrPct ${currPct.toFixed(2)}, AC ${currAc.toFixed(2)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "compressionLimit"],
    },
};
