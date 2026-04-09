import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildCumulativeDecaySum } from "./price-action-statistics-core";

function normalizeDecayMomentumInflectionParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		rocPeriod: Math.max(1, Math.round(params.rocPeriod ?? 1)),
		decayFactor: Math.max(0.01, Math.min(0.999, Number(params.decayFactor ?? 0.9))) };
}

export const decay_momentum_inflection: Strategy = {
	name: "Decay Momentum Inflection",
	description: "An exponentially decay-weighted cumulative sum of close changes gives recent moves disproportionate weight. When this series crosses zero, structural momentum has shifted — catching regime changes earlier than moving-average crosses.",
	defaultParams: {
		rocPeriod: 1,
		decayFactor: 0.9 },
	paramLabels: {
		rocPeriod: "ROC Period",
		decayFactor: "Decay Factor" },
	normalizeParams: normalizeDecayMomentumInflectionParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeDecayMomentumInflectionParams(params);
		const rocPeriod = p.rocPeriod as number;
		if (cleanData.length < rocPeriod + 2) return [];

		const closes = getCloses(cleanData);
		const changes: number[] = new Array(cleanData.length).fill(0);
		for (let i = rocPeriod; i < cleanData.length; i++) {
			changes[i] = closes[i] - closes[i - rocPeriod];
		}

		const decayed = buildCumulativeDecaySum(changes, p.decayFactor as number);

		return createSignalLoop(cleanData, [], (i) => {
			if (i < rocPeriod + 1) return null;

			if (decayed[i - 1] < 0 && decayed[i] >= 0) {
				return createBuySignal(cleanData, i, `Decay momentum crossed zero bullish (${decayed[i - 1].toFixed(4)}→${decayed[i].toFixed(4)})`);
			}
			if (decayed[i - 1] > 0 && decayed[i] <= 0) {
				return createSellSignal(cleanData, i, `Decay momentum crossed zero bearish (${decayed[i - 1].toFixed(4)}→${decayed[i].toFixed(4)})`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["rocPeriod", "decayFactor"] } };
