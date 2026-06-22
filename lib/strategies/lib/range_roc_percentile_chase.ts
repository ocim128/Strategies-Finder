import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
} from "../strategy-helpers";
import { buildCloseAcceptanceSeries, buildRangeSeries } from "./price-action-frequency-core";
import { buildPercentileRank, buildRateOfChange } from "./price-action-statistics-core";

type RangeRocPercentilePrepared = {
	data: OHLCVData[];
	ranges: number[];
	rangeRoc: number[];
	acceptance: number[];
	percentileByLookback: Map<number, (number | null)[]>;
};

function normalizeRangeRocParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 20))),
	};
}

function prepareRangeRocData(data: OHLCVData[]): RangeRocPercentilePrepared {
	const clean = ensureCleanData(data);
	const ranges = buildRangeSeries(clean);
	const rocRaw = buildRateOfChange(ranges, 1);
	const rangeRoc = rocRaw.map(v => v ?? 0);
	return {
		data: clean,
		ranges,
		rangeRoc,
		acceptance: buildCloseAcceptanceSeries(clean),
		percentileByLookback: new Map(),
	};
}

function getPreparedRangeRocData(preparedData: unknown, data: OHLCVData[]): RangeRocPercentilePrepared {
	if (preparedData && typeof preparedData === "object" && "percentileByLookback" in preparedData) {
		return preparedData as RangeRocPercentilePrepared;
	}
	return prepareRangeRocData(data);
}

export const range_roc_percentile_chase: Strategy = {
	name: "Range ROC Percentile Chase",
	description: "Chases momentum when the 1-bar rate of change (ROC) of true range is in the top 20% of history.",
	defaultParams: {
		lookback: 20,
	},
	paramLabels: {
		lookback: "Lookback",
	},
	normalizeParams: normalizeRangeRocParams,
	prepareFinderData: (data) => prepareRangeRocData(data),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const prepared = getPreparedRangeRocData(preparedData, data);
		const p = normalizeRangeRocParams(params);
		const lookback = p.lookback as number;
		if (prepared.data.length < lookback + 1) return [];

		let percentiles = prepared.percentileByLookback.get(lookback);
		if (!percentiles) {
			percentiles = buildPercentileRank(prepared.rangeRoc, lookback);
			prepared.percentileByLookback.set(lookback, percentiles);
		}

		return createSignalLoop(prepared.data, [percentiles], (i) => {
			if (i < lookback) return null;
			const pct = percentiles[i];
			if (pct === null) return null;

			const acc = prepared.acceptance[i];

			if (pct > 0.80 && acc > 0.5) {
				return createBuySignal(prepared.data, i, `Range ROC acceleration: percentile (${pct.toFixed(2)}) > 0.80 with positive close acceptance (${acc.toFixed(2)}) > 0.5`);
			}
			if (pct > 0.80 && acc < -0.5) {
				return createSellSignal(prepared.data, i, `Range ROC acceleration: percentile (${pct.toFixed(2)}) > 0.80 with negative close acceptance (${acc.toFixed(2)}) < -0.5`);
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams) =>
		range_roc_percentile_chase.executePrepared?.(prepareRangeRocData(data), params, data) ?? [],
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback"],
	},
};
