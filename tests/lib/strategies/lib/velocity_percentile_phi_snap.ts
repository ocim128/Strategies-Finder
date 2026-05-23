import { Strategy, OHLCVData, Signal, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRateOfChange, buildPercentileRank, buildEfficiencyRatio, extractBarMetricSeries } from "./price-action-statistics-core";

type VelocityPercentilePhiSnapCandidates = {
	indexes: number[];
	directions: number[];
	efficiency: number[];
};

type VelocityPercentilePhiSnapPrepared = {
	cleanData: OHLCVData[];
	closes: number[];
	bodyDirection: number[];
	rocFilledByWindow: Map<number, number[]>;
	negRocByWindow: Map<number, number[]>;
	rocRankByKey: Map<string, (number | null)[]>;
	negRankByKey: Map<string, (number | null)[]>;
	erByLookback: Map<number, (number | null)[]>;
	candidateByKey: Map<string, VelocityPercentilePhiSnapCandidates>;
};

function normalizeVelocityPercentilePhiSnapParams(params: StrategyParams): StrategyParams {
	const velocityWindow = Math.max(1, Math.round(params.velocityWindow ?? 5));
	const erLookback = Math.max(3, Math.round(params.erLookback ?? 13));
	const phiInefficiency = Math.max(0.01, Math.min(0.99, Number(params.phiInefficiency ?? 0.382)));
	return { ...params, velocityWindow, erLookback, phiInefficiency };
}

function prepareVelocityPercentilePhiSnapData(data: OHLCVData[]): VelocityPercentilePhiSnapPrepared {
	const cleanData = ensureCleanData(data);
	return {
		cleanData,
		closes: getCloses(cleanData),
		bodyDirection: extractBarMetricSeries(cleanData, "bodyDirection"),
		rocFilledByWindow: new Map<number, number[]>(),
		negRocByWindow: new Map<number, number[]>(),
		rocRankByKey: new Map<string, (number | null)[]>(),
		negRankByKey: new Map<string, (number | null)[]>(),
		erByLookback: new Map<number, (number | null)[]>(),
		candidateByKey: new Map<string, VelocityPercentilePhiSnapCandidates>(),
	};
}

function getPreparedVelocityPercentilePhiSnapData(
	preparedData: unknown,
	data: OHLCVData[]
): VelocityPercentilePhiSnapPrepared {
	if (preparedData && typeof preparedData === "object" && "rocFilledByWindow" in preparedData) {
		return preparedData as VelocityPercentilePhiSnapPrepared;
	}
	return prepareVelocityPercentilePhiSnapData(data);
}

function getRocFilled(prepared: VelocityPercentilePhiSnapPrepared, velocityWindow: number): number[] {
	let rocFilled = prepared.rocFilledByWindow.get(velocityWindow);
	if (!rocFilled) {
		rocFilled = buildRateOfChange(prepared.closes, velocityWindow).map((value) => value ?? 0);
		prepared.rocFilledByWindow.set(velocityWindow, rocFilled);
	}
	return rocFilled;
}

function getNegRoc(prepared: VelocityPercentilePhiSnapPrepared, velocityWindow: number): number[] {
	let negRoc = prepared.negRocByWindow.get(velocityWindow);
	if (!negRoc) {
		negRoc = getRocFilled(prepared, velocityWindow).map((value) => -value);
		prepared.negRocByWindow.set(velocityWindow, negRoc);
	}
	return negRoc;
}

function getRocRank(
	prepared: VelocityPercentilePhiSnapPrepared,
	velocityWindow: number,
	rankLookback: number
): (number | null)[] {
	const key = `${velocityWindow}|${rankLookback}`;
	let rank = prepared.rocRankByKey.get(key);
	if (!rank) {
		rank = buildPercentileRank(getRocFilled(prepared, velocityWindow), rankLookback);
		prepared.rocRankByKey.set(key, rank);
	}
	return rank;
}

