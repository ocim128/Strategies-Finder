import { Strategy, StrategyParams } from "../../types/strategies";
import { createSignalLoop, ensureCleanData, createBuySignal, createSellSignal } from "../strategy-helpers";
import { extractBarMetricSeries, buildRollingAverage } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		rangeLookback: Math.max(2, Math.round(params.rangeLookback ?? 20)),
		rangeSpike: Number(params.rangeSpike ?? 2.5),
		imbalanceReq: Number(params.imbalanceReq ?? 0.85)
	};
}

export const algorithmic_liquidity_spoof: Strategy = {
	name: "Algorithmic Liquidity Spoof",
	description: "A massive expansion in true range that consists entirely of wick imbalance means a breakout was spoofed solely to trigger high-frequency stop-losses.",
	defaultParams: { rangeLookback: 20, rangeSpike: 2.5, imbalanceReq: 0.85 },
	paramLabels: { rangeLookback: "Range Lookback", rangeSpike: "Range Spike Multiplier", imbalanceReq: "Wick Imbalance Requirement" },
	normalizeParams,
	metadata: { role: "entry", direction: "both", walkForwardParams: ["rangeLookback", "rangeSpike", "imbalanceReq"] },
	execute: (data, params) => {
		const clean = ensureCleanData(data);
		const p = normalizeParams(params);
		if (clean.length < p.rangeLookback) return [];

		const trueRange = extractBarMetricSeries(clean, 'trueRange');
		const wickImbalance = extractBarMetricSeries(clean, 'wickImbalance');
		const smaTrueRange = buildRollingAverage(trueRange, p.rangeLookback);

		return createSignalLoop(clean, [smaTrueRange], (i) => {
			if (i === 0) return null;
			
			const prevSmaTr = smaTrueRange[Math.max(0, i-2)] ?? smaTrueRange[i-1];
			if (prevSmaTr === null || prevSmaTr === 0) return null;

			const currentTr = trueRange[i-1];
			const currentImb = wickImbalance[i-1];

			if (currentTr > p.rangeSpike * prevSmaTr) {
				if (currentImb < -p.imbalanceReq) {
					// Negative imbalance = massive lower wick = structural rejection downward
					return createBuySignal(clean, i, "Spoofed Breakdown Rejection");
				}

				if (currentImb > p.imbalanceReq) {
					// Positive imbalance = massive upper wick = structural rejection upward
					return createSellSignal(clean, i, "Spoofed Breakout Rejection");
				}
			}

			return null;
		});
	}
};
