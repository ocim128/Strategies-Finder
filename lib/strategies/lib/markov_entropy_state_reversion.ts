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
		transitionThreshold: Math.max(0.01, Math.min(1, Number(params.transitionThreshold ?? 0.55))),
	};
}

export const markov_entropy_state_reversion: Strategy = {
	name: "Markov Entropy State Reversion",
	description: "Enters mean reversion trades on Markov Low-Entropy -> High-Entropy transition at price extremes.",
	defaultParams: {
		lookback: 40,
		transitionThreshold: 0.55,
	},
	paramLabels: {
		lookback: "Lookback Window",
		transitionThreshold: "Transition Threshold",
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
		const transitionThreshold = p.transitionThreshold as number;

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

		// Discretize states: 0: Low-Entropy (entropyPct < 0.35), 1: High-Entropy (entropyPct >= 0.35)
		const states = new Uint8Array(cleanData.length);
		for (let j = 0; j < cleanData.length; j++) {
			const ep = entropyPct[j];
			states[j] = (ep !== null && ep < 0.35) ? 0 : 1;
		}

		return createSignalLoop(cleanData, [zscore, entropyPct], (i) => {
			if (i < lookback + 1) return null;

			const z = zscore[i];
			if (z === null) return null;

			// Compute P(Low-Entropy -> High-Entropy), i.e., P(0 -> 1)
			const start = i - lookback + 1;
			const end = i - 1;

			let countLow = 0;
			let countLowToHigh = 0;
			for (let j = start; j <= end; j++) {
				if (states[j] === 0) {
					countLow++;
					if (states[j + 1] === 1) {
						countLowToHigh++;
					}
				}
			}

			const prob = countLow > 0 ? countLowToHigh / countLow : 0;

			// Buy: close z-score < -1.8, transition probability > transitionThreshold
			if (z < -1.8 && prob > transitionThreshold) {
				return createBuySignal(cleanData, i, `Entropy transition Low->High prob ${prob.toFixed(2)} > ${transitionThreshold}`);
			}
			// Sell: close z-score > 1.8, transition probability > transitionThreshold
			if (z > 1.8 && prob > transitionThreshold) {
				return createSellSignal(cleanData, i, `Entropy transition Low->High prob ${prob.toFixed(2)} > ${transitionThreshold}`);
			}
			return null;
		});
	},
	execute: (data, params) =>
		markov_entropy_state_reversion.executePrepared!(
			markov_entropy_state_reversion.prepareFinderData!(data),
			params,
			data
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "transitionThreshold"],
	},
};
