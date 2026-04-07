import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { calculateEMA } from "../indicators";

export const ema_touch_continuation: Strategy = {
	name: "EMA Touch Continuation",
	description: "When close touches a short EMA and closes on the same side, enter in the close direction. Tests micro-bounces.",
	defaultParams: {
		emaPeriod: 8,
		touchPct: 0.001 },
	paramLabels: {
		emaPeriod: "EMA Period",
		touchPct: "Max Distance from EMA" },
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const closes = getCloses(cleanData);
		const emaPeriod = Number(params.emaPeriod ?? 8);
		const touchPct = Number(params.touchPct ?? 0.001);

		if (cleanData.length < emaPeriod * 2) return [];

		const ema = calculateEMA(closes, emaPeriod);

		return createSignalLoop(cleanData, [], (i) => {
			if (i < emaPeriod || ema[i] === null) return null;

			const c = closes[i];
			const e = ema[i]!;

			if (Math.abs(c - e) / c <= touchPct) {
				if (c >= e) {
					return createBuySignal(cleanData, i, "Bounce continuation above EMA");
				} else {
					return createSellSignal(cleanData, i, "Bounce continuation below EMA");
				}
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["emaPeriod", "touchPct"] } };
