import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getTypicalPrices } from "../strategy-helpers";
import { calculateSessionVWAP } from "../indicators";
import { buildRollingAverage } from "./price-action-frequency-core";
import { extractBarMetricSeries } from "./price-action-statistics-core";

function normalizeVwapPhiDistanceReversionParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		atr_lookback: Math.max(2, Math.round(params.atr_lookback ?? 14)),
		phi_distance: Math.max(0.01, Number(params.phi_distance ?? 0.382)),
	};
}

export const vwap_phi_distance_reversion: Strategy = {
	name: "VWAP Phi Distance Reversion",
	description: "When the typical price disconnects from Session VWAP by exactly 0.382 of the rolling True Range, passive mean-reversion algos activate at the mathematical microstructure boundary.",
	defaultParams: {
		atr_lookback: 14,
		phi_distance: 0.382,
	},
	paramLabels: {
		atr_lookback: "ATR Lookback",
		phi_distance: "Phi Distance",
	},
	normalizeParams: normalizeVwapPhiDistanceReversionParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeVwapPhiDistanceReversionParams(params);
		if (cleanData.length < p.atr_lookback) return [];

		const typicalPrices = getTypicalPrices(cleanData);
		const sessionVwap = calculateSessionVWAP(cleanData);
		const trueRange = extractBarMetricSeries(cleanData, "trueRange");
		const atr = buildRollingAverage(trueRange, p.atr_lookback);

		return createSignalLoop(cleanData, [sessionVwap, atr], (i) => {
			if (i < p.atr_lookback) return null;
			const vwap = sessionVwap[i];
			const avgTR = atr[i];
			if (vwap === null || avgTR === null) return null;

			const distance = typicalPrices[i] - vwap;
			const boundary = avgTR * p.phi_distance;
			if (distance < -boundary && cleanData[i].close > cleanData[i].open)
				return createBuySignal(cleanData, i, "Typical price below VWAP phi band");
			if (distance > boundary && cleanData[i].close < cleanData[i].open)
				return createSellSignal(cleanData, i, "Typical price above VWAP phi band");
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["atr_lookback", "phi_distance"],
	},
};
