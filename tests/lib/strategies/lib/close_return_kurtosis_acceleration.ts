import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRollingKurtosis } from "./price-action-statistics-core";

function normalizeCloseReturnKurtosisAccelerationParams(params: StrategyParams): StrategyParams {
	const kurtosisLookback = Math.max(10, Math.round(params.kurtosisLookback ?? 30));
	const kurtosisThreshold = Math.max(3.5, Number(params.kurtosisThreshold ?? 5.0));
	return { ...params, kurtosisLookback, kurtosisThreshold };
}

export const close_return_kurtosis_acceleration: Strategy = {
	name: "Close Return Kurtosis Acceleration",
	description:
		"Rolling kurtosis of close-to-close returns measures tail heaviness of the return distribution. A sharp increase in kurtosis (acceleration) signals the distribution is sprouting fat tails — the market is transitioning from normal random-walk behavior into a regime of clustered extreme moves. Entering in the direction of the current return captures the emerging tail event.",
	defaultParams: { kurtosisLookback: 30, kurtosisThreshold: 5.0 },
	paramLabels: { kurtosisLookback: "Kurtosis Lookback", kurtosisThreshold: "Kurtosis Threshold" },
	normalizeParams: normalizeCloseReturnKurtosisAccelerationParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const np = normalizeCloseReturnKurtosisAccelerationParams(params);
		if (cleanData.length < np.kurtosisLookback + 3) return [];
		const closes = getCloses(cleanData);
		const returns: number[] = [0];
		for (let i = 1; i < closes.length; i++) {
			returns.push(closes[i] / closes[i - 1] - 1);
		}
		const kurt = buildRollingKurtosis(returns, np.kurtosisLookback);
		return createSignalLoop(cleanData, [kurt], (i) => {
			const prev = kurt[i - 1];
			const curr = kurt[i];
			if (prev === null || curr === null) return null;
			if (curr > np.kurtosisThreshold && curr > prev) {
				if (closes[i] > closes[i - 1])
					return createBuySignal(cleanData, i, `Kurtosis accelerating ${prev.toFixed(2)} -> ${curr.toFixed(2)}, positive tail forming`);
				if (closes[i] < closes[i - 1])
					return createSellSignal(cleanData, i, `Kurtosis accelerating ${prev.toFixed(2)} -> ${curr.toFixed(2)}, negative tail forming`);
			}
			return null;
		});
	},
	metadata: { role: "entry", direction: "both", walkForwardParams: ["kurtosisLookback", "kurtosisThreshold"] } };
