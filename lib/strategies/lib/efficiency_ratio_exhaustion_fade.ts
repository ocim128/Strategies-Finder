import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
} from "../strategy-helpers";
import { buildRollingZScore, buildEfficiencyRatio } from "./price-action-statistics-core";

type EfficiencyRatioExhaustionPrepared = {
	data: OHLCVData[];
	closes: number[];
	zScoreByLookback: Map<number, (number | null)[]>;
	erByLookback: Map<number, (number | null)[]>;
};

function normalizeEfficiencyExhaustionParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 35))),
		threshold: Math.max(0.1, Number(params.threshold ?? 2.0)),
	};
}

function prepareEfficiencyExhaustionData(data: OHLCVData[]): EfficiencyRatioExhaustionPrepared {
	const clean = ensureCleanData(data);
	const closes = getCloses(clean);
	return {
		data: clean,
		closes,
		zScoreByLookback: new Map(),
		erByLookback: new Map(),
	};
}

function getPreparedEfficiencyExhaustionData(preparedData: unknown, data: OHLCVData[]): EfficiencyRatioExhaustionPrepared {
	if (preparedData && typeof preparedData === "object" && "zScoreByLookback" in preparedData) {
		return preparedData as EfficiencyRatioExhaustionPrepared;
	}
	return prepareEfficiencyExhaustionData(data);
}

export const efficiency_ratio_exhaustion_fade: Strategy = {
	name: "Efficiency Ratio Exhaustion Fade",
	description: "Fades a ratio move when it reaches z-score extremes but the rolling efficiency ratio is low.",
	defaultParams: {
		lookback: 35,
		threshold: 2.0,
	},
	paramLabels: {
		lookback: "Lookback Window",
		threshold: "Z-Score Threshold",
	},
	normalizeParams: normalizeEfficiencyExhaustionParams,
	prepareFinderData: (data) => prepareEfficiencyExhaustionData(data),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const prepared = getPreparedEfficiencyExhaustionData(preparedData, data);
		const p = normalizeEfficiencyExhaustionParams(params);
		const lookback = p.lookback as number;
		const threshold = p.threshold as number;
		if (prepared.data.length < lookback) return [];

		let zscore = prepared.zScoreByLookback.get(lookback);
		if (!zscore) {
			zscore = buildRollingZScore(prepared.closes, lookback);
			prepared.zScoreByLookback.set(lookback, zscore);
		}

		let er = prepared.erByLookback.get(lookback);
		if (!er) {
			er = buildEfficiencyRatio(prepared.data, lookback);
			prepared.erByLookback.set(lookback, er);
		}

		return createSignalLoop(prepared.data, [zscore, er], (i) => {
			if (i < lookback) return null;
			const z = zscore[i];
			const efficiency = er[i];
			if (z === null || efficiency === null) return null;

			if (z <= -threshold && efficiency < 0.20) {
				return createBuySignal(prepared.data, i, `Efficiency ratio exhaustion buy: Z-Score (${z.toFixed(2)}) <= -${threshold.toFixed(2)} with efficiency ratio (${efficiency.toFixed(2)}) < 0.20`);
			}
			if (z >= threshold && efficiency < 0.20) {
				return createSellSignal(prepared.data, i, `Efficiency ratio exhaustion sell: Z-Score (${z.toFixed(2)}) >= ${threshold.toFixed(2)} with efficiency ratio (${efficiency.toFixed(2)}) < 0.20`);
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams) =>
		efficiency_ratio_exhaustion_fade.executePrepared?.(prepareEfficiencyExhaustionData(data), params, data) ?? [],
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "threshold"],
	},
};
