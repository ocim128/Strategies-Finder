import { Strategy, StrategyParams } from "../../types/strategies";
import { createSignalLoop, ensureCleanData, createBuySignal, createSellSignal, getVolumes } from "../strategy-helpers";
import { getPriceActionBarMetrics, buildRollingAverage } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		lookback: Math.max(2, Math.round(params.lookback ?? 20)),
		wickRatioThreshold: Number(params.wickRatioThreshold ?? 0.65),
		volumeMultiplier: Number(params.volumeMultiplier ?? 3.0)
	};
}

export const absorptive_wick_volume_spike: Strategy = {
	name: "Absorptive Wick Volume Spike",
	description: "Locates the most distinct PA artifact of liquidity sweeps: a massively elongated wick that absorbs an equally immense volume climax.",
	defaultParams: { lookback: 20, wickRatioThreshold: 0.65, volumeMultiplier: 3.0 },
	paramLabels: { lookback: "Lookback", wickRatioThreshold: "Wick Ratio Threshold", volumeMultiplier: "Volume Multiplier" },
	normalizeParams,
	metadata: { role: "entry", direction: "both", walkForwardParams: ["lookback", "wickRatioThreshold", "volumeMultiplier"] },
	execute: (data, params) => {
		const clean = ensureCleanData(data);
		const p = normalizeParams(params);
		if (clean.length < p.lookback) return [];

		const volumes = getVolumes(clean);
		const avgVols = buildRollingAverage(volumes, p.lookback);

		return createSignalLoop(clean, [avgVols], (i) => {
			if (i === 0) return null;
			
			const prevV = avgVols[Math.max(0, i-2)] ?? avgVols[i-1];
			if (prevV === null || prevV === 0) return null;

			const m = getPriceActionBarMetrics(clean[i-1]);
			const isVolClimax = volumes[i-1] > prevV * p.volumeMultiplier;

			if (!isVolClimax || m.range === 0) return null;

			const lowerWickRatio = m.lowerWick / m.range;
			const upperWickRatio = m.upperWick / m.range;

			if (lowerWickRatio > p.wickRatioThreshold) {
				return createBuySignal(clean, i, "Absorptive Lower Wick Spike");
			}
			if (upperWickRatio > p.wickRatioThreshold) {
				return createSellSignal(clean, i, "Absorptive Upper Wick Spike");
			}

			return null;
		});
	}
};
