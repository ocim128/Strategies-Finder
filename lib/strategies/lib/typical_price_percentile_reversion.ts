import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getTypicalPrices,
} from "../strategy-helpers";
import { buildPercentileRank } from "./price-action-statistics-core";

type TypicalPricePercentilePrepared = {
	data: OHLCVData[];
	typicalPrices: number[];
	percentileByLookback: Map<number, (number | null)[]>;
};

function normalizeTypicalPercentileParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 50))),
		threshold: Math.max(0.001, Math.min(0.499, Number(params.threshold ?? 0.05))),
	};
}

function prepareTypicalPercentileData(data: OHLCVData[]): TypicalPricePercentilePrepared {
	const clean = ensureCleanData(data);
	return {
		data: clean,
		typicalPrices: getTypicalPrices(clean),
		percentileByLookback: new Map(),
	};
}

function getPreparedTypicalPercentileData(preparedData: unknown, data: OHLCVData[]): TypicalPricePercentilePrepared {
	if (preparedData && typeof preparedData === "object" && "percentileByLookback" in preparedData) {
		return preparedData as TypicalPricePercentilePrepared;
	}
	return prepareTypicalPercentileData(data);
}

export const typical_price_percentile_reversion: Strategy = {
	name: "Typical Price Percentile Reversion",
	description: "Fades the typical price when its rolling percentile rank reaches statistical tails (< threshold or > 1 - threshold).",
	defaultParams: {
		lookback: 50,
		threshold: 0.05,
	},
	paramLabels: {
		lookback: "Lookback",
		threshold: "Percentile Threshold",
	},
	normalizeParams: normalizeTypicalPercentileParams,
	prepareFinderData: (data) => prepareTypicalPercentileData(data),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const prepared = getPreparedTypicalPercentileData(preparedData, data);
		const p = normalizeTypicalPercentileParams(params);
		const lookback = p.lookback as number;
		const threshold = p.threshold as number;
		if (prepared.data.length < lookback) return [];

		let percentiles = prepared.percentileByLookback.get(lookback);
		if (!percentiles) {
			percentiles = buildPercentileRank(prepared.typicalPrices, lookback);
			prepared.percentileByLookback.set(lookback, percentiles);
		}

		return createSignalLoop(prepared.data, [percentiles], (i) => {
			if (i < lookback) return null;
			const pct = percentiles[i];
			if (pct === null) return null;

			if (pct <= threshold) {
				return createBuySignal(prepared.data, i, `Typical price percentile (${pct.toFixed(3)}) <= threshold (${threshold})`);
			}
			if (pct >= (1 - threshold)) {
				return createSellSignal(prepared.data, i, `Typical price percentile (${pct.toFixed(3)}) >= upper threshold (${(1 - threshold).toFixed(3)})`);
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams) =>
		typical_price_percentile_reversion.executePrepared?.(prepareTypicalPercentileData(data), params, data) ?? [],
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "threshold"],
	},
};
