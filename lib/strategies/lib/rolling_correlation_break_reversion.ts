import {
	Strategy,
	OHLCVData,
	StrategyParams,
	StrategyExecutionContext,
} from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
} from "../strategy-helpers";
import { buildRollingZScore } from "./price-action-statistics-core";
import { buildRollingPairCorrelation } from "./cross-symbol-helpers";

type PreparedData = {
	data: OHLCVData[];
	closes: number[];
	secondarySymbol: string | null;
	secondaryCloses: number[] | null;
	zscoreByLookback: Map<number, (number | null)[]>;
	corrByLookback: Map<number, (number | null)[]>;
};

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
		minCorrelation: Number(params.minCorrelation ?? 0.2),
	};
}

function prepareData(data: OHLCVData[], context?: StrategyExecutionContext): PreparedData {
	const cleanData = ensureCleanData(data);
	const closes = getCloses(cleanData);

	if (!context?.crossSymbol) {
		return {
			data: cleanData,
			closes,
			secondarySymbol: null,
			secondaryCloses: null,
			zscoreByLookback: new Map<number, (number | null)[]>(),
			corrByLookback: new Map<number, (number | null)[]>(),
		};
	}

	const secondaryData = ensureCleanData(context.crossSymbol.secondaryData);
	const secondaryCloses = getCloses(secondaryData);

	return {
		data: cleanData,
		closes,
		secondarySymbol: context.crossSymbol.secondarySymbol,
		secondaryCloses,
		zscoreByLookback: new Map<number, (number | null)[]>(),
		corrByLookback: new Map<number, (number | null)[]>(),
	};
}

function getPreparedData(
	preparedData: unknown,
	data: OHLCVData[],
	context?: StrategyExecutionContext
): PreparedData {
	if (preparedData && typeof preparedData === "object" && "corrByLookback" in preparedData) {
		const prepared = preparedData as PreparedData;
		const currentSymbol = context?.crossSymbol?.secondarySymbol ?? null;
		if (prepared.secondarySymbol === currentSymbol) {
			return prepared;
		}
	}
	return prepareData(data, context);
}

export const rolling_correlation_break_reversion: Strategy = {
	name: "Rolling Correlation Break Reversion",
	description: "Fades ratio price extremes (Z-score 2.0) when rolling correlation between the underlying base and quote close prices drops below minCorrelation.",
	defaultParams: {
		lookback: 30,
		minCorrelation: 0.2,
	},
	paramLabels: {
		lookback: "Lookback Window",
		minCorrelation: "Min Correlation",
	},
	normalizeParams,
	crossSymbolConfig: {
		defaultSymbol: "BTCUSDT",
		userSelectable: true,
		minBars: 50,
	},
	prepareFinderData: (data, _settings, context) => prepareData(data, context),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[], context?: StrategyExecutionContext) => {
		if (!context?.crossSymbol) return [];

		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const minCorrelation = p.minCorrelation as number;

		const prepared = getPreparedData(preparedData, data, context);
		const cleanData = prepared.data;
		if (cleanData.length < lookback + 2) return [];

		const closes = prepared.closes;
		const secondaryCloses = prepared.secondaryCloses;
		if (!secondaryCloses) return [];

		const zscoreByLookback = prepared.zscoreByLookback;
		let zscore = zscoreByLookback.get(lookback);
		if (!zscore) {
			zscore = buildRollingZScore(closes, lookback);
			zscoreByLookback.set(lookback, zscore);
		}

		const corrByLookback = prepared.corrByLookback;
		let corr = corrByLookback.get(lookback);
		if (!corr) {
			corr = buildRollingPairCorrelation(closes, secondaryCloses, lookback);
			corrByLookback.set(lookback, corr);
		}

		return createSignalLoop(cleanData, [zscore, corr], (i) => {
			if (i < lookback) return null;

			const z = zscore![i];
			const c = corr![i];
			if (z === null || c === null) return null;

			// Buy/Sell: Z-score limits and correlation drops below minCorrelation
			if (c < minCorrelation) {
				if (z < -2.0) {
					return createBuySignal(cleanData, i, `Correlation break buy: Z ${z.toFixed(2)}, corr ${c.toFixed(2)} < ${minCorrelation}`);
				}
				if (z > 2.0) {
					return createSellSignal(cleanData, i, `Correlation break sell: Z ${z.toFixed(2)}, corr ${c.toFixed(2)} < ${minCorrelation}`);
				}
			}
			return null;
		});
	},
	execute: (data, params, context) =>
		rolling_correlation_break_reversion.executePrepared!(
			rolling_correlation_break_reversion.prepareFinderData!(data, undefined, context),
			params,
			data,
			context
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "minCorrelation"],
	},
};
