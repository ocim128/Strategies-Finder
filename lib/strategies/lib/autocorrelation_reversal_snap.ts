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
		maxAutocorrelation: Number(params.maxAutocorrelation ?? -0.15),
	};
}

export const autocorrelation_reversal_snap: Strategy = {
	name: "Autocorrelation Reversal Snap",
	description: "Fades price extremes (Z-score 1.8) when rolling autocorrelation of close returns is highly negative (less than maxAutocorrelation).",
	defaultParams: {
		lookback: 24,
		maxAutocorrelation: -0.15,
	},
	paramLabels: {
		lookback: "Lookback Window",
		maxAutocorrelation: "Max Autocorrelation",
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
		const maxAutocorrelation = p.maxAutocorrelation as number;

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

			// Buy: rolling autocorrelation less than maxAutocorrelation, rolling close z-score below -1.8
			if (ac < maxAutocorrelation && z < -1.8) {
				return createBuySignal(cleanData, i, `Autocorr reversal buy: Z ${z.toFixed(2)}, Autocorr ${ac.toFixed(2)}`);
			}
			// Sell: rolling autocorrelation less than maxAutocorrelation, rolling close z-score above 1.8
			if (ac < maxAutocorrelation && z > 1.8) {
				return createSellSignal(cleanData, i, `Autocorr reversal sell: Z ${z.toFixed(2)}, Autocorr ${ac.toFixed(2)}`);
			}
			return null;
		});
	},
	execute: (data, params) =>
		autocorrelation_reversal_snap.executePrepared!(
			autocorrelation_reversal_snap.prepareFinderData!(data),
			params,
			data
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "maxAutocorrelation"],
	},
};
