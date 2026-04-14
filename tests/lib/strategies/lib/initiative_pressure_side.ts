import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop } from "../strategy-helpers";
import { buildInitiativePressureSeries } from "./price-action-frequency-core";

function normalizeInitiativePressureSideParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(params.lookback ?? 20)),
		threshold: Number(params.threshold ?? 0.0),
	};
}

export const initiative_pressure_side: Strategy = {
	name: "Initiative Pressure Side",
	description: "Initiative pressure measures whether aggressive takers are buying or selling. Positive pressure indicates buyers lifting offers; negative indicates sellers hitting bids.",
	defaultParams: {
		lookback: 20,
		threshold: 0.0,
	},
	paramLabels: {
		lookback: "Lookback",
		threshold: "Min Pressure Threshold",
	},
	normalizeParams: normalizeInitiativePressureSideParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const p = normalizeInitiativePressureSideParams(params);
		const lookback = p.lookback as number;
		if (data.length < lookback + 2) return [];

		const initiative = buildInitiativePressureSeries(data, lookback);

		return createSignalLoop(data, [initiative], (i) => {
			if (i < lookback) return null;
			const init = initiative[i];
			if (init === null) return null;

			if (init > p.threshold) {
				return createBuySignal(data, i, `Initiative pressure +${init.toFixed(3)} (buyers aggressive)`);
			}
			if (init < -p.threshold) {
				return createSellSignal(data, i, `Initiative pressure ${init.toFixed(3)} (sellers aggressive)`);
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
