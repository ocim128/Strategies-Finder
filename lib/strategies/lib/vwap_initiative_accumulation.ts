import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
} from "../strategy-helpers";
import { buildInitiativePressureSeries } from "./price-action-frequency-core";
import { calculateVWAP } from "../indicators";

function normalizeVwapInitiativeAccumulationParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		pressure_lookback: Math.max(2, Math.round(params.pressure_lookback ?? 10)),
	};
}

export const vwap_initiative_accumulation: Strategy = {
	name: "VWAP Initiative Accumulation",
	description: "Initiative pressure reveals which side is aggressively trading. When initiative pressure is bullish but price is below VWAP, aggressive buyers are accumulating below value. When bearish but price is above VWAP, sellers are distributing above value. Smart-money-below-value detection.",
	defaultParams: {
		pressure_lookback: 10,
	},
	paramLabels: {
		pressure_lookback: "Pressure Lookback",
	},
	normalizeParams: normalizeVwapInitiativeAccumulationParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeVwapInitiativeAccumulationParams(params);
		if (cleanData.length < p.pressure_lookback + 1) return [];

		const closes = getCloses(cleanData);
		const vwap = calculateVWAP(cleanData);
		const pressure = buildInitiativePressureSeries(cleanData, p.pressure_lookback);

		return createSignalLoop(cleanData, [vwap, pressure], (i) => {
			if (i < p.pressure_lookback) return null;
			const v = vwap[i];
			const pres = pressure[i];
			if (v === null || pres === null) return null;

			if (pres > 0 && closes[i] < v) {
				return createBuySignal(cleanData, i, `Buyers aggressive (${pres.toFixed(3)}) below VWAP — accumulation`);
			}
			if (pres < 0 && closes[i] > v) {
				return createSellSignal(cleanData, i, `Sellers aggressive (${pres.toFixed(3)}) above VWAP — distribution`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["pressure_lookback"],
	},
};
