import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, ensureCleanData, getCloses, getHighs, getLows, detectPivotsWithDeviation } from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-statistics-core";
import { calculateATR } from "../indicators";

function normalizeHyperVolPhiCompressionParams(params: StrategyParams): StrategyParams {
	const atrPeriod = Math.max(2, Math.round(params.atrPeriod ?? 13));
	const phiCompressionLimit = Math.max(0.01, Math.min(1, Number(params.phiCompressionLimit ?? 0.382)));
	return { ...params, atrPeriod, phiCompressionLimit };
}

export const hyper_vol_phi_compression: Strategy = {
	name: "Hyper-Vol Phi Compression",
	description:
		"Triggers structural breakouts only when True Range compresses to 0.382x ATR (the golden compression limit), then enters on a confirmed pivot breakout.",
	defaultParams: { atrPeriod: 13, phiCompressionLimit: 0.382 },
	paramLabels: { atrPeriod: "ATR Period", phiCompressionLimit: "Phi Compression Limit" },
	normalizeParams: normalizeHyperVolPhiCompressionParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const np = normalizeHyperVolPhiCompressionParams(params);
		if (cleanData.length < np.atrPeriod + 10) return [];

		const closes = getCloses(cleanData);
		const highs = getHighs(cleanData);
		const lows = getLows(cleanData);
		const atr = calculateATR(highs, lows, closes, np.atrPeriod);
		const trueRange = extractBarMetricSeries(cleanData, "trueRange");

		const pivots = detectPivotsWithDeviation(cleanData, 1.5, 5);
		const lastPivotHigh = new Array(cleanData.length).fill(0);
		const lastPivotLow = new Array(cleanData.length).fill(Infinity);

		let lph = 0;
		let lpl = Infinity;
		for (let i = 0; i < cleanData.length; i++) {
			for (const p of pivots) {
				if (p.index <= i) {
					if (p.isHigh && p.price > lph) lph = p.price;
					if (!p.isHigh && p.price < lpl) lpl = p.price;
				}
			}
			lastPivotHigh[i] = lph;
			lastPivotLow[i] = lpl;
		}

		const signals = [];
		for (let i = np.atrPeriod + 1; i < cleanData.length; i++) {
			const atrVal = atr[i];
			if (atrVal === null || atrVal === 0) continue;

			const compressed = trueRange[i] < atrVal * np.phiCompressionLimit;
			if (!compressed) continue;

			if (lastPivotHigh[i - 1] > 0 && closes[i - 1] <= lastPivotHigh[i - 1] && closes[i] > lastPivotHigh[i]) {
				signals.push(createBuySignal(cleanData, i, `Phi compression breakout above pivot high`));
			}
			if (lastPivotLow[i - 1] < Infinity && closes[i - 1] >= lastPivotLow[i - 1] && closes[i] < lastPivotLow[i]) {
				signals.push(createSellSignal(cleanData, i, `Phi compression breakout below pivot low`));
			}
		}
		return signals;
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["atrPeriod", "phiCompressionLimit"],
	},
};
