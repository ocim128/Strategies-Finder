import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
} from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-frequency-core";
import { buildRollingZScore } from "./price-action-statistics-core";

type PreparedData = {
	data: OHLCVData[];
	closes: number[];
	returns: number[];
	zscoreByLookback: Map<number, (number | null)[]>;
};

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(Number(params.lookback ?? 45))),
		minReboundProbability: Math.max(0.01, Math.min(1, Number(params.minReboundProbability ?? 0.7))),
	};
}

export const markov_rebound_probability_reversion: Strategy = {
	name: "Markov Rebound Probability Reversion",
	description: "Fades price extremes when the transition probability of a change in return direction (Down->Up or Up->Down) exceeds minReboundProbability.",
	defaultParams: {
		lookback: 45,
		minReboundProbability: 0.7,
	},
	paramLabels: {
		lookback: "Lookback Window",
		minReboundProbability: "Min Rebound Prob",
	},
	normalizeParams,
	prepareFinderData: (data) => ({
		data: data,
		closes: getCloses(data),
		returns: extractBarMetricSeries(data, "closeReturn"),
		zscoreByLookback: new Map<number, (number | null)[]>(),
	}),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const minReboundProbability = p.minReboundProbability as number;

		const prepared = preparedData as PreparedData;
		const cleanData = prepared?.data ?? ensureCleanData(data);
		if (cleanData.length < lookback + 2) return [];

		const closes = prepared?.closes ?? getCloses(cleanData);
		const returns = prepared?.returns ?? extractBarMetricSeries(cleanData, "closeReturn");

		const zscoreByLookback = prepared?.zscoreByLookback ?? new Map<number, (number | null)[]>();
		let zscore = zscoreByLookback.get(lookback);
		if (!zscore) {
			zscore = buildRollingZScore(closes, lookback);
			zscoreByLookback.set(lookback, zscore);
		}

		// Discretize states: 1: Up (> 0), 0: Down (<= 0)
		const states = new Uint8Array(cleanData.length);
		for (let j = 0; j < cleanData.length; j++) {
			states[j] = returns[j] > 0 ? 1 : 0;
		}

		return createSignalLoop(cleanData, [zscore], (i) => {
			if (i < lookback + 1) return null;

			const z = zscore[i];
			if (z === null) return null;

			const currentState = states[i];

			// Compute rebound probabilities from history in the window [i - lookback + 1, i - 1]
			const start = i - lookback + 1;
			const end = i - 1;

			if (currentState === 0) {
				// Current state is Down (0). We want P(Down -> Up), i.e., P(0 -> 1)
				let countDown = 0;
				let countDownToUp = 0;
				for (let j = start; j <= end; j++) {
					if (states[j] === 0) {
						countDown++;
						if (states[j + 1] === 1) {
							countDownToUp++;
						}
					}
				}
				const prob = countDown > 0 ? countDownToUp / countDown : 0;

				if (z < -1.8 && prob > minReboundProbability) {
					return createBuySignal(cleanData, i, `Down rebound transition Down->Up prob ${prob.toFixed(2)} > ${minReboundProbability}`);
				}
			} else if (currentState === 1) {
				// Current state is Up (1). We want P(Up -> Down), i.e., P(1 -> 0)
				let countUp = 0;
				let countUpToDown = 0;
				for (let j = start; j <= end; j++) {
					if (states[j] === 1) {
						countUp++;
						if (states[j + 1] === 0) {
							countUpToDown++;
						}
					}
				}
				const prob = countUp > 0 ? countUpToDown / countUp : 0;

				if (z > 1.8 && prob > minReboundProbability) {
					return createSellSignal(cleanData, i, `Up rebound transition Up->Down prob ${prob.toFixed(2)} > ${minReboundProbability}`);
				}
			}
			return null;
		});
	},
	execute: (data, params) =>
		markov_rebound_probability_reversion.executePrepared!(
			markov_rebound_probability_reversion.prepareFinderData!(data),
			params,
			data
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "minReboundProbability"],
	},
};
