import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, ensureCleanData, getVolumes } from "../strategy-helpers";
import { buildRollingMinMax, extractBarMetricSeries } from "./price-action-statistics-core";

function normalizeAlgorithmicLiquidationPhiSpikeParams(params: StrategyParams): StrategyParams {
	const volLookback = Math.max(5, Math.round(params.volLookback ?? 50));
	const phiVolumeSpike = Math.max(1, Number(params.phiVolumeSpike ?? 1.618));
	return { ...params, volLookback, phiVolumeSpike };
}

export const algorithmic_liquidation_phi_spike: Strategy = {
	name: "Algorithmic Liquidation Phi Spike",
	description:
		"Detects instantaneous volume spikes that exceed 1.618x the trailing maximum volume, confirming algorithmic liquidation cascades with directional bar geometry.",
	defaultParams: { volLookback: 50, phiVolumeSpike: 1.618 },
	paramLabels: { volLookback: "Volume Lookback", phiVolumeSpike: "Phi Volume Spike" },
	normalizeParams: normalizeAlgorithmicLiquidationPhiSpikeParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const np = normalizeAlgorithmicLiquidationPhiSpikeParams(params);
		if (cleanData.length < np.volLookback + 2) return [];

		const volumes = getVolumes(cleanData);
		const { max: trailingMaxVol } = buildRollingMinMax(volumes, np.volLookback);
		const bodyDirection = extractBarMetricSeries(cleanData, "bodyDirection");
		const closeLocation = extractBarMetricSeries(cleanData, "closeLocation");

		const signals = [];
		for (let i = np.volLookback; i < cleanData.length; i++) {
			const maxVol = trailingMaxVol[i - 1];
			if (maxVol === null) continue;

			const threshold = maxVol * np.phiVolumeSpike;
			if (volumes[i] <= threshold) continue;

			if (bodyDirection[i] === 1 && closeLocation[i] > 0.618) {
				signals.push(createBuySignal(cleanData, i, `Phi liquidation spike bullish (vol > ${np.phiVolumeSpike}x trailing max)`));
			}
			if (bodyDirection[i] === -1 && closeLocation[i] < 0.382) {
				signals.push(createSellSignal(cleanData, i, `Phi liquidation spike bearish (vol > ${np.phiVolumeSpike}x trailing max)`));
			}
		}
		return signals;
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["volLookback", "phiVolumeSpike"],
	},
};
