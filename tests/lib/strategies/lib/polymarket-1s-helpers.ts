import type {
    OHLCVData,
    Polymarket1sGammaContextRow,
    Polymarket1sQuoteContextRow,
    Polymarket1sRuntimeContext,
    StrategyExecutionContext,
} from "../../types/strategies";
import { parseTimeToUnixSeconds } from "../../time-normalization";
import { buildRollingStdDev } from "./price-action-statistics-core";

const DEFAULT_MAX_QUOTE_AGE_SEC = 2;
const DEFAULT_VOL_LOOKBACK = 45;
const DEFAULT_VOL_FLOOR = 1e-5;

export interface Polymarket1sPressureGapOptions {
    volLookback?: number;
    maxQuoteAgeSec?: number;
    volFloor?: number;
}

export interface Polymarket1sPressureGapFrame {
    available: boolean;
    spotYesProbability: (number | null)[];
    marketYesProbability: (number | null)[];
    pressureGap: (number | null)[];
    longEdge: (number | null)[];
    shortEdge: (number | null)[];
    longAdverse: (number | null)[];
    shortAdverse: (number | null)[];
    distanceZ: (number | null)[];
    eventProgress: (number | null)[];
}

export type Polymarket1sExecutableEdgeOptions = Polymarket1sPressureGapOptions;

export interface Polymarket1sExecutableEdgeFrame {
    available: boolean;
    fairYesProbability: (number | null)[];
    fairNoProbability: (number | null)[];
    marketYesProbability: (number | null)[];
    yesAskProbability: (number | null)[];
    noAskProbability: (number | null)[];
    buyYesEdge: (number | null)[];
    buyNoEdge: (number | null)[];
    quoteAgeSec: (number | null)[];
    eventProgress: (number | null)[];
    secondsRemaining: (number | null)[];
}

export interface Polymarket1sReactionGapOptions extends Polymarket1sPressureGapOptions {
    lagSec?: number;
}

export interface Polymarket1sReactionGapFrame {
    available: boolean;
    spotImpulse: (number | null)[];
    marketImpulse: (number | null)[];
    reactionGap: (number | null)[];
    longLagEdge: (number | null)[];
    shortLagEdge: (number | null)[];
}

export interface Polymarket1sActionabilityOptions extends Polymarket1sExecutableEdgeOptions {
    minEventProgress?: number;
    maxEventProgress?: number;
    minSecondsRemaining?: number;
    maxSecondsRemaining?: number;
}

export type Polymarket1sActionabilityReason =
    | "missing_quote"
    | "event_too_early"
    | "event_too_late"
    | "event_too_close"
    | "event_too_far";

export interface Polymarket1sActionabilityFrame {
    available: boolean;
    actionable: boolean[];
    yesActionable: boolean[];
    noActionable: boolean[];
    reason: (Polymarket1sActionabilityReason | null)[];
}

export interface Polymarket1sEdgePersistenceOptions {
    minEdge?: number;
    ewmaLookback?: number;
}

export interface Polymarket1sEdgePersistenceFrame {
    yesEdgeEwma: (number | null)[];
    noEdgeEwma: (number | null)[];
    yesEdgeSeconds: number[];
    noEdgeSeconds: number[];
}

export interface Polymarket1sGammaAgreementOptions extends Polymarket1sPressureGapOptions {
    maxGammaAgeSec?: number;
}

export interface Polymarket1sGammaAgreementFrame {
    available: boolean;
    gammaYesProbability: (number | null)[];
    gammaGap: (number | null)[];
    consensusLongEdge: (number | null)[];
    consensusShortEdge: (number | null)[];
}

type ContextInput = StrategyExecutionContext | Polymarket1sRuntimeContext | null | undefined;

interface AlignedQuote {
    quote: Polymarket1sQuoteContextRow;
    quoteTs: number;
}

interface AlignedGamma {
    gamma: Polymarket1sGammaContextRow;
    gammaTs: number;
}

type PressureGapCacheEntry = {
    quotes: readonly Polymarket1sQuoteContextRow[];
    quoteCount: number;
    frame: Polymarket1sPressureGapFrame;
};

type RuntimeFrameCacheEntry<TFrame> = {
    quotes: readonly Polymarket1sQuoteContextRow[];
    quoteCount: number;
    gammaSnapshots?: readonly Polymarket1sGammaContextRow[];
    gammaCount?: number;
    frame: TFrame;
};

type RuntimeFrameCache<TFrame> = WeakMap<
    Polymarket1sRuntimeContext,
    WeakMap<readonly OHLCVData[], Map<string, RuntimeFrameCacheEntry<TFrame>>>
