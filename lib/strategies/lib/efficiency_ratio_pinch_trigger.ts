import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildEfficiencyRatio, buildRateOfChange } from "./price-action-statistics-core";

export const efficiency_ratio_pinch_trigger: Strategy = {
	name: "Efficiency Ratio Pinch Trigger",
	description: "Triggers a directional breakout only after the prior efficiency ratio collapses into a clear chop pinch.",
	defaultParams: {
		erLookback: 14,
		compressionThreshold: 0.3,
		rocTrigger: 1.5,
	},
	paramLabels: {
		erLookback: "ER Lookback",
		compressionThreshold: "Compression Threshold",
		rocTrigger: "ROC Trigger (%)",
	},
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		if (cleanData.length < 5) return [];

		const erLookback = Math.max(2, Math.round(params.erLookback ?? 14));
		const compressionThreshold = Math.max(0, params.compressionThreshold ?? 0.3);
		const rocTrigger = Math.max(0, params.rocTrigger ?? 1.5);
		const efficiencyRatio = buildEfficiencyRatio(cleanData, erLookback);
		const rocPct = buildRateOfChange(getCloses(cleanData), erLookback).map((value) =>
			value === null ? null : value * 100
		);

		return createSignalLoop(cleanData, [efficiencyRatio, rocPct], (i) => {
			const priorEr = efficiencyRatio[i - 1] as number;
			const rocValue = rocPct[i] as number;
			if (priorEr > compressionThreshold) return null;

			if (rocValue >= rocTrigger) {
				return createBuySignal(cleanData, i, "Efficiency pinch bullish trigger");
			}
			if (rocValue <= -rocTrigger) {
				return createSellSignal(cleanData, i, "Efficiency pinch bearish trigger");
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["erLookback", "compressionThreshold", "rocTrigger"],
	},
};
