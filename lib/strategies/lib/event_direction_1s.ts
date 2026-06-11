import type { Strategy, OHLCVData, Signal, StrategyParams } from "../../types/strategies";
import { parseTimeToUnixSeconds } from "../../time-normalization";
import {
    createBuySignal,
    createSellSignal,
    ensureCleanData,
} from "../strategy-helpers";
import { normalizeIntegerParam } from "./range-conviction-core";

const POLYMARKET_EVENT_SECONDS = 300;
const ONE_SECOND_CLOSE_SHIFT = 1;

function normalizeEventDirection1sParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        minSecondsToEventEnd: normalizeIntegerParam(params.minSecondsToEventEnd, 180, 0, POLYMARKET_EVENT_SECONDS - 1),
    };
}

function getEventStartSeconds(timestampSeconds: number): number {
    return Math.floor(timestampSeconds / POLYMARKET_EVENT_SECONDS) * POLYMARKET_EVENT_SECONDS;
}

function getEventOpenPrice(bar: OHLCVData): number {
    return bar.open > 0 ? bar.open : bar.close;
}

export const event_direction_1s: Strategy = {
    name: "Event Direction 1s",
    description: "Pure price-based event direction for 1s charts. Buys when close is above 5m event open, sells when below. No Polymarket context required.",
    defaultParams: {
        minSecondsToEventEnd: 180,
    },
    paramLabels: {
        minSecondsToEventEnd: "Min Seconds To Event End",
    },
    normalizeParams: normalizeEventDirection1sParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeEventDirection1sParams(params);
        if (cleanData.length < 2) return [];

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
            if (i === 0) continue;

            if (currentEventOpen === null || currentEventOpen <= 0 || bar.close <= 0) continue;

            const eventEnd = eventStart + POLYMARKET_EVENT_SECONDS;
            const decisionTimeSeconds = timestampSeconds + ONE_SECOND_CLOSE_SHIFT;
            const secondsToEventEnd = eventEnd - decisionTimeSeconds;
            if (p.minSecondsToEventEnd > 0 && secondsToEventEnd <= p.minSecondsToEventEnd) continue;

            const moveBps = ((bar.close / currentEventOpen) - 1) * 10000;
            const direction = moveBps > 0 ? 1 : moveBps < 0 ? -1 : 0;
            if (direction === 0) continue;

            const reason = `Event-open move ${moveBps.toFixed(2)} bps`;
            signals.push(direction > 0
                ? createBuySignal(cleanData, i, reason)
                : createSellSignal(cleanData, i, reason)
            );
        }

        return signals;
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["minSecondsToEventEnd"],
    },
};
