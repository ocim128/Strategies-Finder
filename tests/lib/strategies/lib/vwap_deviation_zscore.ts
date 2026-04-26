import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
} from "../strategy-helpers";
import { buildRollingStdDev } from "./price-action-statistics-core";
import { calculateVWAP } from "../indicators";

function normalizeVwapDeviationZscoreParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(params.lookback ?? 20)),
		threshold: Math.max(0.1, Number(params.threshold ?? 1.5)),
	};
}

export const vwap_deviation_zscore: Strategy = {
	name: "VWAP Deviation Z-Score",
	description: "The z-score of close-to-VWAP deviation measures how many standard deviations price has displaced from the volume-weighted consensus value. Positive z-score = premium, negative = discount. The rolling standard deviation self-normalizes across volatility regimes.",
	defaultParams: {
		lookback: 20,
		threshold: 1.5,
	},
	paramLabels: {
		lookback: "Lookback",
		threshold: "Threshold",
	},
	normalizeParams: normalizeVwapDeviationZscoreParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeVwapDeviationZscoreParams(params);
		if (cleanData.length < p.lookback) return [];

		const closes = getCloses(cleanData);
		const vwap = calculateVWAP(cleanData);
		const deviation: number[] = closes.map((c, i) => {
			const v = vwap[i];
			return v === null ? 0 : c - v;
		});
		const stdDev = buildRollingStdDev(deviation, p.lookback);

		return createSignalLoop(cleanData, [stdDev], (i) => {
			if (i < p.lookback) return null;
			const sd = stdDev[i];
			if (sd === null || sd < 1e-9) return null;

			const z = deviation[i] / sd;
			if (z < -p.threshold) {
				return createBuySignal(cleanData, i, `VWAP deviation z-score ${z.toFixed(3)} below -threshold (discount)`);
			}
			if (z > p.threshold) {
				return createSellSignal(cleanData, i, `VWAP deviation z-score ${z.toFixed(3)} above threshold (premium)`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "threshold"],
	},
};
