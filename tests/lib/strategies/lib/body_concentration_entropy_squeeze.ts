import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildBodyPctSeries, buildRollingAverage } from "./price-action-frequency-core";
import { buildRollingEntropy, buildPercentileRank } from "./price-action-statistics-core";

function normalizeBodyConcentrationEntropySqueezeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		entropyWindow: Math.max(3, Math.round(params.entropyWindow ?? 30)),
		compressionRank: Math.max(0, Math.min(100, Number(params.compressionRank ?? 20))) };
}

export const body_concentration_entropy_squeeze: Strategy = {
	name: "Body Concentration Entropy Squeeze",
	description: "When entropy of body percentage drops to a percentile extreme, bars have become highly predictable in directional commitment — a low-disorder conviction state. Enter in the direction of the rolling average close deviation.",
	defaultParams: {
		entropyWindow: 30,
		compressionRank: 20 },
	paramLabels: {
		entropyWindow: "Entropy Window",
		compressionRank: "Compression Rank Max" },
	normalizeParams: normalizeBodyConcentrationEntropySqueezeParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeBodyConcentrationEntropySqueezeParams(params);
		const window = p.entropyWindow as number;
		const rankMax = p.compressionRank as number;
		if (cleanData.length < window + 2) return [];

		const closes = getCloses(cleanData);
		const bodyPct = buildBodyPctSeries(cleanData);
		const entropy = buildRollingEntropy(bodyPct, window);
		const entropyClean = entropy.map(v => v ?? 0);
		const rank = buildPercentileRank(entropyClean, window);
		const avgClose = buildRollingAverage(closes, window);

		return createSignalLoop(cleanData, [rank, avgClose], (i) => {
			if (i < window) return null;
			const r = rank[i];
			const avg = avgClose[i];
			if (r === null || avg === null) return null;
			if (r >= rankMax / 100) return null;

			if (closes[i] > avg) {
				return createBuySignal(cleanData, i, `Body entropy squeezed (rank ${(r * 100).toFixed(0)}%), close above avg — low-disorder bullish`);
			}
			if (closes[i] < avg) {
				return createSellSignal(cleanData, i, `Body entropy squeezed (rank ${(r * 100).toFixed(0)}%), close below avg — low-disorder bearish`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["entropyWindow", "compressionRank"] } };
