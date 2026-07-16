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
		lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
		regimeThreshold: Number(params.regimeThreshold ?? -0.15),
	};
}

export const medallion_hidden_markov_state_reversion: Strategy = {
	name: "Medallion Hidden Markov State Reversion",
	description: "Restricts mean reversion entries to regimes showing negative autocorrelation (mean-reverting states).",
	defaultParams: {
		lookback: 30,
		regimeThreshold: -0.15,
	},
	paramLabels: {
		lookback: "Lookback Window",
		regimeThreshold: "Regime Threshold",
	},
	normalizeParams,
	prepareFinderData: (data) => ({
		data,
		closes: getCloses(data),
		returns: extractBarMetricSeries(data, "closeReturn"),
		zscoreByLookback: new Map<number, (number | null)[]>(),
		autocorrByLookback: new Map<number, (number | null)[]>(),
	}),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const regimeThreshold = p.regimeThreshold as number;

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

		return createSignalLoop(cleanData, [zscore, autocorr], (i) => {
			if (i < lookback + 1) return null;

			const z = zscore[i];
			const ac = autocorr[i];
			if (z === null || ac === null) return null;

			// Buy: price Z-score < -1.8, and return autocorrelation < regimeThreshold
			if (z < -1.8 && ac < regimeThreshold) {
				return createBuySignal(cleanData, i, `Z-Score extreme (${z.toFixed(2)}) in mean-reverting regime (${ac.toFixed(2)})`);
			}
			// Sell: price Z-score > 1.8, and return autocorrelation < regimeThreshold
			if (z > 1.8 && ac < regimeThreshold) {
				return createSellSignal(cleanData, i, `Z-Score extreme (${z.toFixed(2)}) in mean-reverting regime (${ac.toFixed(2)})`);
			}
			return null;
		});
	},
	execute: (data, params) =>
		medallion_hidden_markov_state_reversion.executePrepared!(
			medallion_hidden_markov_state_reversion.prepareFinderData!(data),
			params,
			data
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "regimeThreshold"],
	},
};
