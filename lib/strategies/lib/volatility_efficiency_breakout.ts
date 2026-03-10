import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildEfficiencyRatio, buildRateOfChange } from "./price-action-statistics-core";

export const volatility_efficiency_breakout: Strategy = {
	name: "Volatility Efficiency Breakout",
	description: "Triggers when low-efficiency compression hands off to a clean directional rate-of-change breakout.",
	defaultParams: {
		erLength: 14,
		compressionThreshold: 0.25,
		rocThreshold: 0.015,
	},
	paramLabels: {
		erLength: "ER Length",
		compressionThreshold: "Compression Threshold",
		rocThreshold: "ROC Threshold",
	},
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		if (cleanData.length < 5) return [];

		const erLength = Math.max(2, Math.round(params.erLength ?? 14));
		const compressionThreshold = Math.max(0, params.compressionThreshold ?? 0.25);
		const rocThreshold = Math.max(0, params.rocThreshold ?? 0.015);
		const efficiencyRatio = buildEfficiencyRatio(cleanData, erLength);
		const roc = buildRateOfChange(getCloses(cleanData), erLength);

		return createSignalLoop(cleanData, [efficiencyRatio, roc], (i) => {
			const er = efficiencyRatio[i] as number;
			const rocValue = roc[i] as number;
			if (er > compressionThreshold) return null;

			if (rocValue >= rocThreshold) {
				return createBuySignal(cleanData, i, "Efficiency compression bullish breakout");
			}
			if (rocValue <= -rocThreshold) {
				return createSellSignal(cleanData, i, "Efficiency compression bearish breakout");
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["erLength", "compressionThreshold", "rocThreshold"],
	},
};
