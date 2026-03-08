import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { clamp, getPriceActionBarMetrics } from "./price-action-frequency-core";

export const prior_range_open_trap: Strategy = {
	name: "Prior Range Open Trap",
	description: "Trades bars that open in an extreme zone of the previous range and reverse to close with directional control.",
	defaultParams: {
		zonePct: 0.2,
		closeLocationThreshold: 0.72,
		minPrevRangePct: 0.004,
	},
	paramLabels: {
		zonePct: "Previous Range Open Zone",
		closeLocationThreshold: "Close Location Threshold",
		minPrevRangePct: "Min Previous Range %",
	},
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		if (cleanData.length < 3) return [];

		const zonePct = clamp(params.zonePct ?? 0.2, 0, 0.5);
		const closeLocationThreshold = clamp(params.closeLocationThreshold ?? 0.72, 0.5, 1);
		const minPrevRangePct = Math.max(0, params.minPrevRangePct ?? 0.004);

		const prevRangePct: (number | null)[] = new Array(cleanData.length).fill(null);
		for (let i = 1; i < cleanData.length; i++) {
			const prev = cleanData[i - 1];
			const prevRange = prev.high - prev.low;
			const priceRef = Math.max(Math.abs(prev.close), 1e-9);
			prevRangePct[i] = prevRange / priceRef;
		}

		return createSignalLoop(cleanData, [prevRangePct], (i) => {
			const prev = cleanData[i - 1];
			const curr = cleanData[i];
			const prevRange = prev.high - prev.low;
			if (prevRange <= 0 || (prevRangePct[i] as number) < minPrevRangePct) return null;

			const prevMid = (prev.high + prev.low) / 2;
			const metrics = getPriceActionBarMetrics(curr);
			const openInLowerZone = curr.open <= prev.low + prevRange * zonePct;
			const openInUpperZone = curr.open >= prev.high - prevRange * zonePct;

			if (openInLowerZone && metrics.closeLocation >= closeLocationThreshold && curr.close > prevMid) {
				return createBuySignal(cleanData, i, "Prior range open trap bullish");
			}
			if (openInUpperZone && metrics.closeLocation <= 1 - closeLocationThreshold && curr.close < prevMid) {
				return createSellSignal(cleanData, i, "Prior range open trap bearish");
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["zonePct", "closeLocationThreshold", "minPrevRangePct"],
	},
};
