import { Strategy, OHLCVData, Signal, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildBodyPctSeries, buildRollingAverage } from "./price-action-frequency-core";
import { buildRollingEntropy, buildPercentileRank } from "./price-action-statistics-core";

type BodyConcentrationEntropySqueezeCandidates = {
	indexes: number[];
	ranks: number[];
	directions: number[];
};

type BodyConcentrationEntropySqueezePrepared = {
	cleanData: OHLCVData[];
	closes: number[];
	bodyPct: number[];
	rankByWindow: Map<number, (number | null)[]>;
	avgCloseByWindow: Map<number, (number | null)[]>;
	candidateByWindow: Map<number, BodyConcentrationEntropySqueezeCandidates>;
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
		candidateByWindow: new Map<number, BodyConcentrationEntropySqueezeCandidates>(),
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

function getSqueezeCandidates(
	prepared: BodyConcentrationEntropySqueezePrepared,
	window: number
): BodyConcentrationEntropySqueezeCandidates {
	let candidates = prepared.candidateByWindow.get(window);
	if (candidates) return candidates;

	const rank = getEntropyRankSeries(prepared, window);
	const avgClose = getAverageCloseSeries(prepared, window);
	const indexes: number[] = [];
	const ranks: number[] = [];
	const directions: number[] = [];

	for (let i = window; i < prepared.cleanData.length; i++) {
		const r = rank[i];
		const avg = avgClose[i];
		if (r === null || r === undefined || avg === null || avg === undefined) continue;
		if (prepared.closes[i] > avg) {
			indexes.push(i);
			ranks.push(r);
			directions.push(1);
		} else if (prepared.closes[i] < avg) {
			indexes.push(i);
			ranks.push(r);
			directions.push(-1);
		}
	}

	candidates = { indexes, ranks, directions };
	prepared.candidateByWindow.set(window, candidates);
	return candidates;
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

		const candidates = getSqueezeCandidates(prepared, window);
		const threshold = rankMax / 100;
		const signals: Signal[] = [];
		for (let i = 0; i < candidates.indexes.length; i++) {
			const r = candidates.ranks[i];
			if (r >= threshold) continue;
			const barIndex = candidates.indexes[i];
			if (candidates.directions[i] > 0) {
				signals.push(createBuySignal(prepared.cleanData, barIndex, `Body entropy squeezed (rank ${(r * 100).toFixed(0)}%), close above avg - low-disorder bullish`));
			} else {
				signals.push(createSellSignal(prepared.cleanData, barIndex, `Body entropy squeezed (rank ${(r * 100).toFixed(0)}%), close below avg - low-disorder bearish`));
			}
		}
		return signals;
	},
	execute: (data: OHLCVData[], params: StrategyParams) =>
		body_concentration_entropy_squeeze.executePrepared?.(prepareBodyConcentrationEntropySqueezeData(data), params, data) ?? [],
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["entropyWindow", "compressionRank"],
	},
};
