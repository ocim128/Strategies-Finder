import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
} from "../strategy-helpers";
import { buildCloseAcceptanceSeries, buildRollingAverage } from "./price-action-frequency-core";

type CloseAcceptanceAccumulationPrepared = {
	data: OHLCVData[];
	acceptance: number[];
	avgByLookback: Map<number, (number | null)[]>;
};

function normalizeAccumulationParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 20))),
	};
}

function prepareAccumulationData(data: OHLCVData[]): CloseAcceptanceAccumulationPrepared {
	const clean = ensureCleanData(data);
	const acceptance = buildCloseAcceptanceSeries(clean);
	return {
		data: clean,
		acceptance,
		avgByLookback: new Map(),
	};
}

function getPreparedAccumulationData(preparedData: unknown, data: OHLCVData[]): CloseAcceptanceAccumulationPrepared {
	if (preparedData && typeof preparedData === "object" && "avgByLookback" in preparedData) {
		return preparedData as CloseAcceptanceAccumulationPrepared;
	}
	return prepareAccumulationData(data);
}

export const close_acceptance_accumulation_fade: Strategy = {
	name: "Close Acceptance Accumulation Fade",
	description: "Fades the ratio when the rolling sum of close acceptance over a window is extremely high or low.",
	defaultParams: {
		lookback: 20,
	},
	paramLabels: {
		lookback: "Lookback Window",
	},
	normalizeParams: normalizeAccumulationParams,
	prepareFinderData: (data) => prepareAccumulationData(data),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const prepared = getPreparedAccumulationData(preparedData, data);
		const p = normalizeAccumulationParams(params);
		const lookback = p.lookback as number;
		if (prepared.data.length < lookback) return [];

		let smoothed = prepared.avgByLookback.get(lookback);
		if (!smoothed) {
			smoothed = buildRollingAverage(prepared.acceptance, lookback);
			prepared.avgByLookback.set(lookback, smoothed);
		}

		return createSignalLoop(prepared.data, [smoothed], (i) => {
			if (i < lookback) return null;
			const avgVal = smoothed[i];
			if (avgVal === null) return null;

			const sum = avgVal * lookback;
			const threshold = 0.6 * lookback;

			if (sum <= -threshold) {
				return createBuySignal(prepared.data, i, `Close acceptance accumulation negative extreme: sum (${sum.toFixed(2)}) <= -${threshold.toFixed(2)}`);
			}
			if (sum >= threshold) {
				return createSellSignal(prepared.data, i, `Close acceptance accumulation positive extreme: sum (${sum.toFixed(2)}) >= ${threshold.toFixed(2)}`);
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams) =>
		close_acceptance_accumulation_fade.executePrepared?.(prepareAccumulationData(data), params, data) ?? [],
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback"],
	},
};
