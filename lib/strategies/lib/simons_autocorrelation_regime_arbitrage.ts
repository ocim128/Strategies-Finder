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
		lookback: Math.max(3, Math.round(Number(params.lookback ?? 24))),
		maxCorrelation: Number(params.maxCorrelation ?? -0.2),
	};
}

export const simons_autocorrelation_regime_arbitrage: Strategy = {
	name: "Simons Autocorrelation Regime Arbitrage",
	description: "Restricts reversion entries to periods where autocorrelation of returns is negative and declining.",
	defaultParams: {
		lookback: 24,
		maxCorrelation: -0.2,
	},
	paramLabels: {
		lookback: "Lookback Window",
		maxCorrelation: "Max Correlation",
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
		const maxCorrelation = p.maxCorrelation as number;

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

			// Buy: close Z-score below -1.5, and autocorrelation below maxCorrelation
			if (z < -1.5 && ac < maxCorrelation) {
				return createBuySignal(cleanData, i, `Mean-reverting autocorrelation regime: Z ${z.toFixed(2)}, Autocorr ${ac.toFixed(2)}`);
			}
			// Sell: close Z-score above 1.5, and autocorrelation below maxCorrelation
			if (z > 1.5 && ac < maxCorrelation) {
				return createSellSignal(cleanData, i, `Mean-reverting autocorrelation regime: Z ${z.toFixed(2)}, Autocorr ${ac.toFixed(2)}`);
			}
			return null;
		});
	},
	execute: (data, params) =>
		simons_autocorrelation_regime_arbitrage.executePrepared!(
			simons_autocorrelation_regime_arbitrage.prepareFinderData!(data),
			params,
			data
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "maxCorrelation"],
	},
};
