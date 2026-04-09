import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildInitiativePressureSeries, buildTrailingHighLow } from "./price-action-frequency-core";
import { extractBarMetricSeries } from "./price-action-statistics-core";

function normalizeTrailingPhiCompressionIgnitionParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(params.lookback ?? 20)),
		phi_compression: Math.max(0.01, Math.min(0.99, Number(params.phi_compression ?? 0.382))),
		pressure_min: Math.max(0.1, Number(params.pressure_min ?? 1.5)),
	};
}

export const trailing_phi_compression_ignition: Strategy = {
	name: "Trailing Phi Compression Ignition",
	description: "Trailing spread compresses so current true range is below 0.382 of the trailing window. An initiative pressure spike out of this compression ignites a new microstructure regime.",
	defaultParams: {
		lookback: 20,
		phi_compression: 0.382,
		pressure_min: 1.5,
	},
	paramLabels: {
		lookback: "Lookback",
		phi_compression: "Phi Compression",
		pressure_min: "Pressure Min",
	},
	normalizeParams: normalizeTrailingPhiCompressionIgnitionParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeTrailingPhiCompressionIgnitionParams(params);
		if (cleanData.length < p.lookback) return [];

		const { highest, lowest } = buildTrailingHighLow(cleanData, p.lookback);
		const pressure = buildInitiativePressureSeries(cleanData, p.lookback);
		const trueRange = extractBarMetricSeries(cleanData, "trueRange");

		return createSignalLoop(cleanData, [highest, lowest, pressure], (i) => {
			if (i < p.lookback) return null;
			const trailHigh = highest[i];
			const trailLow = lowest[i];
			const ip = pressure[i];
			if (trailHigh === null || trailLow === null || ip === null) return null;

			const trailingSpread = trailHigh - trailLow;
			if (trailingSpread <= 0) return null;
			const compressed = trueRange[i] < trailingSpread * p.phi_compression;
			if (!compressed) return null;

			const midpoint = (trailHigh + trailLow) / 2;
			if (ip > p.pressure_min && cleanData[i].close > midpoint)
				return createBuySignal(cleanData, i, "Compression ignition bullish");
			if (ip < -p.pressure_min && cleanData[i].close < midpoint)
				return createSellSignal(cleanData, i, "Compression ignition bearish");
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "phi_compression", "pressure_min"],
	},
};
