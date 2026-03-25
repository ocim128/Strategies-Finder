import { Strategy, StrategyParams } from "../../types/strategies";
import { createSignalLoop, ensureCleanData, createBuySignal, createSellSignal } from "../strategy-helpers";
import { buildRollingAverage, getPriceActionBarMetrics } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		atrLookback: Math.max(2, Math.round(params.atrLookback ?? 30)),
		wickRatioThreshold: Number(params.wickRatioThreshold ?? 0.75),
		rangeMultiple: Number(params.rangeMultiple ?? 2.0)
	};
}

export const noisy_wick_fade_reversion: Strategy = {
	name: "Noisy Wick Fade Reversion",
	description: "Detects severe 1m wicks that represent isolated algorithmic slippage or single-print sweeps, fading them instantly for violent micro mean-reversion.",
	defaultParams: { atrLookback: 30, wickRatioThreshold: 0.75, rangeMultiple: 2.0 },
	paramLabels: { atrLookback: "ATR Lookback", wickRatioThreshold: "Wick Ratio Threshold", rangeMultiple: "Range Multiple" },
	normalizeParams,
	metadata: { role: "entry", direction: "both", walkForwardParams: ["atrLookback", "wickRatioThreshold", "rangeMultiple"] },
	execute: (data, params) => {
		const clean = ensureCleanData(data);
		const p = normalizeParams(params);
		if (clean.length < p.atrLookback) return [];

		const trs = clean.map((c, i) => {
			if (i === 0) return Math.max(0, c.high - c.low);
			return Math.max(c.high - c.low, Math.abs(c.high - clean[i-1].close), Math.abs(c.low - clean[i-1].close));
		});
		const avgTrs = buildRollingAverage(trs, p.atrLookback);

		return createSignalLoop(clean, [avgTrs], (i) => {
			if (i === 0) return null;
			
			const prevAtr = avgTrs[Math.max(0, i-2)] ?? avgTrs[i-1];
			if (prevAtr === null || prevAtr === 0) return null;

			const m = getPriceActionBarMetrics(clean[i-1]);
			const barTr = trs[i-1];

			if (m.range > 0 && barTr > prevAtr * p.rangeMultiple) {
				const lowerWickRatio = m.lowerWick / m.range;
				const upperWickRatio = m.upperWick / m.range;

				if (lowerWickRatio > p.wickRatioThreshold) {
					return createBuySignal(clean, i, "Noisy Lower Wick Fade");
				}

				if (upperWickRatio > p.wickRatioThreshold) {
					return createSellSignal(clean, i, "Noisy Upper Wick Fade");
				}
			}

			return null;
		});
	}
};
