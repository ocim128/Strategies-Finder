import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
} from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-frequency-core";
import { buildRollingAutoCorrelation, buildRollingZScore } from "./price-action-statistics-core";

type PreparedData = {
	data: OHLCVData[];
	closes: number[];
	returns: number[];
	zscoreByLookback: Map<number, (number | null)[]>;
	autocorrByLookback: Map<number, (number | null)[]>;
};

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(Number(params.lookback ?? 35))),
		oscillatingStateStability: Math.max(0.01, Math.min(1, Number(params.oscillatingStateStability ?? 0.7))),
	};
}

export const markov_autocorrelation_regime_reversion: Strategy = {
	name: "Markov Autocorrelation Regime Reversion",
	description: "Enters mean reversion trades when transition probability of remaining in the Oscillating return autocorrelation state is high.",
	defaultParams: {
		lookback: 35,
		oscillatingStateStability: 0.7,
	},
	paramLabels: {
		lookback: "Lookback Window",
		oscillatingStateStability: "Oscillating Stability",
	},
	normalizeParams,
	prepareFinderData: (data) => ({
		data: data,
		closes: getCloses(data),
		returns: extractBarMetricSeries(data, "closeReturn"),
		zscoreByLookback: new Map<number, (number | null)[]>(),
		autocorrByLookback: new Map<number, (number | null)[]>(),
	}),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const oscillatingStateStability = p.oscillatingStateStability as number;

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

		const autocorrByLookback = prepared?.autocorrByLookback ?? new Map<number, (number | null)[]>();
		let autocorr = autocorrByLookback.get(lookback);
		if (!autocorr) {
			autocorr = buildRollingAutoCorrelation(returns, lookback, 1);
			autocorrByLookback.set(lookback, autocorr);
		}

		// Discretize states: 0: Oscillating (autocorr < 0), 1: Trending (autocorr >= 0)
		const states = new Uint8Array(cleanData.length);
		for (let j = 0; j < cleanData.length; j++) {
			const ac = autocorr[j];
			states[j] = (ac !== null && ac < 0) ? 0 : 1;
		}

		return createSignalLoop(cleanData, [zscore, autocorr], (i) => {
			if (i < lookback + 1) return null;

			const z = zscore[i];
			if (z === null) return null;

			const currentState = states[i];

			// Compute P(Oscillating -> Oscillating), i.e. P(0 -> 0)
			const start = i - lookback + 1;
			const end = i - 1;

			let countOscillating = 0;
			let countOscillatingToOscillating = 0;
			for (let j = start; j <= end; j++) {
				if (states[j] === 0) {
					countOscillating++;
					if (states[j + 1] === 0) {
						countOscillatingToOscillating++;
					}
				}
			}

			const prob = countOscillating > 0 ? countOscillatingToOscillating / countOscillating : 0;

			// Buy: close z-score < -1.5, state is Oscillating (0), probability > oscillatingStateStability
			if (z < -1.5 && currentState === 0 && prob > oscillatingStateStability) {
				return createBuySignal(cleanData, i, `Oscillating regime stability prob ${prob.toFixed(2)} > ${oscillatingStateStability}`);
			}
			// Sell: close z-score > 1.5, state is Oscillating (0), probability > oscillatingStateStability
			if (z > 1.5 && currentState === 0 && prob > oscillatingStateStability) {
				return createSellSignal(cleanData, i, `Oscillating regime stability prob ${prob.toFixed(2)} > ${oscillatingStateStability}`);
			}
			return null;
		});
	},
	execute: (data, params) =>
		markov_autocorrelation_regime_reversion.executePrepared!(
			markov_autocorrelation_regime_reversion.prepareFinderData!(data),
			params,
			data
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "oscillatingStateStability"],
	},
};
