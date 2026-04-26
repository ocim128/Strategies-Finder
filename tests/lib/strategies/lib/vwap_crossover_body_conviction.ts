import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
	checkCrossover,
} from "../strategy-helpers";
import { buildBodyPctSeries } from "./price-action-frequency-core";
import { calculateVWAP } from "../indicators";

function normalizeVwapCrossoverBodyConvictionParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		body_pct_min: Math.min(1, Math.max(0.01, Number(params.body_pct_min ?? 0.5))),
	};
}

export const vwap_crossover_body_conviction: Strategy = {
	name: "VWAP Crossover Body Conviction",
	description: "When price crosses through VWAP, the value consensus has been breached. On 1m, this structural break happens frequently — requiring minimum body pct filters out noise from accidental grazes. A genuine VWAP crossover with directional body is one of the highest-conviction intraday signals available.",
	defaultParams: {
		body_pct_min: 0.5,
	},
	paramLabels: {
		body_pct_min: "Min Body %",
	},
	normalizeParams: normalizeVwapCrossoverBodyConvictionParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeVwapCrossoverBodyConvictionParams(params);
		if (cleanData.length < 3) return [];

		const closes = getCloses(cleanData);
		const vwap = calculateVWAP(cleanData);
		const bodyPct = buildBodyPctSeries(cleanData);

		return createSignalLoop(cleanData, [vwap], (i) => {
			if (i < 1) return null;
			const cross = checkCrossover(closes, vwap, i);
			if (cross === null) return null;
			if (bodyPct[i] < p.body_pct_min) return null;

			if (cross === "bullish") {
				return createBuySignal(cleanData, i, `VWAP bullish crossover with body ${(bodyPct[i] * 100).toFixed(1)}%`);
			}
			if (cross === "bearish") {
				return createSellSignal(cleanData, i, `VWAP bearish crossover with body ${(bodyPct[i] * 100).toFixed(1)}%`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["body_pct_min"],
	},
};
