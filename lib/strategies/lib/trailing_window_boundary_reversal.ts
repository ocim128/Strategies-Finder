import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getTypicalPrices,
} from "../strategy-helpers";
import { buildRollingMinMax } from "./price-action-statistics-core";

type TrailingBoundaryPrepared = {
	data: OHLCVData[];
	typicalPrices: number[];
	minMaxByLookback: Map<number, { min: (number | null)[]; max: (number | null)[] }>;
};

function normalizeTrailingBoundaryParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 20))),
	};
}

function prepareTrailingBoundaryData(data: OHLCVData[]): TrailingBoundaryPrepared {
	const clean = ensureCleanData(data);
	return {
		data: clean,
		typicalPrices: getTypicalPrices(clean),
		minMaxByLookback: new Map(),
	};
}

function getPreparedTrailingBoundaryData(
	preparedData: unknown,
	data: OHLCVData[]
): TrailingBoundaryPrepared {
	if (preparedData && typeof preparedData === "object" && "minMaxByLookback" in preparedData) {
		return preparedData as TrailingBoundaryPrepared;
	}
	return prepareTrailingBoundaryData(data);
}

export const trailing_window_boundary_reversal: Strategy = {
	name: "Trailing Window Boundary Reversal",
	description: "Fades the ratio when typical price touches the trailing min/max boundary, and closes back inside.",
	defaultParams: {
		lookback: 20,
	},
	paramLabels: {
		lookback: "Lookback",
	},
	normalizeParams: normalizeTrailingBoundaryParams,
	prepareFinderData: (data) => prepareTrailingBoundaryData(data),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const prepared = getPreparedTrailingBoundaryData(preparedData, data);
		const p = normalizeTrailingBoundaryParams(params);
		const lookback = p.lookback as number;
		if (prepared.data.length < lookback + 1) return [];

		let minMax = prepared.minMaxByLookback.get(lookback);
		if (!minMax) {
			// includeCurrent = false to compare against preceding window
			minMax = buildRollingMinMax(prepared.typicalPrices, lookback, false);
			prepared.minMaxByLookback.set(lookback, minMax);
		}

		const { min, max } = minMax;

		return createSignalLoop(prepared.data, [min, max], (i) => {
			if (i < lookback) return null;
			const prevTypical = prepared.typicalPrices[i - 1];
			const currentTypical = prepared.typicalPrices[i];

			const prevMin = min[i - 1];
			const prevMax = max[i - 1];

			if (prevMin === null || prevMax === null) return null;

			if (prevTypical <= prevMin && currentTypical > prevTypical) {
				return createBuySignal(prepared.data, i, `Typical price rejection of trailing low: prevTypical (${prevTypical.toFixed(4)}) <= prevMin (${prevMin.toFixed(4)}) and currentTypical (${currentTypical.toFixed(4)}) > prevTypical`);
			}
			if (prevTypical >= prevMax && currentTypical < prevTypical) {
				return createSellSignal(prepared.data, i, `Typical price rejection of trailing high: prevTypical (${prevTypical.toFixed(4)}) >= prevMax (${prevMax.toFixed(4)}) and currentTypical (${currentTypical.toFixed(4)}) < prevTypical`);
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams) =>
		trailing_window_boundary_reversal.executePrepared?.(prepareTrailingBoundaryData(data), params, data) ?? [],
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback"],
	},
};
