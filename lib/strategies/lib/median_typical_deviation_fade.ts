import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getTypicalPrices,
} from "../strategy-helpers";
import { buildRollingMedian, buildRollingZScore } from "./price-action-statistics-core";

type MedianTypicalDeviationPrepared = {
	data: OHLCVData[];
	typicalPrices: number[];
	medianByLookback: Map<number, (number | null)[]>;
	zScoreByLookback: Map<number, (number | null)[]>;
};

function normalizeMedianTypicalDeviationParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
	};
}

function prepareMedianTypicalDeviationData(data: OHLCVData[]): MedianTypicalDeviationPrepared {
	const clean = ensureCleanData(data);
	return {
		data: clean,
		typicalPrices: getTypicalPrices(clean),
		medianByLookback: new Map(),
		zScoreByLookback: new Map(),
	};
}

function getPreparedMedianTypicalDeviationData(
	preparedData: unknown,
	data: OHLCVData[]
): MedianTypicalDeviationPrepared {
	if (preparedData && typeof preparedData === "object" && "zScoreByLookback" in preparedData) {
		return preparedData as MedianTypicalDeviationPrepared;
	}
	return prepareMedianTypicalDeviationData(data);
}

export const median_typical_deviation_fade: Strategy = {
	name: "Median Typical Deviation Fade",
	description: "Fades the typical price when its deviation from its rolling median is extreme.",
	defaultParams: {
		lookback: 30,
	},
	paramLabels: {
		lookback: "Lookback",
	},
	normalizeParams: normalizeMedianTypicalDeviationParams,
	prepareFinderData: (data) => prepareMedianTypicalDeviationData(data),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const prepared = getPreparedMedianTypicalDeviationData(preparedData, data);
		const p = normalizeMedianTypicalDeviationParams(params);
		const lookback = p.lookback as number;
		if (prepared.data.length < lookback) return [];

		let median = prepared.medianByLookback.get(lookback);
		if (!median) {
			median = buildRollingMedian(prepared.typicalPrices, lookback);
			prepared.medianByLookback.set(lookback, median);
		}

		let zscore = prepared.zScoreByLookback.get(lookback);
		if (!zscore) {
			const deviation = prepared.typicalPrices.map((tp, idx) => {
				const m = median![idx];
				return m !== null ? tp - m : 0;
			});
			zscore = buildRollingZScore(deviation, lookback);
			prepared.zScoreByLookback.set(lookback, zscore);
		}

		return createSignalLoop(prepared.data, [zscore], (i) => {
			if (i < lookback) return null;
			const z = zscore[i];
			if (z === null) return null;

			if (z <= -2.0) {
				return createBuySignal(prepared.data, i, `Typical price median deviation Z-Score (${z.toFixed(2)}) <= -2.0`);
			}
			if (z >= 2.0) {
				return createSellSignal(prepared.data, i, `Typical price median deviation Z-Score (${z.toFixed(2)}) >= 2.0`);
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams) =>
		median_typical_deviation_fade.executePrepared?.(prepareMedianTypicalDeviationData(data), params, data) ?? [],
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback"],
	},
};
