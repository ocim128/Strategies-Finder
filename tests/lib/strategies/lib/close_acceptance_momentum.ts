import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
} from "../strategy-helpers";
import { buildCloseAcceptanceSeries, buildRollingAverage } from "./price-action-frequency-core";

type CloseAcceptancePrepared = {
	data: OHLCVData[];
	acceptance: number[];
	avgAcceptanceByLookback: Map<number, (number | null)[]>;
};

function normalizeCloseAcceptanceParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 20))),
		threshold: Math.max(0, Number(params.threshold ?? 0.30)),
	};
}

function prepareCloseAcceptanceData(data: OHLCVData[]): CloseAcceptancePrepared {
	const clean = ensureCleanData(data);
	return {
		data: clean,
		acceptance: buildCloseAcceptanceSeries(clean),
		avgAcceptanceByLookback: new Map(),
	};
}

function getPreparedCloseAcceptanceData(preparedData: unknown, data: OHLCVData[]): CloseAcceptancePrepared {
	if (preparedData && typeof preparedData === "object" && "avgAcceptanceByLookback" in preparedData) {
		return preparedData as CloseAcceptancePrepared;
	}
	return prepareCloseAcceptanceData(data);
}

export const close_acceptance_momentum: Strategy = {
	name: "Close Acceptance Momentum",
	description: "Chases a trend when the rolling average of close acceptance is positive or negative.",
	defaultParams: {
		lookback: 20,
		threshold: 0.30,
	},
	paramLabels: {
		lookback: "Lookback",
		threshold: "Threshold",
	},
	normalizeParams: normalizeCloseAcceptanceParams,
	prepareFinderData: (data) => prepareCloseAcceptanceData(data),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const prepared = getPreparedCloseAcceptanceData(preparedData, data);
		const p = normalizeCloseAcceptanceParams(params);
		const lookback = p.lookback as number;
		const threshold = p.threshold as number;
		if (prepared.data.length < lookback) return [];

		let avgAcceptance = prepared.avgAcceptanceByLookback.get(lookback);
		if (!avgAcceptance) {
			avgAcceptance = buildRollingAverage(prepared.acceptance, lookback);
			prepared.avgAcceptanceByLookback.set(lookback, avgAcceptance);
		}

		return createSignalLoop(prepared.data, [avgAcceptance], (i) => {
			if (i < lookback) return null;
			const avg = avgAcceptance[i];
			if (avg === null) return null;

			if (avg > threshold) {
				return createBuySignal(prepared.data, i, `Rolling average close acceptance (${avg.toFixed(2)}) > threshold (${threshold})`);
			}
			if (avg < -threshold) {
				return createSellSignal(prepared.data, i, `Rolling average close acceptance (${avg.toFixed(2)}) < -threshold (-${threshold})`);
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams) =>
		close_acceptance_momentum.executePrepared?.(prepareCloseAcceptanceData(data), params, data) ?? [],
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "threshold"],
	},
};
