import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
} from "../strategy-helpers";
import { buildRollingZScore } from "./price-action-statistics-core";

type ZScorePrepared = {
	data: OHLCVData[];
	closes: number[];
	zScoreByLookback: Map<number, (number | null)[]>;
};

function normalizeZScoreParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 50))),
		threshold: Math.max(0, Number(params.threshold ?? 2.0)),
	};
}

function prepareZScoreData(data: OHLCVData[]): ZScorePrepared {
	const clean = ensureCleanData(data);
	return {
		data: clean,
		closes: getCloses(clean),
		zScoreByLookback: new Map(),
	};
}

function getPreparedZScoreData(preparedData: unknown, data: OHLCVData[]): ZScorePrepared {
	if (preparedData && typeof preparedData === "object" && "zScoreByLookback" in preparedData) {
		return preparedData as ZScorePrepared;
	}
	return prepareZScoreData(data);
}

export const ratio_mean_reversion_zscore: Strategy = {
	name: "Ratio Mean Reversion Z-Score",
	description: "Fades the ratio when it deviates significantly from its rolling average.",
	defaultParams: {
		lookback: 50,
		threshold: 2.0,
	},
	paramLabels: {
		lookback: "Lookback",
		threshold: "Threshold",
	},
	normalizeParams: normalizeZScoreParams,
	prepareFinderData: (data) => prepareZScoreData(data),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const prepared = getPreparedZScoreData(preparedData, data);
		const p = normalizeZScoreParams(params);
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

			if (z <= -threshold) {
				return createBuySignal(prepared.data, i, `Z-Score (${z.toFixed(2)}) <= -threshold (${threshold})`);
			}
			if (z >= threshold) {
				return createSellSignal(prepared.data, i, `Z-Score (${z.toFixed(2)}) >= threshold (${threshold})`);
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams) =>
		ratio_mean_reversion_zscore.executePrepared?.(prepareZScoreData(data), params, data) ?? [],
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "threshold"],
	},
};
