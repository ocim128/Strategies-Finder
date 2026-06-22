import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
} from "../strategy-helpers";
import { buildCloseAcceptanceSeries, buildRangeSeries } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

type RangePercentileAcceptancePrepared = {
	data: OHLCVData[];
	ranges: number[];
	acceptance: number[];
	rangePercentileByLookback: Map<number, (number | null)[]>;
};

function normalizeRangePercentileParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
	};
}

function prepareRangePercentileData(data: OHLCVData[]): RangePercentileAcceptancePrepared {
	const clean = ensureCleanData(data);
	return {
		data: clean,
		ranges: buildRangeSeries(clean),
		acceptance: buildCloseAcceptanceSeries(clean),
		rangePercentileByLookback: new Map(),
	};
}

function getPreparedRangePercentileData(
	preparedData: unknown,
	data: OHLCVData[]
): RangePercentileAcceptancePrepared {
	if (preparedData && typeof preparedData === "object" && "rangePercentileByLookback" in preparedData) {
		return preparedData as RangePercentileAcceptancePrepared;
	}
	return prepareRangePercentileData(data);
}

export const range_percentile_acceptance_follow: Strategy = {
	name: "Range Percentile Acceptance Follow",
	description: "Enters a breakout when the range is in the top 80th percentile and close acceptance confirms direction.",
	defaultParams: {
		lookback: 30,
	},
	paramLabels: {
		lookback: "Lookback",
	},
	normalizeParams: normalizeRangePercentileParams,
	prepareFinderData: (data) => prepareRangePercentileData(data),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const prepared = getPreparedRangePercentileData(preparedData, data);
		const p = normalizeRangePercentileParams(params);
		const lookback = p.lookback as number;
		if (prepared.data.length < lookback) return [];

		let rangePercentile = prepared.rangePercentileByLookback.get(lookback);
		if (!rangePercentile) {
			rangePercentile = buildPercentileRank(prepared.ranges, lookback);
			prepared.rangePercentileByLookback.set(lookback, rangePercentile);
		}

		return createSignalLoop(prepared.data, [rangePercentile], (i) => {
			if (i < lookback) return null;
			const rp = rangePercentile[i];
			if (rp === null) return null;

			const acc = prepared.acceptance[i];

			if (rp > 0.80 && acc > 0.5) {
				return createBuySignal(prepared.data, i, `Range percentile (${rp.toFixed(2)}) > 0.80 with positive close acceptance (${acc.toFixed(2)}) > 0.5`);
			}
			if (rp > 0.80 && acc < -0.5) {
				return createSellSignal(prepared.data, i, `Range percentile (${rp.toFixed(2)}) > 0.80 with negative close acceptance (${acc.toFixed(2)}) < -0.5`);
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams) =>
		range_percentile_acceptance_follow.executePrepared?.(prepareRangePercentileData(data), params, data) ?? [],
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback"],
	},
};