>;

const pressureGapCache = new WeakMap<
    Polymarket1sRuntimeContext,
    WeakMap<readonly OHLCVData[], Map<string, PressureGapCacheEntry>>
>();

const executableEdgeCache: RuntimeFrameCache<Polymarket1sExecutableEdgeFrame> = new WeakMap();
const reactionGapCache: RuntimeFrameCache<Polymarket1sReactionGapFrame> = new WeakMap();
const actionabilityCache: RuntimeFrameCache<Polymarket1sActionabilityFrame> = new WeakMap();
const gammaAgreementCache: RuntimeFrameCache<Polymarket1sGammaAgreementFrame> = new WeakMap();
const timestampSecondsCache = new WeakMap<readonly OHLCVData[], (number | null)[]>();
const sortedQuoteCache = new WeakMap<
    Polymarket1sRuntimeContext,
    { quotes: readonly Polymarket1sQuoteContextRow[]; quoteCount: number; aligned: AlignedQuote[] }
>();
const sortedGammaCache = new WeakMap<
    Polymarket1sRuntimeContext,
    { gammaSnapshots: readonly Polymarket1sGammaContextRow[]; gammaCount: number; aligned: AlignedGamma[] }
>();

const EMPTY_GAMMA_SNAPSHOTS: readonly Polymarket1sGammaContextRow[] = [];

function emptyPressureGapFrame(length: number): Polymarket1sPressureGapFrame {
    return {
        available: false,
        spotYesProbability: new Array(length).fill(null),
        marketYesProbability: new Array(length).fill(null),
        pressureGap: new Array(length).fill(null),
        longEdge: new Array(length).fill(null),
        shortEdge: new Array(length).fill(null),
        longAdverse: new Array(length).fill(null),
        shortAdverse: new Array(length).fill(null),
        distanceZ: new Array(length).fill(null),
        eventProgress: new Array(length).fill(null),
    };
}

function emptyExecutableEdgeFrame(length: number): Polymarket1sExecutableEdgeFrame {
    return {
        available: false,
        fairYesProbability: new Array(length).fill(null),
        fairNoProbability: new Array(length).fill(null),
        marketYesProbability: new Array(length).fill(null),
        yesAskProbability: new Array(length).fill(null),
        noAskProbability: new Array(length).fill(null),
        buyYesEdge: new Array(length).fill(null),
        buyNoEdge: new Array(length).fill(null),
        quoteAgeSec: new Array(length).fill(null),
        eventProgress: new Array(length).fill(null),
        secondsRemaining: new Array(length).fill(null),
    };
}

function emptyReactionGapFrame(length: number): Polymarket1sReactionGapFrame {
    return {
        available: false,
        spotImpulse: new Array(length).fill(null),
        marketImpulse: new Array(length).fill(null),
        reactionGap: new Array(length).fill(null),
        longLagEdge: new Array(length).fill(null),
        shortLagEdge: new Array(length).fill(null),
    };
}

function emptyActionabilityFrame(length: number): Polymarket1sActionabilityFrame {
    return {
        available: false,
        actionable: new Array(length).fill(false),
        yesActionable: new Array(length).fill(false),
        noActionable: new Array(length).fill(false),
        reason: new Array(length).fill(null),
    };
}

function emptyGammaAgreementFrame(length: number): Polymarket1sGammaAgreementFrame {
    return {
        available: false,
        gammaYesProbability: new Array(length).fill(null),
        gammaGap: new Array(length).fill(null),
        consensusLongEdge: new Array(length).fill(null),
        consensusShortEdge: new Array(length).fill(null),
    };
}

function resolveRuntimeContext(context: ContextInput): Polymarket1sRuntimeContext | null {
    if (!context) return null;
    if ("quotes" in context) return context;
    return context.polymarket1s ?? null;
}

