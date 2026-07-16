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
		lookback: Math.max(3, Math.round(Number(params.lookback ?? 40))),
		zScoreThreshold: Number(params.zScoreThreshold ?? 2.1),
	};
}

export const statistical_stretch_entropy_exhaustion: Strategy = {
	name: "Statistical Stretch Entropy Exhaustion",
	description: "Fades price deviations at Z-score extremes when rolling returns entropy percentile rank is below 0.25 (orderly exhaustion).",
	defaultParams: {
		lookback: 40,
		zScoreThreshold: 2.1,
	},
	paramLabels: {
		lookback: "Lookback Window",
		zScoreThreshold: "Z-Score Threshold",
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
		const zScoreThreshold = p.zScoreThreshold as number;

		const prepared = preparedData as PreparedData;
		const cleanData = prepared?.data ?? ensureCleanData(data);
		const len = cleanData.length;
		if (len < lookback + 2) return [];

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
			if (i < lookback) return null;

			const z = zscore[i];
			const ep = entropyPct[i];
			if (z === null || ep === null) return null;

			// Buy: close z-score below -zScoreThreshold, and entropy percentile rank below 0.25
			if (z < -zScoreThreshold && ep < 0.25) {
				return createBuySignal(cleanData, i, `Entropy exhaustion buy: Z ${z.toFixed(2)}, Entropy Pct ${ep.toFixed(2)}`);
			}
			// Sell: close z-score above zScoreThreshold, and entropy percentile rank below 0.25
			if (z > zScoreThreshold && ep < 0.25) {
				return createSellSignal(cleanData, i, `Entropy exhaustion sell: Z ${z.toFixed(2)}, Entropy Pct ${ep.toFixed(2)}`);
			}
			return null;
		});
	},
	execute: (data, params) =>
		statistical_stretch_entropy_exhaustion.executePrepared!(
			statistical_stretch_entropy_exhaustion.prepareFinderData!(data),
			params,
			data
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "zScoreThreshold"],
	},
};
