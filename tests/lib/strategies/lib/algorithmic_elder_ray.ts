import { Strategy, StrategyParams } from "../../types/strategies";
import { createSignalLoop, ensureCleanData, createBuySignal, createSellSignal, getCloses } from "../strategy-helpers";
import { buildDualTimeframeRatio, buildRateOfChange } from "./price-action-statistics-core";
import { calculateSMA } from "../indicators";

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		fastMacro: Math.max(2, Math.round(params.fastMacro ?? 20)),
		slowMacro: Math.max(2, Math.round(params.slowMacro ?? 100)),
		snapbackRoc: Number(params.snapbackRoc ?? 1.0)
	};
}

export const algorithmic_elder_ray: Strategy = {
	name: "Algorithmic Elder Ray",
	description: "Elder's Triple Screen relies on macro alignment and micro pullbacks. We quantize this by checking if the macro Dual Timeframe Ratio is aligned, and entering exactly when micro-momentum experiences a sharp, 1-bar negative snapback.",
	defaultParams: { fastMacro: 20, slowMacro: 100, snapbackRoc: 1.0 },
	paramLabels: { fastMacro: "Fast Macro SMA", slowMacro: "Slow Macro SMA", snapbackRoc: "Snapback ROC" },
	normalizeParams,
	metadata: { role: "entry", direction: "both", walkForwardParams: ["fastMacro", "slowMacro", "snapbackRoc"] },
	execute: (data, params) => {
		const clean = ensureCleanData(data);
		const p = normalizeParams(params);
		if (clean.length < p.slowMacro) return [];

		const closes = getCloses(clean);
		const ratio = buildDualTimeframeRatio(closes, p.fastMacro, p.slowMacro, calculateSMA);
		const roc1 = buildRateOfChange(closes, 1);

		return createSignalLoop(clean, [ratio, roc1], (i) => {
			if (i === 0) return null;

			const r = ratio[i - 1];
			const roc = roc1[i - 1];

			if (r !== null && roc !== null) {
				if (r > 1.0 && roc < -p.snapbackRoc) {
					return createBuySignal(clean, i, "Algorithmic Elder Ray Long");
				}
				if (r < 1.0 && roc > p.snapbackRoc) {
					return createSellSignal(clean, i, "Algorithmic Elder Ray Short");
				}
			}

			return null;
		});
	}
};
