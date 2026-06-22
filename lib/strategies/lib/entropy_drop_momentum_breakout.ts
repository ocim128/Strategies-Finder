import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getTypicalPrices } from "../strategy-helpers";
import { buildRollingEntropy, buildPercentileRank, buildRollingZScore } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
		entropyMaxPercentile: Math.max(0.01, Math.min(0.99, Number(params.entropyMaxPercentile ?? 0.30))),
		zThreshold: Math.max(0.1, Number(params.zThreshold ?? 1.8)),
	};
}

export const entropy_drop_momentum_breakout: Strategy = {
	name: "Entropy Drop Momentum Breakout",
	description: "Triggers a trend-following entry when typical price z-score breakouts occur immediately after a low-entropy consolidation phase.",
	defaultParams: {
		lookback: 30,
		entropyMaxPercentile: 0.30,
		zThreshold: 1.8,
	},
	paramLabels: {
		lookback: "Lookback Window",
		entropyMaxPercentile: "Max Entropy Percentile",
		zThreshold: "Typical Price Z-Score Threshold",
	},
	normalizeParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const entropyMaxPercentile = p.entropyMaxPercentile as number;
		const zThreshold = p.zThreshold as number;
		if (cleanData.length < lookback * 2) return [];

		const typicalPrices = getTypicalPrices(cleanData);
		const entropy = buildRollingEntropy(typicalPrices, lookback, 5);
		const cleanEntropy = entropy.map(v => v !== null ? v : 0);
		const entropyPercentile = buildPercentileRank(cleanEntropy, lookback);

		const typicalZ = buildRollingZScore(typicalPrices, lookback);

		return createSignalLoop(cleanData, [entropyPercentile, typicalZ], (i) => {
			if (i < lookback * 2) return null;
			const tz = typicalZ[i];
			if (tz === null) return null;

			// Check if rolling entropy percentile was below entropyMaxPercentile within the last 3 bars (indices i, i-1, i-2)
			let lowEntropyCondition = false;
			for (let k = 0; k < 3; k++) {
				const ep = entropyPercentile[i - k];
				if (ep !== null && ep < entropyMaxPercentile) {
					lowEntropyCondition = true;
					break;
				}
			}

			if (!lowEntropyCondition) return null;

			if (tz > zThreshold) {
				return createBuySignal(cleanData, i, `Typical price breakout: z-score (${tz.toFixed(2)}) > ${zThreshold} after low-entropy compression phase`);
			}
			if (tz < -zThreshold) {
				return createSellSignal(cleanData, i, `Typical price breakdown: z-score (${tz.toFixed(2)}) < -${zThreshold} after low-entropy compression phase`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "entropyMaxPercentile", "zThreshold"],
	},
};
