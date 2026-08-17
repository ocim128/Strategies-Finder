import type { OHLCVData, Strategy, StrategyParams } from "../types/strategies";
import { open_clearance_collapse_reversal } from "../strategies/lib/open_clearance_collapse_reversal";
import { probability_boundary_eigen_shift } from "../strategies/lib/probability_boundary_eigen_shift";
import { robust_zscore_typical_fade } from "../strategies/lib/robust_zscore_typical_fade";

export const EXIT_HORIZONS = [1, 3, 5, 8, 12, 15] as const;
export const EXIT_CURVE_COST = 0.003;
export const EXIT_CURVE_RANDOM_SEED = 0x5eedc0de;
export const EXIT_CURVE_BLOCK_COUNT = 10;
export const MIN_SLEEVE_SIGNAL_BARS = 300;

export type SleeveKey = "eigen" | "robustz" | "clearanceNVDA" | "clearanceFlow2";

export type SleeveSeries = {
    symbol: string;
    bars: readonly OHLCVData[];
};

export type ExitCurveEntry = {
    symbol: string;
    bars: readonly OHLCVData[];
    signalIndex: number;
};

export type ForwardEntryObservation = {
    symbol: string;
    signalIndex: number;
    entryTime: number;
    exitTime: number;
    entryPrice: number;
    exitPrice: number;
    netReturn: number;
    mae: number;
    mfe: number;
    retPerExposureBar: number;
    spyExcess: number | null;
};

export type ExitCurveHorizon = {
    horizonBars: number;
    sampleSize: number;
    netReturn: number | null;
    mae: number | null;
    mfe: number | null;
    exposureBars: number;
    retPerExposureBar: number | null;
    spyExcess: number | null;
    spyCoverage: { available: number; total: number };
    positiveBlocks: number;
    totalBlocks: number;
    blockNetReturns: Array<number | null>;
    blockRetPerExposureBars: Array<number | null>;
};

export type ExitCurveControl = {
    horizonBars: number;
    sampleSize: number;
    randomNet: number | null;
    delta: number | null;
};

export type SleeveExitCurve = {
    sleeve: SleeveKey;
    horizons: ExitCurveHorizon[];
    controls: ExitCurveControl[];
};

export type ExitQuestionAssessment = {
    status: "YES" | "NO" | "INCONCLUSIVE" | "NOT_APPLICABLE";
    fiveBarNet: number | null;
    twelveBarNet: number | null;
    retentionRatio: number | null;
    fiveBarRetPerExposure: number | null;
    twelveBarRetPerExposure: number | null;
    retPerExposureImprovement: number | null;
    improvedExposureBlocks: number | null;
};

export const SLEEVE_STRATEGIES: Readonly<Record<Exclude<SleeveKey, "clearanceNVDA" | "clearanceFlow2">, {
    strategy: Strategy;
    params: StrategyParams;
}>> = {
    eigen: {
        strategy: probability_boundary_eigen_shift,
        params: { stateLookback: 50, eigenLimit: 3 },
    },
    robustz: {
        strategy: robust_zscore_typical_fade,
        params: { lookback: 40 },
    },
};

function numericTime(value: OHLCVData["time"]): number | null {
    const time = Number(value);
    return Number.isFinite(time) ? time : null;
}

function sortBars(data: readonly OHLCVData[]): OHLCVData[] {
    return [...data].sort((left, right) => Number(left.time) - Number(right.time));
}

function aggregateBucketedBars(data: readonly OHLCVData[]): OHLCVData[] {
    const buckets = new Map<number, OHLCVData>();
    for (const bar of sortBars(data)) {
        const time = numericTime(bar.time);
        if (time === null) continue;
        const bucketStart = Math.floor(time / 14_400) * 14_400;
        const current = buckets.get(bucketStart);
        if (!current) {
            buckets.set(bucketStart, {
                time: bucketStart as OHLCVData["time"],
                open: bar.open,
                high: bar.high,
                low: bar.low,
                close: bar.close,
                volume: 1_000,
            });
            continue;
        }
        current.high = Math.max(current.high, bar.high);
        current.low = Math.min(current.low, bar.low);
        current.close = bar.close;
    }
    return Array.from(buckets.values()).sort((left, right) => Number(left.time) - Number(right.time));
}

export function aggregateThirtyMinuteToFourHour(data: readonly OHLCVData[]): OHLCVData[] {
    return aggregateBucketedBars(data);
}

