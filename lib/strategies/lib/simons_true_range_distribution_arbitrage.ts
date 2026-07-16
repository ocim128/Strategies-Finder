import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
} from "../strategy-helpers";
import { extractBarMetricSeries, buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

type PreparedData = {
	data: OHLCVData[];
	tr: number[];
	closeLocation: number[];
	trPctByLookback: Map<number, (number | null)[]>;
};

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 35))),
		minRangePercentile: Math.max(0.01, Math.min(1, Number(params.minRangePercentile ?? 0.85))),
	};
}

export const simons_true_range_distribution_arbitrage: Strategy = {
	name: "Simons True Range Distribution Arbitrage",
	description: "Fades true range expansions that fail to displace close price, showing rejection friction.",
	defaultParams: {
		lookback: 35,
		minRangePercentile: 0.85,
	},
	paramLabels: {
		lookback: "Lookback Window",
		minRangePercentile: "Min Range Percentile",
	},
	normalizeParams,
	prepareFinderData: (data) => ({
		data,
		tr: extractBarMetricSeries(data, "trueRange"),
		closeLocation: buildCloseLocationSeries(data),
		trPctByLookback: new Map<number, (number | null)[]>(),
	}),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const minRangePercentile = p.minRangePercentile as number;

		const prepared = preparedData as PreparedData;
		const cleanData = prepared?.data ?? ensureCleanData(data);
		if (cleanData.length < lookback + 2) return [];

		const tr = prepared?.tr ?? extractBarMetricSeries(cleanData, "trueRange");
		const closeLocation = prepared?.closeLocation ?? buildCloseLocationSeries(cleanData);

		const trPctByLookback = prepared?.trPctByLookback ?? new Map<number, (number | null)[]>();
		let trPct = trPctByLookback.get(lookback);
		if (!trPct) {
			trPct = buildPercentileRank(tr, lookback);
			trPctByLookback.set(lookback, trPct);
		}

		return createSignalLoop(cleanData, [trPct], (i) => {
			if (i < lookback) return null;

			const tp = trPct[i];
			if (tp === null) return null;

			const cl = closeLocation[i];

			// Buy: true range percentile above minRangePercentile, closeLocation below 0.15 (downside expansion rejection)
			if (tp > minRangePercentile && cl < 0.15) {
				return createBuySignal(cleanData, i, `Friction downside rejection: TR percentile ${tp.toFixed(2)}, closeLocation ${cl.toFixed(2)}`);
			}
			// Sell: true range percentile above minRangePercentile, closeLocation above 0.85 (upside expansion rejection)
			if (tp > minRangePercentile && cl > 0.85) {
				return createSellSignal(cleanData, i, `Friction upside rejection: TR percentile ${tp.toFixed(2)}, closeLocation ${cl.toFixed(2)}`);
			}
			return null;
		});
	},
	execute: (data, params) =>
		simons_true_range_distribution_arbitrage.executePrepared!(
			simons_true_range_distribution_arbitrage.prepareFinderData!(data),
			params,
			data
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "minRangePercentile"],
	},
};
