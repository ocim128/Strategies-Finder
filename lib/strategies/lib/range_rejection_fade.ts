import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
} from "../strategy-helpers";
import { computePriceActionBarMetrics } from "./price-action-frequency-core";
import { buildRollingZScore } from "./price-action-statistics-core";

type RangeRejectionPrepared = {
	data: OHLCVData[];
	closes: number[];
	lowerWickRatios: number[];
	upperWickRatios: number[];
	zScoreByLookback: Map<number, (number | null)[]>;
};

function normalizeRangeRejectionParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
		threshold: Math.max(0, Number(params.threshold ?? 2.0)),
	};
}

function prepareRangeRejectionData(data: OHLCVData[]): RangeRejectionPrepared {
	const clean = ensureCleanData(data);
	const lowerWickRatios = new Array(clean.length);
	const upperWickRatios = new Array(clean.length);
	for (let i = 0; i < clean.length; i++) {
		const metrics = computePriceActionBarMetrics(clean[i]);
		lowerWickRatios[i] = metrics.range > 0 ? metrics.lowerWick / metrics.range : 0;
		upperWickRatios[i] = metrics.range > 0 ? metrics.upperWick / metrics.range : 0;
	}
	return {
		data: clean,
		closes: getCloses(clean),
		lowerWickRatios,
		upperWickRatios,
		zScoreByLookback: new Map(),
	};
}

function getPreparedRangeRejectionData(preparedData: unknown, data: OHLCVData[]): RangeRejectionPrepared {
	if (preparedData && typeof preparedData === "object" && "zScoreByLookback" in preparedData) {
		return preparedData as RangeRejectionPrepared;
	}
	return prepareRangeRejectionData(data);
}

export const range_rejection_fade: Strategy = {
	name: "Range Rejection Fade",
	description: "Fades a ratio extreme when a large-range bar prints a massive wick rejection.",
	defaultParams: {
		lookback: 30,
		threshold: 2.0,
	},
	paramLabels: {
		lookback: "Lookback",
		threshold: "Threshold",
	},
	normalizeParams: normalizeRangeRejectionParams,
	prepareFinderData: (data) => prepareRangeRejectionData(data),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const prepared = getPreparedRangeRejectionData(preparedData, data);
		const p = normalizeRangeRejectionParams(params);
		const lookback = p.lookback as number;
		const threshold = p.threshold as number;
		if (prepared.data.length < lookback) return [];

		let zscore = prepared.zScoreByLookback.get(lookback);
		if (!zscore) {
			zscore = buildRollingZScore(prepared.closes, lookback);
			prepared.zScoreByLookback.set(lookback, zscore);
		}

		return createSignalLoop(prepared.data, [zscore], (i) => {
			if (i < lookback) return null;
			const z = zscore[i];
			if (z === null) return null;

			const lowerWickRatio = prepared.lowerWickRatios[i];
			const upperWickRatio = prepared.upperWickRatios[i];

			if (z <= -threshold && lowerWickRatio > 0.40) {
				return createBuySignal(prepared.data, i, `Extremely low Z-Score (${z.toFixed(2)}) with lower wick rejection (${lowerWickRatio.toFixed(2)} > 0.40)`);
			}
			if (z >= threshold && upperWickRatio > 0.40) {
				return createSellSignal(prepared.data, i, `Extremely high Z-Score (${z.toFixed(2)}) with upper wick rejection (${upperWickRatio.toFixed(2)} > 0.40)`);
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams) =>
		range_rejection_fade.executePrepared?.(prepareRangeRejectionData(data), params, data) ?? [],
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "threshold"],
	},
};
