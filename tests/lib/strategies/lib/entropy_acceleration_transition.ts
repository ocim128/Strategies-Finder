import { Strategy, OHLCVData, Signal, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRollingEntropy, buildRateOfChange, buildRollingMedian } from "./price-action-statistics-core";

type EntropyAccelerationTransitionCandidates = {
	indexes: number[];
	directions: number[];
};

type EntropyAccelerationTransitionPrepared = {
	cleanData: OHLCVData[];
	closes: number[];
	returns: number[];
	entropyCleanByWindow: Map<number, number[]>;
	entropyRocByKey: Map<string, (number | null)[]>;
	medianCloseByWindow: Map<number, (number | null)[]>;
	candidateByKey: Map<string, EntropyAccelerationTransitionCandidates>;
};

function normalizeEntropyAccelerationTransitionParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		entropyWindow: Math.max(3, Math.round(params.entropyWindow ?? 20)),
		rocPeriod: Math.max(1, Math.round(params.rocPeriod ?? 5)) };
}

function prepareEntropyAccelerationTransitionData(data: OHLCVData[]): EntropyAccelerationTransitionPrepared {
	const cleanData = ensureCleanData(data);
	const closes = getCloses(cleanData);
	const returns: number[] = new Array(cleanData.length).fill(0);
	for (let i = 1; i < cleanData.length; i++) {
		returns[i] = closes[i] - closes[i - 1];
	}
	return {
		cleanData,
		closes,
		returns,
		entropyCleanByWindow: new Map<number, number[]>(),
		entropyRocByKey: new Map<string, (number | null)[]>(),
		medianCloseByWindow: new Map<number, (number | null)[]>(),
		candidateByKey: new Map<string, EntropyAccelerationTransitionCandidates>(),
	};
}

function getPreparedEntropyAccelerationTransitionData(
	preparedData: unknown,
	data: OHLCVData[]
): EntropyAccelerationTransitionPrepared {
	if (preparedData && typeof preparedData === "object" && "entropyCleanByWindow" in preparedData) {
		return preparedData as EntropyAccelerationTransitionPrepared;
	}
	return prepareEntropyAccelerationTransitionData(data);
}

function getEntropyClean(prepared: EntropyAccelerationTransitionPrepared, entropyWindow: number): number[] {
	let entropyClean = prepared.entropyCleanByWindow.get(entropyWindow);
	if (!entropyClean) {
		entropyClean = buildRollingEntropy(prepared.returns, entropyWindow).map((value) => value ?? 0);
		prepared.entropyCleanByWindow.set(entropyWindow, entropyClean);
	}
	return entropyClean;
}

function getEntropyRoc(
	prepared: EntropyAccelerationTransitionPrepared,
	entropyWindow: number,
	rocPeriod: number
): (number | null)[] {
	const key = `${entropyWindow}|${rocPeriod}`;
	let entropyRoc = prepared.entropyRocByKey.get(key);
	if (!entropyRoc) {
		entropyRoc = buildRateOfChange(getEntropyClean(prepared, entropyWindow), rocPeriod);
		prepared.entropyRocByKey.set(key, entropyRoc);
	}
	return entropyRoc;
}

function getMedianClose(
	prepared: EntropyAccelerationTransitionPrepared,
	entropyWindow: number
): (number | null)[] {
	let medianClose = prepared.medianCloseByWindow.get(entropyWindow);
	if (!medianClose) {
		medianClose = buildRollingMedian(prepared.closes, entropyWindow);
		prepared.medianCloseByWindow.set(entropyWindow, medianClose);
	}
	return medianClose;
}

function getEntropyTransitionCandidates(
	prepared: EntropyAccelerationTransitionPrepared,
	entropyWindow: number,
	rocPeriod: number
): EntropyAccelerationTransitionCandidates {
	const key = `${entropyWindow}|${rocPeriod}`;
	let candidates = prepared.candidateByKey.get(key);
	if (candidates) return candidates;

	const entropyRoc = getEntropyRoc(prepared, entropyWindow, rocPeriod);
	const medianClose = getMedianClose(prepared, entropyWindow);
	const indexes: number[] = [];
	const directions: number[] = [];

	for (let i = entropyWindow + rocPeriod + 1; i < prepared.cleanData.length; i++) {
		const prevRoc = entropyRoc[i - 1];
		const currRoc = entropyRoc[i];
		const median = medianClose[i];
		if (prevRoc === null || prevRoc === undefined || currRoc === null || currRoc === undefined || median === null || median === undefined) {
			continue;
		}
		if (prevRoc <= 0 || currRoc > 0) continue;

		if (prepared.closes[i] > median) {
			indexes.push(i);
			directions.push(1);
		} else if (prepared.closes[i] < median) {
			indexes.push(i);
			directions.push(-1);
		}
	}

	candidates = { indexes, directions };
	prepared.candidateByKey.set(key, candidates);
	return candidates;
}

export const entropy_acceleration_transition: Strategy = {
	name: "Entropy Acceleration Transition",
	description: "The rate of change of rolling entropy measures how fast the market's information structure is changing. When entropy ROC crosses from positive to negative, the market transitions from disordering to structuring. Enter in the direction of close versus rolling median.",
	defaultParams: {
		entropyWindow: 20,
		rocPeriod: 5 },
	paramLabels: {
		entropyWindow: "Entropy Window",
		rocPeriod: "ROC Period" },
	normalizeParams: normalizeEntropyAccelerationTransitionParams,
	prepareFinderData: (data) => prepareEntropyAccelerationTransitionData(data),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const prepared = getPreparedEntropyAccelerationTransitionData(preparedData, data);
		const p = normalizeEntropyAccelerationTransitionParams(params);
		const entropyWindow = p.entropyWindow as number;
		const rocPeriod = p.rocPeriod as number;
		if (prepared.cleanData.length < entropyWindow + rocPeriod + 2) return [];

		const candidates = getEntropyTransitionCandidates(prepared, entropyWindow, rocPeriod);
		const signals: Signal[] = [];
		for (let i = 0; i < candidates.indexes.length; i++) {
			const barIndex = candidates.indexes[i];
			if (candidates.directions[i] > 0) {
				signals.push(createBuySignal(prepared.cleanData, barIndex, `Entropy ROC structuring transition (disordering->ordering), close above median`));
			} else {
				signals.push(createSellSignal(prepared.cleanData, barIndex, `Entropy ROC structuring transition (disordering->ordering), close below median`));
			}
		}
		return signals;
	},
	execute: (data: OHLCVData[], params: StrategyParams) =>
		entropy_acceleration_transition.executePrepared?.(prepareEntropyAccelerationTransitionData(data), params, data) ?? [],
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["entropyWindow", "rocPeriod"] } };