function getNegRank(
	prepared: VelocityPercentilePhiSnapPrepared,
	velocityWindow: number,
	rankLookback: number
): (number | null)[] {
	const key = `${velocityWindow}|${rankLookback}`;
	let rank = prepared.negRankByKey.get(key);
	if (!rank) {
		rank = buildPercentileRank(getNegRoc(prepared, velocityWindow), rankLookback);
		prepared.negRankByKey.set(key, rank);
	}
	return rank;
}

function getEfficiencyRatio(
	prepared: VelocityPercentilePhiSnapPrepared,
	erLookback: number
): (number | null)[] {
	let er = prepared.erByLookback.get(erLookback);
	if (!er) {
		er = buildEfficiencyRatio(prepared.cleanData, erLookback);
		prepared.erByLookback.set(erLookback, er);
	}
	return er;
}

function getVelocityCandidates(
	prepared: VelocityPercentilePhiSnapPrepared,
	velocityWindow: number,
	erLookback: number,
	minBars: number
): VelocityPercentilePhiSnapCandidates {
	const key = `${velocityWindow}|${erLookback}`;
	let candidates = prepared.candidateByKey.get(key);
	if (candidates) return candidates;

	const rankLookback = erLookback + velocityWindow;
	const rocRank = getRocRank(prepared, velocityWindow, rankLookback);
	const negRank = getNegRank(prepared, velocityWindow, rankLookback);
	const er = getEfficiencyRatio(prepared, erLookback);
	const indexes: number[] = [];
	const directions: number[] = [];
	const efficiency: number[] = [];

	for (let i = minBars; i < prepared.cleanData.length; i++) {
		const erVal = er[i];
		if (erVal === null || erVal === undefined) continue;

		if (prepared.bodyDirection[i] === 1) {
			const rank = rocRank[i];
			if (rank !== null && rank !== undefined && rank > 0.99) {
				indexes.push(i);
				directions.push(1);
				efficiency.push(erVal);
			}
			continue;
		}

		if (prepared.bodyDirection[i] === -1) {
			const nr = negRank[i];
			if (nr !== null && nr !== undefined && nr > 0.99) {
				indexes.push(i);
				directions.push(-1);
				efficiency.push(erVal);
			}
		}
	}

	candidates = { indexes, directions, efficiency };
	prepared.candidateByKey.set(key, candidates);
	return candidates;
}

export const velocity_percentile_phi_snap: Strategy = {
	name: "Velocity Percentile Phi Snap",
	description:
		"Identifies synthetic hyper-speed where absolute velocity is at the 99th percentile but path efficiency has collapsed below 0.382, fading the ghost thrust.",
	defaultParams: { velocityWindow: 5, erLookback: 13, phiInefficiency: 0.382 },
	paramLabels: { velocityWindow: "Velocity Window", erLookback: "ER Lookback", phiInefficiency: "Phi Inefficiency" },
	normalizeParams: normalizeVelocityPercentilePhiSnapParams,
	prepareFinderData: (data) => prepareVelocityPercentilePhiSnapData(data),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const prepared = getPreparedVelocityPercentilePhiSnapData(preparedData, data);
		const np = normalizeVelocityPercentilePhiSnapParams(params);
		const minBars = Math.max(np.velocityWindow, np.erLookback) + 20;
		if (prepared.cleanData.length < minBars) return [];

		const candidates = getVelocityCandidates(prepared, np.velocityWindow, np.erLookback, minBars);

		const signals: Signal[] = [];
		for (let i = 0; i < candidates.indexes.length; i++) {
			if (candidates.efficiency[i] >= np.phiInefficiency) continue;
			const barIndex = candidates.indexes[i];
			if (candidates.directions[i] === 1) {
				signals.push(createBuySignal(prepared.cleanData, barIndex, `Velocity 99th pctile with ER < ${np.phiInefficiency} & bullish body`));
			} else {
				signals.push(createSellSignal(prepared.cleanData, barIndex, `Velocity 99th pctile with ER < ${np.phiInefficiency} & bearish body`));
			}
		}
		return signals;
	},
	execute: (data: OHLCVData[], params: StrategyParams) =>
		velocity_percentile_phi_snap.executePrepared?.(prepareVelocityPercentilePhiSnapData(data), params, data) ?? [],
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["velocityWindow", "erLookback", "phiInefficiency"] } };
