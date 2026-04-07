import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRollingEntropy, buildPercentileRank } from "./price-action-statistics-core";

function normalizeEntropyPhiPercentileSingularityParams(params: StrategyParams): StrategyParams {
	const entropyLookback = Math.max(2, Math.round(params.entropyLookback ?? 34));
	const phiPercentile = Math.min(1, Math.max(0, Number(params.phiPercentile ?? 0.618)));
	return { ...params, entropyLookback, phiPercentile };
}

export const entropy_phi_percentile_singularity: Strategy = {
	name: "Entropy Phi Percentile Singularity",
	description:
		"Identifies the exact moment the market transitions into a terminal noise state by tracking when the percentile rank of entropy hits the golden ratio, fading the ensuing random-walk breakdown.",
	defaultParams: { entropyLookback: 34, phiPercentile: 0.618 },
	paramLabels: { entropyLookback: "Entropy Lookback", phiPercentile: "Phi Percentile" },
	normalizeParams: normalizeEntropyPhiPercentileSingularityParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const np = normalizeEntropyPhiPercentileSingularityParams(params);
		if (cleanData.length < np.entropyLookback + 2) return [];
		const closes = getCloses(cleanData);
		const diffs: number[] = [];
		for (let i = 1; i < closes.length; i++) diffs.push(closes[i] - closes[i - 1]);
		const entropy = buildRollingEntropy(diffs, np.entropyLookback);
		const entropyClean = entropy.map((v) => v ?? 0);
		const pRank = buildPercentileRank(entropyClean, np.entropyLookback);
		const pRankAligned: (number | null)[] = new Array(cleanData.length).fill(null);
		for (let i = 1; i < cleanData.length; i++) pRankAligned[i] = pRank[i - 1];
		return createSignalLoop(cleanData, [pRankAligned], (i) => {
			const prev = pRankAligned[i - 1];
			const curr = pRankAligned[i];
			if (prev === null || curr === null) return null;
			if (prev <= np.phiPercentile && curr > np.phiPercentile) {
				if (cleanData[i].close > cleanData[i].open)
					return createBuySignal(cleanData, i, `Entropy percentile crossed above ${np.phiPercentile}`);
				if (cleanData[i].close < cleanData[i].open)
					return createSellSignal(cleanData, i, `Entropy percentile crossed above ${np.phiPercentile}`);
			}
			return null;
		});
	},
	metadata: { role: "entry", direction: "both", walkForwardParams: ["entropyLookback", "phiPercentile"] } };
