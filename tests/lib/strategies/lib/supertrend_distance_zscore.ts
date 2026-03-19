import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getHighs, getLows } from "../strategy-helpers";
import { calculateSupertrend } from "../indicators";
import { buildRollingZScore } from "./price-action-statistics-core";

type SupertrendDistanceZscorePrepared = {
	cleanData: OHLCVData[];
	highs: number[];
	lows: number[];
	closes: number[];
	supertrendByPeriod: Map<number, ReturnType<typeof calculateSupertrend>>;
	distancesByPeriod: Map<number, number[]>;
	zscoreByKey: Map<string, (number | null)[]>;
};

function prepareSupertrendDistanceZscoreData(data: OHLCVData[]): SupertrendDistanceZscorePrepared {
	const cleanData = ensureCleanData(data);
	return {
		cleanData,
		highs: getHighs(cleanData),
		lows: getLows(cleanData),
		closes: getCloses(cleanData),
		supertrendByPeriod: new Map<number, ReturnType<typeof calculateSupertrend>>(),
		distancesByPeriod: new Map<number, number[]>(),
		zscoreByKey: new Map<string, (number | null)[]>(),
	};
}

function getPreparedSupertrendDistanceZscoreData(
	preparedData: unknown,
	data: OHLCVData[]
): SupertrendDistanceZscorePrepared {
	if (preparedData && typeof preparedData === "object" && "supertrendByPeriod" in preparedData) {
		return preparedData as SupertrendDistanceZscorePrepared;
	}
	return prepareSupertrendDistanceZscoreData(data);
}

export const supertrend_distance_zscore: Strategy = {
	name: "Supertrend Distance Z-Score",
	description: "Quantifies the elastic stretch between price and the Supertrend step line. Uses a rolling z-score of that distance to pinpoint exact moments when the market has statistically exhausted its directional momentum and must revert to the median trend.",
	defaultParams: {
		stPeriod: 10,
		zscoreLookback: 50,
		zscoreTrigger: 2.5,
	},
	paramLabels: {
		stPeriod: "Supertrend ATR Baseline",
		zscoreLookback: "Distance Distribution Window",
		zscoreTrigger: "Elastic Snap Threshold",
	},
	prepareFinderData: (data) => prepareSupertrendDistanceZscoreData(data),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const prepared = getPreparedSupertrendDistanceZscoreData(preparedData, data);
		const { cleanData, highs, lows, closes, supertrendByPeriod, distancesByPeriod, zscoreByKey } = prepared;
		const stPeriod = Number(params.stPeriod ?? 10);
		const zLookback = Number(params.zscoreLookback ?? 50);
		const trigger = Number(params.zscoreTrigger ?? 2.5);

		if (cleanData.length < Math.max(stPeriod * 2, zLookback)) return [];

		let st = supertrendByPeriod.get(stPeriod);
		if (!st) {
			st = calculateSupertrend(highs, lows, closes, stPeriod, 3.0);
			supertrendByPeriod.set(stPeriod, st);
		}

		let distances = distancesByPeriod.get(stPeriod);
		if (!distances) {
			distances = closes.map((close, i) => {
				if (st.supertrend[i] === null || st.direction[i] === null) return 0;
				return close - st.supertrend[i]!;
			});
			distancesByPeriod.set(stPeriod, distances);
		}

		const zscoreKey = `${stPeriod}:${zLookback}`;
		let zscore = zscoreByKey.get(zscoreKey);
		if (!zscore) {
			zscore = buildRollingZScore(distances, zLookback);
			zscoreByKey.set(zscoreKey, zscore);
		}

		return createSignalLoop(cleanData, [], (i) => {
			if (i < Math.max(stPeriod * 2, zLookback) || zscore[i] === null || st.direction[i] === null) return null;

			const z = zscore[i]!;
			const isBullishST = st.direction[i] === 1;
			const isBearishST = st.direction[i] === -1;

			// Fade extreme upside extension within a bullish Supertrend
			if (isBullishST && z > trigger) {
				return createSellSignal(cleanData, i, "Extreme upside overextension from Supertrend elastic band fade");
			}
			// Fade extreme downside extension within a bearish Supertrend
			if (isBearishST && z < -trigger) {
				return createBuySignal(cleanData, i, "Extreme downside overextension from Supertrend elastic band fade");
			}

			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams) =>
		supertrend_distance_zscore.executePrepared?.(prepareSupertrendDistanceZscoreData(data), params, data) ?? [],
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["stPeriod", "zscoreLookback", "zscoreTrigger"],
	},
};
