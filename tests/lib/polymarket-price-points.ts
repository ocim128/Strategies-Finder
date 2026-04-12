import type { PolymarketPricePoint } from "./local-sqlite-polymarket-api";

export interface EventPriceIndex {
    pointsByEventStart: Map<number, PolymarketPricePoint[]>;
}

export function indexPricePointsByEvent(
    pricePoints: readonly PolymarketPricePoint[]
): EventPriceIndex {
    const pointsByEventStart = new Map<number, PolymarketPricePoint[]>();

    for (const point of pricePoints) {
        const key = point.event_start_ts;
        let list = pointsByEventStart.get(key);
        if (!list) {
            list = [];
            pointsByEventStart.set(key, list);
        }
        list.push(point);
    }

    for (const list of pointsByEventStart.values()) {
        list.sort((a, b) => a.ts - b.ts);
    }

    return { pointsByEventStart };
}

export function findEntryFill(
    eventPoints: readonly PolymarketPricePoint[],
    entryTs: number,
    side: "yes" | "no"
): { price: number; ts: number } | null {
    for (const point of eventPoints) {
        if (point.ts < entryTs) continue;
        const price = side === "yes" ? point.yes_price : point.no_price;
        if (price === null || price === undefined) continue;
        return { price, ts: point.ts };
    }

    return null;
}

export function findSignalExitFill(
    eventPoints: readonly PolymarketPricePoint[],
    exitTs: number,
    side: "yes" | "no"
): { price: number; ts: number } | null {
    let best: PolymarketPricePoint | null = null;

    for (const point of eventPoints) {
        if (point.ts > exitTs) break;
        const price = side === "yes" ? point.yes_price : point.no_price;
        if (price === null || price === undefined) continue;
        best = point;
    }

    if (!best) return null;
    const price = side === "yes" ? best.yes_price : best.no_price;
    if (price === null || price === undefined) return null;
    return { price, ts: best.ts };
}
