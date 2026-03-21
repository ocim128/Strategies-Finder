import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { calculateMACD } from "../indicators";
import { buildRollingStdDev } from "./price-action-statistics-core";

type MacdHistogramVolatilitySqueezePrepared = {
	cleanData: OHLCVData[];
	closes: number[];
	histogramByFast: Map<number, number[]>;
	histogramStdDevByKey: Map<string, (number | null)[]>;
};

function normalizeMacdHistogramVolatilitySqueezeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		macdFast: Math.max(2, Math.round(Number(params.macdFast ?? 12))),
		stdDevLookback: Math.max(2, Math.round(Number(params.stdDevLookback ?? 30))),
		squeezeThreshold: Math.max(0, Number(params.squeezeThreshold ?? 0.05)),
	};
}

function prepareMacdHistogramVolatilitySqueezeData(data: OHLCVData[]): MacdHistogramVolatilitySqueezePrepared {
	const cleanData = ensureCleanData(data);
	return {
		cleanData,
		closes: getCloses(cleanData),
		histogramByFast: new Map<number, number[]>(),
		histogramStdDevByKey: new Map<string, (number | null)[]>(),
	};
}

function getPreparedMacdHistogramVolatilitySqueezeData(
	preparedData: unknown,
	data: OHLCVData[]
): MacdHistogramVolatilitySqueezePrepared {
	if (preparedData && typeof preparedData === "object" && "histogramByFast" in preparedData) {
		return preparedData as MacdHistogramVolatilitySqueezePrepared;
	}
	return prepareMacdHistogramVolatilitySqueezeData(data);
}

export const macd_histogram_volatility_squeeze: Strategy = {
	name: "MACD Histogram Volatility Squeeze",
	description: "Measures histogram variance directly and enters only when that momentum derivative expands out of a deep squeeze.",
	defaultParams: {
		macdFast: 12,
		stdDevLookback: 30,
		squeezeThreshold: 0.05,
	},
	paramLabels: {
		macdFast: "MACD Fast",
		stdDevLookback: "StdDev Lookback",
		squeezeThreshold: "Squeeze Threshold",
	},
	normalizeParams: normalizeMacdHistogramVolatilitySqueezeParams,
	prepareFinderData: (data) => prepareMacdHistogramVolatilitySqueezeData(data),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const prepared = getPreparedMacdHistogramVolatilitySqueezeData(preparedData, data);
		const { cleanData, closes, histogramByFast, histogramStdDevByKey } = prepared;
		const normalizedParams = normalizeMacdHistogramVolatilitySqueezeParams(params);
		const macdFast = normalizedParams.macdFast as number;
		const stdDevLookback = normalizedParams.stdDevLookback as number;
		const squeezeThreshold = normalizedParams.squeezeThreshold as number;
		const macdSlow = Math.max(macdFast + 1, macdFast * 2);

		if (cleanData.length < Math.max(macdSlow, stdDevLookback) + 1) return [];

		let histogram = histogramByFast.get(macdFast);
		if (!histogram) {
			histogram = calculateMACD(closes, macdFast, macdSlow, 9).histogram.map((value) => value ?? 0);
			histogramByFast.set(macdFast, histogram);
		}

		const stdDevKey = `${macdFast}:${stdDevLookback}`;
		let histogramStdDev = histogramStdDevByKey.get(stdDevKey);
		if (!histogramStdDev) {
			histogramStdDev = buildRollingStdDev(histogram, stdDevLookback);
			histogramStdDevByKey.set(stdDevKey, histogramStdDev);
		}

		return createSignalLoop(cleanData, [], (i) => {
			if (i < 1 || histogramStdDev[i] === null) return null;
			if (histogramStdDev[i]! > squeezeThreshold) return null;

			if (histogram[i] > 0 && histogram[i] > histogram[i - 1]) {
				return createBuySignal(cleanData, i, "MACD histogram volatility squeeze long");
			}
			if (histogram[i] < 0 && histogram[i] < histogram[i - 1]) {
				return createSellSignal(cleanData, i, "MACD histogram volatility squeeze short");
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams) =>
		macd_histogram_volatility_squeeze.executePrepared?.(prepareMacdHistogramVolatilitySqueezeData(data), params, data) ?? [],
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["macdFast", "stdDevLookback", "squeezeThreshold"],
	},
};
