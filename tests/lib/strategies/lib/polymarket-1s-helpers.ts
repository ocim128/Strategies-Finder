import type {
    OHLCVData,
    Polymarket1sQuoteContextRow,
    Polymarket1sGammaContextRow,
    Polymarket1sRuntimeContext,
    StrategyExecutionContext,
} from "../../types/strategies";
import { parseTimeToUnixSeconds } from "../../time-normalization";
import { buildRollingStdDev } from "./price-action-statistics-core";

const DEFAULT_MAX_QUOTE_AGE_SEC = 2;
const DEFAULT_MAX_GAMMA_AGE_SEC = 60;
const DEFAULT_VOL_LOOKBACK = 45;
const DEFAULT_LAG_SEC = 3;
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

export interface Polymarket1sReactionGapOptions extends Polymarket1sPressureGapOptions {
    lagSec?: number;
}

export interface Polymarket1sReactionGapFrame {
    available: boolean;
    reactionGap: (number | null)[];
    longLagEdge: (number | null)[];
    shortLagEdge: (number | null)[];
    spotImpulse: (number | null)[];
    marketImpulse: (number | null)[];
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
    snapshotTs: number;
}

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

function emptyReactionGapFrame(length: number): Polymarket1sReactionGapFrame {
    return {
        available: false,
        reactionGap: new Array(length).fill(null),
        longLagEdge: new Array(length).fill(null),
        shortLagEdge: new Array(length).fill(null),
        spotImpulse: new Array(length).fill(null),
        marketImpulse: new Array(length).fill(null),
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
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function normalizeProbability(value: number | null): number | null {
    if (value === null || !Number.isFinite(value)) return null;
    return clamp(value, 0, 1);
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

function sortedQuotes(context: Polymarket1sRuntimeContext): AlignedQuote[] {
    return context.quotes
        .map((quote) => ({ quote, quoteTs: finiteNumber(quote.sample_ts) }))
        .filter((item): item is AlignedQuote => item.quoteTs !== null)
        .sort((left, right) => left.quoteTs - right.quoteTs);
}

function sortedGamma(context: Polymarket1sRuntimeContext): AlignedGamma[] {
    return (context.gammaSnapshots ?? [])
        .map((gamma) => ({ gamma, snapshotTs: finiteNumber(gamma.snapshot_ts) }))
        .filter((item): item is AlignedGamma => item.snapshotTs !== null)
        .sort((left, right) => left.snapshotTs - right.snapshotTs);
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
    while (pointerState.pointer < aligned.length && aligned[pointerState.pointer].snapshotTs <= targetTs) {
        pointerState.latest = aligned[pointerState.pointer];
        pointerState.pointer += 1;
    }

    const latest = pointerState.latest;
    if (!latest) return null;
    const gamma = latest.gamma;
    const ageSec = targetTs - latest.snapshotTs;
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
    eventStartTs: number
): number | null {
    const currentTs = parseTimeToUnixSeconds(data[index].time);
    if (currentTs === null) return null;
    if (currentTs === eventStartTs) return data[index].close;

    if (index === 0) return null;
    const previousTs = parseTimeToUnixSeconds(data[index - 1].time);
    if (previousTs === null) return null;
    if (previousTs === eventStartTs) return data[index - 1].close;
    if (previousTs < eventStartTs && currentTs > eventStartTs) return data[index].close;

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

    const frame = emptyPressureGapFrame(length);
    const quotes = sortedQuotes(runtime);
    const quoteState = { pointer: 0, latest: null as AlignedQuote | null };
    const logReturns = buildLogReturns(data);
    const volLookback = Math.max(5, Math.round(options.volLookback ?? DEFAULT_VOL_LOOKBACK));
    const rollingVol = buildRollingStdDev(logReturns, volLookback);
    const maxQuoteAgeSec = Math.max(0, Math.round(options.maxQuoteAgeSec ?? DEFAULT_MAX_QUOTE_AGE_SEC));
    const volFloor = Math.max(1e-9, Number(options.volFloor ?? DEFAULT_VOL_FLOOR));
    const eventOpenByKey = new Map<string, number>();
    let populated = 0;

    for (let i = 0; i < length; i++) {
        const ts = parseTimeToUnixSeconds(data[i].time);
        if (ts === null) continue;

        const alignedQuote = activeQuoteAt(quotes, quoteState, ts, maxQuoteAgeSec);
        if (!alignedQuote) continue;

        const quote = alignedQuote.quote;
        const key = eventKey(quote);
        if (!eventOpenByKey.has(key)) {
            const eventOpen = resolveEventOpenPrice(data, i, quote.event_start_ts);
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
    return frame;
}

/**
 * Measures whether Polymarket probability has reacted less than Binance-implied
 * probability over a short causal lag.
 */
export function buildPolymarket1sReactionGap(
    data: readonly OHLCVData[],
    context: ContextInput,
    options: Polymarket1sReactionGapOptions = {}
): Polymarket1sReactionGapFrame {
    const length = data.length;
    const pressure = buildPolymarket1sPressureGap(data, context, options);
    if (!pressure.available) {
        return emptyReactionGapFrame(length);
    }

    const frame = emptyReactionGapFrame(length);
    const lag = Math.max(1, Math.round(options.lagSec ?? DEFAULT_LAG_SEC));
    let populated = 0;

    for (let i = lag; i < length; i++) {
        const spotNow = pressure.spotYesProbability[i];
        const spotPrev = pressure.spotYesProbability[i - lag];
        const marketNow = pressure.marketYesProbability[i];
        const marketPrev = pressure.marketYesProbability[i - lag];
        if (spotNow === null || spotPrev === null || marketNow === null || marketPrev === null) {
            continue;
        }

        const spotImpulse = spotNow - spotPrev;
        const marketImpulse = marketNow - marketPrev;
        const reactionGap = spotImpulse - marketImpulse;

        frame.spotImpulse[i] = spotImpulse;
        frame.marketImpulse[i] = marketImpulse;
        frame.reactionGap[i] = reactionGap;
        frame.longLagEdge[i] = Math.max(0, reactionGap);
        frame.shortLagEdge[i] = Math.max(0, -reactionGap);
        populated++;
    }

    frame.available = populated > 0;
    return frame;
}

/**
 * Uses Gamma snapshots as agreement only. A positive consensus edge requires
 * Binance-implied pressure and Gamma-vs-CLOB pressure to point the same way.
 */
export function buildPolymarket1sGammaAgreement(
    data: readonly OHLCVData[],
    context: ContextInput,
    options: Polymarket1sGammaAgreementOptions = {}
): Polymarket1sGammaAgreementFrame {
    const runtime = resolveRuntimeContext(context);
    const length = data.length;
    if (!runtime || !runtime.gammaSnapshots || runtime.gammaSnapshots.length === 0 || length === 0) {
        return emptyGammaAgreementFrame(length);
    }

    const pressure = buildPolymarket1sPressureGap(data, runtime, options);
    if (!pressure.available) {
        return emptyGammaAgreementFrame(length);
    }

    const frame = emptyGammaAgreementFrame(length);
    const gammaRows = sortedGamma(runtime);
    const gammaState = { pointer: 0, latest: null as AlignedGamma | null };
    const maxGammaAgeSec = Math.max(0, Math.round(options.maxGammaAgeSec ?? DEFAULT_MAX_GAMMA_AGE_SEC));
    let populated = 0;

    for (let i = 0; i < length; i++) {
        const ts = parseTimeToUnixSeconds(data[i].time);
        if (ts === null) continue;

        const alignedGamma = activeGammaAt(gammaRows, gammaState, ts, maxGammaAgeSec);
        if (!alignedGamma) continue;

        const gamma = alignedGamma.gamma;
        const gammaYesProbability = normalizeYesProbability(
            finiteNumber(gamma.gamma_yes_price),
            finiteNumber(gamma.gamma_no_price)
        );
        const marketYesProbability = pressure.marketYesProbability[i];
        const pressureGap = pressure.pressureGap[i];
        if (gammaYesProbability === null || marketYesProbability === null || pressureGap === null) {
            continue;
        }

        const gammaGap = gammaYesProbability - marketYesProbability;
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
    return frame;
}
