import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getVolumes,
} from "../strategy-helpers";
import { buildCloseLocationSeries, buildRangeSeries } from "./price-action-frequency-core";
import { buildPercentileRank, buildRollingMedian } from "./price-action-statistics-core";

type VolumeGatedPrepared = {
	data: OHLCVData[];
	ranges: number[];
	volumes: number[];
	closeLocation: number[];
	medianRangeByLookback: Map<number, (number | null)[]>;
	volPercentileByLookback: Map<number, (number | null)[]>;
};

function normalizeVolumeGatedParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 20))),
	};
}

function prepareVolumeGatedData(data: OHLCVData[]): VolumeGatedPrepared {
	const clean = ensureCleanData(data);
	return {
		data: clean,
		ranges: buildRangeSeries(clean),
		volumes: getVolumes(clean),
		closeLocation: buildCloseLocationSeries(clean),
		medianRangeByLookback: new Map(),
		volPercentileByLookback: new Map(),
	};
}

function getPreparedVolumeGatedData(preparedData: unknown, data: OHLCVData[]): VolumeGatedPrepared {
	if (preparedData && typeof preparedData === "object" && "volPercentileByLookback" in preparedData) {
		return preparedData as VolumeGatedPrepared;
	}
	return prepareVolumeGatedData(data);
}

export const volume_gated_range_expansion: Strategy = {
	name: "Volume-Gated Range Expansion",
	description: "Chases a breakout when range expands beyond its median and proxy volume is in the top 30% of history.",
	defaultParams: {
		lookback: 20,
	},
	paramLabels: {
		lookback: "Lookback",
	},
	normalizeParams: normalizeVolumeGatedParams,
	prepareFinderData: (data) => prepareVolumeGatedData(data),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const prepared = getPreparedVolumeGatedData(preparedData, data);
		const p = normalizeVolumeGatedParams(params);
		const lookback = p.lookback as number;
		if (prepared.data.length < lookback) return [];

		let medianRange = prepared.medianRangeByLookback.get(lookback);
		if (!medianRange) {
			medianRange = buildRollingMedian(prepared.ranges, lookback);
			prepared.medianRangeByLookback.set(lookback, medianRange);
		}

		let volPercentile = prepared.volPercentileByLookback.get(lookback);
		if (!volPercentile) {
			volPercentile = buildPercentileRank(prepared.volumes, lookback);
			prepared.volPercentileByLookback.set(lookback, volPercentile);
		}

		return createSignalLoop(prepared.data, [medianRange, volPercentile], (i) => {
			if (i < lookback) return null;
			const med = medianRange[i];
			const vp = volPercentile[i];
			if (med === null || vp === null) return null;

			const range = prepared.ranges[i];
			const cl = prepared.closeLocation[i];

			if (range > med && vp > 0.70 && cl > 0.75) {
				return createBuySignal(prepared.data, i, `Volume-gated breakout: range (${range.toFixed(4)} > ${med.toFixed(4)}) and volume percentile (${vp.toFixed(2)}) > 0.70 with close location (${cl.toFixed(2)}) > 0.75`);
			}
			if (range > med && vp > 0.70 && cl < 0.25) {
				return createSellSignal(prepared.data, i, `Volume-gated breakdown: range (${range.toFixed(4)} > ${med.toFixed(4)}) and volume percentile (${vp.toFixed(2)}) > 0.70 with close location (${cl.toFixed(2)}) < 0.25`);
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams) =>
		volume_gated_range_expansion.executePrepared?.(prepareVolumeGatedData(data), params, data) ?? [],
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback"],
	},
};
