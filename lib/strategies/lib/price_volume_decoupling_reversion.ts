import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getVolumes } from "../strategy-helpers";
import { buildRollingAverage } from "./price-action-frequency-core";
import { buildRollingCorrelation, buildRollingStdDev, buildRateOfChange } from "./price-action-statistics-core";

function normalizePriceVolumeDecouplingReversionParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		corrWindow: Math.max(3, Math.round(params.corrWindow ?? 30)),
		extensionStd: Math.max(0.5, Math.abs(Number(params.extensionStd ?? 2.0))) };
}

export const price_volume_decoupling_reversion: Strategy = {
	name: "Price-Volume Decoupling Reversion",
	description: "When rolling price-volume correlation collapses toward zero, volume is no longer confirming directional moves. If price is simultaneously extended from its rolling mean, the extension is structurally unsupported and likely to revert.",
	defaultParams: {
		corrWindow: 30,
		extensionStd: 2.0 },
	paramLabels: {
		corrWindow: "Correlation Window",
		extensionStd: "Extension Std Dev" },
	normalizeParams: normalizePriceVolumeDecouplingReversionParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizePriceVolumeDecouplingReversionParams(params);
		const corrWindow = p.corrWindow as number;
		const extensionStd = p.extensionStd as number;
		if (cleanData.length < corrWindow + 2) return [];

		const closes = getCloses(cleanData);
		const volumes = getVolumes(cleanData);
		const returns = buildRateOfChange(closes, 1);
		const retClean = returns.map(v => v ?? 0);
		const corr = buildRollingCorrelation(retClean, volumes, corrWindow);
		const avgClose = buildRollingAverage(closes, corrWindow);
		const stdClose = buildRollingStdDev(closes, corrWindow);

		return createSignalLoop(cleanData, [corr, avgClose, stdClose], (i) => {
			if (i < corrWindow) return null;
			const c = corr[i];
			const avg = avgClose[i];
			const sd = stdClose[i];
			if (c === null || avg === null || sd === null || sd <= 0) return null;
			if (Math.abs(c) > 0.15) return null;

			const zScore = (closes[i] - avg) / sd;

			if (zScore < -extensionStd) {
				return createBuySignal(cleanData, i, `Price-volume decoupled (corr=${c.toFixed(2)}), close ${extensionStd.toFixed(1)}σ below mean`);
			}
			if (zScore > extensionStd) {
				return createSellSignal(cleanData, i, `Price-volume decoupled (corr=${c.toFixed(2)}), close ${extensionStd.toFixed(1)}σ above mean`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["corrWindow", "extensionStd"] } };
