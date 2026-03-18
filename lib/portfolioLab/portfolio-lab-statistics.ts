import { timeKey, type BacktestResult, type OHLCVData, type Trade } from "../strategies";

export function average(values: Array<number | null>): number | null {
    const finite = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    if (finite.length === 0) {
        return null;
    }
    return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

export function standardDeviation(values: number[]): number {
    if (values.length === 0) {
        return 0;
    }
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length;
    return Math.sqrt(variance);
}

export function computeCorrelation(a: Map<string, number>, b: Map<string, number>): number | null {
    const xs: number[] = [];
    const ys: number[] = [];
    const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];

    for (const [key, value] of smaller.entries()) {
        const other = larger.get(key);
        if (!Number.isFinite(value) || !Number.isFinite(other)) {
            continue;
        }
        xs.push(value);
        ys.push(other as number);
    }

    if (xs.length < 3) {
        return null;
    }

    const meanX = average(xs) ?? 0;
    const meanY = average(ys) ?? 0;
    let numerator = 0;
    let denomX = 0;
    let denomY = 0;

    for (let index = 0; index < xs.length; index += 1) {
        const dx = xs[index] - meanX;
        const dy = ys[index] - meanY;
        numerator += dx * dy;
        denomX += dx * dx;
        denomY += dy * dy;
    }

    if (denomX === 0 || denomY === 0) {
        return null;
    }

    return numerator / Math.sqrt(denomX * denomY);
}

export function buildCloseReturnSeries(data: OHLCVData[]): Map<string, number> {
    const series = new Map<string, number>();
    for (let index = 1; index < data.length; index += 1) {
        const previousClose = data[index - 1]?.close;
        const currentClose = data[index]?.close;
        if (!Number.isFinite(previousClose) || !Number.isFinite(currentClose) || previousClose === 0) {
            continue;
        }
        series.set(timeKey(data[index].time), (currentClose - previousClose) / previousClose);
    }
    return series;
}

export function buildEquityReturnSeries(result: BacktestResult): Map<string, number> {
    const series = new Map<string, number>();
    for (let index = 1; index < result.equityCurve.length; index += 1) {
        const previous = result.equityCurve[index - 1]?.value;
        const current = result.equityCurve[index]?.value;
        if (!Number.isFinite(previous) || !Number.isFinite(current) || previous === 0) {
            continue;
        }
        series.set(timeKey(result.equityCurve[index].time), (current - previous) / previous);
    }
    return series;
}

export function computeCloseReturnCorrelation(a: OHLCVData[], b: OHLCVData[]): number | null {
    return computeCorrelation(buildCloseReturnSeries(a), buildCloseReturnSeries(b));
}

export function computeEquityReturnCorrelation(a: BacktestResult, b: BacktestResult): number | null {
    return computeCorrelation(buildEquityReturnSeries(a), buildEquityReturnSeries(b));
}

export function computeDirectionalReturnAtIndex(
    data: OHLCVData[],
    barIndex: number,
    lookbackBars: number,
    directionFactor: number
): number | null {
    if (barIndex < lookbackBars || !data[barIndex] || !data[barIndex - lookbackBars]) {
        return null;
    }
    const start = data[barIndex - lookbackBars].close;
    const end = data[barIndex].close;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start === 0) {
        return null;
    }
    return directionFactor * (((end - start) / start) * 100);
}

export function computeDirectionalReturnAtTime(
    data: OHLCVData[],
    timeKeyValue: string,
    lookbackBars: number,
    directionFactor: number
): number | null {
    if (data.length === 0) {
        return null;
    }
    const index = data.findIndex((candle) => timeKey(candle.time) === timeKeyValue);
    if (index < 0) {
        return null;
    }
    return computeDirectionalReturnAtIndex(data, index, lookbackBars, directionFactor);
}

export function computeDirectionalPercentMove(
    startPrice: number,
    endPrice: number,
    direction: Trade["type"]
): number {
    if (!Number.isFinite(startPrice) || !Number.isFinite(endPrice) || startPrice === 0) {
        return 0;
    }
    const raw = ((endPrice - startPrice) / startPrice) * 100;
    return direction === "long" ? raw : -raw;
}

export function computeDirectionalAtrDistance(
    startPrice: number,
    endPrice: number,
    direction: Trade["type"],
    atr: number
): number {
    if (!Number.isFinite(atr) || atr <= 0) {
        return 0;
    }
    const move = direction === "long" ? endPrice - startPrice : startPrice - endPrice;
    return move / atr;
}

export function computeAdverseExcursionAtr(
    data: OHLCVData[],
    entryIndex: number,
    barIndex: number,
    direction: Trade["type"],
    entryPrice: number,
    atr: number
): number {
    if (!Number.isFinite(atr) || atr <= 0) {
        return 0;
    }
    let adversePrice = entryPrice;
    for (let index = entryIndex; index <= barIndex; index += 1) {
        const candle = data[index];
        if (!candle) {
            continue;
        }
        if (direction === "long") {
            adversePrice = Math.min(adversePrice, candle.low);
        } else {
            adversePrice = Math.max(adversePrice, candle.high);
        }
    }
    return direction === "long"
        ? Math.max(0, (entryPrice - adversePrice) / atr)
        : Math.max(0, (adversePrice - entryPrice) / atr);
}

export function computeAtrAt(data: OHLCVData[], index: number, period = 14): number | null {
    if (index <= 0 || index >= data.length) {
        return null;
    }
    const start = Math.max(1, index - period + 1);
    const values: number[] = [];
    for (let barIndex = start; barIndex <= index; barIndex += 1) {
        const current = data[barIndex];
        const previous = data[barIndex - 1];
        if (!current || !previous) {
            continue;
        }
        const trueRange = Math.max(
            current.high - current.low,
            Math.abs(current.high - previous.close),
            Math.abs(current.low - previous.close)
        );
        if (Number.isFinite(trueRange)) {
            values.push(trueRange);
        }
    }
    return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}
