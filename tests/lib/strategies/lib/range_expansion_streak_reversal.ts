import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getTypicalPrices,
} from "../strategy-helpers";
import { buildRangeSeries } from "./price-action-frequency-core";
import { buildRollingZScore } from "./price-action-statistics-core";

type RangeExpansionPrepared = {
	data: OHLCVData[];
	range: number[];
	typicalPrices: number[];
	zScoreByLookback: Map<number, (number | null)[]>;
};

function normalizeRangeExpansionParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
	};
}

function prepareRangeExpansionData(data: OHLCVData[]): RangeExpansionPrepared {
	const clean = ensureCleanData(data);
	const range = buildRangeSeries(clean);
	const typicalPrices = getTypicalPrices(clean);
	return {
		data: clean,
		range,
		typicalPrices,
		zScoreByLookback: new Map(),
	};
}

function getPreparedRangeExpansionData(preparedData: unknown, data: OHLCVData[]): RangeExpansionPrepared {
	if (preparedData && typeof preparedData === "object" && "zScoreByLookback" in preparedData) {
		return preparedData as RangeExpansionPrepared;
	}
	return prepareRangeExpansionData(data);
}

export const range_expansion_streak_reversal: Strategy = {
	name: "Range Expansion Streak Reversal",
	description: "Fades range expansions when the range has expanded for 3 consecutive bars and typical price z-score is at an extreme.",
	defaultParams: {
		lookback: 30,
	},
	paramLabels: {
		lookback: "Z-Score Lookback Window",
	},
	normalizeParams: normalizeRangeExpansionParams,
	prepareFinderData: (data) => prepareRangeExpansionData(data),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const prepared = getPreparedRangeExpansionData(preparedData, data);
		const p = normalizeRangeExpansionParams(params);
		const lookback = p.lookback as number;
		if (prepared.data.length < lookback) return [];

		let zscore = prepared.zScoreByLookback.get(lookback);
		if (!zscore) {
			zscore = buildRollingZScore(prepared.typicalPrices, lookback);
			prepared.zScoreByLookback.set(lookback, zscore);
		}

		return createSignalLoop(prepared.data, [zscore], (i) => {
			if (i < 3) return null;
			const z = zscore[i];
			if (z === null) return null;

			// Range expanded for 3 consecutive bars
			const rCurr = prepared.range[i];
			const rPrev1 = prepared.range[i - 1];
			const rPrev2 = prepared.range[i - 2];
			const rPrev3 = prepared.range[i - 3];

			const rangeExpanded = rCurr > rPrev1 && rPrev1 > rPrev2 && rPrev2 > rPrev3;

			if (rangeExpanded) {
				if (z <= -1.8) {
					return createBuySignal(prepared.data, i, `Range expansion streak buy reversal: 3 bars range expansion with typical price Z-Score (${z.toFixed(2)}) <= -1.8`);
				}
				if (z >= 1.8) {
					return createSellSignal(prepared.data, i, `Range expansion streak sell reversal: 3 bars range expansion with typical price Z-Score (${z.toFixed(2)}) >= 1.8`);
				}
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams) =>
		range_expansion_streak_reversal.executePrepared?.(prepareRangeExpansionData(data), params, data) ?? [],
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback"],
	},
};
