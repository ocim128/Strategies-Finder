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
	negReturns: number[];
	posReturns: number[];
	negPctByLookback: Map<number, (number | null)[]>;
	posPctByLookback: Map<number, (number | null)[]>;
};

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(Number(params.lookback ?? 50))),
		stretchPercentile: Number(params.stretchPercentile ?? 0.96),
	};
}

export const return_distribution_stretch_fade: Strategy = {
	name: "Return Distribution Stretch Fade",
	description: "Fades single-bar close returns that exceed extreme historical percentile bands (stretchPercentile) of positive or negative returns.",
	defaultParams: {
		lookback: 50,
		stretchPercentile: 0.96,
	},
	paramLabels: {
		lookback: "Lookback Window",
		stretchPercentile: "Stretch Percentile",
	},
	normalizeParams,
	prepareFinderData: (data) => {
		const cleanData = ensureCleanData(data);
		const returns = extractBarMetricSeries(cleanData, "closeReturn");
		const negReturns = returns.map((v) => (v < 0 ? -v : 0));
		const posReturns = returns.map((v) => (v > 0 ? v : 0));
		return {
			data: cleanData,
			returns,
			negReturns,
			posReturns,
			negPctByLookback: new Map<number, (number | null)[]>(),
			posPctByLookback: new Map<number, (number | null)[]>(),
		};
	},
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const stretchPercentile = p.stretchPercentile as number;

		const prepared = preparedData as PreparedData;
		const cleanData = prepared?.data ?? ensureCleanData(data);
		if (cleanData.length < lookback + 2) return [];

		const returns = prepared?.returns ?? extractBarMetricSeries(cleanData, "closeReturn");
		const negReturns = prepared?.negReturns ?? returns.map((v) => (v < 0 ? -v : 0));
		const posReturns = prepared?.posReturns ?? returns.map((v) => (v > 0 ? v : 0));

		const negPctByLookback = prepared?.negPctByLookback ?? new Map<number, (number | null)[]>();
		let negPct = negPctByLookback.get(lookback);
		if (!negPct) {
			negPct = buildPercentileRank(negReturns, lookback);
			negPctByLookback.set(lookback, negPct);
		}

		const posPctByLookback = prepared?.posPctByLookback ?? new Map<number, (number | null)[]>();
		let posPct = posPctByLookback.get(lookback);
		if (!posPct) {
			posPct = buildPercentileRank(posReturns, lookback);
			posPctByLookback.set(lookback, posPct);
		}

		return createSignalLoop(cleanData, [negPct, posPct], (i) => {
			if (i < lookback) return null;

			const np = negPct![i];
			const pp = posPct![i];
			if (np === null || pp === null) return null;

			const ret = returns[i];

			// Buy: return is negative and its percentile rank relative to negative returns is above stretchPercentile
			if (ret < 0 && np > stretchPercentile) {
				return createBuySignal(cleanData, i, `Negative stretch fade: return ${ret.toFixed(4)}, negPct ${np.toFixed(2)}`);
			}
			// Sell: return is positive and its percentile rank relative to positive returns is above stretchPercentile
			if (ret > 0 && pp > stretchPercentile) {
				return createSellSignal(cleanData, i, `Positive stretch fade: return ${ret.toFixed(4)}, posPct ${pp.toFixed(2)}`);
			}
			return null;
		});
	},
	execute: (data, params) =>
		return_distribution_stretch_fade.executePrepared!(
			return_distribution_stretch_fade.prepareFinderData!(data),
			params,
			data
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "stretchPercentile"],
	},
};
