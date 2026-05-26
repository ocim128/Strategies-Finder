import type {
    Strategy,
    OHLCVData,
    Polymarket1sQuoteContextRow,
    Polymarket1sRuntimeContext,
    StrategyExecutionContext,
    StrategyParams,
} from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getTypicalPrices,
} from "../strategy-helpers";
import { parseTimeToUnixSeconds } from "../../time-normalization";
import { buildPolymarket1sPressureGap } from "./polymarket-1s-helpers";

// #COMPLETION_DRIVE: Assuming event-open price can be determined causally based on the event_start_ts of the active quote
// #SUGGEST_VERIFY: Verify eventProgress from buildPolymarket1sPressureGap maps to eventProgress inside the signal loop correctly
function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        volLookback: Math.max(5, Math.round(Number(params.volLookback ?? 40))),
        progressMin: Math.max(0.01, Math.min(0.99, Number(params.progressMin ?? 0.85))),
        minEdge: Math.max(0.0, Number(params.minEdge ?? 0.03)),
    };
}

type ProbabilityThetaDecayArbitragePrepared = {
    cleanData: OHLCVData[];
    timestamps: (number | null)[];
    typicalPrices: number[];
    runtime: Polymarket1sRuntimeContext | null;
    quotes: readonly Polymarket1sQuoteContextRow[] | null;
    quoteCount: number;
    quoteAtIdx: (Polymarket1sQuoteContextRow | null)[];
    eventOpenCache: Map<number, number | null>;
};

type AlignedThetaQuote = {
    quote: Polymarket1sQuoteContextRow;
    ts: number;
};

function prepareProbabilityThetaDecayArbitrageData(
    data: OHLCVData[],
    context?: StrategyExecutionContext
): ProbabilityThetaDecayArbitragePrepared {
    const cleanData = ensureCleanData(data);
    const timestamps = cleanData.map((bar) => parseTimeToUnixSeconds(bar.time));
    const runtime = context?.polymarket1s ?? null;
    const quoteAtIdx: (Polymarket1sQuoteContextRow | null)[] = new Array(cleanData.length).fill(null);

    if (runtime) {
        const sortedQuotes = [...runtime.quotes]
            .map((q) => ({ quote: q, ts: Number(q.sample_ts) }))
            .filter((q): q is AlignedThetaQuote => !isNaN(q.ts))
            .sort((a, b) => a.ts - b.ts);

        let qPointer = 0;
        let latestQuote: Polymarket1sQuoteContextRow | null = null;
        for (let i = 0; i < cleanData.length; i++) {
            const barTs = timestamps[i];
            if (barTs === null) continue;
            while (qPointer < sortedQuotes.length && sortedQuotes[qPointer].ts <= barTs) {
                latestQuote = sortedQuotes[qPointer].quote;
                qPointer++;
            }
            quoteAtIdx[i] = latestQuote;
        }
    }

    return {
        cleanData,
        timestamps,
        typicalPrices: getTypicalPrices(cleanData),
        runtime,
        quotes: runtime?.quotes ?? null,
        quoteCount: runtime?.quotes.length ?? 0,
        quoteAtIdx,
        eventOpenCache: new Map(),
    };
}

function getPreparedProbabilityThetaDecayArbitrageData(
    preparedData: unknown,
    data: OHLCVData[],
    context?: StrategyExecutionContext
): ProbabilityThetaDecayArbitragePrepared {
    const runtime = context?.polymarket1s ?? null;
    if (
        preparedData
        && typeof preparedData === "object"
        && "cleanData" in preparedData
        && "quoteAtIdx" in preparedData
        && (preparedData as ProbabilityThetaDecayArbitragePrepared).runtime === runtime
        && (
            !runtime
            || (
                (preparedData as ProbabilityThetaDecayArbitragePrepared).quotes === runtime.quotes
                && (preparedData as ProbabilityThetaDecayArbitragePrepared).quoteCount === runtime.quotes.length
            )
        )
    ) {
        return preparedData as ProbabilityThetaDecayArbitragePrepared;
    }
    return prepareProbabilityThetaDecayArbitrageData(data, context);
}

