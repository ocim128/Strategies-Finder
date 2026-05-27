import type { Strategy, OHLCVData, Signal, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import { parseTimeToUnixSeconds } from "../../time-normalization";
import {
    createBuySignal,
    createSellSignal,
    ensureCleanData,
} from "../strategy-helpers";
import { buildRollingSkewness } from "./price-action-statistics-core";
import {
    buildPolymarket1sGammaAgreement,
    buildPolymarket1sPressureGap,
} from "./polymarket-1s-helpers";
import { buildLogReturnSeries } from "./polymarket-1s-strategy-utils";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

const POLYMARKET_EVENT_SECONDS = 300;
const MIN_SECONDS_TO_EVENT_END = 180;
const ONE_SECOND_CLOSE_SHIFT = 1;

function normalizePolymarketEventDirectionGammaSkewFilterParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        volLookback: normalizeIntegerParam(params.volLookback, 164, 3),
        skewThreshold: normalizeNumberParam(params.skewThreshold, 1.6, 0),
        minEdge: normalizeNumberParam(params.minEdge, 0, 0),
    };
}

function getEventStartSeconds(timestampSeconds: number): number {
    return Math.floor(timestampSeconds / POLYMARKET_EVENT_SECONDS) * POLYMARKET_EVENT_SECONDS;
}

function getEventOpenPrice(bar: OHLCVData): number {
    return bar.open > 0 ? bar.open : bar.close;
}

function hasConsensusEdge(edge: number | null | undefined, minEdge: number): boolean {
    return edge !== null && edge !== undefined && edge > 0 && edge >= minEdge;
}

export const polymarket_event_direction_gamma_skew_filter: Strategy = {
    name: "Polymarket Event Direction Gamma Skew Filter",
    description: "Trades the 1s Polymarket event-open direction only when event-open distance acceleration, Binance return skew, and Gamma consensus agree.",
    defaultParams: {
        volLookback: 164,
        skewThreshold: 1.6,
        minEdge: 0,
    },
    paramLabels: {
        volLookback: "Volatility Lookback",
        skewThreshold: "Skew Threshold",
        minEdge: "Minimum Consensus Edge",
    },
    normalizeParams: normalizePolymarketEventDirectionGammaSkewFilterParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizePolymarketEventDirectionGammaSkewFilterParams(params);
        const volLookback = p.volLookback;
        if (cleanData.length < volLookback + 2) return [];

        const returns = buildLogReturnSeries(cleanData);
        const skewness = buildRollingSkewness(returns, volLookback);
        const pressure = buildPolymarket1sPressureGap(cleanData, context, { volLookback });
        if (!pressure.available) return [];
        const gamma = buildPolymarket1sGammaAgreement(cleanData, context, { volLookback });
        if (!gamma.available) return [];

        const signals: Signal[] = [];
        let currentEventStart: number | null = null;
        let currentEventOpen: number | null = null;

        for (let i = 0; i < cleanData.length; i++) {
            const bar = cleanData[i]!;
            const timestampSeconds = parseTimeToUnixSeconds(bar.time);
            if (timestampSeconds === null) continue;

            const eventStart = getEventStartSeconds(timestampSeconds);
            if (eventStart !== currentEventStart) {
                currentEventStart = eventStart;
                currentEventOpen = getEventOpenPrice(bar);
            }
            if (i < volLookback + 1) continue;
            if (currentEventOpen === null || currentEventOpen <= 0 || bar.close <= 0) continue;

            const eventEnd = eventStart + POLYMARKET_EVENT_SECONDS;
            const decisionTimeSeconds = timestampSeconds + ONE_SECOND_CLOSE_SHIFT;
            const secondsToEventEnd = eventEnd - decisionTimeSeconds;
            if (secondsToEventEnd <= MIN_SECONDS_TO_EVENT_END) continue;

            const moveBps = ((bar.close / currentEventOpen) - 1) * 10000;
            const baselineDirection = moveBps > 0 ? 1 : moveBps < 0 ? -1 : 0;
            if (baselineDirection === 0) continue;

            const distance = pressure.distanceZ[i];
            const previousDistance = pressure.distanceZ[i - 1];
            const skew = skewness[i];
            if (distance === null || previousDistance === null || skew === null) continue;

            const distanceShift = distance - previousDistance;
            if (
                baselineDirection > 0
                && distanceShift > 0
                && skew > p.skewThreshold
                && hasConsensusEdge(gamma.consensusLongEdge[i], p.minEdge)
            ) {
                signals.push(createBuySignal(cleanData, i, `Event direction long with Gamma-skew filter (${moveBps.toFixed(2)} bps)`));
            }
            if (
                baselineDirection < 0
                && distanceShift < 0
                && skew < -p.skewThreshold
                && hasConsensusEdge(gamma.consensusShortEdge[i], p.minEdge)
            ) {
                signals.push(createSellSignal(cleanData, i, `Event direction short with Gamma-skew filter (${moveBps.toFixed(2)} bps)`));
            }
        }

        return signals;
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["volLookback", "skewThreshold", "minEdge"],
    },
};