function finiteNumber(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function finiteOrDefault(value: unknown, fallback: number): number {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
}

function roundedAtLeast(value: unknown, fallback: number, min: number): number {
    return Math.max(min, Math.round(finiteOrDefault(value, fallback)));
}

function numberAtLeast(value: unknown, fallback: number, min: number): number {
    return Math.max(min, finiteOrDefault(value, fallback));
}

function clampFinite(value: unknown, fallback: number, min: number, max: number): number {
    return clamp(finiteOrDefault(value, fallback), min, max);
}

function normalizeProbability(value: number | null): number | null {
    if (value === null || !Number.isFinite(value)) return null;
    return clamp(value, 0, 1);
}

function normalizePrice(value: unknown): number | null {
    return normalizeProbability(finiteNumber(value));
}

function normalizeYesProbability(yes: number | null, no: number | null): number | null {
    const yesProb = normalizeProbability(yes);
    const noProb = normalizeProbability(no);
    if (yesProb !== null && noProb !== null) {
        const sum = yesProb + noProb;
        if (sum > 0) return clamp(yesProb / sum, 0, 1);
    }
    return yesProb;
}

function normalCdf(value: number): number {
    if (!Number.isFinite(value)) return 0.5;
    const x = value / Math.SQRT2;
    const sign = x < 0 ? -1 : 1;
    const absX = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * absX);
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const erf = sign * (1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX));
    return clamp(0.5 * (1 + erf), 0, 1);
}

function buildLogReturns(data: readonly OHLCVData[]): number[] {
    const returns = new Array(data.length).fill(0);
    for (let i = 1; i < data.length; i++) {
        const prev = data[i - 1].close;
        const current = data[i].close;
        if (prev > 0 && current > 0) {
            returns[i] = Math.log(current / prev);
        }
    }
    return returns;
}

function getTimestampSeconds(data: readonly OHLCVData[]): (number | null)[] {
    const cached = timestampSecondsCache.get(data);
    if (cached) return cached;
    const timestamps = data.map((bar) => parseTimeToUnixSeconds(bar.time));
    timestampSecondsCache.set(data, timestamps);
    return timestamps;
}

function sortedQuotes(context: Polymarket1sRuntimeContext): AlignedQuote[] {
    const cached = sortedQuoteCache.get(context);
    if (cached && cached.quotes === context.quotes && cached.quoteCount === context.quotes.length) {
        return cached.aligned;
    }
    const aligned = context.quotes
        .map((quote) => ({ quote, quoteTs: finiteNumber(quote.sample_ts) }))
        .filter((item): item is AlignedQuote => item.quoteTs !== null)
        .sort((left, right) => left.quoteTs - right.quoteTs);
    sortedQuoteCache.set(context, {
        quotes: context.quotes,
        quoteCount: context.quotes.length,
        aligned,
    });
    return aligned;
}

function sortedGammaSnapshots(context: Polymarket1sRuntimeContext): AlignedGamma[] {
    const gammaSnapshots = context.gammaSnapshots ?? EMPTY_GAMMA_SNAPSHOTS;
    const cached = sortedGammaCache.get(context);
    if (cached && cached.gammaSnapshots === gammaSnapshots && cached.gammaCount === gammaSnapshots.length) {
        return cached.aligned;
    }
    const aligned = gammaSnapshots
        .map((gamma) => ({ gamma, gammaTs: finiteNumber(gamma.snapshot_ts) }))
        .filter((item): item is AlignedGamma => item.gammaTs !== null)
        .sort((left, right) => left.gammaTs - right.gammaTs);
    sortedGammaCache.set(context, {
        gammaSnapshots,
        gammaCount: gammaSnapshots.length,
        aligned,
    });
    return aligned;
}

function pressureGapOptionsKey(options: Polymarket1sPressureGapOptions): string {
    return [
        roundedAtLeast(options.volLookback, DEFAULT_VOL_LOOKBACK, 5),
        roundedAtLeast(options.maxQuoteAgeSec, DEFAULT_MAX_QUOTE_AGE_SEC, 0),
        numberAtLeast(options.volFloor, DEFAULT_VOL_FLOOR, 1e-9),
    ].join("|");
}

function reactionGapOptionsKey(options: Polymarket1sReactionGapOptions): string {
    return [
        pressureGapOptionsKey(options),
        roundedAtLeast(options.lagSec, 3, 1),
    ].join("|");
}

function actionabilityOptionsKey(options: Polymarket1sActionabilityOptions): string {
    return [
        pressureGapOptionsKey(options),
        clampFinite(options.minEventProgress, 0, 0, 1),
        clampFinite(options.maxEventProgress, 1, 0, 1),
        roundedAtLeast(options.minSecondsRemaining, 0, 0),
        Number.isFinite(Number(options.maxSecondsRemaining))
            ? roundedAtLeast(options.maxSecondsRemaining, 0, 0)
            : "inf",
    ].join("|");
}

function gammaAgreementOptionsKey(options: Polymarket1sGammaAgreementOptions): string {
    return [
        pressureGapOptionsKey(options),
        roundedAtLeast(options.maxGammaAgeSec, 60, 0),
    ].join("|");
}

