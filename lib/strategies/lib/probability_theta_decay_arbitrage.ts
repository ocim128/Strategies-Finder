import { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
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
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const volLookback = p.volLookback as number;
        const progressMin = p.progressMin as number;
        const minEdge = p.minEdge as number;

        if (cleanData.length < volLookback) return [];

        const pressure = buildPolymarket1sPressureGap(cleanData, context, { volLookback });
        if (!pressure.available) return [];

        const quotes = context.polymarket1s.quotes;
        const timestamps = cleanData.map((bar) => parseTimeToUnixSeconds(bar.time));
        const typical = getTypicalPrices(cleanData);

        const eventOpenCache = new Map<number, number | null>();
        const resolveOpenPrice = (eventStartTs: number, currentIndex: number): number | null => {
            if (eventOpenCache.has(eventStartTs)) return eventOpenCache.get(eventStartTs)!;

            let firstCloseAfterStart: number | null = null;
            for (let cursor = currentIndex; cursor >= 0; cursor--) {
                const ts = timestamps[cursor];
                if (ts === null) continue;
                if (ts === eventStartTs) {
                    eventOpenCache.set(eventStartTs, cleanData[cursor].close);
                    return cleanData[cursor].close;
                }
                if (ts < eventStartTs) {
                    eventOpenCache.set(eventStartTs, firstCloseAfterStart);
                    return firstCloseAfterStart;
                }
                firstCloseAfterStart = cleanData[cursor].close;
            }
            eventOpenCache.set(eventStartTs, null);
            return null;
        };

        const sortedQuotes = [...quotes]
            .map((q) => ({ quote: q, ts: Number(q.sample_ts) }))
            .filter((q) => !isNaN(q.ts))
            .sort((a, b) => a.ts - b.ts);

        const quoteAtIdx = new Array(cleanData.length).fill(null);
        let qPointer = 0;
        let latestQuote = null;
        for (let i = 0; i < cleanData.length; i++) {
            const barTs = timestamps[i];
            if (barTs === null) continue;
            while (qPointer < sortedQuotes.length && sortedQuotes[qPointer].ts <= barTs) {
                latestQuote = sortedQuotes[qPointer].quote;
                qPointer++;
            }
            quoteAtIdx[i] = latestQuote;
        }

        return createSignalLoop(
            cleanData,
            [pressure.eventProgress, pressure.longEdge, pressure.shortEdge],
            (i) => {
                const eventProgress = pressure.eventProgress[i];
                const longEdge = pressure.longEdge[i];
                const shortEdge = pressure.shortEdge[i];
                const quote = quoteAtIdx[i];

                if (eventProgress === null || longEdge === null || shortEdge === null || !quote) {
                    return null;
                }

                if (eventProgress < progressMin) return null;

                const eventOpen = resolveOpenPrice(quote.event_start_ts, i);
                if (eventOpen === null || eventOpen <= 0) return null;

                const currentTypical = typical[i];

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
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["volLookback", "progressMin", "minEdge"],
    },
};
