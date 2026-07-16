import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
} from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

type PreparedData = {
	data: OHLCVData[];
	returns: number[];
	pctRankByLookback: Map<number, (number | null)[]>;
};

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 50))),
		tailThreshold: Math.max(0.5, Math.min(1, Number(params.tailThreshold ?? 0.98))),
	};
}

export const simons_non_parametric_distribution_fade: Strategy = {
	name: "Simons Non Parametric Distribution Fade",
	description: "Fades extreme tails of the empirical cumulative distribution function (eCDF) of returns.",
	defaultParams: {
		lookback: 50,
		tailThreshold: 0.98,
	},
	paramLabels: {
		lookback: "Lookback Window",
		tailThreshold: "Tail Threshold",
	},
	normalizeParams,
	prepareFinderData: (data) => ({
		data,
		returns: extractBarMetricSeries(data, "closeReturn"),
		pctRankByLookback: new Map<number, (number | null)[]>(),
	}),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const tailThreshold = p.tailThreshold as number;

		const prepared = preparedData as PreparedData;
		const cleanData = prepared?.data ?? ensureCleanData(data);
		if (cleanData.length < lookback + 2) return [];

		const returns = prepared?.returns ?? extractBarMetricSeries(cleanData, "closeReturn");
		const pctRankByLookback = prepared?.pctRankByLookback ?? new Map<number, (number | null)[]>();
		let pctRank = pctRankByLookback.get(lookback);
		if (!pctRank) {
			pctRank = buildPercentileRank(returns, lookback);
			pctRankByLookback.set(lookback, pctRank);
		}

		return createSignalLoop(cleanData, [pctRank], (i) => {
			if (i < lookback) return null;

			const rank = pctRank[i];
			if (rank === null) return null;

			// Buy: rank below (1 - tailThreshold)
			if (rank < (1 - tailThreshold)) {
				return createBuySignal(cleanData, i, `Empirical return percentile rank (${rank.toFixed(3)}) in lower tail`);
			}
			// Sell: rank above tailThreshold
			if (rank > tailThreshold) {
				return createSellSignal(cleanData, i, `Empirical return percentile rank (${rank.toFixed(3)}) in upper tail`);
			}
			return null;
		});
	},
	execute: (data, params) =>
		simons_non_parametric_distribution_fade.executePrepared!(
			simons_non_parametric_distribution_fade.prepareFinderData!(data),
			params,
			data
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "tailThreshold"],
	},
};
