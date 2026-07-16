import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
} from "../strategy-helpers";
import { buildEfficiencyRatio, buildRollingZScore } from "./price-action-statistics-core";

type PreparedData = {
	data: OHLCVData[];
	closes: number[];
	zscoreByLookback: Map<number, (number | null)[]>;
	erByLookback: Map<number, (number | null)[]>;
};

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
		transitionThreshold: Math.max(0.01, Math.min(1, Number(params.transitionThreshold ?? 0.65))),
	};
}

export const markov_efficiency_decay_reversion: Strategy = {
	name: "Markov Efficiency Decay Reversion",
	description: "Enters mean reversion trades when the transition probability of moving from Efficient to Inefficient state is high.",
	defaultParams: {
		lookback: 30,
		transitionThreshold: 0.65,
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
		erByLookback: new Map<number, (number | null)[]>(),
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

		const erByLookback = prepared?.erByLookback ?? new Map<number, (number | null)[]>();
		let er = erByLookback.get(lookback);
		if (!er) {
			er = buildEfficiencyRatio(cleanData, lookback);
			erByLookback.set(lookback, er);
		}

		// Discretize states: 1: Efficient (er > 0.5), 0: Inefficient (er <= 0.5)
		const states = new Uint8Array(cleanData.length);
		for (let j = 0; j < cleanData.length; j++) {
			const e = er[j];
			states[j] = (e !== null && e > 0.5) ? 1 : 0;
		}

		return createSignalLoop(cleanData, [zscore, er], (i) => {
			if (i < lookback + 1) return null;

			const z = zscore[i];
			if (z === null) return null;

			// Compute P(Efficient -> Inefficient), i.e., P(1 -> 0)
			const start = i - lookback + 1;
			const end = i - 1;

			let countEfficient = 0;
			let countEfficientToInefficient = 0;
			for (let j = start; j <= end; j++) {
				if (states[j] === 1) {
					countEfficient++;
					if (states[j + 1] === 0) {
						countEfficientToInefficient++;
					}
				}
			}

			const prob = countEfficient > 0 ? countEfficientToInefficient / countEfficient : 0;

			// Buy: close z-score < -1.5, transition probability > transitionThreshold
			if (z < -1.5 && prob > transitionThreshold) {
				return createBuySignal(cleanData, i, `Efficiency decay transition Eff->Ineff prob ${prob.toFixed(2)} > ${transitionThreshold}`);
			}
			// Sell: close z-score > 1.5, transition probability > transitionThreshold
			if (z > 1.5 && prob > transitionThreshold) {
				return createSellSignal(cleanData, i, `Efficiency decay transition Eff->Ineff prob ${prob.toFixed(2)} > ${transitionThreshold}`);
			}
			return null;
		});
	},
	execute: (data, params) =>
		markov_efficiency_decay_reversion.executePrepared!(
			markov_efficiency_decay_reversion.prepareFinderData!(data),
			params,
			data
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "transitionThreshold"],
	},
};
