import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getHighs, getLows, getCloses } from "../strategy-helpers";
import { buildTrailingHighLow } from "./price-action-frequency-core";
import { calculateATR } from "../indicators";

function normalizeTrailingRangePhiCompressionParams(params: StrategyParams): StrategyParams {
	const trailingLookback = Math.max(2, Math.round(params.trailingLookback ?? 21));
	const phiCompression = Math.min(5, Math.max(0, Number(params.phiCompression ?? 0.618)));
	return { ...params, trailingLookback, phiCompression };
}

export const trailing_range_phi_compression: Strategy = {
	name: "Trailing Range Phi Compression",
	description:
		"Measures the absolute physical range of the trailing window. When this macro range compresses to less than 61.8% of the local ATR, the coiled energy dictates an immediate breakout.",
	defaultParams: { trailingLookback: 21, phiCompression: 0.618 },
	paramLabels: { trailingLookback: "Trailing Lookback", phiCompression: "Phi Compression" },
	normalizeParams: normalizeTrailingRangePhiCompressionParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const np = normalizeTrailingRangePhiCompressionParams(params);
		if (cleanData.length < np.trailingLookback + 2) return [];
		const { highest, lowest } = buildTrailingHighLow(cleanData, np.trailingLookback);
		const highs = getHighs(cleanData);
		const lows = getLows(cleanData);
		const closes = getCloses(cleanData);
		const atr = calculateATR(highs, lows, closes, np.trailingLookback);
		const compression: (number | null)[] = new Array(cleanData.length).fill(null);
		for (let i = 0; i < cleanData.length; i++) {
			const h = highest[i];
			const l = lowest[i];
			const a = atr[i];
			if (h !== null && l !== null && a !== null && a > 0) {
				compression[i] = (h - l) / a;
			}
		}
		return createSignalLoop(cleanData, [compression, atr], (i) => {
			const c = compression[i];
			const hPrev = highest[i - 1];
			const lPrev = lowest[i - 1];
			if (c === null || hPrev === null || lPrev === null) return null;
			if (c < np.phiCompression) {
				if (cleanData[i].close > hPrev)
					return createBuySignal(cleanData, i, `Range compression ${(c).toFixed(3)} < ${np.phiCompression}, breakout above trailing high`);
				if (cleanData[i].close < lPrev)
					return createSellSignal(cleanData, i, `Range compression ${(c).toFixed(3)} < ${np.phiCompression}, breakout below trailing low`);
			}
			return null;
		});
	},
	metadata: { role: "entry", direction: "both", walkForwardParams: ["trailingLookback", "phiCompression"] } };
