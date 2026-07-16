import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
} from "../strategy-helpers";
import { buildRollingZScore, buildRollingEntropy, buildPercentileRank, buildStreakCount } from "./price-action-statistics-core";

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
		lookback: Math.max(3, Math.round(Number(params.lookback ?? 20))),
		entropyPercentileLimit: Math.max(0, Math.min(1, Number(params.entropyPercentileLimit ?? 0.3))),
		streakThreshold: Math.max(1, Math.round(Number(params.streakThreshold ?? 4))),
	};
}

export const entropy_regime_streak_exhaustion: Strategy = {
	name: "Entropy Regime Streak Exhaustion",
	description: "Fades low-entropy trend regimes when entropy rises at close z-score extremes.",
	defaultParams: {
		lookback: 20,
		entropyPercentileLimit: 0.3,
		streakThreshold: 4,
	},
	paramLabels: {
		lookback: "Lookback Window",
		entropyPercentileLimit: "Entropy Percentile Limit",
		streakThreshold: "Streak Threshold",
	},
	normalizeParams,
	prepareFinderData: (data) => ({
		data,
		closes: getCloses(data),
		zscoreByLookback: new Map<number, (number | null)[]>(),
		entropyByLookback: new Map<number, (number | null)[]>(),
		entropyPctByLookback: new Map<string, (number | null)[]>(),
	}),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const entropyPercentileLimit = p.entropyPercentileLimit as number;
		const streakThreshold = p.streakThreshold as number;

		const prepared = preparedData as PreparedData;
		const cleanData = prepared?.data ?? ensureCleanData(data);
		if (cleanData.length < Math.max(lookback, streakThreshold + 2)) return [];

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

		// Percentile rank of entropy needs lookback.
		// Since buildPercentileRank expects number[], we map nulls in entropy to 0
		const entropyClean = entropy.map((v) => v ?? 0);
		const entropyPctByLookback = prepared?.entropyPctByLookback ?? new Map<string, (number | null)[]>();
		const pctKey = `${lookback}|${lookback}`;
		let entropyPct = entropyPctByLookback.get(pctKey);
		if (!entropyPct) {
			entropyPct = buildPercentileRank(entropyClean, lookback);
			entropyPctByLookback.set(pctKey, entropyPct);
		}

		// Compute low-entropy streaks
		const flags = new Array(cleanData.length).fill(0);
		for (let j = 0; j < cleanData.length; j++) {
			const ep = entropyPct[j];
			if (ep !== null && ep < entropyPercentileLimit) {
				flags[j] = 1;
			}
		}
		const entropyStreaks = buildStreakCount(flags);

		return createSignalLoop(cleanData, [zscore, entropyPct], (i) => {
			if (i < Math.max(lookback, streakThreshold + 1)) return null;

			const z = zscore[i];
			const ep = entropyPct[i];
			if (z === null || ep === null) return null;

			// Buy: close z-score below -1.5, streak of low entropy ended at i-1, current entropy crosses above 0.5
			if (z < -1.5 && entropyStreaks[i - 1] >= streakThreshold && ep > 0.5) {
				return createBuySignal(cleanData, i, `Entropy regime breakdown buy: low entropy streak of ${entropyStreaks[i - 1]} bars broke with entropy pct ${ep.toFixed(2)}`);
			}
			// Sell: close z-score above 1.5, streak of low entropy ended at i-1, current entropy crosses above 0.5
			if (z > 1.5 && entropyStreaks[i - 1] >= streakThreshold && ep > 0.5) {
				return createSellSignal(cleanData, i, `Entropy regime breakdown sell: low entropy streak of ${entropyStreaks[i - 1]} bars broke with entropy pct ${ep.toFixed(2)}`);
			}
			return null;
		});
	},
	execute: (data, params) =>
		entropy_regime_streak_exhaustion.executePrepared!(
			entropy_regime_streak_exhaustion.prepareFinderData!(data),
			params,
			data
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "entropyPercentileLimit", "streakThreshold"],
	},
};
