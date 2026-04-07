import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getHighs, getLows, getCloses, getVolumes } from "../strategy-helpers";
import { calculateMFI } from "../indicators";

function normalizeMfiExtremeReversalParams(params: StrategyParams): StrategyParams {
	const mfiPeriod = Math.max(2, Math.round(params.mfiPeriod ?? 14));
	const oversoldLevel = Math.min(40, Math.max(10, Number(params.oversoldLevel ?? 20)));
	const overboughtLevel = Math.min(90, Math.max(60, Number(params.overboughtLevel ?? 80)));
	return { ...params, mfiPeriod, oversoldLevel, overboughtLevel };
}

export const mfi_extreme_reversal: Strategy = {
	name: "MFI Extreme Reversal",
	description:
		"Money Flow Index is a volume-weighted RSI bounded 0-100. Extreme readings identify genuine buying or selling exhaustion where volume-confirmed momentum has reached an unsustainable extreme. The snap-back from these extremes is structurally persistent because informed participants reduce exposure at exhaustion points.",
	defaultParams: { mfiPeriod: 14, oversoldLevel: 20, overboughtLevel: 80 },
	paramLabels: { mfiPeriod: "MFI Period", oversoldLevel: "Oversold Level", overboughtLevel: "Overbought Level" },
	normalizeParams: normalizeMfiExtremeReversalParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const np = normalizeMfiExtremeReversalParams(params);
		if (cleanData.length < np.mfiPeriod + 2) return [];
		const highs = getHighs(cleanData);
		const lows = getLows(cleanData);
		const closes = getCloses(cleanData);
		const volumes = getVolumes(cleanData);
		const mfi = calculateMFI(highs, lows, closes, volumes, np.mfiPeriod);
		return createSignalLoop(cleanData, [mfi], (i) => {
			const prev = mfi[i - 1];
			const curr = mfi[i];
			if (prev === null || curr === null) return null;
			if (prev < np.oversoldLevel && curr >= np.oversoldLevel)
				return createBuySignal(cleanData, i, `MFI emerging from oversold ${prev.toFixed(1)} -> ${curr.toFixed(1)}`);
			if (prev > np.overboughtLevel && curr <= np.overboughtLevel)
				return createSellSignal(cleanData, i, `MFI emerging from overbought ${prev.toFixed(1)} -> ${curr.toFixed(1)}`);
			return null;
		});
	},
	metadata: { role: "entry", direction: "both", walkForwardParams: ["mfiPeriod", "oversoldLevel", "overboughtLevel"] } };
