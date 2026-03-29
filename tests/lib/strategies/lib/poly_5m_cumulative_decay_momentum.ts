import { Strategy, StrategyParams, OHLCVData } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildCumulativeDecaySum, buildRollingStdDev } from "./price-action-statistics-core";

function normalizePoly5mCumulativeDecayMomentumParams(params: StrategyParams): StrategyParams {
	const lookback = Math.max(2, Math.round(params.lookback ?? 8));
	const decayFactor = Math.max(0.01, Math.min(0.999, Number(params.decayFactor ?? 0.85)));
	const stdMultiplier = Math.max(0.1, Number(params.stdMultiplier ?? 1.5));

	return {
		...params,
		lookback,
		decayFactor,
		stdMultiplier,
	};
}

export const poly_5m_cumulative_decay_momentum: Strategy = {
	name: "Poly 5m Cumulative Decay Momentum",
	description: "Cumulative decay sum of price changes shows hidden momentum. Enter when threshold crossed with directional confirmation.",
	defaultParams: {
		lookback: 8,
		decayFactor: 0.85,
		stdMultiplier: 1.5,
	},
	paramLabels: {
		lookback: "Lookback",
		decayFactor: "Decay Factor",
		stdMultiplier: "Std Multiplier",
	},
	normalizeParams: normalizePoly5mCumulativeDecayMomentumParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const normalizedParams = normalizePoly5mCumulativeDecayMomentumParams(params);
		if (cleanData.length < normalizedParams.lookback + 1) return [];

		const closes = getCloses(cleanData);

		// Calculate price changes (returns)
		const priceChanges: number[] = [];
		for (let i = 1; i < closes.length; i++) {
			priceChanges.push(closes[i] - closes[i - 1]);
		}

		// Build cumulative decay sum of price changes
		const decaySum = buildCumulativeDecaySum(priceChanges, normalizedParams.decayFactor);

		// Pad decay sum to match cleanData length
		const decaySumPadded: number[] = new Array(cleanData.length).fill(0);
		for (let i = 0; i < decaySum.length; i++) {
			decaySumPadded[i + 1] = decaySum[i];
		}

		// Calculate rolling std dev of decay sum
		const decayStdDev = buildRollingStdDev(decaySumPadded, normalizedParams.lookback);

		return createSignalLoop(cleanData, [decaySumPadded, decayStdDev], (i) => {
			const currentDecaySum = decaySumPadded[i];
			const currentStdDev = decayStdDev[i];

			if (currentStdDev === null) return null;

			const threshold = normalizedParams.stdMultiplier * currentStdDev;
			const isBullishBar = cleanData[i].close > cleanData[i].open;
			const isBearishBar = cleanData[i].close < cleanData[i].open;

			// Buy signal: decay sum above threshold with bullish bar
			if (currentDecaySum > threshold && isBullishBar) {
				return createBuySignal(cleanData, i, `Decay sum ${currentDecaySum.toFixed(6)} > ${threshold.toFixed(6)}, bullish bar`);
			}

			// Sell signal: decay sum below negative threshold with bearish bar
			if (currentDecaySum < -threshold && isBearishBar) {
				return createSellSignal(cleanData, i, `Decay sum ${currentDecaySum.toFixed(6)} < -${threshold.toFixed(6)}, bearish bar`);
			}

			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "decayFactor", "stdMultiplier"],
	},
};
