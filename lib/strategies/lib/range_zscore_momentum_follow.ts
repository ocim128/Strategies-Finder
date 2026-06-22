import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
} from "../strategy-helpers";
import { buildCloseLocationSeries, buildRangeSeries } from "./price-action-frequency-core";
import { buildRollingZScore } from "./price-action-statistics-core";

type RangeZScorePrepared = {
	data: OHLCVData[];
	ranges: number[];
	closeLocation: number[];
	rangeZScoreByLookback: Map<number, (number | null)[]>;
};

function normalizeRangeZScoreParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 20))),
	};
}

function prepareRangeZScoreData(data: OHLCVData[]): RangeZScorePrepared {
	const clean = ensureCleanData(data);
	return {
		data: clean,
		ranges: buildRangeSeries(clean),
		closeLocation: buildCloseLocationSeries(clean),
		rangeZScoreByLookback: new Map(),
	};
}

function getPreparedRangeZScoreData(preparedData: unknown, data: OHLCVData[]): RangeZScorePrepared {
	if (preparedData && typeof preparedData === "object" && "rangeZScoreByLookback" in preparedData) {
		return preparedData as RangeZScorePrepared;
	}
	return prepareRangeZScoreData(data);
}

export const range_zscore_momentum_follow: Strategy = {
	name: "Range Z-Score Momentum Follow",
	description: "Chases a breakout when the z-score of true range exceeds 1.5, gated by directional close location.",
	defaultParams: {
		lookback: 20,
	},
	paramLabels: {
		lookback: "Lookback",
	},
	normalizeParams: normalizeRangeZScoreParams,
	prepareFinderData: (data) => prepareRangeZScoreData(data),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const prepared = getPreparedRangeZScoreData(preparedData, data);
		const p = normalizeRangeZScoreParams(params);
		const lookback = p.lookback as number;
		if (prepared.data.length < lookback) return [];

		let rangeZ = prepared.rangeZScoreByLookback.get(lookback);
		if (!rangeZ) {
			rangeZ = buildRollingZScore(prepared.ranges, lookback);
			prepared.rangeZScoreByLookback.set(lookback, rangeZ);
		}

		return createSignalLoop(prepared.data, [rangeZ], (i) => {
			if (i < lookback) return null;
			const rz = rangeZ[i];
			if (rz === null) return null;

			const cl = prepared.closeLocation[i];

			if (rz > 1.5 && cl > 0.7) {
				return createBuySignal(prepared.data, i, `Range Z-Score (${rz.toFixed(2)}) > 1.5 with close location (${cl.toFixed(2)}) > 0.7`);
			}
			if (rz > 1.5 && cl < 0.3) {
				return createSellSignal(prepared.data, i, `Range Z-Score (${rz.toFixed(2)}) > 1.5 with close location (${cl.toFixed(2)}) < 0.3`);
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams) =>
		range_zscore_momentum_follow.executePrepared?.(prepareRangeZScoreData(data), params, data) ?? [],
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback"],
	},
};
