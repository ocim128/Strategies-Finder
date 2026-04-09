import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildInitiativePressureSeries, buildRollingAverage } from "./price-action-frequency-core";
import { extractBarMetricSeries } from "./price-action-statistics-core";

function normalizeBodyMidDeltaPhiSnapParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(params.lookback ?? 14)),
		phi_shift: Math.max(0.01, Number(params.phi_shift ?? 0.382)),
		pressure_max: Math.max(0, Number(params.pressure_max ?? 0.5)),
	};
}

export const body_mid_delta_phi_snap: Strategy = {
	name: "Body Mid Delta Phi Snap",
	description: "Extreme intraday repricing where the body midpoint shifts beyond 0.382 of rolling true range with collapsed initiative pressure signals a liquidity vacuum snapback.",
	defaultParams: {
		lookback: 14,
		phi_shift: 0.382,
		pressure_max: 0.5,
	},
	paramLabels: {
		lookback: "Lookback",
		phi_shift: "Phi Shift",
		pressure_max: "Pressure Max",
	},
	normalizeParams: normalizeBodyMidDeltaPhiSnapParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeBodyMidDeltaPhiSnapParams(params);
		if (cleanData.length < p.lookback) return [];

		const bodyMidSeries = extractBarMetricSeries(cleanData, "bodyMid");
		const bodyMidDelta = new Array(cleanData.length).fill(0);
		for (let j = 1; j < cleanData.length; j++) {
			bodyMidDelta[j] = bodyMidSeries[j] - bodyMidSeries[j - 1];
		}

		const trueRange = extractBarMetricSeries(cleanData, "trueRange");
		const atr = buildRollingAverage(trueRange, p.lookback);
		const pressure = buildInitiativePressureSeries(cleanData, p.lookback);

		return createSignalLoop(cleanData, [atr, pressure], (i) => {
			if (i < p.lookback) return null;
			const avgTR = atr[i];
			const ip = pressure[i];
			if (avgTR === null || ip === null) return null;

			const threshold = avgTR * p.phi_shift;
			const delta = bodyMidDelta[i];
			if (delta < -threshold && Math.abs(ip) < p.pressure_max)
				return createBuySignal(cleanData, i, "Body mid delta snap bullish");
			if (delta > threshold && Math.abs(ip) < p.pressure_max)
				return createSellSignal(cleanData, i, "Body mid delta snap bearish");
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "phi_shift", "pressure_max"],
	},
};
