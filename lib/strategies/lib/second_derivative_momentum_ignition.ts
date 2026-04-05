import { Strategy, StrategyParams } from "../../types/strategies";
import { createSignalLoop, ensureCleanData, createBuySignal, createSellSignal, getCloses } from "../strategy-helpers";
import { buildRateOfChange } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		rocLookback: Math.max(1, Math.round(params.rocLookback ?? 5)),
		maxVelocity: Number(params.maxVelocity ?? 0.5),
		accelMin: Number(params.accelMin ?? 2.0)
	};
}

export const second_derivative_momentum_ignition: Strategy = {
	name: "Second Derivative Momentum Ignition",
	description: "Trading strictly the ignition of acceleration (second derivative) while raw velocity is near zero captures the literal inception coordinate of systemic algorithmic sweeps.",
	defaultParams: { rocLookback: 5, maxVelocity: 0.5, accelMin: 2.0 },
	paramLabels: { rocLookback: "ROC Lookback", maxVelocity: "Max Velocity", accelMin: "Minimum Acceleration" },
	normalizeParams,
	metadata: { role: "entry", direction: "both", walkForwardParams: ["rocLookback", "maxVelocity", "accelMin"] },
	execute: (data, params) => {
		const clean = ensureCleanData(data);
		const p = normalizeParams(params);
		if (clean.length < p.rocLookback * 2) return [];

		const closes = getCloses(clean);
		const roc = buildRateOfChange(closes, p.rocLookback).map(v => v === null ? 0 : v);
		const rocOfRoc = buildRateOfChange(roc, 1);

		return createSignalLoop(clean, [roc, rocOfRoc], (i) => {
			if (i === 0) return null;

			const velocity = roc[i - 1];
			const accel = rocOfRoc[i - 1];

			if (accel !== null && Math.abs(velocity) < p.maxVelocity) {
				if (accel > p.accelMin) {
					return createBuySignal(clean, i, "Momentum Ignition Long");
				}
				if (accel < -p.accelMin) {
					return createSellSignal(clean, i, "Momentum Ignition Short");
				}
			}

			return null;
		});
	}
};