function getCachedPressureGapFrame(
    runtime: Polymarket1sRuntimeContext,
    data: readonly OHLCVData[],
    key: string
): Polymarket1sPressureGapFrame | null {
    const byData = pressureGapCache.get(runtime);
    const byOptions = byData?.get(data);
    const cached = byOptions?.get(key);
    if (!cached) return null;
    return cached.quotes === runtime.quotes && cached.quoteCount === runtime.quotes.length
        ? cached.frame
        : null;
}

function setCachedPressureGapFrame(
    runtime: Polymarket1sRuntimeContext,
    data: readonly OHLCVData[],
    key: string,
    frame: Polymarket1sPressureGapFrame
): void {
    let byData = pressureGapCache.get(runtime);
    if (!byData) {
        byData = new WeakMap();
        pressureGapCache.set(runtime, byData);
    }
    let byOptions = byData.get(data);
    if (!byOptions) {
        byOptions = new Map();
        byData.set(data, byOptions);
    }
    byOptions.set(key, {
        quotes: runtime.quotes,
        quoteCount: runtime.quotes.length,
        frame,
    });
}

function getCachedRuntimeFrame<TFrame>(
    cache: RuntimeFrameCache<TFrame>,
    runtime: Polymarket1sRuntimeContext,
    data: readonly OHLCVData[],
    key: string,
    includeGamma = false
): TFrame | null {
    const byData = cache.get(runtime);
    const byOptions = byData?.get(data);
    const cached = byOptions?.get(key);
    if (!cached) return null;
    if (cached.quotes !== runtime.quotes || cached.quoteCount !== runtime.quotes.length) return null;
    if (includeGamma) {
        const gammaSnapshots = runtime.gammaSnapshots ?? EMPTY_GAMMA_SNAPSHOTS;
        if (cached.gammaSnapshots !== gammaSnapshots || cached.gammaCount !== gammaSnapshots.length) return null;
    }
    return cached.frame;
}

function setCachedRuntimeFrame<TFrame>(
    cache: RuntimeFrameCache<TFrame>,
    runtime: Polymarket1sRuntimeContext,
    data: readonly OHLCVData[],
    key: string,
    frame: TFrame,
    includeGamma = false
): void {
    let byData = cache.get(runtime);
    if (!byData) {
        byData = new WeakMap();
        cache.set(runtime, byData);
    }
    let byOptions = byData.get(data);
    if (!byOptions) {
        byOptions = new Map();
        byData.set(data, byOptions);
    }
    const gammaSnapshots = runtime.gammaSnapshots ?? EMPTY_GAMMA_SNAPSHOTS;
    byOptions.set(key, {
        quotes: runtime.quotes,
        quoteCount: runtime.quotes.length,
        gammaSnapshots: includeGamma ? gammaSnapshots : undefined,
        gammaCount: includeGamma ? gammaSnapshots.length : undefined,
        frame,
    });
}

function activeQuoteAt(
    aligned: readonly AlignedQuote[],
    pointerState: { pointer: number; latest: AlignedQuote | null },
    targetTs: number,
    maxQuoteAgeSec: number
): AlignedQuote | null {
    while (pointerState.pointer < aligned.length && aligned[pointerState.pointer].quoteTs <= targetTs) {
        pointerState.latest = aligned[pointerState.pointer];
        pointerState.pointer += 1;
    }

    const latest = pointerState.latest;
    if (!latest) return null;
    const quote = latest.quote;
    const ageSec = targetTs - latest.quoteTs;
    if (ageSec < 0 || ageSec > maxQuoteAgeSec) return null;
    if (quote.event_start_ts > targetTs || quote.event_end_ts <= targetTs) return null;
    return latest;
}

function activeGammaAt(
    aligned: readonly AlignedGamma[],
    pointerState: { pointer: number; latest: AlignedGamma | null },
    targetTs: number,
    maxGammaAgeSec: number
): AlignedGamma | null {
    while (pointerState.pointer < aligned.length && aligned[pointerState.pointer].gammaTs <= targetTs) {
        pointerState.latest = aligned[pointerState.pointer];
        pointerState.pointer += 1;
    }

    const latest = pointerState.latest;
    if (!latest) return null;
    const gamma = latest.gamma;
    const ageSec = targetTs - latest.gammaTs;
    if (ageSec < 0 || ageSec > maxGammaAgeSec) return null;
    if (gamma.event_start_ts > targetTs || gamma.event_end_ts <= targetTs) return null;
    return latest;
}

function eventKey(row: Pick<Polymarket1sQuoteContextRow, "series_id" | "event_start_ts">): string {
    return `${row.series_id}:${row.event_start_ts}`;
}

