import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getHighs, getLows, getCloses, getVolumes } from "../strategy-helpers";
import { calculateCMF } from "../indicators";

function normalizeCmfZeroLineRegimeFlipParams(params: StrategyParams): StrategyParams {
	const cmfPeriod = Math.max(2, Math.round(params.cmfPeriod ?? 20));
	return { ...params, cmfPeriod };
}

export const cmf_zero_line_regime_flip: Strategy = {
	name: "CMF Zero-Line Regime Flip",
	description:
		"Chaikin Money Flow measures accumulation vs distribution by comparing close location within the bar against volume. When CMF crosses zero, the dominant money flow regime has changed from selling pressure to buying pressure (or vice versa). This zero-line cross is a direct, single-threshold regime boundary.",
	defaultParams: { cmfPeriod: 20 },
	paramLabels: { cmfPeriod: "CMF Period" },
	normalizeParams: normalizeCmfZeroLineRegimeFlipParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const np = normalizeCmfZeroLineRegimeFlipParams(params);
		if (cleanData.length < np.cmfPeriod + 2) return [];
		const highs = getHighs(cleanData);
		const lows = getLows(cleanData);
		const closes = getCloses(cleanData);
		const volumes = getVolumes(cleanData);
		const cmf = calculateCMF(highs, lows, closes, volumes, np.cmfPeriod);
		return createSignalLoop(cleanData, [cmf], (i) => {
			const prev = cmf[i - 1];
			const curr = cmf[i];
			if (prev === null || curr === null) return null;
			if (prev < 0 && curr >= 0)
				return createBuySignal(cleanData, i, `CMF regime flip from distribution to accumulation ${prev.toFixed(4)} -> ${curr.toFixed(4)}`);
			if (prev >= 0 && curr < 0)
				return createSellSignal(cleanData, i, `CMF regime flip from accumulation to distribution ${prev.toFixed(4)} -> ${curr.toFixed(4)}`);
			return null;
		});
	},
	metadata: { role: "entry", direction: "both", walkForwardParams: ["cmfPeriod"] } };
