import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
} from "../strategy-helpers";
import { buildRollingZScore } from "./price-action-statistics-core";

type PreparedData = {
	data: OHLCVData[];
	closes: number[];
	zscoreByLookback: Map<number, (number | null)[]>;
};

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(Number(params.lookback ?? 40))),
		minQuarterKelly: Number(params.minQuarterKelly ?? 0.06),
	};
}

function normalCDF(x: number): number {
	const p = 0.2316419;
	const a1 = 0.319381530;
	const a2 = -0.356563782;
	const a3 = 1.781477937;
	const a4 = -1.821255978;
	const a5 = 1.330274429;
	const absX = Math.abs(x);
	const t = 1.0 / (1.0 + p * absX);
	const cdf = 1.0 - (1.0 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * absX * absX) * 
				(a1 * t + a2 * t * t + a3 * Math.pow(t, 3) + a4 * Math.pow(t, 4) + a5 * Math.pow(t, 5));
	return x >= 0 ? cdf : 1.0 - cdf;
}

export const quarter_kelly_zscore_stretch_reversion: Strategy = {
	name: "Quarter Kelly Z-Score Stretch Reversion",
	description: "CDF maps rolling close Z-scores to win rates and triggers reversion entries when a conservative Quarter-Kelly allocation is positive and significant.",
	defaultParams: {
		lookback: 40,
		minQuarterKelly: 0.06,
	},
	paramLabels: {
		lookback: "Lookback Window",
		minQuarterKelly: "Min Quarter Kelly",
	},
	normalizeParams,
	prepareFinderData: (data) => ({
		data: data,
		closes: getCloses(data),
		zscoreByLookback: new Map<number, (number | null)[]>(),
	}),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const minQuarterKelly = p.minQuarterKelly as number;

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

		return createSignalLoop(cleanData, [zscore], (i) => {
			if (i < lookback) return null;

			const z = zscore[i];
			if (z === null) return null;

			if (z < -1.8) {
				const winProb = normalCDF(-z);
				const qKelly = 0.25 * (2 * winProb - 1);
				if (qKelly > minQuarterKelly) {
					return createBuySignal(cleanData, i, `Z stretch buy: Z ${z.toFixed(2)}, winProb ${winProb.toFixed(3)}, Q-Kelly ${qKelly.toFixed(3)} > ${minQuarterKelly}`);
				}
			} else if (z > 1.8) {
				const winProb = normalCDF(z);
				const qKelly = 0.25 * (2 * winProb - 1);
				if (qKelly > minQuarterKelly) {
					return createSellSignal(cleanData, i, `Z stretch sell: Z ${z.toFixed(2)}, winProb ${winProb.toFixed(3)}, Q-Kelly ${qKelly.toFixed(3)} > ${minQuarterKelly}`);
				}
			}
			return null;
		});
	},
	execute: (data, params) =>
		quarter_kelly_zscore_stretch_reversion.executePrepared!(
			quarter_kelly_zscore_stretch_reversion.prepareFinderData!(data),
			params,
			data
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "minQuarterKelly"],
	},
};
