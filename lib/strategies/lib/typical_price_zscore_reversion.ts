import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getTypicalPrices,
} from "../strategy-helpers";
import { buildRollingZScore } from "./price-action-statistics-core";

type TypicalZScorePrepared = {
	data: OHLCVData[];
	typicalPrices: number[];
	typicalZScoreByLookback: Map<number, (number | null)[]>;
};

function normalizeTypicalZScoreParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 50))),
	};
}

function prepareTypicalZScoreData(data: OHLCVData[]): TypicalZScorePrepared {
	const clean = ensureCleanData(data);
	return {
		data: clean,
		typicalPrices: getTypicalPrices(clean),
		typicalZScoreByLookback: new Map(),
	};
}

function getPreparedTypicalZScoreData(preparedData: unknown, data: OHLCVData[]): TypicalZScorePrepared {
	if (preparedData && typeof preparedData === "object" && "typicalZScoreByLookback" in preparedData) {
		return preparedData as TypicalZScorePrepared;
	}
	return prepareTypicalZScoreData(data);
}

export const typical_price_zscore_reversion: Strategy = {
	name: "Typical Price Z-Score Reversion",
	description: "Fades the typical price when its rolling z-score crosses a 2.5-sigma boundary.",
	defaultParams: {
		lookback: 50,
	},
	paramLabels: {
		lookback: "Lookback",
	},
	normalizeParams: normalizeTypicalZScoreParams,
	prepareFinderData: (data) => prepareTypicalZScoreData(data),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const prepared = getPreparedTypicalZScoreData(preparedData, data);
		const p = normalizeTypicalZScoreParams(params);
		const lookback = p.lookback as number;
		if (prepared.data.length < lookback) return [];

		let zscore = prepared.typicalZScoreByLookback.get(lookback);
		if (!zscore) {
			zscore = buildRollingZScore(prepared.typicalPrices, lookback);
			prepared.typicalZScoreByLookback.set(lookback, zscore);
		}

		return createSignalLoop(prepared.data, [zscore], (i) => {
			if (i < lookback) return null;
			const z = zscore[i];
			if (z === null) return null;

			if (z <= -2.5) {
				return createBuySignal(prepared.data, i, `Typical price Z-Score (${z.toFixed(2)}) <= -2.5`);
			}
			if (z >= 2.5) {
				return createSellSignal(prepared.data, i, `Typical price Z-Score (${z.toFixed(2)}) >= 2.5`);
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams) =>
		typical_price_zscore_reversion.executePrepared?.(prepareTypicalZScoreData(data), params, data) ?? [],
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback"],
	},
};