export function buildRatioFourHourBars(
    baseData: readonly OHLCVData[],
    quoteData: readonly OHLCVData[],
): OHLCVData[] {
    const quoteByTime = new Map<number, OHLCVData>();
    for (const bar of quoteData) {
        const time = numericTime(bar.time);
        if (time !== null) quoteByTime.set(time, bar);
    }

    const ratio30m: OHLCVData[] = [];
    for (const base of baseData) {
        const time = numericTime(base.time);
        const quote = time === null ? undefined : quoteByTime.get(time);
        if (!quote || quote.open <= 0 || quote.high <= 0 || quote.low <= 0 || quote.close <= 0) continue;
        const open = base.open / quote.open;
        const close = base.close / quote.close;
        const high = Math.max(open, close, base.high / quote.high, base.low / quote.low);
        const low = Math.min(open, close, base.high / quote.high, base.low / quote.low);
        if (![open, high, low, close].every(Number.isFinite)) continue;
        ratio30m.push({
            time: time as OHLCVData["time"],
            open,
            high,
            low,
            close,
            volume: 1_000,
        });
    }
    return aggregateBucketedBars(ratio30m);
}

export function collectBuySignalIndices(
    strategy: Strategy,
    bars: readonly OHLCVData[],
    params: StrategyParams,
): number[] {
    const signals = strategy.execute([...bars], params);
    return signals
        .filter((signal) => signal.type === "buy" && Number.isInteger(signal.barIndex))
        .map((signal) => signal.barIndex as number)
        .filter((index) => index >= 0 && index < bars.length)
        .sort((left, right) => left - right);
}

export function collectFlowQualifiedBuySignalIndices(
    bars: readonly OHLCVData[],
    params: StrategyParams = { lookback: 22 },
): number[] {
    const buys = collectBuySignalIndices(open_clearance_collapse_reversal, bars, params);
    const buySet = new Set(buys);
    return buys.filter((index) => {
        let flow = 0;
        for (let previous = Math.max(0, index - 5); previous <= index; previous += 1) {
            if (buySet.has(previous)) flow += 1;
        }
        return flow >= 2;
    });
}

export function buildExitCurveEntries(
    symbol: string,
    bars: readonly OHLCVData[],
    signalIndices: readonly number[],
): ExitCurveEntry[] {
    return signalIndices
        .filter((signalIndex) => Number.isInteger(signalIndex) && signalIndex >= 0 && signalIndex + 1 < bars.length)
        .map((signalIndex) => ({ symbol, bars, signalIndex }));
}

