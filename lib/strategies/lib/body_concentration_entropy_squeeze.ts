import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildBodyPctSeries, buildRollingAverage } from "./price-action-frequency-core";
import { buildRollingEntropy, buildPercentileRank } from "./price-action-statistics-core";

type BodyConcentrationEntropySqueezePrepared = {
	cleanData: OHLCVData[];
	closes: number[];
	bodyPct: number[];
	rankByWindow: Map<number, (number | null)[]>;
	avgCloseByWindow: Map<number, (number | null)[]>;
};

function normalizeBodyConcentrationEntropySqueezeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		entropyWindow: Math.max(3, Math.round(params.entropyWindow ?? 30)),
		compressionRank: Math.max(0, Math.min(100, Number(params.compressionRank ?? 20))),
	};
}

function prepareBodyConcentrationEntropySqueezeData(data: OHLCVData[]): BodyConcentrationEntropySqueezePrepared {
	const cleanData = ensureCleanData(data);
	return {
		cleanData,
		closes: getCloses(cleanData),
		bodyPct: buildBodyPctSeries(cleanData),
		rankByWindow: new Map<number, (number | null)[]>(),
		avgCloseByWindow: new Map<number, (number | null)[]>(),
	};
}

function getPreparedBodyConcentrationEntropySqueezeData(
	preparedData: unknown,
	data: OHLCVData[]
): BodyConcentrationEntropySqueezePrepared {
	if (preparedData && typeof preparedData === "object" && "rankByWindow" in preparedData) {
		return preparedData as BodyConcentrationEntropySqueezePrepared;
	}
	return prepareBodyConcentrationEntropySqueezeData(data);
}

function getEntropyRankSeries(
	prepared: BodyConcentrationEntropySqueezePrepared,
	window: number
): (number | null)[] {
	let rank = prepared.rankByWindow.get(window);
	if (!rank) {
		const entropy = buildRollingEntropy(prepared.bodyPct, window);
		const entropyClean = entropy.map((value) => value ?? 0);
		rank = buildPercentileRank(entropyClean, window);
		prepared.rankByWindow.set(window, rank);
	}
	return rank;
}

function getAverageCloseSeries(
	prepared: BodyConcentrationEntropySqueezePrepared,
	window: number
): (number | null)[] {
	let avgClose = prepared.avgCloseByWindow.get(window);
	if (!avgClose) {
		avgClose = buildRollingAverage(prepared.closes, window);
		prepared.avgCloseByWindow.set(window, avgClose);
	}
	return avgClose;
}

export const body_concentration_entropy_squeeze: Strategy = {
	name: "Body Concentration Entropy Squeeze",
	description: "When entropy of body percentage drops to a percentile extreme, bars have become highly predictable in directional commitment - a low-disorder conviction state. Enter in the direction of the rolling average close deviation.",
	defaultParams: {
		entropyWindow: 30,
		compressionRank: 20,
	},
	paramLabels: {
		entropyWindow: "Entropy Window",
		compressionRank: "Compression Rank Max",
	},
	normalizeParams: normalizeBodyConcentrationEntropySqueezeParams,
	prepareFinderData: (data) => prepareBodyConcentrationEntropySqueezeData(data),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const prepared = getPreparedBodyConcentrationEntropySqueezeData(preparedData, data);
		const p = normalizeBodyConcentrationEntropySqueezeParams(params);
		const window = p.entropyWindow as number;
		const rankMax = p.compressionRank as number;
		if (prepared.cleanData.length < window + 2) return [];

		const rank = getEntropyRankSeries(prepared, window);
		const avgClose = getAverageCloseSeries(prepared, window);

		return createSignalLoop(prepared.cleanData, [rank, avgClose], (i) => {
			if (i < window) return null;
			const r = rank[i];
			const avg = avgClose[i];
			if (r === null || avg === null) return null;
			if (r >= rankMax / 100) return null;

			if (prepared.closes[i] > avg) {
				return createBuySignal(prepared.cleanData, i, `Body entropy squeezed (rank ${(r * 100).toFixed(0)}%), close above avg - low-disorder bullish`);
			}
			if (prepared.closes[i] < avg) {
				return createSellSignal(prepared.cleanData, i, `Body entropy squeezed (rank ${(r * 100).toFixed(0)}%), close below avg - low-disorder bearish`);
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams) =>
		body_concentration_entropy_squeeze.executePrepared?.(prepareBodyConcentrationEntropySqueezeData(data), params, data) ?? [],
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["entropyWindow", "compressionRank"],
	},
};
