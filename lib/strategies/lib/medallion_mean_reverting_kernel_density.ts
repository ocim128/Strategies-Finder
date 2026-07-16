import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
} from "../strategy-helpers";
import { buildRollingMedian } from "./price-action-statistics-core";

type PreparedData = {
	data: OHLCVData[];
	closes: number[];
	medianByLookback: Map<number, (number | null)[]>;
	densityRankByLookback: Map<number, (number | null)[]>;
};

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(5, Math.round(Number(params.lookback ?? 45))),
		densityPercentile: Math.max(0.01, Math.min(0.5, Number(params.densityPercentile ?? 0.1))),
	};
}

function computeDensityRankSeries(closes: number[], lookback: number): (number | null)[] {
	const result: (number | null)[] = new Array(closes.length).fill(null);
	if (closes.length < lookback) return result;

	for (let i = lookback - 1; i < closes.length; i++) {
		const W = new Array<number>(lookback);
		let sum = 0;
		for (let j = 0; j < lookback; j++) {
			const val = closes[i - lookback + 1 + j];
			W[j] = val;
			sum += val;
		}
		const mean = sum / lookback;
		let sumSquares = 0;
		for (let j = 0; j < lookback; j++) {
			const diff = W[j] - mean;
			sumSquares += diff * diff;
		}
		const variance = sumSquares / lookback;
		if (variance <= 0) {
			result[i] = 1.0;
			continue;
		}

		const std = Math.sqrt(variance);
		const h = 1.06 * std * Math.pow(lookback, -0.2);

		// Compute relative density score for each element in W
		const scores = new Array<number>(lookback);
		for (let j = 0; j < lookback; j++) {
			let density = 0;
			const x = W[j];
			for (let k = 0; k < lookback; k++) {
				const u = (x - W[k]) / h;
				density += Math.exp(-0.5 * u * u);
			}
			scores[j] = density;
		}

		const currentScore = scores[lookback - 1];
		let countLower = 0;
		for (let j = 0; j < lookback - 1; j++) {
			if (scores[j] < currentScore) {
				countLower++;
			}
		}
		result[i] = countLower / (lookback - 1);
	}
	return result;
}

export const medallion_mean_reverting_kernel_density: Strategy = {
	name: "Medallion Mean Reverting Kernel Density",
	description: "Approximates rolling price density via Gaussian kernel to fade price deviations at low-probability density tails.",
	defaultParams: {
		lookback: 45,
		densityPercentile: 0.1,
	},
	paramLabels: {
		lookback: "Lookback Window",
		densityPercentile: "Density Percentile",
	},
	normalizeParams,
	prepareFinderData: (data) => ({
		data,
		closes: getCloses(data),
		medianByLookback: new Map<number, (number | null)[]>(),
		densityRankByLookback: new Map<number, (number | null)[]>(),
	}),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const densityPercentile = p.densityPercentile as number;

		const prepared = preparedData as PreparedData;
		const cleanData = prepared?.data ?? ensureCleanData(data);
		if (cleanData.length < lookback + 2) return [];

		const closes = prepared?.closes ?? getCloses(cleanData);

		const medianByLookback = prepared?.medianByLookback ?? new Map<number, (number | null)[]>();
		let median = medianByLookback.get(lookback);
		if (!median) {
			median = buildRollingMedian(closes, lookback);
			medianByLookback.set(lookback, median);
		}

		const densityRankByLookback = prepared?.densityRankByLookback ?? new Map<number, (number | null)[]>();
		let densityRank = densityRankByLookback.get(lookback);
		if (!densityRank) {
			densityRank = computeDensityRankSeries(closes, lookback);
			densityRankByLookback.set(lookback, densityRank);
		}

		return createSignalLoop(cleanData, [median, densityRank], (i) => {
			if (i < lookback) return null;

			const m = median[i];
			const rank = densityRank[i];
			if (m === null || rank === null) return null;

			const price = closes[i];

			// Buy: price below median and density rank is below densityPercentile (rare lower-tail)
			if (price < m && rank < densityPercentile) {
				return createBuySignal(cleanData, i, `Lower density tail event: rank ${rank.toFixed(3)} < ${densityPercentile}`);
			}
			// Sell: price above median and density rank is below densityPercentile (rare upper-tail)
			if (price > m && rank < densityPercentile) {
				return createSellSignal(cleanData, i, `Upper density tail event: rank ${rank.toFixed(3)} < ${densityPercentile}`);
			}
			return null;
		});
	},
	execute: (data, params) =>
		medallion_mean_reverting_kernel_density.executePrepared!(
			medallion_mean_reverting_kernel_density.prepareFinderData!(data),
			params,
			data
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "densityPercentile"],
	},
};
