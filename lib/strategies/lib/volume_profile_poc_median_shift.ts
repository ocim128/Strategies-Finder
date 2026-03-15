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
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const normalizedParams = normalizeVolumeProfilePocMedianShiftParams(params);
		const vpPeriod = normalizedParams.vpPeriod as number;
		const medianLookback = normalizedParams.medianLookback as number;
		const shiftThreshold = normalizedParams.shiftThreshold as number;

		if (cleanData.length < Math.max(vpPeriod, medianLookback, 14)) return [];

		const { poc } = calculateVolumeProfile(cleanData, vpPeriod, 24);
		const pocMedian = buildRollingMedian(poc.map((value, i) => value ?? cleanData[i].close), medianLookback);
		const atr = calculateATR(getHighs(cleanData), getLows(cleanData), getCloses(cleanData), 14);

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
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["vpPeriod", "medianLookback", "shiftThreshold"],
	},
};
