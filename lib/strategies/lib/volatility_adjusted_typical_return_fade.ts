import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getTypicalPrices,
} from "../strategy-helpers";
import { buildRateOfChange, buildRollingStdDev } from "./price-action-statistics-core";

type VolatilityAdjustedReturnPrepared = {
	data: OHLCVData[];
	typicalPrices: number[];
	returns: (number | null)[];
	stdDevByLookback: Map<number, (number | null)[]>;
};

function normalizeVolatilityAdjustedParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
	};
}

function prepareVolatilityAdjustedData(data: OHLCVData[]): VolatilityAdjustedReturnPrepared {
	const clean = ensureCleanData(data);
	const typicalPrices = getTypicalPrices(clean);
	return {
		data: clean,
		typicalPrices,
		returns: buildRateOfChange(typicalPrices, 1),
		stdDevByLookback: new Map(),
	};
}

function getPreparedVolatilityAdjustedData(
	preparedData: unknown,
	data: OHLCVData[]
): VolatilityAdjustedReturnPrepared {
	if (preparedData && typeof preparedData === "object" && "stdDevByLookback" in preparedData) {
		return preparedData as VolatilityAdjustedReturnPrepared;
	}
	return prepareVolatilityAdjustedData(data);
}

export const volatility_adjusted_typical_return_fade: Strategy = {
	name: "Volatility-Adjusted Typical Return Fade",
	description: "Fades typical price returns when the 1-bar return is extremely large relative to rolling return standard deviation.",
	defaultParams: {
		lookback: 30,
	},
	paramLabels: {
		lookback: "Lookback",
	},
	normalizeParams: normalizeVolatilityAdjustedParams,
	prepareFinderData: (data) => prepareVolatilityAdjustedData(data),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const prepared = getPreparedVolatilityAdjustedData(preparedData, data);
		const p = normalizeVolatilityAdjustedParams(params);
		const lookback = p.lookback as number;
		if (prepared.data.length < lookback + 1) return [];

		// Coerce returns to number[] by replacing null with 0
		const cleanReturns = prepared.returns.map(v => v ?? 0);

		let stddev = prepared.stdDevByLookback.get(lookback);
		if (!stddev) {
			stddev = buildRollingStdDev(cleanReturns, lookback);
			prepared.stdDevByLookback.set(lookback, stddev);
		}

		return createSignalLoop(prepared.data, [stddev], (i) => {
			if (i < lookback) return null;
			const r = prepared.returns[i];
			const std = stddev[i];
			if (r === null || std === null || std <= 1e-9) return null;

			const z = r / std;

			if (z <= -2.5) {
				return createBuySignal(prepared.data, i, `Extremely large negative velocity spike: return Z-Score (${z.toFixed(2)}) <= -2.5`);
			}
			if (z >= 2.5) {
				return createSellSignal(prepared.data, i, `Extremely large positive velocity spike: return Z-Score (${z.toFixed(2)}) >= 2.5`);
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams) =>
		volatility_adjusted_typical_return_fade.executePrepared?.(prepareVolatilityAdjustedData(data), params, data) ?? [],
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback"],
	},
};
