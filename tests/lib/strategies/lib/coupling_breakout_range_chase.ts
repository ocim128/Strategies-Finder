import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildRangeSeries, buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 35))),
		couplingLookback: Math.max(1, Math.round(Number(params.couplingLookback ?? 10))),
		breakoutCloseLoc: Math.max(0.51, Math.min(0.99, Number(params.breakoutCloseLoc ?? 0.85))),
	};
}

export const coupling_breakout_range_chase: Strategy = {
	name: "Coupling Breakout Range Chase",
	description: "Enters a breakout in the direction of close location when a prolonged state of low range (tight coupling) ends with a sharp range expansion.",
	defaultParams: {
		lookback: 35,
		couplingLookback: 10,
		breakoutCloseLoc: 0.85,
	},
	paramLabels: {
		lookback: "Lookback Window",
		couplingLookback: "Coupling Lookback",
		breakoutCloseLoc: "Breakout Close Location",
	},
	normalizeParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const couplingLookback = p.couplingLookback as number;
		const breakoutCloseLoc = p.breakoutCloseLoc as number;
		if (cleanData.length < lookback + couplingLookback) return [];

		const ranges = buildRangeSeries(cleanData);
		const rangePercentile = buildPercentileRank(ranges, lookback);
		const closeLocation = buildCloseLocationSeries(cleanData);

		return createSignalLoop(cleanData, [rangePercentile], (i) => {
			if (i < lookback + couplingLookback) return null;
			const currentPercentile = rangePercentile[i];
			if (currentPercentile === null) return null;

			// Check that all of the previous couplingLookback bars were compressed (< 0.35)
			for (let j = 1; j <= couplingLookback; j++) {
				const prevPct = rangePercentile[i - j];
				if (prevPct === null || prevPct >= 0.35) return null;
			}

			const closeLoc = closeLocation[i];
			if (closeLoc > breakoutCloseLoc) {
				return createBuySignal(cleanData, i, `Coupling breakout to upside: close location ${closeLoc.toFixed(2)} > ${breakoutCloseLoc} after ${couplingLookback} compressed range bars`);
			}
			if (closeLoc < (1 - breakoutCloseLoc)) {
				return createSellSignal(cleanData, i, `Coupling breakout to downside: close location ${closeLoc.toFixed(2)} < ${(1 - breakoutCloseLoc).toFixed(2)} after ${couplingLookback} compressed range bars`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "couplingLookback", "breakoutCloseLoc"],
	},
};
