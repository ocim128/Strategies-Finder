import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, ensureCleanData, getHighs, getLows } from "../strategy-helpers";
import { getPriceActionBarMetrics } from "./price-action-frequency-core";
import { calculateKeltnerChannels } from "../indicators";

function normalizeSingularityBandPhiRejectionParams(params: StrategyParams): StrategyParams {
	const keltnerLookback = Math.max(2, Math.round(params.keltnerLookback ?? 21));
	const phiMultiplier = Math.max(0.1, Number(params.phiMultiplier ?? 1.618));
	return { ...params, keltnerLookback, phiMultiplier };
}

export const singularity_band_phi_rejection: Strategy = {
	name: "Singularity Band Phi Rejection",
	description:
		"Models boundaries using exactly 1.618 ATR multiplier bands. Fades the false penetration when price pierces the harmonic singularity but fails to hold its close in the outer zone.",
	defaultParams: { keltnerLookback: 21, phiMultiplier: 1.618 },
	paramLabels: { keltnerLookback: "Keltner Lookback", phiMultiplier: "Phi Multiplier" },
	normalizeParams: normalizeSingularityBandPhiRejectionParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const np = normalizeSingularityBandPhiRejectionParams(params);
		if (cleanData.length < np.keltnerLookback + 2) return [];

		const highs = getHighs(cleanData);
		const lows = getLows(cleanData);
		const closes = cleanData.map((d) => d.close);
		const kc = calculateKeltnerChannels(highs, lows, closes, np.keltnerLookback, np.keltnerLookback, np.phiMultiplier);

		const signals = [];
		for (let i = np.keltnerLookback; i < cleanData.length; i++) {
			const upper = kc.upper[i];
			const lower = kc.lower[i];
			if (upper === null || lower === null) continue;

			const bar = cleanData[i];
			const metrics = getPriceActionBarMetrics(bar);
			const cl = metrics.closeLocation;

			if (bar.low < lower && bar.close > lower && cl > 0.618) {
				signals.push(createBuySignal(cleanData, i, `Singularity band rejection: low pierced lower, close > lower, CL > 0.618`));
			}
			if (bar.high > upper && bar.close < upper && cl < 0.382) {
				signals.push(createSellSignal(cleanData, i, `Singularity band rejection: high pierced upper, close < upper, CL < 0.382`));
			}
		}
		return signals;
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["keltnerLookback", "phiMultiplier"],
	},
};
