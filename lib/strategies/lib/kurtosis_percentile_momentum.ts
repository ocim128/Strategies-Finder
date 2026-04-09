import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRateOfChange, buildRollingKurtosis, buildPercentileRank } from "./price-action-statistics-core";

function normalizeKurtosisPercentileMomentumParams(params: StrategyParams): StrategyParams {
	const kurtosisWindow = Math.max(4, Math.round(params.kurtosisWindow ?? 30));
	const momentumWindow = Math.max(1, Math.round(params.momentumWindow ?? 5));
	return {
		...params,
		kurtosisWindow,
		momentumWindow: Math.min(momentumWindow, kurtosisWindow - 1) };
}

export const kurtosis_percentile_momentum: Strategy = {
	name: "Kurtosis Percentile Momentum",
	description: "When rolling kurtosis reaches a high percentile rank, extreme moves are statistically probable. In this fat-tailed regime, momentum tends to persist due to institutional flow imbalances.",
	defaultParams: {
		kurtosisWindow: 30,
		momentumWindow: 5 },
	paramLabels: {
		kurtosisWindow: "Kurtosis Window",
		momentumWindow: "Momentum Window" },
	normalizeParams: normalizeKurtosisPercentileMomentumParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeKurtosisPercentileMomentumParams(params);
		if (cleanData.length < p.kurtosisWindow) return [];

		const closes = getCloses(cleanData);
		const returns = buildRateOfChange(closes, 1);
		const returnValues: number[] = new Array(cleanData.length).fill(0);
		for (let i = 0; i < cleanData.length; i++) {
			returnValues[i] = returns[i] ?? 0;
		}
		const kurtosis = buildRollingKurtosis(returnValues, p.kurtosisWindow);
		const kurtosisValues: number[] = new Array(cleanData.length).fill(0);
		for (let i = 0; i < cleanData.length; i++) {
			kurtosisValues[i] = kurtosis[i] ?? 0;
		}
		const rank = buildPercentileRank(kurtosisValues, p.kurtosisWindow);
		const momentum = buildRateOfChange(closes, p.momentumWindow);

		return createSignalLoop(cleanData, [rank, momentum], (i) => {
			if (i < p.kurtosisWindow) return null;
			const r = rank[i];
			const mom = momentum[i];
			if (r === null || mom === null) return null;

			if (r > 0.8 && mom > 0) {
				return createBuySignal(cleanData, i, `Kurtosis rank ${r.toFixed(3)} > 80th pctile, momentum ${mom.toFixed(4)} > 0, fat-tail continuation`);
			}
			if (r > 0.8 && mom < 0) {
				return createSellSignal(cleanData, i, `Kurtosis rank ${r.toFixed(3)} > 80th pctile, momentum ${mom.toFixed(4)} < 0, fat-tail continuation`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["kurtosisWindow", "momentumWindow"] } };
