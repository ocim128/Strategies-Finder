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

function clampProbability(value: number | null | undefined): number | null {
    if (value === null || value === undefined || !Number.isFinite(value)) {
        return null;
    }
    if (value <= 0) return 0;
    if (value >= 1) return 1;
    return value;
}

export function getPolymarketSidePrice(
    point: PolymarketPricePoint,
    side: "yes" | "no"
): number | null {
    const yesPrice = clampProbability(point.yes_price);
    if (side === "yes") {
        return yesPrice;
    }

    const noPrice = clampProbability(point.no_price);
    if (noPrice !== null) {
        return noPrice;
    }
    return yesPrice === null ? null : clampProbability(1 - yesPrice);
}

function getSidePrice(
    point: PolymarketPricePoint,
    side: "yes" | "no"
): number | null | undefined {
    return getPolymarketSidePrice(point, side);
}

function lowerBoundByTimestamp(
    eventPoints: readonly PolymarketPricePoint[],
    targetTs: number
): number {
    let left = 0;
    let right = eventPoints.length;

    while (left < right) {
        const mid = (left + right) >>> 1;
        if (eventPoints[mid]!.ts < targetTs) {
            left = mid + 1;
        } else {
            right = mid;
        }
    }

    return left;
}

function upperBoundByTimestamp(
    eventPoints: readonly PolymarketPricePoint[],
    targetTs: number
): number {
    let left = 0;
    let right = eventPoints.length;

    while (left < right) {
        const mid = (left + right) >>> 1;
        if (eventPoints[mid]!.ts <= targetTs) {
            left = mid + 1;
        } else {
            right = mid;
        }
    }

    return left;
}

export function findEntryFill(
    eventPoints: readonly PolymarketPricePoint[],
    entryTs: number,
    side: "yes" | "no"
): { price: number; ts: number } | null {
    for (let index = lowerBoundByTimestamp(eventPoints, entryTs); index < eventPoints.length; index++) {
        const point = eventPoints[index]!;
        const price = getSidePrice(point, side);
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
    for (let index = upperBoundByTimestamp(eventPoints, exitTs) - 1; index >= 0; index--) {
        const point = eventPoints[index]!;
        const price = getSidePrice(point, side);
        if (price === null || price === undefined) continue;
        return { price, ts: point.ts };
    }

    return null;
}
