import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
	getVolumes,
} from "../strategy-helpers";
import { buildRollingValueArea } from "./value-area-acceptance-core";
import { buildPercentileRank } from "./price-action-statistics-core";

type PreparedData = {
	data: OHLCVData[];
	closes: number[];
	volumes: number[];
	vahByLookback: Map<number, (number | null)[]>;
	valByLookback: Map<number, (number | null)[]>;
	volPctByLookback: Map<number, (number | null)[]>;
};

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(5, Math.round(Number(params.lookback ?? 50))),
		minQuarterKelly: Number(params.minQuarterKelly ?? 0.07),
	};
}

export const quarter_kelly_value_area_rejection: Strategy = {
	name: "Quarter Kelly Value Area Rejection",
	description: "Fades value area deviations when low relative volume WinRate (1 - volumePercentile) yields positive Quarter-Kelly allocation as price closes back inside VAL/VAH.",
	defaultParams: {
		lookback: 50,
		minQuarterKelly: 0.07,
	},
	paramLabels: {
		lookback: "Lookback Window",
		minQuarterKelly: "Min Quarter Kelly",
	},
	normalizeParams,
	prepareFinderData: (data) => ({
		data: data,
		closes: getCloses(data),
		volumes: getVolumes(data),
		vahByLookback: new Map<number, (number | null)[]>(),
		valByLookback: new Map<number, (number | null)[]>(),
		volPctByLookback: new Map<number, (number | null)[]>(),
	}),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const minQuarterKelly = p.minQuarterKelly as number;

		const prepared = preparedData as PreparedData;
		const cleanData = prepared?.data ?? ensureCleanData(data);
		if (cleanData.length < lookback + 2) return [];

		const closes = prepared?.closes ?? getCloses(cleanData);
		const volumes = prepared?.volumes ?? getVolumes(cleanData);

		const vahByLookback = prepared?.vahByLookback ?? new Map<number, (number | null)[]>();
		const valByLookback = prepared?.valByLookback ?? new Map<number, (number | null)[]>();

		let vah = vahByLookback.get(lookback);
		let val = valByLookback.get(lookback);

		if (!vah || !val) {
			const va = buildRollingValueArea(cleanData, lookback);
			vah = va.vah;
			val = va.val;
			vahByLookback.set(lookback, vah);
			valByLookback.set(lookback, val);
		}

		const volPctByLookback = prepared?.volPctByLookback ?? new Map<number, (number | null)[]>();
		let volPct = volPctByLookback.get(lookback);
		if (!volPct) {
			volPct = buildPercentileRank(volumes, lookback);
			volPctByLookback.set(lookback, volPct);
		}

		return createSignalLoop(cleanData, [vah, val, volPct], (i) => {
			if (i < lookback + 1) return null;

			const close = closes[i];
			const prevClose = closes[i - 1];
			const vLow = val[i];
			const vHigh = vah[i];
			const prevLow = val[i - 1];
			const prevHigh = vah[i - 1];
			const vp = volPct[i];

			if (vLow === null || vHigh === null || prevLow === null || prevHigh === null || vp === null) return null;

			const winProb = 1 - vp;
			const qKelly = 0.25 * (2 * winProb - 1);

			if (qKelly > minQuarterKelly) {
				// Buy: previous close below VAL, current close is back above VAL
				if (prevClose < prevLow && close >= vLow) {
					return createBuySignal(cleanData, i, `Value Area rejection buy: prevClose ${prevClose.toFixed(2)} < VAL ${prevLow.toFixed(2)}, close ${close.toFixed(2)} >= VAL ${vLow.toFixed(2)}, Q-Kelly ${qKelly.toFixed(3)} > ${minQuarterKelly}`);
				}
				// Sell: previous close above VAH, current close is back below VAH
				if (prevClose > prevHigh && close <= vHigh) {
					return createSellSignal(cleanData, i, `Value Area rejection sell: prevClose ${prevClose.toFixed(2)} > VAH ${prevHigh.toFixed(2)}, close ${close.toFixed(2)} <= VAH ${vHigh.toFixed(2)}, Q-Kelly ${qKelly.toFixed(3)} > ${minQuarterKelly}`);
				}
			}
			return null;
		});
	},
	execute: (data, params) =>
		quarter_kelly_value_area_rejection.executePrepared!(
			quarter_kelly_value_area_rejection.prepareFinderData!(data),
			params,
			data
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "minQuarterKelly"],
	},
};
