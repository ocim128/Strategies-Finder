import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
} from "../strategy-helpers";
import { buildCloseAcceptanceSeries, buildRangeSeries, buildRollingAverage } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

type CloseAcceptanceMomentumPrepared = {
	data: OHLCVData[];
	acceptance: number[];
	range: number[];
	avgAcceptanceByLookback: Map<number, (number | null)[]>;
	rangePercentileByLookback: Map<number, (number | null)[]>;
};

function normalizeCloseAcceptanceMomParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 20))),
		threshold: Math.max(0.01, Number(params.threshold ?? 0.25)),
	};
}

function prepareCloseAcceptanceMomData(data: OHLCVData[]): CloseAcceptanceMomentumPrepared {
	const clean = ensureCleanData(data);
	const acceptance = buildCloseAcceptanceSeries(clean);
	const range = buildRangeSeries(clean);
	return {
		data: clean,
		acceptance,
		range,
		avgAcceptanceByLookback: new Map(),
		rangePercentileByLookback: new Map(),
	};
}

function getPreparedCloseAcceptanceMomData(preparedData: unknown, data: OHLCVData[]): CloseAcceptanceMomentumPrepared {
	if (preparedData && typeof preparedData === "object" && "avgAcceptanceByLookback" in preparedData) {
		return preparedData as CloseAcceptanceMomentumPrepared;
	}
	return prepareCloseAcceptanceMomData(data);
}

export const close_acceptance_momentum_breakout: Strategy = {
	name: "Close Acceptance Momentum Breakout",
	description: "Chases a breakout when the rolling average of close acceptance is strongly directional and the range is expanded.",
	defaultParams: {
		lookback: 20,
		threshold: 0.25,
	},
	paramLabels: {
		lookback: "Lookback Window",
		threshold: "Close Acceptance Threshold",
	},
	normalizeParams: normalizeCloseAcceptanceMomParams,
	prepareFinderData: (data) => prepareCloseAcceptanceMomData(data),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const prepared = getPreparedCloseAcceptanceMomData(preparedData, data);
		const p = normalizeCloseAcceptanceMomParams(params);
		const lookback = p.lookback as number;
		const threshold = p.threshold as number;
		if (prepared.data.length < lookback) return [];

		let avgAcceptance = prepared.avgAcceptanceByLookback.get(lookback);
		if (!avgAcceptance) {
			avgAcceptance = buildRollingAverage(prepared.acceptance, lookback);
			prepared.avgAcceptanceByLookback.set(lookback, avgAcceptance);
		}

		let rangePercentile = prepared.rangePercentileByLookback.get(lookback);
		if (!rangePercentile) {
			rangePercentile = buildPercentileRank(prepared.range, lookback);
			prepared.rangePercentileByLookback.set(lookback, rangePercentile);
		}

		return createSignalLoop(prepared.data, [avgAcceptance, rangePercentile], (i) => {
			if (i < lookback) return null;
			const avg = avgAcceptance[i];
			const pct = rangePercentile[i];
			if (avg === null || pct === null) return null;

			if (avg > threshold && pct > 0.70) {
				return createBuySignal(prepared.data, i, `Close acceptance buy breakout: average close acceptance (${avg.toFixed(2)}) > ${threshold.toFixed(2)} with range percentile (${pct.toFixed(2)}) > 0.70`);
			}
			if (avg < -threshold && pct > 0.70) {
				return createSellSignal(prepared.data, i, `Close acceptance sell breakout: average close acceptance (${avg.toFixed(2)}) < -${threshold.toFixed(2)} with range percentile (${pct.toFixed(2)}) > 0.70`);
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams) =>
		close_acceptance_momentum_breakout.executePrepared?.(prepareCloseAcceptanceMomData(data), params, data) ?? [],
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "threshold"],
	},
};
