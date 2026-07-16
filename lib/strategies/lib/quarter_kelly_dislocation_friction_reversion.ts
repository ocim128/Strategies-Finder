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
		minQuarterKelly: Number(params.minQuarterKelly ?? 0.06),
	};
}

export const quarter_kelly_dislocation_friction_reversion: Strategy = {
	name: "Quarter Kelly Dislocation Friction Reversion",
	description: "Fades price extremes when dislocation friction WinRate (1 - absReturn / trueRange) maps to positive Quarter-Kelly allocation during range expansion.",
	defaultParams: {
		lookback: 35,
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
		returns: extractBarMetricSeries(data, "closeReturn"),
		tr: extractBarMetricSeries(data, "trueRange"),
		zscoreByLookback: new Map<number, (number | null)[]>(),
		trPctByLookback: new Map<number, (number | null)[]>(),
	}),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const minQuarterKelly = p.minQuarterKelly as number;

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
			const qKelly = 0.25 * (2 * winProb - 1);

			if (qKelly > minQuarterKelly && tp > 0.8) {
				if (z < -1.5) {
					return createBuySignal(cleanData, i, `Friction dislocation buy: Z ${z.toFixed(2)}, TR Pct ${tp.toFixed(2)}, ratio ${ratio.toFixed(2)}, Q-Kelly ${qKelly.toFixed(3)} > ${minQuarterKelly}`);
				}
				if (z > 1.5) {
					return createSellSignal(cleanData, i, `Friction dislocation sell: Z ${z.toFixed(2)}, TR Pct ${tp.toFixed(2)}, ratio ${ratio.toFixed(2)}, Q-Kelly ${qKelly.toFixed(3)} > ${minQuarterKelly}`);
				}
			}
			return null;
		});
	},
	execute: (data, params) =>
		quarter_kelly_dislocation_friction_reversion.executePrepared!(
			quarter_kelly_dislocation_friction_reversion.prepareFinderData!(data),
			params,
			data
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "minQuarterKelly"],
	},
};
