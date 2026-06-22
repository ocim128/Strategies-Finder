import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
} from "../strategy-helpers";
import { buildInitiativePressureSeries } from "./price-action-frequency-core";
import { buildRateOfChange, buildRollingZScore, buildRollingCorrelation } from "./price-action-statistics-core";

type InitiativePressureCorrPrepared = {
	data: OHLCVData[];
	closes: number[];
	returnsClean: number[];
	zScoreByLookback: Map<number, (number | null)[]>;
	corrByLookback: Map<number, (number | null)[]>;
};

function normalizeInitiativeCorrParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(Number(params.lookback ?? 25))),
		threshold: Math.max(0.1, Number(params.threshold ?? 1.8)),
	};
}

function prepareInitiativeCorrData(data: OHLCVData[]): InitiativePressureCorrPrepared {
	const clean = ensureCleanData(data);
	const closes = getCloses(clean);
	const returns = buildRateOfChange(closes, 1);
	const returnsClean = returns.map(r => r ?? 0);
	return {
		data: clean,
		closes,
		returnsClean,
		zScoreByLookback: new Map(),
		corrByLookback: new Map(),
	};
}

function getPreparedInitiativeCorrData(preparedData: unknown, data: OHLCVData[]): InitiativePressureCorrPrepared {
	if (preparedData && typeof preparedData === "object" && "zScoreByLookback" in preparedData) {
		return preparedData as InitiativePressureCorrPrepared;
	}
	return prepareInitiativeCorrData(data);
}

export const initiative_pressure_correlation_reversal: Strategy = {
	name: "Initiative Pressure Correlation Reversal",
	description: "Fades the ratio when price is at z-score extremes and the correlation between returns and initiative pressure is negative.",
	defaultParams: {
		lookback: 25,
		threshold: 1.8,
	},
	paramLabels: {
		lookback: "Lookback Window",
		threshold: "Z-Score Threshold",
	},
	normalizeParams: normalizeInitiativeCorrParams,
	prepareFinderData: (data) => prepareInitiativeCorrData(data),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const prepared = getPreparedInitiativeCorrData(preparedData, data);
		const p = normalizeInitiativeCorrParams(params);
		const lookback = p.lookback as number;
		const threshold = p.threshold as number;
		if (prepared.data.length < lookback) return [];

		let zscore = prepared.zScoreByLookback.get(lookback);
		if (!zscore) {
			zscore = buildRollingZScore(prepared.closes, lookback);
			prepared.zScoreByLookback.set(lookback, zscore);
		}

		let corr = prepared.corrByLookback.get(lookback);
		if (!corr) {
			const initiative = buildInitiativePressureSeries(prepared.data, lookback);
			const initiativeClean = initiative.map(ip => ip ?? 0);
			corr = buildRollingCorrelation(prepared.returnsClean, initiativeClean, lookback);
			prepared.corrByLookback.set(lookback, corr);
		}

		return createSignalLoop(prepared.data, [zscore, corr], (i) => {
			if (i < lookback) return null;
			const z = zscore[i];
			const c = corr[i];
			if (z === null || c === null) return null;

			if (z <= -threshold && c < -0.10) {
				return createBuySignal(prepared.data, i, `Initiative pressure correlation buy: Close Z-Score (${z.toFixed(2)}) <= -${threshold.toFixed(2)} and correlation (${c.toFixed(2)}) < -0.10`);
			}
			if (z >= threshold && c < -0.10) {
				return createSellSignal(prepared.data, i, `Initiative pressure correlation sell: Close Z-Score (${z.toFixed(2)}) >= ${threshold.toFixed(2)} and correlation (${c.toFixed(2)}) < -0.10`);
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams) =>
		initiative_pressure_correlation_reversal.executePrepared?.(prepareInitiativeCorrData(data), params, data) ?? [],
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "threshold"],
	},
};
