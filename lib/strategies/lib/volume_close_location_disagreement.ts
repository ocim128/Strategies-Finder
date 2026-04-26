import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getVolumes,
} from "../strategy-helpers";
import { buildRateOfChange } from "./price-action-statistics-core";
import { buildCloseLocationSeries } from "./price-action-frequency-core";

function normalizeVolumeCloseLocationDisagreementParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		location_threshold: Math.min(0.99, Math.max(0.01, Number(params.location_threshold ?? 0.7))),
		volume_lookback: Math.max(2, Math.round(params.volume_lookback ?? 20)),
		volume_decline_pct: Number(params.volume_decline_pct ?? -0.1),
	};
}

export const volume_close_location_disagreement: Strategy = {
	name: "Volume Close-Location Disagreement",
	description: "When close location is bullish (close near bar high) but volume is declining relative to its trailing average, the buying pressure lacks participation — a divergence that often precedes reversal. The divergence directly gives the hedge direction.",
	defaultParams: {
		location_threshold: 0.7,
		volume_lookback: 20,
		volume_decline_pct: -0.1,
	},
	paramLabels: {
		location_threshold: "Location Threshold",
		volume_lookback: "Volume Lookback",
		volume_decline_pct: "Volume Decline %",
	},
	normalizeParams: normalizeVolumeCloseLocationDisagreementParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeVolumeCloseLocationDisagreementParams(params);
		if (cleanData.length < p.volume_lookback + 1) return [];

		const closeLocation = buildCloseLocationSeries(cleanData);
		const volumes = getVolumes(cleanData);
		const volumeRoc = buildRateOfChange(volumes, 1);

		return createSignalLoop(cleanData, [volumeRoc], (i) => {
			if (i < p.volume_lookback) return null;
			const vr = volumeRoc[i];
			if (vr === null) return null;
			if (vr >= p.volume_decline_pct) return null;

			const cl = closeLocation[i];

			if (cl > p.location_threshold) {
				return createSellSignal(cleanData, i, `Bullish close location (${cl.toFixed(2)}) with declining volume — fade`);
			}
			if (cl < (1 - p.location_threshold)) {
				return createBuySignal(cleanData, i, `Bearish close location (${cl.toFixed(2)}) with declining volume — fade`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["location_threshold", "volume_lookback", "volume_decline_pct"],
	},
};
