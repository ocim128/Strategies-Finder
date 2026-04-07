import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { calculateBollingerBands } from "../indicators";
import { buildRollingSkewness } from "./price-action-statistics-core";

export const bollinger_skewness_ride: Strategy = {
    name: "Bollinger Skewness Ride",
    description: "Dispenses completely with classic band mean-reversion. Confirms that a directional breakout is institutionally sustainable by verifying the underlying return distribution is physically skewed towards the breakout limit.",
    defaultParams: {
        bbPeriod: 20,
        bbMult: 2.0,
        skewThreshold: 0.4 },
    paramLabels: {
        bbPeriod: "Bollinger Trailing Base",
        bbMult: "Envelope Width Reach",
        skewThreshold: "Required Path Distribution Bias" },
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const bPeriod = params.bbPeriod as number;
        // Skewness needs a somewhat broader view to establish a mathematical envelope limit than 20
        const skewLookback = Math.max(40, bPeriod * 2);

        if (cleanData.length < Math.max(bPeriod, skewLookback)) return [];

        const bb = calculateBollingerBands(
            cleanData.map(d => d.close),
            bPeriod,
            params.bbMult as number
        );

        const returns = cleanData.map((d, i) => i === 0 ? 0 : (d.close - cleanData[i - 1].close) / cleanData[i - 1].close);
        const safeReturns = returns.map(v => v === 0 ? 0.000001 : v);
        
        const skewnessSeries = buildRollingSkewness(safeReturns, skewLookback);

        return createSignalLoop(cleanData, [], (i) => {
            if (i < Math.max(bPeriod, skewLookback) || bb.upper[i] === null || bb.lower[i] === null || skewnessSeries[i] === null) return null;

            const currClose = cleanData[i].close;
            const bbUpper = bb.upper[i]!;
            const bbLower = bb.lower[i]!;

            const skew = skewnessSeries[i]!;
            const threshold = params.skewThreshold as number;

            // Strict structural breakout
            const isPushingUpper = currClose > bbUpper;
            const isPushingLower = currClose < bbLower;

            const hasStrongUpsideBias = skew > threshold;
            const hasStrongDownsideBias = skew < -threshold;

            if (isPushingUpper && hasStrongUpsideBias) {
                return createBuySignal(cleanData, i, "Bollinger ceiling push aggressively matched by heavily skewed structural distribution");
            }

            if (isPushingLower && hasStrongDownsideBias) {
                return createSellSignal(cleanData, i, "Bollinger floor breakdown aggressively matched by heavily skewed structural distribution");
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["bbPeriod", "bbMult", "skewThreshold"] } };
