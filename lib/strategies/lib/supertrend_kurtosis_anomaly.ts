import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { calculateSupertrend } from "../indicators";
import { buildRollingKurtosis } from "./price-action-statistics-core";
import { getPriceActionBarMetrics } from "./price-action-frequency-core";

type SupertrendKurtosisAnomalyPrepared = {
	cleanData: OHLCVData[];
	highs: number[];
	lows: number[];
	closes: number[];
	metrics: ReturnType<typeof getPriceActionBarMetrics>[];
	supertrendByPeriod: Map<number, ReturnType<typeof calculateSupertrend>>;
	absDistanceByPeriod: Map<number, number[]>;
	kurtosisByKey: Map<string, (number | null)[]>;
};

function prepareSupertrendKurtosisAnomalyData(data: OHLCVData[]): SupertrendKurtosisAnomalyPrepared {
	const cleanData = ensureCleanData(data);
	return {
		cleanData,
		highs: cleanData.map((d) => d.high),
		lows: cleanData.map((d) => d.low),
		closes: cleanData.map((d) => d.close),
		metrics: cleanData.map((d) => getPriceActionBarMetrics(d)),
		supertrendByPeriod: new Map<number, ReturnType<typeof calculateSupertrend>>(),
		absDistanceByPeriod: new Map<number, number[]>(),
		kurtosisByKey: new Map<string, (number | null)[]>(),
	};
}

function getPreparedSupertrendKurtosisAnomalyData(
	preparedData: unknown,
	data: OHLCVData[]
): SupertrendKurtosisAnomalyPrepared {
	if (preparedData && typeof preparedData === "object" && "supertrendByPeriod" in preparedData) {
		return preparedData as SupertrendKurtosisAnomalyPrepared;
	}
	return prepareSupertrendKurtosisAnomalyData(data);
}

export const supertrend_kurtosis_anomaly: Strategy = {
	name: "Supertrend Kurtosis Anomaly",
	description: "Quantifies the absolute distance between price and the Supertrend line, identifying statistically extreme overextensions via rolling kurtosis to fade localized capitulations.",
	defaultParams: {
		stPeriod: 10,
		kurtosisLookback: 50,
		kurtosisThreshold: 3.5,
	},
	paramLabels: {
		stPeriod: "Supertrend Period",
		kurtosisLookback: "Kurtosis Lookback",
		kurtosisThreshold: "Kurtosis Threshold",
	},
	prepareFinderData: (data) => prepareSupertrendKurtosisAnomalyData(data),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const prepared = getPreparedSupertrendKurtosisAnomalyData(preparedData, data);
		const { cleanData, highs, lows, closes, metrics, supertrendByPeriod, absDistanceByPeriod, kurtosisByKey } = prepared;
		const stPeriod = Number(params.stPeriod ?? 10);
		const lookback = Number(params.kurtosisLookback ?? 50);
		const threshold = Number(params.kurtosisThreshold ?? 3.5);

		if (cleanData.length < Math.max(stPeriod * 2, lookback)) return [];

		let st = supertrendByPeriod.get(stPeriod);
		if (!st) {
			st = calculateSupertrend(highs, lows, closes, stPeriod, 3.0);
			supertrendByPeriod.set(stPeriod, st);
		}

		let absDistance = absDistanceByPeriod.get(stPeriod);
		if (!absDistance) {
			absDistance = closes.map((close, i) => {
				if (st.supertrend[i] === null) return 0;
				return Math.abs(close - st.supertrend[i]!);
			});
			absDistanceByPeriod.set(stPeriod, absDistance);
		}

		const kurtosisKey = `${stPeriod}:${lookback}`;
		let kurtosis = kurtosisByKey.get(kurtosisKey);
		if (!kurtosis) {
			kurtosis = buildRollingKurtosis(absDistance, lookback);
			kurtosisByKey.set(kurtosisKey, kurtosis);
		}

		return createSignalLoop(cleanData, [], (i) => {
			if (i < Math.max(stPeriod * 2, lookback) || kurtosis[i] === null || st.direction[i] === null || metrics[i].closeLocation === null) return null;

            const isBullishST = st.direction[i] === 1;
            const isBearishST = st.direction[i] === -1;
            const k = kurtosis[i]!;

            const closeLoc = metrics[i].closeLocation;

            if (isBullishST && k > threshold && closeLoc > 0.5) {
                return createBuySignal(cleanData, i, "Bullish Supertrend distance kurtosis spike with capitulation wick fade");
            }

            if (isBearishST && k > threshold && closeLoc < 0.5) {
                return createSellSignal(cleanData, i, "Bearish Supertrend distance kurtosis spike with rip fade");
            }

			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams) =>
		supertrend_kurtosis_anomaly.executePrepared?.(prepareSupertrendKurtosisAnomalyData(data), params, data) ?? [],
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["stPeriod", "kurtosisLookback", "kurtosisThreshold"],
	},
};
