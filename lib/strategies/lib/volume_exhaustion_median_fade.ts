import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
	getVolumes,
} from "../strategy-helpers";
import { buildRollingZScore, buildPercentileRank } from "./price-action-statistics-core";

type VolumeExhaustionPrepared = {
	data: OHLCVData[];
	closes: number[];
	volumes: number[];
	zScoreByLookback: Map<number, (number | null)[]>;
	percentileByLookback: Map<number, (number | null)[]>;
};

function normalizeVolumeExhaustionParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 40))),
		threshold: Math.max(0.1, Number(params.threshold ?? 2.0)),
	};
}

function prepareVolumeExhaustionData(data: OHLCVData[]): VolumeExhaustionPrepared {
	const clean = ensureCleanData(data);
	const closes = getCloses(clean);
	const volumes = getVolumes(clean);
	return {
		data: clean,
		closes,
		volumes,
		zScoreByLookback: new Map(),
		percentileByLookback: new Map(),
	};
}

function getPreparedVolumeExhaustionData(preparedData: unknown, data: OHLCVData[]): VolumeExhaustionPrepared {
	if (preparedData && typeof preparedData === "object" && "zScoreByLookback" in preparedData) {
		return preparedData as VolumeExhaustionPrepared;
	}
	return prepareVolumeExhaustionData(data);
}

export const volume_exhaustion_median_fade: Strategy = {
	name: "Volume Exhaustion Median Fade",
	description: "Fades ratio extensions that occur on low relative volume.",
	defaultParams: {
		lookback: 40,
		threshold: 2.0,
	},
	paramLabels: {
		lookback: "Lookback Window",
		threshold: "Z-Score Threshold",
	},
	normalizeParams: normalizeVolumeExhaustionParams,
	prepareFinderData: (data) => prepareVolumeExhaustionData(data),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const prepared = getPreparedVolumeExhaustionData(preparedData, data);
		const p = normalizeVolumeExhaustionParams(params);
		const lookback = p.lookback as number;
		const threshold = p.threshold as number;
		if (prepared.data.length < lookback) return [];

		let zscore = prepared.zScoreByLookback.get(lookback);
		if (!zscore) {
			zscore = buildRollingZScore(prepared.closes, lookback);
			prepared.zScoreByLookback.set(lookback, zscore);
		}

		let percentile = prepared.percentileByLookback.get(lookback);
		if (!percentile) {
			percentile = buildPercentileRank(prepared.volumes, lookback);
			prepared.percentileByLookback.set(lookback, percentile);
		}

		return createSignalLoop(prepared.data, [zscore, percentile], (i) => {
			if (i < lookback) return null;
			const z = zscore[i];
			const pct = percentile[i];
			if (z === null || pct === null) return null;

			if (z <= -threshold && pct < 0.30) {
				return createBuySignal(prepared.data, i, `Volume exhaustion buy: Close Z-Score (${z.toFixed(2)}) <= -${threshold.toFixed(2)} with volume percentile (${pct.toFixed(2)}) < 0.30`);
			}
			if (z >= threshold && pct < 0.30) {
				return createSellSignal(prepared.data, i, `Volume exhaustion sell: Close Z-Score (${z.toFixed(2)}) >= ${threshold.toFixed(2)} with volume percentile (${pct.toFixed(2)}) < 0.30`);
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams) =>
		volume_exhaustion_median_fade.executePrepared?.(prepareVolumeExhaustionData(data), params, data) ?? [],
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "threshold"],
	},
};
