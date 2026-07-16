import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
} from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-frequency-core";
import { buildPercentileRank, buildRollingZScore } from "./price-action-statistics-core";

type PreparedData = {
	data: OHLCVData[];
	closes: number[];
	returns: number[];
	tr: number[];
	zscoreByLookback: Map<number, (number | null)[]>;
	trPctByLookback: Map<number, (number | null)[]>;
};

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(Number(params.lookback ?? 35))),
		minKellyFraction: Number(params.minKellyFraction ?? 0.25),
	};
}

export const kelly_true_range_dislocation_reversion: Strategy = {
	name: "Kelly True Range Dislocation Reversion",
	description: "Fades price extremes when true range expands (percentile > 0.8) without close displacement, mapping win probability (1 - absReturn / trueRange) to positive Kelly allocation above minKellyFraction.",
	defaultParams: {
		lookback: 35,
		minKellyFraction: 0.25,
	},
	paramLabels: {
		lookback: "Lookback Window",
		minKellyFraction: "Min Kelly Fraction",
	},
	normalizeParams,
	prepareFinderData: (data) => ({
		data: data,
		closes: getCloses(data),
		returns: extractBarMetricSeries(data, "closeReturn"),
		tr: extractBarMetricSeries(data, "trueRange"),
		zscoreByLookback: new Map<number, (number | null)[]>(),
		trPctByLookback: new Map<number, (number | null)[]>(),
	}),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const minKellyFraction = p.minKellyFraction as number;

		const prepared = preparedData as PreparedData;
		const cleanData = prepared?.data ?? ensureCleanData(data);
		if (cleanData.length < lookback + 2) return [];

		const closes = prepared?.closes ?? getCloses(cleanData);
		const returns = prepared?.returns ?? extractBarMetricSeries(cleanData, "closeReturn");
		const tr = prepared?.tr ?? extractBarMetricSeries(cleanData, "trueRange");

		const zscoreByLookback = prepared?.zscoreByLookback ?? new Map<number, (number | null)[]>();
		let zscore = zscoreByLookback.get(lookback);
		if (!zscore) {
			zscore = buildRollingZScore(closes, lookback);
			zscoreByLookback.set(lookback, zscore);
		}

		const trPctByLookback = prepared?.trPctByLookback ?? new Map<number, (number | null)[]>();
		let trPct = trPctByLookback.get(lookback);
		if (!trPct) {
			trPct = buildPercentileRank(tr, lookback);
			trPctByLookback.set(lookback, trPct);
		}

		return createSignalLoop(cleanData, [zscore, trPct], (i) => {
			if (i < lookback) return null;

			const z = zscore[i];
			const tp = trPct[i];
			if (z === null || tp === null) return null;

			const absRet = Math.abs(returns[i]);
			const range = tr[i];
			const ratio = range === 0 ? 0 : absRet / range;

			const winProb = 1 - ratio;
			const kelly = 2 * winProb - 1;

			if (kelly > minKellyFraction && tp > 0.8) {
				if (z < -1.5) {
					return createBuySignal(cleanData, i, `Friction dislocation Kelly buy: Z ${z.toFixed(2)}, TR Pct ${tp.toFixed(2)}, ratio ${ratio.toFixed(2)}, Kelly ${kelly.toFixed(3)} > ${minKellyFraction}`);
				}
				if (z > 1.5) {
					return createSellSignal(cleanData, i, `Friction dislocation Kelly sell: Z ${z.toFixed(2)}, TR Pct ${tp.toFixed(2)}, ratio ${ratio.toFixed(2)}, Kelly ${kelly.toFixed(3)} > ${minKellyFraction}`);
				}
			}
			return null;
		});
	},
	execute: (data, params) =>
		kelly_true_range_dislocation_reversion.executePrepared!(
			kelly_true_range_dislocation_reversion.prepareFinderData!(data),
			params,
			data
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "minKellyFraction"],
	},
};
