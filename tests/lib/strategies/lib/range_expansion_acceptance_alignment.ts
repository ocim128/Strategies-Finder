import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
} from "../strategy-helpers";
import { buildRangeSeries, buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildRollingMedian } from "./price-action-statistics-core";

type RangeExpansionAcceptancePrepared = {
	data: OHLCVData[];
	range: number[];
	acceptance: number[];
	medianByLookback: Map<number, (number | null)[]>;
};

function normalizeRangeExpansionAcceptanceParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 25))),
		threshold: Math.max(0.01, Number(params.threshold ?? 0.50)),
	};
}

function prepareRangeExpansionAcceptanceData(data: OHLCVData[]): RangeExpansionAcceptancePrepared {
	const clean = ensureCleanData(data);
	const range = buildRangeSeries(clean);
	const acceptance = buildCloseAcceptanceSeries(clean);
	return {
		data: clean,
		range,
		acceptance,
		medianByLookback: new Map(),
	};
}

function getPreparedRangeExpansionAcceptanceData(preparedData: unknown, data: OHLCVData[]): RangeExpansionAcceptancePrepared {
	if (preparedData && typeof preparedData === "object" && "medianByLookback" in preparedData) {
		return preparedData as RangeExpansionAcceptancePrepared;
	}
	return prepareRangeExpansionAcceptanceData(data);
}

export const range_expansion_acceptance_alignment: Strategy = {
	name: "Range Expansion Acceptance Alignment",
	description: "Chases a breakout when range expands above its rolling median and close acceptance is strongly directional.",
	defaultParams: {
		lookback: 25,
		threshold: 0.50,
	},
	paramLabels: {
		lookback: "Lookback Window",
		threshold: "Close Acceptance Threshold",
	},
	normalizeParams: normalizeRangeExpansionAcceptanceParams,
	prepareFinderData: (data) => prepareRangeExpansionAcceptanceData(data),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const prepared = getPreparedRangeExpansionAcceptanceData(preparedData, data);
		const p = normalizeRangeExpansionAcceptanceParams(params);
		const lookback = p.lookback as number;
		const threshold = p.threshold as number;
		if (prepared.data.length < lookback) return [];

		let rangeMedian = prepared.medianByLookback.get(lookback);
		if (!rangeMedian) {
			rangeMedian = buildRollingMedian(prepared.range, lookback);
			prepared.medianByLookback.set(lookback, rangeMedian);
		}

		return createSignalLoop(prepared.data, [rangeMedian], (i) => {
			if (i < lookback) return null;
			const median = rangeMedian[i];
			if (median === null) return null;

			const r = prepared.range[i];
			const acc = prepared.acceptance[i];

			if (r > median) {
				if (acc > threshold) {
					return createBuySignal(prepared.data, i, `Range expansion acceptance buy: range (${r.toFixed(4)}) > median (${median.toFixed(4)}) and close acceptance (${acc.toFixed(2)}) > ${threshold.toFixed(2)}`);
				}
				if (acc < -threshold) {
					return createSellSignal(prepared.data, i, `Range expansion acceptance sell: range (${r.toFixed(4)}) > median (${median.toFixed(4)}) and close acceptance (${acc.toFixed(2)}) < -${threshold.toFixed(2)}`);
				}
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams) =>
		range_expansion_acceptance_alignment.executePrepared?.(prepareRangeExpansionAcceptanceData(data), params, data) ?? [],
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "threshold"],
	},
};
