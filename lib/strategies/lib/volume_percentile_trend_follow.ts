import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
	getVolumes,
} from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildPercentileRank, buildRollingMedian } from "./price-action-statistics-core";

type VolumePercentilePrepared = {
	data: OHLCVData[];
	closes: number[];
	volumes: number[];
	closeLocation: number[];
	medianByLookback: Map<number, (number | null)[]>;
	volPercentileByLookback: Map<number, (number | null)[]>;
};

function normalizeVolumePercentileParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 25))),
		threshold: Math.max(0.01, Math.min(0.99, Number(params.threshold ?? 0.75))),
	};
}

function prepareVolumePercentileData(data: OHLCVData[]): VolumePercentilePrepared {
	const clean = ensureCleanData(data);
	return {
		data: clean,
		closes: getCloses(clean),
		volumes: getVolumes(clean),
		closeLocation: buildCloseLocationSeries(clean),
		medianByLookback: new Map(),
		volPercentileByLookback: new Map(),
	};
}

function getPreparedVolumePercentileData(preparedData: unknown, data: OHLCVData[]): VolumePercentilePrepared {
	if (preparedData && typeof preparedData === "object" && "volPercentileByLookback" in preparedData) {
		return preparedData as VolumePercentilePrepared;
	}
	return prepareVolumePercentileData(data);
}

export const volume_percentile_trend_follow: Strategy = {
	name: "Volume Percentile Trend Follow",
	description: "Chases trends only when the price movement is accompanied by high relative proxy volume.",
	defaultParams: {
		lookback: 25,
		threshold: 0.75,
	},
	paramLabels: {
		lookback: "Lookback",
		threshold: "Volume Percentile Threshold",
	},
	normalizeParams: normalizeVolumePercentileParams,
	prepareFinderData: (data) => prepareVolumePercentileData(data),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const prepared = getPreparedVolumePercentileData(preparedData, data);
		const p = normalizeVolumePercentileParams(params);
		const lookback = p.lookback as number;
		const threshold = p.threshold as number;
		if (prepared.data.length < lookback) return [];

		let median = prepared.medianByLookback.get(lookback);
		if (!median) {
			median = buildRollingMedian(prepared.closes, lookback);
			prepared.medianByLookback.set(lookback, median);
		}

		let volPercentile = prepared.volPercentileByLookback.get(lookback);
		if (!volPercentile) {
			volPercentile = buildPercentileRank(prepared.volumes, lookback);
			prepared.volPercentileByLookback.set(lookback, volPercentile);
		}

		return createSignalLoop(prepared.data, [median, volPercentile], (i) => {
			if (i < lookback) return null;
			const m = median[i];
			const vp = volPercentile[i];
			if (m === null || vp === null) return null;

			const close = prepared.closes[i];
			const cl = prepared.closeLocation[i];

			if (close > m && vp > threshold && cl > 0.7) {
				return createBuySignal(prepared.data, i, `Trend up breakout: close above median (${close.toFixed(4)} > ${m.toFixed(4)}) with volume percentile (${vp.toFixed(2)}) > threshold (${threshold})`);
			}
			if (close < m && vp > threshold && cl < 0.3) {
				return createSellSignal(prepared.data, i, `Trend down breakout: close below median (${close.toFixed(4)} < ${m.toFixed(4)}) with volume percentile (${vp.toFixed(2)}) > threshold (${threshold})`);
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams) =>
		volume_percentile_trend_follow.executePrepared?.(prepareVolumePercentileData(data), params, data) ?? [],
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "threshold"],
	},
};