function resolveEventOpenPrice(
    data: readonly OHLCVData[],
    index: number,
    eventStartTs: number,
    timestamps: readonly (number | null)[] = getTimestampSeconds(data)
): number | null {
    let firstCloseAfterStart: number | null = null;
    for (let cursor = index; cursor >= 0; cursor--) {
        const ts = timestamps[cursor];
        if (ts === null) continue;
        if (ts === eventStartTs) return data[cursor].close;
        if (ts < eventStartTs) return firstCloseAfterStart;
        firstCloseAfterStart = data[cursor].close;
    }
    return null;
}

/**
 * Compares a simple Binance-implied event probability against Polymarket YES probability.
 *
 * Positive pressureGap means YES looks underpriced relative to current spot state.
 * Negative pressureGap means NO looks underpriced relative to current spot state.
 */
export function buildPolymarket1sPressureGap(
    data: readonly OHLCVData[],
    context: ContextInput,
    options: Polymarket1sPressureGapOptions = {}
): Polymarket1sPressureGapFrame {
    const runtime = resolveRuntimeContext(context);
    const length = data.length;
    if (!runtime || runtime.quotes.length === 0 || length === 0) {
        return emptyPressureGapFrame(length);
    }

    const cacheKey = pressureGapOptionsKey(options);
    const cached = getCachedPressureGapFrame(runtime, data, cacheKey);
    if (cached) return cached;

    const frame = emptyPressureGapFrame(length);
    const quotes = sortedQuotes(runtime);
    const quoteState = { pointer: 0, latest: null as AlignedQuote | null };
    const logReturns = buildLogReturns(data);
    const timestamps = getTimestampSeconds(data);
    const volLookback = roundedAtLeast(options.volLookback, DEFAULT_VOL_LOOKBACK, 5);
    const rollingVol = buildRollingStdDev(logReturns, volLookback);
    const maxQuoteAgeSec = roundedAtLeast(options.maxQuoteAgeSec, DEFAULT_MAX_QUOTE_AGE_SEC, 0);
    const volFloor = numberAtLeast(options.volFloor, DEFAULT_VOL_FLOOR, 1e-9);
    const eventOpenByKey = new Map<string, number>();
    let populated = 0;

    for (let i = 0; i < length; i++) {
        const ts = timestamps[i];
        if (ts === null) continue;

        const alignedQuote = activeQuoteAt(quotes, quoteState, ts, maxQuoteAgeSec);
        if (!alignedQuote) continue;

        const quote = alignedQuote.quote;
        const key = eventKey(quote);
        if (!eventOpenByKey.has(key)) {
            const eventOpen = resolveEventOpenPrice(data, i, quote.event_start_ts, timestamps);
            if (eventOpen === null || eventOpen <= 0) continue;
            eventOpenByKey.set(key, eventOpen);
        }
        const eventOpen = eventOpenByKey.get(key)!;
        if (eventOpen <= 0 || data[i].close <= 0) continue;

        const sigma1s = rollingVol[i];
        if (sigma1s === null) continue;

        const secondsRemaining = Math.max(1, quote.event_end_ts - ts);
        const remainingVol = Math.max(Math.abs(sigma1s) * Math.sqrt(secondsRemaining), volFloor);
        const eventMove = Math.log(data[i].close / eventOpen);
        const distanceZ = eventMove / remainingVol;
        const spotYesProbability = normalCdf(distanceZ);
        const marketYesProbability = normalizeYesProbability(
            finiteNumber(quote.yes_mid),
            finiteNumber(quote.no_mid)
        );
        if (marketYesProbability === null) continue;

        const gap = spotYesProbability - marketYesProbability;
        const progressDenominator = Math.max(1, quote.event_end_ts - quote.event_start_ts);
        const eventProgress = clamp((ts - quote.event_start_ts) / progressDenominator, 0, 1);

        frame.spotYesProbability[i] = spotYesProbability;
        frame.marketYesProbability[i] = marketYesProbability;
        frame.pressureGap[i] = gap;
        frame.longEdge[i] = Math.max(0, gap);
        frame.shortEdge[i] = Math.max(0, -gap);
        frame.longAdverse[i] = Math.max(0, -gap);
        frame.shortAdverse[i] = Math.max(0, gap);
        frame.distanceZ[i] = distanceZ;
        frame.eventProgress[i] = eventProgress;
        populated++;
    }

    frame.available = populated > 0;
    setCachedPressureGapFrame(runtime, data, cacheKey, frame);
    return frame;
}

