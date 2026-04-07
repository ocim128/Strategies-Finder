import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getHighs, getLows, getCloses, getVolumes } from "../strategy-helpers";
import { buildRollingZScore, extractBarMetricSeries } from "./price-action-statistics-core";
import { calculateCMF } from "../indicators";

function normalizeCmfGoldenAbsorptionParams(params: StrategyParams): StrategyParams {
	const cmfLookback = Math.max(2, Math.round(params.cmfLookback ?? 21));
	const phiZScore = Math.max(0.1, Number(params.phiZScore ?? 1.618));
	const phiAbsorptionLimit = Math.min(1, Math.max(0, Number(params.phiAbsorptionLimit ?? 0.382)));
	return { ...params, cmfLookback, phiZScore, phiAbsorptionLimit };
}

export const cmf_golden_absorption: Strategy = {
	name: "CMF Golden Absorption",
	description:
		"Tracks institutional flow via CMF. When money flow Z-score hits a 1.618 extreme but the bar's close location is heavily absorbed (<0.382), it signals an invisible algorithmic limit-order wall.",
	defaultParams: { cmfLookback: 21, phiZScore: 1.618, phiAbsorptionLimit: 0.382 },
	paramLabels: { cmfLookback: "CMF Lookback", phiZScore: "Phi Z-Score", phiAbsorptionLimit: "Phi Absorption Limit" },
	normalizeParams: normalizeCmfGoldenAbsorptionParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const np = normalizeCmfGoldenAbsorptionParams(params);
		if (cleanData.length < np.cmfLookback + 2) return [];
		const highs = getHighs(cleanData);
		const lows = getLows(cleanData);
		const closes = getCloses(cleanData);
		const volumes = getVolumes(cleanData);
		const cmf = calculateCMF(highs, lows, closes, volumes, np.cmfLookback);
		const cmfClean = cmf.map((v) => v ?? 0);
		const cmfZ = buildRollingZScore(cmfClean, np.cmfLookback);
		const closeLoc = extractBarMetricSeries(cleanData, "closeLocation");
		return createSignalLoop(cleanData, [cmfZ], (i) => {
			const z = cmfZ[i];
			if (z === null) return null;
			if (z < -np.phiZScore && closeLoc[i] > 1.0 - np.phiAbsorptionLimit)
				return createBuySignal(cleanData, i, `CMF Z-score ${z.toFixed(2)} < -${np.phiZScore}, absorbed at close location ${closeLoc[i].toFixed(3)}`);
			if (z > np.phiZScore && closeLoc[i] < np.phiAbsorptionLimit)
				return createSellSignal(cleanData, i, `CMF Z-score ${z.toFixed(2)} > ${np.phiZScore}, absorbed at close location ${closeLoc[i].toFixed(3)}`);
			return null;
		});
	},
	metadata: { role: "entry", direction: "both", walkForwardParams: ["cmfLookback", "phiZScore", "phiAbsorptionLimit"] } };
