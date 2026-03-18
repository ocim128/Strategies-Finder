import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { calculateMFI } from "../indicators";
import { buildRollingStdDev, buildEfficiencyRatio } from "./price-action-statistics-core";

export const mfi_variance_efficiency_breakout: Strategy = {
	name: "MFI Variance Efficiency Breakout",
	description: "Quantifies extreme structural dead tapes where the mathematical variance (Standard Deviation) of the Money Flow Index collapses while price path efficiency rests squarely at zero, firing blindly into the resolution.",
	defaultParams: {
		mfiPeriod: 14,
		varianceLookback: 30,
		varianceFloor: 5.0,
	},
	paramLabels: {
		mfiPeriod: "MFI Period",
		varianceLookback: "Variance Lookback",
		varianceFloor: "Variance Floor",
	},
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const mfiLen = Number(params.mfiPeriod ?? 14);
		const lookback = Number(params.varianceLookback ?? 30);
		const floor = Number(params.varianceFloor ?? 5.0);

		if (cleanData.length < Math.max(mfiLen, lookback)) return [];

		const mfi = calculateMFI(
			cleanData.map(d => d.high),
			cleanData.map(d => d.low),
			cleanData.map(d => d.close),
			cleanData.map(d => d.volume),
			mfiLen
		);

		const cleanMfi = mfi.map(m => m === null ? 0 : m);
		const stddev = buildRollingStdDev(cleanMfi, lookback);
        const er = buildEfficiencyRatio(cleanData, lookback);

		return createSignalLoop(cleanData, [], (i) => {
			if (i < 1 || stddev[i-1] === null || er[i-1] === null || er[i] === null) return null;

            const wasDead = (stddev[i-1]! < floor) && (Math.abs(er[i-1]!) < 0.1);

            if (wasDead && er[i]! > 0.3) {
                return createBuySignal(cleanData, i, "MFI Deadzone Efficiency Breakout Long");
            }

            if (wasDead && er[i]! < -0.3) {
                return createSellSignal(cleanData, i, "MFI Deadzone Efficiency Breakout Short");
            }

			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["mfiPeriod", "varianceLookback", "varianceFloor"],
	},
};
