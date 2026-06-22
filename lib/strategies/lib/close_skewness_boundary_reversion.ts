import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	checkCrossover,
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getTypicalPrices,
} from "../strategy-helpers";
import { buildRollingMedian, buildRollingSkewness } from "./price-action-statistics-core";

type CloseSkewnessPrepared = {
	data: OHLCVData[];
	typicalPrices: number[];
	medianByLookback: Map<number, (number | null)[]>;
	skewnessByLookback: Map<number, (number | null)[]>;
};

function normalizeCloseSkewnessParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 35))),
	};
}

function prepareCloseSkewnessData(data: OHLCVData[]): CloseSkewnessPrepared {
	const clean = ensureCleanData(data);
	return {
		data: clean,
		typicalPrices: getTypicalPrices(clean),
		medianByLookback: new Map(),
		skewnessByLookback: new Map(),
	};
}

function getPreparedCloseSkewnessData(preparedData: unknown, data: OHLCVData[]): CloseSkewnessPrepared {
	if (preparedData && typeof preparedData === "object" && "skewnessByLookback" in preparedData) {
		return preparedData as CloseSkewnessPrepared;
	}
	return prepareCloseSkewnessData(data);
}

export const close_skewness_boundary_reversion: Strategy = {
	name: "Close Skewness Boundary Reversion",
	description: "Fades the typical price when its distribution skewness is at extremes and crosses back over the median.",
	defaultParams: {
		lookback: 35,
	},
	paramLabels: {
		lookback: "Lookback",
	},
	normalizeParams: normalizeCloseSkewnessParams,
	prepareFinderData: (data) => prepareCloseSkewnessData(data),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const prepared = getPreparedCloseSkewnessData(preparedData, data);
		const p = normalizeCloseSkewnessParams(params);
		const lookback = p.lookback as number;
		if (prepared.data.length < lookback + 1) return [];

		let median = prepared.medianByLookback.get(lookback);
		if (!median) {
			median = buildRollingMedian(prepared.typicalPrices, lookback);
			prepared.medianByLookback.set(lookback, median);
		}

		let skewness = prepared.skewnessByLookback.get(lookback);
		if (!skewness) {
			skewness = buildRollingSkewness(prepared.typicalPrices, lookback);
			prepared.skewnessByLookback.set(lookback, skewness);
		}

		return createSignalLoop(prepared.data, [median, skewness], (i) => {
			if (i < lookback) return null;
			const skew = skewness[i];
			const med = median[i];
			if (skew === null || med === null) return null;

			// checkCrossover takes (fast, slow, index)
			const cross = checkCrossover(prepared.typicalPrices, median!, i);

			if (skew < -1.5 && cross === "bullish") {
				return createBuySignal(prepared.data, i, `Bullish reversion: skewness (${skew.toFixed(2)}) < -1.5 and typicalPrice crossed above rolling median`);
			}
			if (skew > 1.5 && cross === "bearish") {
				return createSellSignal(prepared.data, i, `Bearish reversion: skewness (${skew.toFixed(2)}) > 1.5 and typicalPrice crossed below rolling median`);
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams) =>
		close_skewness_boundary_reversion.executePrepared?.(prepareCloseSkewnessData(data), params, data) ?? [],
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback"],
	},
};
