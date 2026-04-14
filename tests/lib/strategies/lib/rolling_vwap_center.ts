import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, getCloses, getVolumes } from "../strategy-helpers";

function normalizeRollingVwapCenterParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(params.lookback ?? 20)),
	};
}

export const rolling_vwap_center: Strategy = {
	name: "Rolling VWAP Center",
	description: "A rolling window volume-weighted average price represents the capital-weighted consensus. Closes above indicate value acceptance above where capital was most recently deployed.",
	defaultParams: {
		lookback: 20,
	},
	paramLabels: {
		lookback: "Lookback",
	},
	normalizeParams: normalizeRollingVwapCenterParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const p = normalizeRollingVwapCenterParams(params);
		const lookback = p.lookback as number;
		if (data.length < lookback + 2) return [];

		const closes = getCloses(data);
		const volumes = getVolumes(data);

		const rvwap: (number | null)[] = new Array(data.length).fill(null);
		let sumCloseVol = 0;
		let sumVol = 0;

		for (let i = 0; i < data.length; i++) {
			sumCloseVol += closes[i] * volumes[i];
			sumVol += volumes[i];
			if (i >= lookback) {
				sumCloseVol -= closes[i - lookback] * volumes[i - lookback];
				sumVol -= volumes[i - lookback];
			}
			if (i >= lookback - 1 && sumVol > 0) {
				rvwap[i] = sumCloseVol / sumVol;
			}
		}

		return createSignalLoop(data, [rvwap], (i) => {
			if (i < lookback) return null;
			const vwap = rvwap[i];
			if (vwap === null) return null;

			if (closes[i] > vwap) {
				return createBuySignal(data, i, `Close ${closes[i].toFixed(2)} above rolling VWAP ${vwap.toFixed(2)}`);
			}
			if (closes[i] < vwap) {
				return createSellSignal(data, i, `Close ${closes[i].toFixed(2)} below rolling VWAP ${vwap.toFixed(2)}`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback"],
	},
};
