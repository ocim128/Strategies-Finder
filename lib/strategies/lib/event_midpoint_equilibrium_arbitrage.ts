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

// #COMPLETION_DRIVE: Assuming event-open price can be determined by finding the bar close closest to event_start_ts
// #SUGGEST_VERIFY: Verify eventOpen is not null or zero in execution and matches the value resolved by buildPolymarket1sPressureGap
function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        volLookback: Math.max(5, Math.round(Number(params.volLookback ?? 45))),
        proximityPct: Math.max(0.0001, Math.min(0.5, Number(params.proximityPct ?? 0.05))),
        minEdge: Math.max(0.0, Number(params.minEdge ?? 0.03)),
    };
}

export const event_midpoint_equilibrium_arbitrage: Strategy = {
    name: "Event Midpoint Equilibrium Arbitrage",
    description: "Fades temporary Polymarket mid-probability skews away from the 0.5 coin-flip baseline when the Binance spot price is mathematically pinned precisely at the event-open price.",
    defaultParams: {
        volLookback: 45,
        proximityPct: 0.05,
        minEdge: 0.03,
    },
    paramLabels: {
        volLookback: "Volatility Lookback",
        proximityPct: "Proximity Percentage",
        minEdge: "Minimum Edge Magnitude",
    },
    normalizeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const volLookback = p.volLookback as number;
        const proximityPct = p.proximityPct as number;
        const minEdge = p.minEdge as number;

        if (cleanData.length < volLookback) return [];

        const pressure = buildPolymarket1sPressureGap(cleanData, context, { volLookback });
        if (!pressure.available) return [];

        // Build a mapping from timestamp to quote to find the event_start_ts for each index
        const quotes = context.polymarket1s.quotes;
        const timestamps = cleanData.map((bar) => parseTimeToUnixSeconds(bar.time));
        const typical = getTypicalPrices(cleanData);

        // Map event start times to their resolved open prices
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

        // Align quotes causally
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
            [pressure.distanceZ, pressure.longEdge, pressure.shortEdge],
            (i) => {
                const distanceZ = pressure.distanceZ[i];
                const longEdge = pressure.longEdge[i];
                const shortEdge = pressure.shortEdge[i];
                const quote = quoteAtIdx[i];

                if (distanceZ === null || longEdge === null || shortEdge === null || !quote) {
                    return null;
                }

                const eventOpen = resolveOpenPrice(quote.event_start_ts, i);
                if (eventOpen === null || eventOpen <= 0) return null;

                const currentTypical = typical[i];
                const deviationPct = Math.abs(currentTypical - eventOpen) / eventOpen;

                if (deviationPct > proximityPct) return null;

                // distanceZ is near 0 check: let's verify distanceZ is close to 0 (e.g. within 0.5 z-score)
                const distanceZNearZero = Math.abs(distanceZ) <= 0.5;
                if (!distanceZNearZero) return null;

                // Buy YES: longEdge >= minEdge
                if (longEdge >= minEdge) {
                    return createBuySignal(
                        cleanData,
                        i,
                        `Equilibrium buy YES with edge ${longEdge.toFixed(3)}, dev ${deviationPct.toFixed(4)}, distZ ${distanceZ.toFixed(2)}`
                    );
                }

                // Buy NO (expressed as Sell signal): shortEdge >= minEdge
                if (shortEdge >= minEdge) {
                    return createSellSignal(
                        cleanData,
                        i,
                        `Equilibrium buy NO with edge ${shortEdge.toFixed(3)}, dev ${deviationPct.toFixed(4)}, distZ ${distanceZ.toFixed(2)}`
                    );
                }

                return null;
            }
        );
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["volLookback", "proximityPct", "minEdge"],
    },
};
