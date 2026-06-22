import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
} from "../strategy-helpers";
import { buildRollingAverage } from "./price-action-frequency-core";
import { buildRollingStdDev } from "./price-action-statistics-core";

type VolatilityReversalPrepared = {
	data: OHLCVData[];
	closes: number[];
	avgByLookback: Map<number, (number | null)[]>;
	stdDevByLookback: Map<number, (number | null)[]>;
};

function normalizeVolatilityReversalParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
		threshold: Math.max(0, Number(params.threshold ?? 2.5)),
	};
}

function prepareVolatilityReversalData(data: OHLCVData[]): VolatilityReversalPrepared {
	const clean = ensureCleanData(data);
	return {
		data: clean,
		closes: getCloses(clean),
		avgByLookback: new Map(),
		stdDevByLookback: new Map(),
	};
}

function getPreparedVolatilityReversalData(preparedData: unknown, data: OHLCVData[]): VolatilityReversalPrepared {
	if (preparedData && typeof preparedData === "object" && "stdDevByLookback" in preparedData) {
		return preparedData as VolatilityReversalPrepared;
	}
	return prepareVolatilityReversalData(data);
}

export const volatility_reversal_fade: Strategy = {
	name: "Volatility Reversal Fade",
	description: "Fades the ratio when the price expands outside standard deviation bands and then closes back inside.",
	defaultParams: {
		lookback: 30,
		threshold: 2.5,
	},
	paramLabels: {
		lookback: "Lookback",
		threshold: "Standard Deviation Multiplier",
	},
	normalizeParams: normalizeVolatilityReversalParams,
	prepareFinderData: (data) => prepareVolatilityReversalData(data),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const prepared = getPreparedVolatilityReversalData(preparedData, data);
		const p = normalizeVolatilityReversalParams(params);
		const lookback = p.lookback as number;
		const threshold = p.threshold as number;
		if (prepared.data.length < lookback + 1) return [];

		let avg = prepared.avgByLookback.get(lookback);
		if (!avg) {
			avg = buildRollingAverage(prepared.closes, lookback);
			prepared.avgByLookback.set(lookback, avg);
		}

		let stddev = prepared.stdDevByLookback.get(lookback);
		if (!stddev) {
			stddev = buildRollingStdDev(prepared.closes, lookback);
			prepared.stdDevByLookback.set(lookback, stddev);
		}

		return createSignalLoop(prepared.data, [avg, stddev], (i) => {
			if (i < lookback) return null;
			const currentClose = prepared.closes[i];
			const prevClose = prepared.closes[i - 1];

			const prevAvg = avg[i - 1];
			const prevStd = stddev[i - 1];

			if (prevAvg === null || prevStd === null) return null;

			const lowerBand = prevAvg - threshold * prevStd;
			const upperBand = prevAvg + threshold * prevStd;

			if (prevClose <= lowerBand && currentClose > prevClose) {
				return createBuySignal(prepared.data, i, `Reversal from lower band: prevClose (${prevClose.toFixed(4)}) <= lowerBand (${lowerBand.toFixed(4)}) and currentClose (${currentClose.toFixed(4)}) > prevClose`);
			}
			if (prevClose >= upperBand && currentClose < prevClose) {
				return createSellSignal(prepared.data, i, `Reversal from upper band: prevClose (${prevClose.toFixed(4)}) >= upperBand (${upperBand.toFixed(4)}) and currentClose (${currentClose.toFixed(4)}) < prevClose`);
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams) =>
		volatility_reversal_fade.executePrepared?.(prepareVolatilityReversalData(data), params, data) ?? [],
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "threshold"],
	},
};
