import { Strategy, OHLCVData, Signal, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, ensureCleanData, getVolumes } from "../strategy-helpers";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

type CloseAcceptanceVolumeConvictionCandidates = {
	indexes: number[];
	acceptanceRanks: number[];
	volumeRanks: number[];
	directions: number[];
};

type CloseAcceptanceVolumeConvictionPrepared = {
	cleanData: OHLCVData[];
	acceptance: number[];
	absAcceptance: number[];
	volumes: number[];
	acceptanceRankByLookback: Map<number, (number | null)[]>;
	volumeRankByLookback: Map<number, (number | null)[]>;
	candidateByLookback: Map<number, CloseAcceptanceVolumeConvictionCandidates>;
};

function normalizeCloseAcceptanceVolumeConvictionParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(params.lookback ?? 30)),
		convictionRank: Math.max(50, Math.min(99, Number(params.convictionRank ?? 85))) };
}

function prepareCloseAcceptanceVolumeConvictionData(data: OHLCVData[]): CloseAcceptanceVolumeConvictionPrepared {
	const cleanData = ensureCleanData(data);
	const acceptance = buildCloseAcceptanceSeries(cleanData);
	return {
		cleanData,
		acceptance,
		absAcceptance: acceptance.map(v => Math.abs(v)),
		volumes: getVolumes(cleanData),
		acceptanceRankByLookback: new Map<number, (number | null)[]>(),
		volumeRankByLookback: new Map<number, (number | null)[]>(),
		candidateByLookback: new Map<number, CloseAcceptanceVolumeConvictionCandidates>(),
	};
}

function getPreparedCloseAcceptanceVolumeConvictionData(
	preparedData: unknown,
	data: OHLCVData[]
): CloseAcceptanceVolumeConvictionPrepared {
	if (preparedData && typeof preparedData === "object" && "acceptanceRankByLookback" in preparedData) {
		return preparedData as CloseAcceptanceVolumeConvictionPrepared;
	}
	return prepareCloseAcceptanceVolumeConvictionData(data);
}

function getAcceptanceRank(
	prepared: CloseAcceptanceVolumeConvictionPrepared,
	lookback: number
): (number | null)[] {
	let rank = prepared.acceptanceRankByLookback.get(lookback);
	if (!rank) {
		rank = buildPercentileRank(prepared.absAcceptance, lookback);
		prepared.acceptanceRankByLookback.set(lookback, rank);
	}
	return rank;
}

function getVolumeRank(
	prepared: CloseAcceptanceVolumeConvictionPrepared,
	lookback: number
): (number | null)[] {
	let rank = prepared.volumeRankByLookback.get(lookback);
	if (!rank) {
		rank = buildPercentileRank(prepared.volumes, lookback);
		prepared.volumeRankByLookback.set(lookback, rank);
	}
	return rank;
}

function getConvictionCandidates(
	prepared: CloseAcceptanceVolumeConvictionPrepared,
	lookback: number
): CloseAcceptanceVolumeConvictionCandidates {
	let candidates = prepared.candidateByLookback.get(lookback);
	if (candidates) return candidates;

	const accRank = getAcceptanceRank(prepared, lookback);
	const volRank = getVolumeRank(prepared, lookback);
	const indexes: number[] = [];
	const acceptanceRanks: number[] = [];
	const volumeRanks: number[] = [];
	const directions: number[] = [];

	for (let i = lookback; i < prepared.cleanData.length; i++) {
		const ar = accRank[i];
		const vr = volRank[i];
		const acceptance = prepared.acceptance[i];
		if (ar === null || ar === undefined || vr === null || vr === undefined) continue;
		if (ar < 0.5 || vr < 0.5 || acceptance === 0) continue;
		indexes.push(i);
		acceptanceRanks.push(ar);
		volumeRanks.push(vr);
		directions.push(acceptance > 0 ? 1 : -1);
	}

	candidates = { indexes, acceptanceRanks, volumeRanks, directions };
	prepared.candidateByLookback.set(lookback, candidates);
	return candidates;
}

export const close_acceptance_volume_conviction: Strategy = {
	name: "Close Acceptance Volume Conviction",
	description: "When close acceptance reaches an extreme and volume simultaneously confirms with a high percentile rank, the market has produced a high-conviction directional settlement backed by genuine participation. Trade continuation.",
	defaultParams: {
		lookback: 30,
		convictionRank: 85 },
	paramLabels: {
		lookback: "Lookback",
		convictionRank: "Conviction Rank" },
	normalizeParams: normalizeCloseAcceptanceVolumeConvictionParams,
	prepareFinderData: (data) => prepareCloseAcceptanceVolumeConvictionData(data),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const prepared = getPreparedCloseAcceptanceVolumeConvictionData(preparedData, data);
		const p = normalizeCloseAcceptanceVolumeConvictionParams(params);
		const lookback = p.lookback as number;
		const rankThreshold = p.convictionRank as number / 100;
		if (prepared.cleanData.length < lookback + 2) return [];

		const candidates = getConvictionCandidates(prepared, lookback);
		const signals: Signal[] = [];
		for (let i = 0; i < candidates.indexes.length; i++) {
			const ar = candidates.acceptanceRanks[i];
			const vr = candidates.volumeRanks[i];
			if (ar < rankThreshold || vr < rankThreshold) continue;
			const barIndex = candidates.indexes[i];

			if (candidates.directions[i] > 0) {
				signals.push(createBuySignal(prepared.cleanData, barIndex, `High-conviction bullish (acc rank ${(ar * 100).toFixed(0)}%, vol rank ${(vr * 100).toFixed(0)}%)`));
			} else {
				signals.push(createSellSignal(prepared.cleanData, barIndex, `High-conviction bearish (acc rank ${(ar * 100).toFixed(0)}%, vol rank ${(vr * 100).toFixed(0)}%)`));
			}
		}
		return signals;
	},
	execute: (data: OHLCVData[], params: StrategyParams) =>
		close_acceptance_volume_conviction.executePrepared?.(prepareCloseAcceptanceVolumeConvictionData(data), params, data) ?? [],
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "convictionRank"] } };