function mean(values: readonly number[]): number | null {
    return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function createSpyMap(spySeries: readonly OHLCVData[] | undefined): Map<number, OHLCVData> {
    const byTime = new Map<number, OHLCVData>();
    for (const bar of spySeries ?? []) {
        const time = numericTime(bar.time);
        if (time !== null) byTime.set(time, bar);
    }
    return byTime;
}

export function evaluateForwardEntry(
    entry: ExitCurveEntry,
    horizonBars: number,
    options: { cost?: number; spyByTime?: ReadonlyMap<number, OHLCVData> } = {},
): ForwardEntryObservation | null {
    const horizon = Math.floor(horizonBars);
    const entryIndex = entry.signalIndex + 1;
    const exitIndex = entry.signalIndex + horizon;
    if (horizon < 1 || entryIndex >= entry.bars.length || exitIndex >= entry.bars.length) return null;

    const entryBar = entry.bars[entryIndex]!;
    const exitBar = entry.bars[exitIndex]!;
    if (!Number.isFinite(entryBar.open) || entryBar.open <= 0 || !Number.isFinite(exitBar.close)) return null;

    let mae = Number.POSITIVE_INFINITY;
    let mfe = Number.NEGATIVE_INFINITY;
    for (let index = entryIndex; index <= exitIndex; index += 1) {
        const bar = entry.bars[index]!;
        mae = Math.min(mae, bar.low / entryBar.open - 1);
        mfe = Math.max(mfe, bar.high / entryBar.open - 1);
    }
    if (!Number.isFinite(mae) || !Number.isFinite(mfe)) return null;

    const entryTime = numericTime(entryBar.time);
    const exitTime = numericTime(exitBar.time);
    if (entryTime === null || exitTime === null) return null;
    const grossReturn = exitBar.close / entryBar.open - 1;
    const netReturn = grossReturn - (options.cost ?? EXIT_CURVE_COST);
    const spyEntry = options.spyByTime?.get(entryTime);
    const spyExit = options.spyByTime?.get(exitTime);
    const spyExcess = spyEntry && spyExit && spyEntry.open > 0 && Number.isFinite(spyExit.close)
        ? netReturn - (spyExit.close / spyEntry.open - 1)
        : null;

    return {
        symbol: entry.symbol,
        signalIndex: entry.signalIndex,
        entryTime,
        exitTime,
        entryPrice: entryBar.open,
        exitPrice: exitBar.close,
        netReturn,
        mae,
        mfe,
        retPerExposureBar: netReturn / horizon,
        spyExcess,
    };
}

function blockIndex(index: number, total: number): number {
    return Math.min(EXIT_CURVE_BLOCK_COUNT - 1, Math.floor((index * EXIT_CURVE_BLOCK_COUNT) / total));
}

function buildBlockMeans(
    observations: readonly ForwardEntryObservation[],
    value: (observation: ForwardEntryObservation) => number,
): Array<number | null> {
    const buckets: number[][] = Array.from({ length: EXIT_CURVE_BLOCK_COUNT }, () => []);
    for (let index = 0; index < observations.length; index += 1) {
        buckets[blockIndex(index, observations.length)]!.push(value(observations[index]!));
    }
    return buckets.map((bucket) => mean(bucket));
}

function buildHorizonMetrics(
    horizonBars: number,
    observations: readonly ForwardEntryObservation[],
): ExitCurveHorizon {
    const ordered = [...observations].sort((left, right) => left.entryTime - right.entryTime);
    const blockNetReturns = buildBlockMeans(ordered, (observation) => observation.netReturn);
    const blockRetPerExposureBars = buildBlockMeans(ordered, (observation) => observation.retPerExposureBar);
    const spyObservations = ordered.filter((observation) => observation.spyExcess !== null);
    return {
        horizonBars,
        sampleSize: ordered.length,
        netReturn: mean(ordered.map((observation) => observation.netReturn)),
        mae: mean(ordered.map((observation) => observation.mae)),
        mfe: mean(ordered.map((observation) => observation.mfe)),
        exposureBars: horizonBars,
        retPerExposureBar: mean(ordered.map((observation) => observation.retPerExposureBar)),
        spyExcess: mean(spyObservations.map((observation) => observation.spyExcess as number)),
        spyCoverage: { available: spyObservations.length, total: ordered.length },
        positiveBlocks: blockNetReturns.filter((value) => value !== null && value > 0).length,
        totalBlocks: EXIT_CURVE_BLOCK_COUNT,
        blockNetReturns,
        blockRetPerExposureBars,
    };
}

function nextRandom(state: { value: number }): number {
    let value = state.value >>> 0;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    state.value = value >>> 0;
    return state.value / 0x1_0000_0000;
}

export function sampleUniformEntries(
    series: readonly SleeveSeries[],
    symbols: readonly string[],
    horizonBars: number,
    count: number,
    seed: number,
): ExitCurveEntry[] {
    const allowedSymbols = new Set(symbols);
    const pool: ExitCurveEntry[] = [];
    for (const item of series) {
        if (!allowedSymbols.has(item.symbol)) continue;
        for (let signalIndex = 0; signalIndex + horizonBars < item.bars.length; signalIndex += 1) {
            pool.push({ symbol: item.symbol, bars: item.bars, signalIndex });
        }
    }
    if (pool.length === 0 || count <= 0) return [];

    const state = { value: (seed >>> 0) || 0x6d2b79f5 };
    const sampled: ExitCurveEntry[] = [];
    for (let index = 0; index < count; index += 1) {
        sampled.push(pool[Math.floor(nextRandom(state) * pool.length)]!);
    }
    return sampled;
}

export function computeSleeveExitCurve(
    sleeve: SleeveKey,
    entries: readonly ExitCurveEntry[],
    series: readonly SleeveSeries[],
    options: {
        spySeries?: readonly OHLCVData[];
        cost?: number;
        randomSeed?: number;
        horizons?: readonly number[];
    } = {},
): SleeveExitCurve {
    const horizons = options.horizons ?? EXIT_HORIZONS;
    const spyByTime = createSpyMap(options.spySeries);
    const symbols = Array.from(new Set(entries.map((entry) => entry.symbol)));
    const computedHorizons: ExitCurveHorizon[] = [];
    const controls: ExitCurveControl[] = [];
    for (const horizonBars of horizons) {
        const observations = entries
            .map((entry) => evaluateForwardEntry(entry, horizonBars, { cost: options.cost, spyByTime }))
            .filter((observation): observation is ForwardEntryObservation => observation !== null);
        const metrics = buildHorizonMetrics(horizonBars, observations);
        computedHorizons.push(metrics);

        const randomEntries = sampleUniformEntries(
            series,
            symbols,
            horizonBars,
            metrics.sampleSize,
            (options.randomSeed ?? EXIT_CURVE_RANDOM_SEED) + horizonBars * 0x9e3779b9,
        );
        const randomObservations = randomEntries
            .map((entry) => evaluateForwardEntry(entry, horizonBars, { cost: options.cost, spyByTime }))
            .filter((observation): observation is ForwardEntryObservation => observation !== null);
        const randomNet = mean(randomObservations.map((observation) => observation.netReturn));
        controls.push({
            horizonBars,
            sampleSize: randomObservations.length,
            randomNet,
            delta: metrics.netReturn !== null && randomNet !== null ? metrics.netReturn - randomNet : null,
        });
    }

    return { sleeve, horizons: computedHorizons, controls };
}

function findHorizon(result: SleeveExitCurve, horizonBars: number): ExitCurveHorizon | null {
    return result.horizons.find((horizon) => horizon.horizonBars === horizonBars) ?? null;
}

export function assessExitQuestion(result: SleeveExitCurve): ExitQuestionAssessment {
    if (result.sleeve !== "clearanceNVDA") {
        return {
            status: "NOT_APPLICABLE",
            fiveBarNet: null,
            twelveBarNet: null,
            retentionRatio: null,
            fiveBarRetPerExposure: null,
            twelveBarRetPerExposure: null,
            retPerExposureImprovement: null,
            improvedExposureBlocks: null,
        };
    }
    const five = findHorizon(result, 5);
    const twelve = findHorizon(result, 12);
    if (!five || !twelve || five.netReturn === null || twelve.netReturn === null
        || five.retPerExposureBar === null || twelve.retPerExposureBar === null) {
        return {
            status: "INCONCLUSIVE",
            fiveBarNet: five?.netReturn ?? null,
            twelveBarNet: twelve?.netReturn ?? null,
            retentionRatio: null,
            fiveBarRetPerExposure: five?.retPerExposureBar ?? null,
            twelveBarRetPerExposure: twelve?.retPerExposureBar ?? null,
            retPerExposureImprovement: null,
            improvedExposureBlocks: null,
        };
    }

    const retentionRatio = twelve.netReturn > 0 ? five.netReturn / twelve.netReturn : null;
    const retPerExposureImprovement = twelve.retPerExposureBar > 0
        ? five.retPerExposureBar / twelve.retPerExposureBar - 1
        : null;
    let improvedExposureBlocks = 0;
    for (let index = 0; index < EXIT_CURVE_BLOCK_COUNT; index += 1) {
        const fiveBlock = five.blockRetPerExposureBars[index];
        const twelveBlock = twelve.blockRetPerExposureBars[index];
        if (fiveBlock !== null && twelveBlock !== null && twelveBlock > 0 && fiveBlock >= twelveBlock * 1.2) {
            improvedExposureBlocks += 1;
        }
    }
    const status = retentionRatio !== null && retPerExposureImprovement !== null
        ? retentionRatio >= 0.8 && retPerExposureImprovement >= 0.2 && improvedExposureBlocks >= 7 ? "YES" : "NO"
        : "NO";
    return {
        status,
        fiveBarNet: five.netReturn,
        twelveBarNet: twelve.netReturn,
        retentionRatio,
        fiveBarRetPerExposure: five.retPerExposureBar,
        twelveBarRetPerExposure: twelve.retPerExposureBar,
        retPerExposureImprovement,
        improvedExposureBlocks,
    };
}

export function buildSleeveSignalIndices(sleeve: SleeveKey, bars: readonly OHLCVData[]): number[] {
    if (sleeve === "eigen" || sleeve === "robustz") {
        const definition = SLEEVE_STRATEGIES[sleeve];
        return collectBuySignalIndices(definition.strategy, bars, definition.params);
    }
    if (sleeve === "clearanceFlow2") return collectFlowQualifiedBuySignalIndices(bars);
    return collectBuySignalIndices(open_clearance_collapse_reversal, bars, { lookback: 22 });
}
