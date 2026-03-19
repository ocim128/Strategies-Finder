import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getHighs, getLows } from "../strategy-helpers";
import { calculateATR, calculateVolumeProfile } from "../indicators";
import { buildRollingMedian } from "./price-action-statistics-core";

function normalizeVolumeProfilePocMedianShiftParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		vpPeriod: Math.max(5, Math.round(Number(params.vpPeriod ?? 50))),
		medianLookback: Math.max(2, Math.round(Number(params.medianLookback ?? 20))),
		shiftThreshold: Math.max(0, Number(params.shiftThreshold ?? 2)),
	};
}

type VolumeProfilePocMedianShiftPrepared = {
	cleanData: OHLCVData[];
	closes: number[];
	atr: (number | null)[];
	pocSeriesByPeriod: Map<number, number[]>;
	pocMedianByKey: Map<string, (number | null)[]>;
};

function prepareVolumeProfilePocMedianShiftData(data: OHLCVData[]): VolumeProfilePocMedianShiftPrepared {
	const cleanData = ensureCleanData(data);
	const closes = getCloses(cleanData);

	return {
		cleanData,
		closes,
		atr: calculateATR(getHighs(cleanData), getLows(cleanData), closes, 14),
		pocSeriesByPeriod: new Map<number, number[]>(),
		pocMedianByKey: new Map<string, (number | null)[]>(),
	};
}

function getPreparedVolumeProfilePocMedianShiftData(
	preparedData: unknown,
	data: OHLCVData[]
): VolumeProfilePocMedianShiftPrepared {
	if (preparedData && typeof preparedData === "object" && "pocSeriesByPeriod" in preparedData) {
		return preparedData as VolumeProfilePocMedianShiftPrepared;
	}
	return prepareVolumeProfilePocMedianShiftData(data);
}

export const volume_profile_poc_median_shift: Strategy = {
	name: "Volume Profile POC Median Shift",
	description: "Builds a median baseline from the rolling POC itself and enters only when price escapes that value anchor by a large ATR-normalized amount.",
	defaultParams: {
		vpPeriod: 50,
		medianLookback: 20,
		shiftThreshold: 2,
	},
	paramLabels: {
		vpPeriod: "VP Period",
		medianLookback: "Median Lookback",
		shiftThreshold: "Shift Threshold",
	},
	normalizeParams: normalizeVolumeProfilePocMedianShiftParams,
	prepareFinderData: (data) => prepareVolumeProfilePocMedianShiftData(data),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const prepared = getPreparedVolumeProfilePocMedianShiftData(preparedData, data);
		const { cleanData, closes, atr, pocSeriesByPeriod, pocMedianByKey } = prepared;
		const normalizedParams = normalizeVolumeProfilePocMedianShiftParams(params);
		const vpPeriod = normalizedParams.vpPeriod as number;
		const medianLookback = normalizedParams.medianLookback as number;
		const shiftThreshold = normalizedParams.shiftThreshold as number;

		if (cleanData.length < Math.max(vpPeriod, medianLookback, 14)) return [];

		let pocSeries = pocSeriesByPeriod.get(vpPeriod);
		if (!pocSeries) {
			const { poc } = calculateVolumeProfile(cleanData, vpPeriod, 24);
			pocSeries = poc.map((value, i) => value ?? closes[i]);
			pocSeriesByPeriod.set(vpPeriod, pocSeries);
		}

		const pocMedianKey = `${vpPeriod}:${medianLookback}`;
		let pocMedian = pocMedianByKey.get(pocMedianKey);
		if (!pocMedian) {
			pocMedian = buildRollingMedian(pocSeries, medianLookback);
			pocMedianByKey.set(pocMedianKey, pocMedian);
		}

		return createSignalLoop(cleanData, [], (i) => {
			if (pocMedian[i] === null || atr[i] === null) return null;
			const thresholdDistance = atr[i]! * shiftThreshold;

			if (cleanData[i].close > pocMedian[i]! + thresholdDistance) {
				return createBuySignal(cleanData, i, "Volume profile POC median shift long");
			}
			if (cleanData[i].close < pocMedian[i]! - thresholdDistance) {
				return createSellSignal(cleanData, i, "Volume profile POC median shift short");
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams) =>
		volume_profile_poc_median_shift.executePrepared?.(prepareVolumeProfilePocMedianShiftData(data), params, data) ?? [],
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["vpPeriod", "medianLookback", "shiftThreshold"],
	},
};
