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
	returns: number[];
	closeLocation: number[];
	trPctByLookback: Map<number, (number | null)[]>;
};

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
		rangePercentile: Number(params.rangePercentile ?? 0.88),
	};
}

export const decoupling_wick_rejection_fade: Strategy = {
	name: "Decoupling Wick Rejection Fade",
	description: "Fades high-percentile true-range expansions (above rangePercentile) that exhibit sharp intrabar wick rejection at bar highs or lows.",
	defaultParams: {
		lookback: 30,
		rangePercentile: 0.88,
	},
	paramLabels: {
		lookback: "Lookback Window",
		rangePercentile: "Range Percentile",
	},
	normalizeParams,
	prepareFinderData: (data) => {
		const cleanData = ensureCleanData(data);
		return {
			data: cleanData,
			tr: extractBarMetricSeries(cleanData, "trueRange"),
			returns: extractBarMetricSeries(cleanData, "closeReturn"),
			closeLocation: buildCloseLocationSeries(cleanData),
			trPctByLookback: new Map<number, (number | null)[]>(),
		};
	},
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const rangePercentile = p.rangePercentile as number;

		const prepared = preparedData as PreparedData;
		const cleanData = prepared?.data ?? ensureCleanData(data);
		if (cleanData.length < lookback + 2) return [];

		const tr = prepared?.tr ?? extractBarMetricSeries(cleanData, "trueRange");
		const returns = prepared?.returns ?? extractBarMetricSeries(cleanData, "closeReturn");
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

			const ret = returns[i];
			const cl = closeLocation[i];

			// Buy: true range percentile is above rangePercentile, bar return is negative, but close location is above 0.85 (rejection of lows)
			if (tp > rangePercentile && ret < 0 && cl > 0.85) {
				return createBuySignal(cleanData, i, `Decoupling wick buy: TR Pct ${tp.toFixed(2)}, return ${ret.toFixed(4)}, CL ${cl.toFixed(2)}`);
			}
			// Sell: true range percentile is above rangePercentile, bar return is positive, but close location is below 0.15 (rejection of highs)
			if (tp > rangePercentile && ret > 0 && cl < 0.15) {
				return createSellSignal(cleanData, i, `Decoupling wick sell: TR Pct ${tp.toFixed(2)}, return ${ret.toFixed(4)}, CL ${cl.toFixed(2)}`);
			}
			return null;
		});
	},
	execute: (data, params) =>
		decoupling_wick_rejection_fade.executePrepared!(
			decoupling_wick_rejection_fade.prepareFinderData!(data),
			params,
			data
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "rangePercentile"],
	},
};
