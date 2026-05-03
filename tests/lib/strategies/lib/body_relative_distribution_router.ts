import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { calculateBollingerBands } from "../indicators";
import { buildBodyPctSeries, buildRollingAverage } from "./price-action-frequency-core";

const BODY_RELATIVE_BOLLINGER_STDDEV = 2;
const BODY_RELATIVE_MOMENTUM_THRESHOLD = 0.5;

function normalizeBodyRelativeDistributionRouterParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 20))),
    };
}

export const body_relative_distribution_router: Strategy = {
    name: "Body Relative Distribution Router",
    description:
        "Routes large-body candle regimes to Bollinger momentum breaks and wick-heavy regimes to Bollinger boundary reversion.",
    defaultParams: {
        lookback: 20,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeBodyRelativeDistributionRouterParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeBodyRelativeDistributionRouterParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const bodyPct = buildBodyPctSeries(cleanData);
        const averageBodyPct = buildRollingAverage(bodyPct, lookback);
        const bands = calculateBollingerBands(closes, lookback, BODY_RELATIVE_BOLLINGER_STDDEV);

        return createSignalLoop(cleanData, [averageBodyPct, bands.upper, bands.lower], (i) => {
            const avgBody = averageBodyPct[i];
            const upper = bands.upper[i];
            const lower = bands.lower[i];
            const prevUpper = bands.upper[i - 1];
            const prevLower = bands.lower[i - 1];
            if (avgBody === null || upper === null || lower === null || prevUpper === null || prevLower === null) return null;

            if (avgBody > BODY_RELATIVE_MOMENTUM_THRESHOLD) {
                if (closes[i - 1] <= prevUpper && closes[i] > upper) {
                    return createBuySignal(cleanData, i, `Large-body Bollinger momentum break avgBody=${avgBody.toFixed(2)}`);
                }
                if (closes[i - 1] >= prevLower && closes[i] < lower) {
                    return createSellSignal(cleanData, i, `Large-body Bollinger momentum break avgBody=${avgBody.toFixed(2)}`);
                }
                return null;
            }

            if (closes[i - 1] < prevLower && closes[i] > lower) {
                return createBuySignal(cleanData, i, `Wick-heavy lower-band reversion avgBody=${avgBody.toFixed(2)}`);
            }
            if (closes[i - 1] > prevUpper && closes[i] < upper) {
                return createSellSignal(cleanData, i, `Wick-heavy upper-band reversion avgBody=${avgBody.toFixed(2)}`);
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
