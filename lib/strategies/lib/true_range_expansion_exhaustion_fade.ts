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
	absReturns: number[];
	closeLocation: number[];
	trPctByLookback: Map<number, (number | null)[]>;
	retPctByLookback: Map<number, (number | null)[]>;
};

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
		minRangePercentile: Number(params.minRangePercentile ?? 0.85),
	};
}

export const true_range_expansion_exhaustion_fade: Strategy = {
	name: "True Range Expansion Exhaustion Fade",
	description: "Fades true range expansions (above minRangePercentile) that fail to displace close price (absolute close return percentile < 0.3) at close location boundaries.",
	defaultParams: {
		lookback: 30,
		minRangePercentile: 0.85,
	},
	paramLabels: {
		lookback: "Lookback Window",
		minRangePercentile: "Min Range Percentile",
	},
	normalizeParams,
	prepareFinderData: (data) => {
		const cleanData = ensureCleanData(data);
		const returns = extractBarMetricSeries(cleanData, "closeReturn");
		const absReturns = returns.map((v) => Math.abs(v));
		return {
			data: cleanData,
			tr: extractBarMetricSeries(cleanData, "trueRange"),
			absReturns,
			closeLocation: buildCloseLocationSeries(cleanData),
			trPctByLookback: new Map<number, (number | null)[]>(),
			retPctByLookback: new Map<number, (number | null)[]>(),
		};
	},
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const minRangePercentile = p.minRangePercentile as number;

		const prepared = preparedData as PreparedData;
		const cleanData = prepared?.data ?? ensureCleanData(data);
		if (cleanData.length < lookback + 2) return [];

		const tr = prepared?.tr ?? extractBarMetricSeries(cleanData, "trueRange");
		const absReturns = prepared?.absReturns ?? extractBarMetricSeries(cleanData, "closeReturn").map((v) => Math.abs(v));
		const closeLocation = prepared?.closeLocation ?? buildCloseLocationSeries(cleanData);

		const trPctByLookback = prepared?.trPctByLookback ?? new Map<number, (number | null)[]>();
		let trPct = trPctByLookback.get(lookback);
		if (!trPct) {
			trPct = buildPercentileRank(tr, lookback);
			trPctByLookback.set(lookback, trPct);
		}

		const retPctByLookback = prepared?.retPctByLookback ?? new Map<number, (number | null)[]>();
		let retPct = retPctByLookback.get(lookback);
		if (!retPct) {
			retPct = buildPercentileRank(absReturns, lookback);
			retPctByLookback.set(lookback, retPct);
		}

		return createSignalLoop(cleanData, [trPct, retPct], (i) => {
			if (i < lookback) return null;

			const tp = trPct[i];
			const rp = retPct[i];
			if (tp === null || rp === null) return null;

			const cl = closeLocation[i];

			// Buy: true range percentile is above minRangePercentile, absolute return percentile below 0.3, close location below 0.2
			if (tp > minRangePercentile && rp < 0.3 && cl < 0.2) {
				return createBuySignal(cleanData, i, `Friction rejection buy: TR Pct ${tp.toFixed(2)}, Ret Pct ${rp.toFixed(2)}, CL ${cl.toFixed(2)}`);
			}
			// Sell: true range percentile is above minRangePercentile, absolute return percentile below 0.3, close location above 0.8
			if (tp > minRangePercentile && rp < 0.3 && cl > 0.8) {
				return createSellSignal(cleanData, i, `Friction rejection sell: TR Pct ${tp.toFixed(2)}, Ret Pct ${rp.toFixed(2)}, CL ${cl.toFixed(2)}`);
			}
			return null;
		});
	},
	execute: (data, params) =>
		true_range_expansion_exhaustion_fade.executePrepared!(
			true_range_expansion_exhaustion_fade.prepareFinderData!(data),
			params,
			data
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "minRangePercentile"],
	},
};
