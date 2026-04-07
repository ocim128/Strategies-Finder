import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import {
	buildRollingAutoCorrelation,
	buildCumulativeDecaySum,
	buildRollingZScore } from "./price-action-statistics-core";

function normalizeAutocorrelationPhiDecayParams(params: StrategyParams): StrategyParams {
	const autoCorrLookback = Math.max(2, Math.round(params.autoCorrLookback ?? 21));
	const phiDecay = Math.min(1, Math.max(0, Number(params.phiDecay ?? 0.618)));
	const zscoreExtreme = Math.max(0.1, Number(params.zscoreExtreme ?? 1.618));
	return { ...params, autoCorrLookback, phiDecay, zscoreExtreme };
}

export const autocorrelation_phi_decay: Strategy = {
	name: "Autocorrelation Phi Decay",
	description:
		"Applies a 0.618 decay factor to the rolling autocorrelation, creating an infinite-impulse memory of path dependency. Fades when this structural memory reaches a Z-score extreme.",
	defaultParams: { autoCorrLookback: 21, phiDecay: 0.618, zscoreExtreme: 1.618 },
	paramLabels: { autoCorrLookback: "Autocorrelation Lookback", phiDecay: "Phi Decay", zscoreExtreme: "Z-Score Extreme" },
	normalizeParams: normalizeAutocorrelationPhiDecayParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const np = normalizeAutocorrelationPhiDecayParams(params);
		if (cleanData.length < np.autoCorrLookback + 2) return [];
		const closes = getCloses(cleanData);
		const autoCorr = buildRollingAutoCorrelation(closes, np.autoCorrLookback);
		const scores = autoCorr.map((v) => v ?? 0);
		const decayed = buildCumulativeDecaySum(scores, np.phiDecay);
		const zScore = buildRollingZScore(decayed, np.autoCorrLookback);
		return createSignalLoop(cleanData, [zScore], (i) => {
			const z = zScore[i];
			if (z === null) return null;
			if (z < -np.zscoreExtreme && cleanData[i].close > cleanData[i].open)
				return createBuySignal(cleanData, i, `Decayed autocorrelation Z-score ${z.toFixed(2)} < -${np.zscoreExtreme}`);
			if (z > np.zscoreExtreme && cleanData[i].close < cleanData[i].open)
				return createSellSignal(cleanData, i, `Decayed autocorrelation Z-score ${z.toFixed(2)} > ${np.zscoreExtreme}`);
			return null;
		});
	},
	metadata: { role: "entry", direction: "both", walkForwardParams: ["autoCorrLookback", "phiDecay", "zscoreExtreme"] } };