/**
 * Compares Binance-implied event probability against executable CLOB ask prices.
 *
 * Positive buyYesEdge means YES ask is below the model fair YES probability.
 * Positive buyNoEdge means NO ask is below the model fair NO probability.
 */
export function buildPolymarket1sExecutableEdge(
    data: readonly OHLCVData[],
    context: ContextInput,
    options: Polymarket1sExecutableEdgeOptions = {}
): Polymarket1sExecutableEdgeFrame {
    const runtime = resolveRuntimeContext(context);
    const length = data.length;
    if (!runtime || runtime.quotes.length === 0 || length === 0) {
        return emptyExecutableEdgeFrame(length);
    }

    const cacheKey = pressureGapOptionsKey(options);
    const cached = getCachedRuntimeFrame(executableEdgeCache, runtime, data, cacheKey);
    if (cached) return cached;

    const pressure = buildPolymarket1sPressureGap(data, runtime, options);
    const frame = emptyExecutableEdgeFrame(length);
    const quotes = sortedQuotes(runtime);
    const quoteState = { pointer: 0, latest: null as AlignedQuote | null };
    const timestamps = getTimestampSeconds(data);
    const maxQuoteAgeSec = roundedAtLeast(options.maxQuoteAgeSec, DEFAULT_MAX_QUOTE_AGE_SEC, 0);
    let populated = 0;

    for (let i = 0; i < length; i++) {
        const ts = timestamps[i];
        if (ts === null) continue;

        const alignedQuote = activeQuoteAt(quotes, quoteState, ts, maxQuoteAgeSec);
        const fairYes = pressure.spotYesProbability[i];
        const marketYes = pressure.marketYesProbability[i];
        const eventProgress = pressure.eventProgress[i];
        if (!alignedQuote || fairYes === null || marketYes === null || eventProgress === null) continue;

        const quote = alignedQuote.quote;
        const fairNo = 1 - fairYes;
        const yesAsk = normalizePrice(quote.yes_ask);
        const noAsk = normalizePrice(quote.no_ask);
        const secondsRemaining = Math.max(0, quote.event_end_ts - ts);

        frame.fairYesProbability[i] = fairYes;
        frame.fairNoProbability[i] = fairNo;
        frame.marketYesProbability[i] = marketYes;
        frame.yesAskProbability[i] = yesAsk;
        frame.noAskProbability[i] = noAsk;
        frame.quoteAgeSec[i] = ts - alignedQuote.quoteTs;
        frame.eventProgress[i] = eventProgress;
        frame.secondsRemaining[i] = secondsRemaining;

        if (yesAsk !== null) frame.buyYesEdge[i] = fairYes - yesAsk;
        if (noAsk !== null) frame.buyNoEdge[i] = fairNo - noAsk;
        if (frame.buyYesEdge[i] !== null || frame.buyNoEdge[i] !== null) populated++;
    }

    frame.available = populated > 0;
    setCachedRuntimeFrame(executableEdgeCache, runtime, data, cacheKey, frame);
    return frame;
}

/**
 * Measures whether Polymarket probability lagged a recent Binance-implied probability impulse.
 */
export function buildPolymarket1sReactionGap(
    data: readonly OHLCVData[],
    context: ContextInput,
    options: Polymarket1sReactionGapOptions = {}
): Polymarket1sReactionGapFrame {
    const runtime = resolveRuntimeContext(context);
    const length = data.length;
    if (!runtime || runtime.quotes.length === 0 || length === 0) {
        return emptyReactionGapFrame(length);
    }

    const cacheKey = reactionGapOptionsKey(options);
    const cached = getCachedRuntimeFrame(reactionGapCache, runtime, data, cacheKey);
    if (cached) return cached;

    const pressure = buildPolymarket1sPressureGap(data, runtime, options);
    const frame = emptyReactionGapFrame(length);
    const lagSec = roundedAtLeast(options.lagSec, 3, 1);
    const timestamps = getTimestampSeconds(data);
    let scanIndex = 0;
    let lagIndex = -1;
    let populated = 0;

    for (let i = 0; i < length; i++) {
        const ts = timestamps[i];
        if (ts === null) continue;

        const targetTs = ts - lagSec;
        while (scanIndex < i) {
            const candidateTs = timestamps[scanIndex];
            if (candidateTs === null) {
                scanIndex++;
                continue;
            }
            if (candidateTs <= targetTs) {
                lagIndex = scanIndex;
                scanIndex++;
                continue;
            }
            break;
        }

        if (lagIndex < 0) continue;
        const spotNow = pressure.spotYesProbability[i];
        const spotThen = pressure.spotYesProbability[lagIndex];
        const marketNow = pressure.marketYesProbability[i];
        const marketThen = pressure.marketYesProbability[lagIndex];
        const progressNow = pressure.eventProgress[i];
        const progressThen = pressure.eventProgress[lagIndex];
        if (
            spotNow === null
            || spotThen === null
            || marketNow === null
            || marketThen === null
            || progressNow === null
            || progressThen === null
            || progressThen > progressNow
        ) continue;

        const spotImpulse = spotNow - spotThen;
        const marketImpulse = marketNow - marketThen;
        const reactionGap = spotImpulse - marketImpulse;
        frame.spotImpulse[i] = spotImpulse;
        frame.marketImpulse[i] = marketImpulse;
        frame.reactionGap[i] = reactionGap;
        frame.longLagEdge[i] = Math.max(0, reactionGap);
        frame.shortLagEdge[i] = Math.max(0, -reactionGap);
        populated++;
    }

    frame.available = populated > 0;
    setCachedRuntimeFrame(reactionGapCache, runtime, data, cacheKey, frame);
    return frame;
}

