import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, getCloses, getVolumes } from "../strategy-helpers";

type RollingVwapCenterPrepared = {
	data: OHLCVData[];
	closes: number[];
	volumes: number[];
	rvwapByLookback: Map<number, (number | null)[]>;
};

function normalizeRollingVwapCenterParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(params.lookback ?? 20)),
	};
}

function prepareRollingVwapCenterData(data: OHLCVData[]): RollingVwapCenterPrepared {
	return {
		data,
		closes: getCloses(data),
		volumes: getVolumes(data),
		rvwapByLookback: new Map<number, (number | null)[]>(),
	};
}

function getPreparedRollingVwapCenterData(preparedData: unknown, data: OHLCVData[]): RollingVwapCenterPrepared {
	if (preparedData && typeof preparedData === "object" && "rvwapByLookback" in preparedData) {
		return preparedData as RollingVwapCenterPrepared;
	}
	return prepareRollingVwapCenterData(data);
}

function buildRollingVwapSeries(
	closes: number[],
	volumes: number[],
	lookback: number
): (number | null)[] {
	const rvwap: (number | null)[] = new Array(closes.length).fill(null);
	let sumCloseVol = 0;
	let sumVol = 0;

	for (let i = 0; i < closes.length; i++) {
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

	return rvwap;
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
	prepareFinderData: (data) => prepareRollingVwapCenterData(data),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const prepared = getPreparedRollingVwapCenterData(preparedData, data);
		const p = normalizeRollingVwapCenterParams(params);
		const lookback = p.lookback as number;
		if (prepared.data.length < lookback + 2) return [];

		let rvwap = prepared.rvwapByLookback.get(lookback);
		if (!rvwap) {
			rvwap = buildRollingVwapSeries(prepared.closes, prepared.volumes, lookback);
			prepared.rvwapByLookback.set(lookback, rvwap);
		}

		return createSignalLoop(prepared.data, [rvwap], (i) => {
			if (i < lookback) return null;
			const vwap = rvwap[i];
			if (vwap === null) return null;

			if (prepared.closes[i] > vwap) {
				return createBuySignal(prepared.data, i, `Close ${prepared.closes[i].toFixed(2)} above rolling VWAP ${vwap.toFixed(2)}`);
			}
			if (prepared.closes[i] < vwap) {
				return createSellSignal(prepared.data, i, `Close ${prepared.closes[i].toFixed(2)} below rolling VWAP ${vwap.toFixed(2)}`);
			}
			return null;
		});
	},
	execute: (data: OHLCVData[], params: StrategyParams) =>
		rolling_vwap_center.executePrepared?.(prepareRollingVwapCenterData(data), params, data) ?? [],
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback"],
	},
};





