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
		transitionThreshold: Math.max(0.01, Math.min(1, Number(params.transitionThreshold ?? 0.6))),
	};
}

export const markov_dislocation_friction_reversion: Strategy = {
	name: "Markov Dislocation Friction Reversion",
	description: "Fades price extremes when transition probability indicates moving from Efficient to Frictional displacement state.",
	defaultParams: {
		lookback: 35,
		transitionThreshold: 0.6,
	},
	paramLabels: {
		lookback: "Lookback Window",
		transitionThreshold: "Transition Threshold",
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
		const transitionThreshold = p.transitionThreshold as number;

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

		// Discretize states: 0: Frictional (absReturn / trueRange < 0.3), 1: Efficient (absReturn / trueRange >= 0.3)
		const states = new Uint8Array(cleanData.length);
		for (let j = 0; j < cleanData.length; j++) {
			const absRet = Math.abs(returns[j]);
			const range = tr[j];
			const ratio = range === 0 ? 0 : absRet / range;
			states[j] = ratio < 0.3 ? 0 : 1;
		}

		return createSignalLoop(cleanData, [zscore, trPct], (i) => {
			if (i < lookback + 1) return null;

			const z = zscore[i];
			const tp = trPct[i];
			if (z === null || tp === null) return null;

			// Compute P(Efficient -> Frictional), i.e., P(1 -> 0)
			const start = i - lookback + 1;
			const end = i - 1;

			let countEfficient = 0;
			let countEfficientToFrictional = 0;
			for (let j = start; j <= end; j++) {
				if (states[j] === 1) {
					countEfficient++;
					if (states[j + 1] === 0) {
						countEfficientToFrictional++;
					}
				}
			}

			const prob = countEfficient > 0 ? countEfficientToFrictional / countEfficient : 0;

			// Buy: close z-score < -1.5, true range percentile > 0.75, transition probability > transitionThreshold
			if (z < -1.5 && tp > 0.75 && prob > transitionThreshold) {
				return createBuySignal(cleanData, i, `Friction transition Eff->Fric prob ${prob.toFixed(2)} > ${transitionThreshold}`);
			}
			// Sell: close z-score > 1.5, true range percentile > 0.75, transition probability > transitionThreshold
			if (z > 1.5 && tp > 0.75 && prob > transitionThreshold) {
				return createSellSignal(cleanData, i, `Friction transition Eff->Fric prob ${prob.toFixed(2)} > ${transitionThreshold}`);
			}
			return null;
		});
	},
	execute: (data, params) =>
		markov_dislocation_friction_reversion.executePrepared!(
			markov_dislocation_friction_reversion.prepareFinderData!(data),
			params,
			data
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "transitionThreshold"],
	},
};
