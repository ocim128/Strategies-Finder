import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildEfficiencyRatio } from "./price-action-statistics-core";
import { calculateEMA } from "../indicators";

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		ema_period: Math.max(2, Math.round(params.ema_period ?? 50)),
		er_lookback: Math.max(2, Math.round(params.er_lookback ?? 10)),
		er_thresh: Number(params.er_thresh ?? 0.8) };
}

export const ema_distance_efficiency_snapback: Strategy = {
	name: "EMA Distance Efficiency Snapback",
	description: "If the distance between price and an EMA grows in a perfectly straight line (high Efficiency Ratio), it is an unsustainable vacuum that will snap.",
	defaultParams: {
		ema_period: 50,
		er_lookback: 10,
		er_thresh: 0.8 },
	paramLabels: {
		ema_period: "EMA Period",
		er_lookback: "ER Lookback",
		er_thresh: "ER Threshold" },
	normalizeParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const normalizedParams = normalizeParams(params);
		if (cleanData.length < normalizedParams.ema_period + normalizedParams.er_lookback) return [];

		const closes = getCloses(cleanData);
		const ema = calculateEMA(closes, normalizedParams.ema_period);

		// To use efficiency ratio on distance, we need a pseudo OHLCV array where close = distance
		const distancesOHLCV: OHLCVData[] = cleanData.map((d, i) => {
			const e = ema[i];
			const dist = e !== null ? closes[i]! - e : 0;
			return { ...d, close: dist };
		});

		const er = buildEfficiencyRatio(distancesOHLCV, normalizedParams.er_lookback);

		return createSignalLoop(cleanData, [ema, er], (i) => {
			if (i === 0) return null;
			
			const e = ema[i]!;
			const eff = er[i]!;
			const c = closes[i]!;

			if (eff > normalizedParams.er_thresh) {
				if (c < e) {
					// Price is far below EMA, stretching linearly down
					return createBuySignal(cleanData, i, "ER of distance > threshold (below EMA)");
				} else if (c > e) {
					// Price is far above EMA, stretching linearly up
					return createSellSignal(cleanData, i, "ER of distance > threshold (above EMA)");
				}
			}

			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["ema_period", "er_lookback", "er_thresh"] } };
