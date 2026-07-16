import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
} from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildRollingZScore } from "./price-action-statistics-core";

type PreparedData = {
	data: OHLCVData[];
	closes: number[];
	closeLocation: number[];
	zscoreByLookback: Map<number, (number | null)[]>;
};

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(Number(params.lookback ?? 40))),
		minReversionProbability: Math.max(0.01, Math.min(1, Number(params.minReversionProbability ?? 0.65))),
	};
}

export const markov_close_location_state_reversion: Strategy = {
	name: "Markov Close Location State Reversion",
	description: "Fades close location state extremes when empirical Markov transition probability to Mid state is high.",
	defaultParams: {
		lookback: 40,
		minReversionProbability: 0.65,
	},
	paramLabels: {
		lookback: "Lookback Window",
		minReversionProbability: "Min Reversion Probability",
	},
	normalizeParams,
	prepareFinderData: (data) => ({
		data: data,
		closes: getCloses(data),
		closeLocation: buildCloseLocationSeries(data),
		zscoreByLookback: new Map<number, (number | null)[]>(),
	}),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const minReversionProbability = p.minReversionProbability as number;

		const prepared = preparedData as PreparedData;
		const cleanData = prepared?.data ?? ensureCleanData(data);
		if (cleanData.length < lookback + 2) return [];

		const closes = prepared?.closes ?? getCloses(cleanData);
		const closeLocation = prepared?.closeLocation ?? buildCloseLocationSeries(cleanData);

		const zscoreByLookback = prepared?.zscoreByLookback ?? new Map<number, (number | null)[]>();
		let zscore = zscoreByLookback.get(lookback);
		if (!zscore) {
			zscore = buildRollingZScore(closes, lookback);
			zscoreByLookback.set(lookback, zscore);
		}

		// Discretize states: 0: Low (< 0.3), 1: Mid (0.3 - 0.7), 2: High (> 0.7)
		const states = new Uint8Array(cleanData.length);
		for (let j = 0; j < cleanData.length; j++) {
			const loc = closeLocation[j];
			if (loc < 0.3) {
				states[j] = 0;
			} else if (loc > 0.7) {
				states[j] = 2;
			} else {
				states[j] = 1;
			}
		}

		return createSignalLoop(cleanData, [zscore], (i) => {
			if (i < lookback + 1) return null;

			const z = zscore[i];
			if (z === null) return null;

			const currentState = states[i];

			// Compute rolling transition probabilities
			// We look at the window [i - lookback + 1, i - 1] to calculate transition probabilities
			const start = i - lookback + 1;
			const end = i - 1;

			if (currentState === 0) {
				// We need empirical P(Low -> Mid), i.e., P(0 -> 1)
				let countLow = 0;
				let countLowToMid = 0;
				for (let j = start; j <= end; j++) {
					if (states[j] === 0) {
						countLow++;
						if (states[j + 1] === 1) {
							countLowToMid++;
						}
					}
				}
				const prob = countLow > 0 ? countLowToMid / countLow : 0;
				if (z < -1.5 && prob > minReversionProbability) {
					return createBuySignal(cleanData, i, `Low close location state with P(Low->Mid) ${prob.toFixed(2)} > ${minReversionProbability}`);
				}
			} else if (currentState === 2) {
				// We need empirical P(High -> Mid), i.e., P(2 -> 1)
				let countHigh = 0;
				let countHighToMid = 0;
				for (let j = start; j <= end; j++) {
					if (states[j] === 2) {
						countHigh++;
						if (states[j + 1] === 1) {
							countHighToMid++;
						}
					}
				}
				const prob = countHigh > 0 ? countHighToMid / countHigh : 0;
				if (z > 1.5 && prob > minReversionProbability) {
					return createSellSignal(cleanData, i, `High close location state with P(High->Mid) ${prob.toFixed(2)} > ${minReversionProbability}`);
				}
			}

			return null;
		});
	},
	execute: (data, params) =>
		markov_close_location_state_reversion.executePrepared!(
			markov_close_location_state_reversion.prepareFinderData!(data),
			params,
			data
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "minReversionProbability"],
	},
};
