import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
} from "../strategy-helpers";
import { buildRollingValueArea } from "./value-area-acceptance-core";

type PreparedData = {
	data: OHLCVData[];
	closes: number[];
	vahByLookback: Map<number, (number | null)[]>;
	valByLookback: Map<number, (number | null)[]>;
};

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(5, Math.round(Number(params.lookback ?? 50))),
		minRejectionProbability: Math.max(0.01, Math.min(1, Number(params.minRejectionProbability ?? 0.7))),
	};
}

export const markov_value_area_rejection_reversion: Strategy = {
	name: "Markov Value Area Rejection Reversion",
	description: "Fades breakouts outside the value consensus zone when Markov transition probability to return Inside is extremely high.",
	defaultParams: {
		lookback: 50,
		minRejectionProbability: 0.7,
	},
	paramLabels: {
		lookback: "Lookback Window",
		minRejectionProbability: "Min Rejection Prob",
	},
	normalizeParams,
	prepareFinderData: (data) => ({
		data: data,
		closes: getCloses(data),
		vahByLookback: new Map<number, (number | null)[]>(),
		valByLookback: new Map<number, (number | null)[]>(),
	}),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const minRejectionProbability = p.minRejectionProbability as number;

		const prepared = preparedData as PreparedData;
		const cleanData = prepared?.data ?? ensureCleanData(data);
		if (cleanData.length < lookback + 2) return [];

		const closes = prepared?.closes ?? getCloses(cleanData);

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

		// Discretize states: 1: Outside (close < val || close > vah), 0: Inside (val <= close <= vah)
		const states = new Uint8Array(cleanData.length);
		for (let j = 0; j < cleanData.length; j++) {
			const close = closes[j];
			const vLow = val[j];
			const vHigh = vah[j];
			states[j] = (vLow !== null && vHigh !== null && (close < vLow || close > vHigh)) ? 1 : 0;
		}

		return createSignalLoop(cleanData, [vah, val], (i) => {
			if (i < lookback + 1) return null;

			const close = closes[i];
			const vLow = val[i];
			const vHigh = vah[i];
			if (vLow === null || vHigh === null) return null;

			const currentState = states[i];

			// Compute P(Outside -> Inside), i.e., P(1 -> 0)
			const start = i - lookback + 1;
			const end = i - 1;

			let countOutside = 0;
			let countOutsideToInside = 0;
			for (let j = start; j <= end; j++) {
				if (states[j] === 1) {
					countOutside++;
					if (states[j + 1] === 0) {
						countOutsideToInside++;
					}
				}
			}

			const prob = countOutside > 0 ? countOutsideToInside / countOutside : 0;

			// Buy: close currently below VAL (Outside state 1), probability > minRejectionProbability
			if (close < vLow && currentState === 1 && prob > minRejectionProbability) {
				return createBuySignal(cleanData, i, `Value Area rejection buy: close ${close.toFixed(2)} < VAL ${vLow.toFixed(2)} with P(Out->In) ${prob.toFixed(2)} > ${minRejectionProbability}`);
			}
			// Sell: close currently above VAH (Outside state 1), probability > minRejectionProbability
			if (close > vHigh && currentState === 1 && prob > minRejectionProbability) {
				return createSellSignal(cleanData, i, `Value Area rejection sell: close ${close.toFixed(2)} > VAH ${vHigh.toFixed(2)} with P(Out->In) ${prob.toFixed(2)} > ${minRejectionProbability}`);
			}
			return null;
		});
	},
	execute: (data, params) =>
		markov_value_area_rejection_reversion.executePrepared!(
			markov_value_area_rejection_reversion.prepareFinderData!(data),
			params,
			data
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "minRejectionProbability"],
	},
};
