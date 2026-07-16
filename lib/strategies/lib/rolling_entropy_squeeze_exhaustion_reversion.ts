import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
} from "../strategy-helpers";
import { buildRollingEntropy, buildPercentileRank, buildRollingZScore } from "./price-action-statistics-core";

type PreparedData = {
	data: OHLCVData[];
	closes: number[];
	zscoreByLookback: Map<number, (number | null)[]>;
	entropyByLookback: Map<number, (number | null)[]>;
	entropyPctByLookback: Map<string, (number | null)[]>;
};

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(5, Math.round(Number(params.lookback ?? 35))),
		maxEntropyPercentile: Number(params.maxEntropyPercentile ?? 0.35),
	};
}

export const rolling_entropy_squeeze_exhaustion_reversion: Strategy = {
	name: "Rolling Entropy Squeeze Exhaustion Reversion",
	description: "Fades price extremes when rolling entropy percentile increases after being squeezed below maxEntropyPercentile for the last 3 bars.",
	defaultParams: {
		lookback: 35,
		maxEntropyPercentile: 0.35,
	},
	paramLabels: {
		lookback: "Lookback Window",
		maxEntropyPercentile: "Max Entropy Percentile",
	},
	normalizeParams,
	prepareFinderData: (data) => ({
		data: data,
		closes: getCloses(data),
		zscoreByLookback: new Map<number, (number | null)[]>(),
		entropyByLookback: new Map<number, (number | null)[]>(),
		entropyPctByLookback: new Map<string, (number | null)[]>(),
	}),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const maxEntropyPercentile = p.maxEntropyPercentile as number;

		const prepared = preparedData as PreparedData;
		const cleanData = prepared?.data ?? ensureCleanData(data);
		if (cleanData.length < lookback + 5) return [];

		const closes = prepared?.closes ?? getCloses(cleanData);

		const zscoreByLookback = prepared?.zscoreByLookback ?? new Map<number, (number | null)[]>();
		let zscore = zscoreByLookback.get(lookback);
		if (!zscore) {
			zscore = buildRollingZScore(closes, lookback);
			zscoreByLookback.set(lookback, zscore);
		}

		const entropyByLookback = prepared?.entropyByLookback ?? new Map<number, (number | null)[]>();
		let entropy = entropyByLookback.get(lookback);
		if (!entropy) {
			entropy = buildRollingEntropy(closes, lookback);
			entropyByLookback.set(lookback, entropy);
		}

		// Percentile rank of entropy. Map nulls in entropy to 0 to prevent compilation errors
		const cleanEntropy = entropy.map((v) => v ?? 0);
		const entropyPctByLookback = prepared?.entropyPctByLookback ?? new Map<string, (number | null)[]>();
		const pctKey = `${lookback}|${lookback}`;
		let entropyPct = entropyPctByLookback.get(pctKey);
		if (!entropyPct) {
			entropyPct = buildPercentileRank(cleanEntropy, lookback);
			entropyPctByLookback.set(pctKey, entropyPct);
		}

		return createSignalLoop(cleanData, [zscore, entropyPct], (i) => {
			if (i < lookback + 3) return null;

			const z = zscore[i];
			if (z === null) return null;

			// Check entropy squeeze condition: below maxEntropyPercentile for the last 3 bars (i-3, i-2, i-1)
			const ep3 = entropyPct[i - 3];
			const ep2 = entropyPct[i - 2];
			const ep1 = entropyPct[i - 1];
			const ep0 = entropyPct[i];

			if (ep3 === null || ep2 === null || ep1 === null || ep0 === null) return null;

			const squeezed = ep3 < maxEntropyPercentile && ep2 < maxEntropyPercentile && ep1 < maxEntropyPercentile;
			const turning = ep0 > ep1;

			if (squeezed && turning) {
				if (z < -1.8) {
					return createBuySignal(cleanData, i, `Entropy squeeze exhaustion buy: Z ${z.toFixed(2)}, entropy Pct ${ep0.toFixed(2)} increased from prev ${ep1.toFixed(2)}`);
				}
				if (z > 1.8) {
					return createSellSignal(cleanData, i, `Entropy squeeze exhaustion sell: Z ${z.toFixed(2)}, entropy Pct ${ep0.toFixed(2)} increased from prev ${ep1.toFixed(2)}`);
				}
			}
			return null;
		});
	},
	execute: (data, params) =>
		rolling_entropy_squeeze_exhaustion_reversion.executePrepared!(
			rolling_entropy_squeeze_exhaustion_reversion.prepareFinderData!(data),
			params,
			data
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "maxEntropyPercentile"],
	},
};
