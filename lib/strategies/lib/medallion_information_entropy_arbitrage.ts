import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
} from "../strategy-helpers";
import { buildRollingEntropy, buildRollingZScore, buildPercentileRank } from "./price-action-statistics-core";

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
		entropyPercentileLimit: Math.max(0, Math.min(1, Number(params.entropyPercentileLimit ?? 0.25))),
	};
}

export const medallion_information_entropy_arbitrage: Strategy = {
	name: "Medallion Information Entropy Arbitrage",
	description: "Fades collapsing rolling entropy trends at price z-score extremes.",
	defaultParams: {
		lookback: 40,
		entropyPercentileLimit: 0.25,
	},
	paramLabels: {
		lookback: "Lookback Window",
		entropyPercentileLimit: "Entropy Percentile Limit",
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

		const prepared = preparedData as PreparedData;
		const cleanData = prepared?.data ?? ensureCleanData(data);
		if (cleanData.length < lookback + 2) return [];

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

			// Buy: close z-score below -1.8, rolling entropy percentile below entropyPercentileLimit
			if (z < -1.8 && ep < entropyPercentileLimit) {
				return createBuySignal(cleanData, i, `Structured trend exhaustion buy: Z ${z.toFixed(2)}, Entropy Pct ${ep.toFixed(2)}`);
			}
			// Sell: close z-score above 1.8, rolling entropy percentile below entropyPercentileLimit
			if (z > 1.8 && ep < entropyPercentileLimit) {
				return createSellSignal(cleanData, i, `Structured trend exhaustion sell: Z ${z.toFixed(2)}, Entropy Pct ${ep.toFixed(2)}`);
			}
			return null;
		});
	},
	execute: (data, params) =>
		medallion_information_entropy_arbitrage.executePrepared!(
			medallion_information_entropy_arbitrage.prepareFinderData!(data),
			params,
			data
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "entropyPercentileLimit"],
	},
};