function resolvePreparedOpenPrice(
    prepared: ProbabilityThetaDecayArbitragePrepared,
    eventStartTs: number,
    currentIndex: number
): number | null {
    if (prepared.eventOpenCache.has(eventStartTs)) return prepared.eventOpenCache.get(eventStartTs)!;

    let firstCloseAfterStart: number | null = null;
    for (let cursor = currentIndex; cursor >= 0; cursor--) {
        const ts = prepared.timestamps[cursor];
        if (ts === null) continue;
        if (ts === eventStartTs) {
            prepared.eventOpenCache.set(eventStartTs, prepared.cleanData[cursor].close);
            return prepared.cleanData[cursor].close;
        }
        if (ts < eventStartTs) {
            prepared.eventOpenCache.set(eventStartTs, firstCloseAfterStart);
            return firstCloseAfterStart;
        }
        firstCloseAfterStart = prepared.cleanData[cursor].close;
    }
    prepared.eventOpenCache.set(eventStartTs, null);
    return null;
}

export const probability_theta_decay_arbitrage: Strategy = {
    name: "Probability Theta Decay Arbitrage",
    description: "Arbitrages the slow adjustment of Polymarket options pricing as the event progress approaches maturity (remaining time approaches 0), forcing the probability path to mathematically decay rapidly to 1 or 0.",
    defaultParams: {
        volLookback: 40,
        progressMin: 0.85,
        minEdge: 0.03,
    },
    paramLabels: {
        volLookback: "Volatility Lookback",
        progressMin: "Minimum Event Progress",
        minEdge: "Minimum Edge Magnitude",
    },
    normalizeParams,
    polymarket1sConfig: { required: true },
    prepareFinderData: (data, _settings, context) => prepareProbabilityThetaDecayArbitrageData(data, context),
    executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[], context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const prepared = getPreparedProbabilityThetaDecayArbitrageData(preparedData, data, context);
        const cleanData = prepared.cleanData;
        const p = normalizeParams(params);
        const volLookback = p.volLookback as number;
        const progressMin = p.progressMin as number;
        const minEdge = p.minEdge as number;

        if (cleanData.length < volLookback) return [];

        const pressure = buildPolymarket1sPressureGap(cleanData, context, { volLookback });
        if (!pressure.available) return [];

        return createSignalLoop(
            cleanData,
            [pressure.eventProgress, pressure.longEdge, pressure.shortEdge],
            (i) => {
                const eventProgress = pressure.eventProgress[i];
                const longEdge = pressure.longEdge[i];
                const shortEdge = pressure.shortEdge[i];
                const quote = prepared.quoteAtIdx[i];

                if (eventProgress === null || longEdge === null || shortEdge === null || !quote) {
                    return null;
                }

                if (eventProgress < progressMin) return null;

                const eventOpen = resolvePreparedOpenPrice(prepared, quote.event_start_ts, i);
                if (eventOpen === null || eventOpen <= 0) return null;

                const currentTypical = prepared.typicalPrices[i];

                // Buy YES: typical price is above event-open and longEdge >= minEdge
                if (currentTypical > eventOpen && longEdge >= minEdge) {
                    return createBuySignal(
                        cleanData,
                        i,
                        `Theta decay buy YES: progress ${eventProgress.toFixed(3)}, edge ${longEdge.toFixed(3)}, typical ${currentTypical} > open ${eventOpen}`
                    );
                }

                // Buy NO (expressed as Sell signal): typical price is below event-open and shortEdge >= minEdge
                if (currentTypical < eventOpen && shortEdge >= minEdge) {
                    return createSellSignal(
                        cleanData,
                        i,
                        `Theta decay buy NO: progress ${eventProgress.toFixed(3)}, edge ${shortEdge.toFixed(3)}, typical ${currentTypical} < open ${eventOpen}`
                    );
                }

                return null;
            }
        );
    },
    execute: (data, params, context) => {
        if (!context?.polymarket1s) return [];
        return probability_theta_decay_arbitrage.executePrepared?.(
            prepareProbabilityThetaDecayArbitrageData(data, context),
            params,
            data,
            context
        ) ?? [];
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["volLookback", "progressMin", "minEdge"],
    },
};