/**
 * Marks bars whose CLOB quote state is tradable enough for helper-driven entries.
 */
export function buildPolymarket1sActionabilityMask(
    data: readonly OHLCVData[],
    context: ContextInput,
    options: Polymarket1sActionabilityOptions = {}
): Polymarket1sActionabilityFrame {
    const runtime = resolveRuntimeContext(context);
    const length = data.length;
    if (!runtime || runtime.quotes.length === 0 || length === 0) {
        return emptyActionabilityFrame(length);
    }

    const cacheKey = actionabilityOptionsKey(options);
    const cached = getCachedRuntimeFrame(actionabilityCache, runtime, data, cacheKey);
    if (cached) return cached;

    const edge = buildPolymarket1sExecutableEdge(data, runtime, options);
    const frame = emptyActionabilityFrame(length);
    const minEventProgress = clampFinite(options.minEventProgress, 0, 0, 1);
    const maxEventProgress = clampFinite(options.maxEventProgress, 1, 0, 1);
    const minSecondsRemaining = roundedAtLeast(options.minSecondsRemaining, 0, 0);
    const maxSecondsRemaining = Number.isFinite(Number(options.maxSecondsRemaining))
        ? roundedAtLeast(options.maxSecondsRemaining, 0, 0)
        : Infinity;
    let populated = 0;

    for (let i = 0; i < length; i++) {
        const quoteAge = edge.quoteAgeSec[i];
        const eventProgress = edge.eventProgress[i];
        const secondsRemaining = edge.secondsRemaining[i];
        if (quoteAge === null || eventProgress === null || secondsRemaining === null) {
            frame.reason[i] = "missing_quote";
            continue;
        }
        if (eventProgress < minEventProgress) {
            frame.reason[i] = "event_too_early";
            continue;
        }
        if (eventProgress > maxEventProgress) {
            frame.reason[i] = "event_too_late";
            continue;
        }
        if (secondsRemaining < minSecondsRemaining) {
            frame.reason[i] = "event_too_close";
            continue;
        }
        if (secondsRemaining > maxSecondsRemaining) {
            frame.reason[i] = "event_too_far";
            continue;
        }

        const yesActionable = edge.yesAskProbability[i] !== null;
        const noActionable = edge.noAskProbability[i] !== null;
        frame.yesActionable[i] = yesActionable;
        frame.noActionable[i] = noActionable;
        frame.actionable[i] = yesActionable || noActionable;
        frame.reason[i] = frame.actionable[i] ? null : "missing_quote";
        if (frame.actionable[i]) populated++;
    }

    frame.available = populated > 0;
    setCachedRuntimeFrame(actionabilityCache, runtime, data, cacheKey, frame);
    return frame;
}

/**
 * Converts noisy one-second executable edge arrays into side-specific persistence features.
 */
export function buildPolymarket1sEdgePersistence(
    edgeFrame: Polymarket1sExecutableEdgeFrame,
    options: Polymarket1sEdgePersistenceOptions = {}
): Polymarket1sEdgePersistenceFrame {
    const length = edgeFrame.buyYesEdge.length;
    const frame: Polymarket1sEdgePersistenceFrame = {
        yesEdgeEwma: new Array(length).fill(null),
        noEdgeEwma: new Array(length).fill(null),
        yesEdgeSeconds: new Array(length).fill(0),
        noEdgeSeconds: new Array(length).fill(0),
    };
    const minEdge = numberAtLeast(options.minEdge, 0, 0);
    const ewmaLookback = roundedAtLeast(options.ewmaLookback, 3, 1);
    const alpha = 2 / (ewmaLookback + 1);

    for (let i = 0; i < length; i++) {
        const prevProgress = i > 0 ? edgeFrame.eventProgress[i - 1] : null;
        const currentProgress = edgeFrame.eventProgress[i];
        const eventChanged = prevProgress !== null && currentProgress !== null && currentProgress < prevProgress;
        const yesEdge = edgeFrame.buyYesEdge[i];
        const noEdge = edgeFrame.buyNoEdge[i];
        const yesPositive = yesEdge === null ? null : Math.max(0, yesEdge);
        const noPositive = noEdge === null ? null : Math.max(0, noEdge);

        if (yesPositive !== null) {
            const prevEwma = eventChanged || i === 0 ? null : frame.yesEdgeEwma[i - 1];
            frame.yesEdgeEwma[i] = prevEwma === null ? yesPositive : alpha * yesPositive + (1 - alpha) * prevEwma;
            if (yesPositive > 0 && yesPositive >= minEdge) {
                frame.yesEdgeSeconds[i] = eventChanged ? 1 : (i > 0 ? frame.yesEdgeSeconds[i - 1] : 0) + 1;
            }
        }

        if (noPositive !== null) {
            const prevEwma = eventChanged || i === 0 ? null : frame.noEdgeEwma[i - 1];
            frame.noEdgeEwma[i] = prevEwma === null ? noPositive : alpha * noPositive + (1 - alpha) * prevEwma;
            if (noPositive > 0 && noPositive >= minEdge) {
                frame.noEdgeSeconds[i] = eventChanged ? 1 : (i > 0 ? frame.noEdgeSeconds[i - 1] : 0) + 1;
            }
        }
    }

    return frame;
}

/**
 * Uses Gamma as secondary agreement when both Binance pressure and Gamma point to the same CLOB mispricing.
 */
export function buildPolymarket1sGammaAgreement(
    data: readonly OHLCVData[],
    context: ContextInput,
    options: Polymarket1sGammaAgreementOptions = {}
): Polymarket1sGammaAgreementFrame {
    const runtime = resolveRuntimeContext(context);
    const length = data.length;
    const gammaSnapshots = runtime?.gammaSnapshots ?? EMPTY_GAMMA_SNAPSHOTS;
    if (!runtime || runtime.quotes.length === 0 || gammaSnapshots.length === 0 || length === 0) {
        return emptyGammaAgreementFrame(length);
    }

    const cacheKey = gammaAgreementOptionsKey(options);
    const cached = getCachedRuntimeFrame(gammaAgreementCache, runtime, data, cacheKey, true);
    if (cached) return cached;

    const pressure = buildPolymarket1sPressureGap(data, runtime, options);
    const frame = emptyGammaAgreementFrame(length);
    const gamma = sortedGammaSnapshots(runtime);
    const gammaState = { pointer: 0, latest: null as AlignedGamma | null };
    const timestamps = getTimestampSeconds(data);
    const maxGammaAgeSec = roundedAtLeast(options.maxGammaAgeSec, 60, 0);
    let populated = 0;

    for (let i = 0; i < length; i++) {
        const ts = timestamps[i];
        if (ts === null) continue;

        const alignedGamma = activeGammaAt(gamma, gammaState, ts, maxGammaAgeSec);
        const marketYes = pressure.marketYesProbability[i];
        const pressureGap = pressure.pressureGap[i];
        if (!alignedGamma || marketYes === null || pressureGap === null) continue;

        const gammaYesProbability = normalizeYesProbability(
            finiteNumber(alignedGamma.gamma.gamma_yes_price),
            finiteNumber(alignedGamma.gamma.gamma_no_price)
        );
        if (gammaYesProbability === null) continue;

        const gammaGap = gammaYesProbability - marketYes;
        frame.gammaYesProbability[i] = gammaYesProbability;
        frame.gammaGap[i] = gammaGap;
        frame.consensusLongEdge[i] = pressureGap > 0 && gammaGap > 0
            ? Math.min(pressureGap, gammaGap)
            : 0;
        frame.consensusShortEdge[i] = pressureGap < 0 && gammaGap < 0
            ? Math.min(-pressureGap, -gammaGap)
            : 0;
        populated++;
    }

    frame.available = populated > 0;
    setCachedRuntimeFrame(gammaAgreementCache, runtime, data, cacheKey, frame, true);
    return frame;
}

