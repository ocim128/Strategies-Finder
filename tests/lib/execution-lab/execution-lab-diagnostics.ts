import type { SecondMarketSymbol } from "../second-market/types";

const DIAGNOSTIC_EVENT_PHASE_SEC = 30;
const DIAGNOSTIC_INVERTED_SPREAD_HEALTH_PCT = 5;
const DIAGNOSTIC_NULL_QUOTE_HEALTH_PCT = 1;

export type ExecutionLabDiagnosticSample = {
    recordedAtIso: string;
    mode: "miner" | "paper" | "live";
    symbol: SecondMarketSymbol;
    marketType: "spot" | "futures";
    candle: {
        timeSec: number;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
        tradeCount: number | null;
        source: string | null;
        updatedAtIso: string | null;
    };
    feedLagSec: number | null;
    quote: {
        sampleTs: number;
        sampleMinusCandleSec: number;
        quoteAgeSec: number | null;
        source: string;
        sourceAgeSec: number | null;
        yesBid: number | null;
        yesAsk: number | null;
        yesMid: number | null;
        noBid: number | null;
        noAsk: number | null;
        noMid: number | null;
        qualityFlags: string[];
    } | null;
    event: {
        marketSlug: string;
        eventStartTs: number;
        eventEndTs: number;
        secondsToEnd: number;
        startClose: number | null;
        moveFromStart: number | null;
        moveFromStartPct: number | null;
    } | null;
    warnings: string[];
};

type ExecutionLabDiagnosticNumericAccumulator = {
    count: number;
    sum: number;
    min: number | null;
    max: number | null;
};

type ExecutionLabDiagnosticNumericSummary = {
    count: number;
    min: number | null;
    max: number | null;
    avg: number | null;
};

type ExecutionLabDiagnosticHealthIssue = {
    code: string;
    severity: "warning" | "critical";
    detail: string;
};

type ExecutionLabDiagnosticHealth = {
    status: "ok" | "warning" | "critical";
    issues: ExecutionLabDiagnosticHealthIssue[];
};

export type ExecutionLabDiagnosticAccumulator = {
    firstSampleAtIso: string | null;
    latestSampleAtIso: string | null;
    totalSamples: number;
    modeCounts: Record<string, number>;
    symbolCounts: Record<string, number>;
    marketTypeCounts: Record<string, number>;
    warningCounts: Record<string, number>;
    quoteSourceCounts: Record<string, number>;
    quoteQualityFlagCounts: Record<string, number>;
    candleSourceCounts: Record<string, number>;
    missingQuoteCount: number;
    invertedYesSpreadCount: number;
    invertedNoSpreadCount: number;
    feedLagSec: ExecutionLabDiagnosticNumericAccumulator;
    quoteAgeSec: ExecutionLabDiagnosticNumericAccumulator;
    quoteSourceAgeSec: ExecutionLabDiagnosticNumericAccumulator;
    quoteMinusCandleSec: ExecutionLabDiagnosticNumericAccumulator;
    quoteAbsMinusCandleSec: ExecutionLabDiagnosticNumericAccumulator;
    candleTradeCount: ExecutionLabDiagnosticNumericAccumulator;
    candleVolume: ExecutionLabDiagnosticNumericAccumulator;
    yesSpreadCents: ExecutionLabDiagnosticNumericAccumulator;
    noSpreadCents: ExecutionLabDiagnosticNumericAccumulator;
    eventSecondsToEnd: ExecutionLabDiagnosticNumericAccumulator;
    eventMoveFromStartPct: ExecutionLabDiagnosticNumericAccumulator;
};

type ExecutionLabDiagnosticSampleGroup = {
    key: string;
    samples: ExecutionLabDiagnosticSample[];
};

type ExecutionLabDiagnosticSegment = {
    firstRecordedAtIso: string;
    lastRecordedAtIso: string;
    count: number;
    mode: "miner" | "paper" | "live";
    symbol: SecondMarketSymbol;
    marketType: "spot" | "futures";
    candleFirstTimeSec: number;
    candleLastTimeSec: number;
    candleUniqueTimeCount: number;
    candleSourceCounts: Record<string, number>;
    closeMin: number | null;
    closeMax: number | null;
    closeAvg: number | null;
    zeroVolumePct: number | null;
    avgTradeCount: number | null;
    quoteCoveragePct: number | null;
    missingQuoteCount: number;
    quoteSourceCounts: Record<string, number>;
    quoteQualityFlagCounts: Record<string, number>;
    quoteAgeMinSec: number | null;
    quoteAgeMaxSec: number | null;
    quoteAgeAvgSec: number | null;
    quoteMinusCandleMinSec: number | null;
    quoteMinusCandleMaxSec: number | null;
    quoteMinusCandleAvgSec: number | null;
    yesMidMin: number | null;
    yesMidMax: number | null;
    yesMidAvg: number | null;
    noMidMin: number | null;
    noMidMax: number | null;
    noMidAvg: number | null;
    yesSpreadAvgCents: number | null;
    noSpreadAvgCents: number | null;
    latestQuoteSampleTs: number | null;
    latestQuoteAgeSec: number | null;
    latestYesBid: number | null;
    latestYesAsk: number | null;
    latestNoBid: number | null;
    latestNoAsk: number | null;
    eventSlug: string | null;
    eventStartTs: number | null;
    eventEndTs: number | null;
    secondsToEndMin: number | null;
    secondsToEndMax: number | null;
    secondsToEndAvg: number | null;
    moveFromStartPctMin: number | null;
    moveFromStartPctMax: number | null;
    moveFromStartPctAvg: number | null;
    warnings: string[];
    warningCounts: Record<string, number>;
    feedLagMinSec: number | null;
    feedLagMaxSec: number | null;
    feedLagAvgSec: number | null;
};

export type ExecutionLabDiagnostics = {
    schema: "execution_lab.price_alignment.v6";
    generatedAtIso: string;
    latest: ExecutionLabDiagnosticSample | null;
    segments: ExecutionLabDiagnosticSegment[];
    summary: {
        totalSamples: number;
        retainedSampleCount: number;
        retainedSampleLimit: number;
        exportedSegmentCount: number;
        segmentLimit: number;
        firstSampleAtIso: string | null;
        latestSampleAtIso: string | null;
        modeCounts: Record<string, number>;
        symbolCounts: Record<string, number>;
        marketTypeCounts: Record<string, number>;
        warningCounts: Record<string, number>;
        quoteSourceCounts: Record<string, number>;
        quoteQualityFlagCounts: Record<string, number>;
        candleSourceCounts: Record<string, number>;
        missingQuoteCount: number;
        quoteCoveragePct: number | null;
        missingQuotePct: number | null;
        fillCandlePct: number | null;
        repeatedCandlePct: number | null;
        zeroVolumeCandlePct: number | null;
        candleGapPct: number | null;
        feedLagWarningPct: number | null;
        invertedYesSpreadCount: number;
        invertedYesSpreadPct: number | null;
        invertedNoSpreadCount: number;
        invertedNoSpreadPct: number | null;
        health: ExecutionLabDiagnosticHealth;
        feedLagSec: ExecutionLabDiagnosticNumericSummary;
        quoteAgeSec: ExecutionLabDiagnosticNumericSummary;
        quoteSourceAgeSec: ExecutionLabDiagnosticNumericSummary;
        quoteMinusCandleSec: ExecutionLabDiagnosticNumericSummary;
        quoteAbsMinusCandleSec: ExecutionLabDiagnosticNumericSummary;
        candleTradeCount: ExecutionLabDiagnosticNumericSummary;
        candleVolume: ExecutionLabDiagnosticNumericSummary;
        yesSpreadCents: ExecutionLabDiagnosticNumericSummary;
        noSpreadCents: ExecutionLabDiagnosticNumericSummary;
        eventSecondsToEnd: ExecutionLabDiagnosticNumericSummary;
        eventMoveFromStartPct: ExecutionLabDiagnosticNumericSummary;
    };
};

type ExecutionLabDiagnosticBuildOptions = {
    retainedSampleLimit: number;
    segmentLimit: number;
    maxLiveCandleLagSec: number;
};

export function resolveExecutionLabCandleSequenceWarning(args: {
    currentTimeSec: number;
    previousTimeSec: number | null;
    currentHasNoTrades: boolean;
    currentIsFill: boolean;
}): "binance_repeated_candle" | "binance_candle_gap" | null {
    if (!args.currentHasNoTrades && !args.currentIsFill) return null;
    if (args.previousTimeSec === null) return null;
    const candleDeltaSec = args.currentTimeSec - args.previousTimeSec;
    if (candleDeltaSec === 0) return "binance_repeated_candle";
    if (candleDeltaSec > 1) return "binance_candle_gap";
    return null;
}

function createDiagnosticNumericAccumulator(): ExecutionLabDiagnosticNumericAccumulator {
    return { count: 0, sum: 0, min: null, max: null };
}

export function createExecutionLabDiagnosticAccumulator(): ExecutionLabDiagnosticAccumulator {
    return {
        firstSampleAtIso: null,
        latestSampleAtIso: null,
        totalSamples: 0,
        modeCounts: {},
        symbolCounts: {},
        marketTypeCounts: {},
        warningCounts: {},
        quoteSourceCounts: {},
        quoteQualityFlagCounts: {},
        candleSourceCounts: {},
        missingQuoteCount: 0,
        invertedYesSpreadCount: 0,
        invertedNoSpreadCount: 0,
        feedLagSec: createDiagnosticNumericAccumulator(),
        quoteAgeSec: createDiagnosticNumericAccumulator(),
        quoteSourceAgeSec: createDiagnosticNumericAccumulator(),
        quoteMinusCandleSec: createDiagnosticNumericAccumulator(),
        quoteAbsMinusCandleSec: createDiagnosticNumericAccumulator(),
        candleTradeCount: createDiagnosticNumericAccumulator(),
        candleVolume: createDiagnosticNumericAccumulator(),
        yesSpreadCents: createDiagnosticNumericAccumulator(),
        noSpreadCents: createDiagnosticNumericAccumulator(),
        eventSecondsToEnd: createDiagnosticNumericAccumulator(),
        eventMoveFromStartPct: createDiagnosticNumericAccumulator(),
    };
}

function incrementDiagnosticCount(counts: Record<string, number>, key: string | null | undefined): void {
    if (!key) return;
    counts[key] = (counts[key] ?? 0) + 1;
}

function copyDiagnosticCounts(counts: Record<string, number>): Record<string, number> {
    return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function recordDiagnosticNumber(stats: ExecutionLabDiagnosticNumericAccumulator, value: number | null | undefined): void {
    if (value === null || value === undefined || !Number.isFinite(value)) return;
    stats.count += 1;
    stats.sum += value;
    stats.min = stats.min === null ? value : Math.min(stats.min, value);
    stats.max = stats.max === null ? value : Math.max(stats.max, value);
}

function roundDiagnosticNumber(value: number | null): number | null {
    if (value === null || !Number.isFinite(value)) return null;
    const rounded = Number(value.toFixed(4));
    return Object.is(rounded, -0) ? 0 : rounded;
}

function summarizeDiagnosticNumber(stats: ExecutionLabDiagnosticNumericAccumulator): ExecutionLabDiagnosticNumericSummary {
    return {
        count: stats.count,
        min: roundDiagnosticNumber(stats.min),
        max: roundDiagnosticNumber(stats.max),
        avg: stats.count > 0 ? roundDiagnosticNumber(stats.sum / stats.count) : null,
    };
}

function diagnosticPct(count: number, total: number): number | null {
    if (total <= 0) return null;
    return roundDiagnosticNumber(count / total * 100);
}

function spreadCents(bid: number | null, ask: number | null): number | null {
    if (bid === null || ask === null || !Number.isFinite(bid) || !Number.isFinite(ask)) return null;
    return (ask - bid) * 100;
}

function diagnosticEventPhaseKey(sample: ExecutionLabDiagnosticSample): number | null {
    const secondsToEnd = sample.event?.secondsToEnd;
    if (secondsToEnd === null || secondsToEnd === undefined || !Number.isFinite(secondsToEnd)) return null;
    return Math.max(0, Math.floor(secondsToEnd / DIAGNOSTIC_EVENT_PHASE_SEC));
}

function diagnosticSegmentKey(sample: ExecutionLabDiagnosticSample): string {
    return JSON.stringify([
        sample.mode,
        sample.symbol,
        sample.marketType,
        sample.candle.source,
        sample.quote ? "quoted" : "missing_quote",
        sample.event?.marketSlug ?? null,
        sample.event?.eventStartTs ?? null,
        sample.event?.eventEndTs ?? null,
        diagnosticEventPhaseKey(sample),
        sample.warnings.join("|"),
    ]);
}

function groupDiagnosticSamples(samples: readonly ExecutionLabDiagnosticSample[]): ExecutionLabDiagnosticSampleGroup[] {
    const groups: ExecutionLabDiagnosticSampleGroup[] = [];
    for (const sample of samples) {
        const key = diagnosticSegmentKey(sample);
        const current = groups[groups.length - 1];
        if (current?.key === key) {
            current.samples.push(sample);
        } else {
            groups.push({ key, samples: [sample] });
        }
    }
    return groups;
}

function buildDiagnosticSegment(group: ExecutionLabDiagnosticSampleGroup): ExecutionLabDiagnosticSegment {
    const first = group.samples[0]!;
    const last = group.samples[group.samples.length - 1]!;
    const uniqueCandleTimes = new Set<number>();
    const feedLag = createDiagnosticNumericAccumulator();
    const candleClose = createDiagnosticNumericAccumulator();
    const candleTradeCount = createDiagnosticNumericAccumulator();
    const quoteAgeSec = createDiagnosticNumericAccumulator();
    const quoteMinusCandleSec = createDiagnosticNumericAccumulator();
    const yesMid = createDiagnosticNumericAccumulator();
    const noMid = createDiagnosticNumericAccumulator();
    const yesSpread = createDiagnosticNumericAccumulator();
    const noSpread = createDiagnosticNumericAccumulator();
    const eventSecondsToEnd = createDiagnosticNumericAccumulator();
    const eventMoveFromStartPct = createDiagnosticNumericAccumulator();
    const candleSourceCounts: Record<string, number> = {};
    const warningCounts: Record<string, number> = {};
    const quoteSourceCounts: Record<string, number> = {};
    const quoteQualityFlagCounts: Record<string, number> = {};
    let missingQuoteCount = 0;
    let zeroVolumeCount = 0;
    let latestQuote: ExecutionLabDiagnosticSample["quote"] = null;
    for (const sample of group.samples) {
        uniqueCandleTimes.add(sample.candle.timeSec);
        incrementDiagnosticCount(candleSourceCounts, sample.candle.source ?? "unknown");
        for (const warning of sample.warnings) {
            incrementDiagnosticCount(warningCounts, warning);
        }
        recordDiagnosticNumber(feedLag, sample.feedLagSec);
        recordDiagnosticNumber(candleClose, sample.candle.close);
        recordDiagnosticNumber(candleTradeCount, sample.candle.tradeCount);
        if (sample.candle.volume === 0) zeroVolumeCount += 1;
        recordDiagnosticNumber(eventSecondsToEnd, sample.event?.secondsToEnd);
        recordDiagnosticNumber(eventMoveFromStartPct, sample.event?.moveFromStartPct);
        if (!sample.quote) {
            missingQuoteCount += 1;
            continue;
        }
        latestQuote = sample.quote;
        incrementDiagnosticCount(quoteSourceCounts, sample.quote.source);
        for (const flag of sample.quote.qualityFlags) {
            incrementDiagnosticCount(quoteQualityFlagCounts, flag);
        }
        recordDiagnosticNumber(quoteAgeSec, sample.quote.quoteAgeSec);
        recordDiagnosticNumber(quoteMinusCandleSec, sample.quote.sampleMinusCandleSec);
        recordDiagnosticNumber(yesMid, sample.quote.yesMid);
        recordDiagnosticNumber(noMid, sample.quote.noMid);
        recordDiagnosticNumber(yesSpread, spreadCents(sample.quote.yesBid, sample.quote.yesAsk));
        recordDiagnosticNumber(noSpread, spreadCents(sample.quote.noBid, sample.quote.noAsk));
    }
    const close = summarizeDiagnosticNumber(candleClose);
    const tradeCount = summarizeDiagnosticNumber(candleTradeCount);
    const quoteAge = summarizeDiagnosticNumber(quoteAgeSec);
    const quoteMinusCandle = summarizeDiagnosticNumber(quoteMinusCandleSec);
    const yesMidSummary = summarizeDiagnosticNumber(yesMid);
    const noMidSummary = summarizeDiagnosticNumber(noMid);
    const yesSpreadSummary = summarizeDiagnosticNumber(yesSpread);
    const noSpreadSummary = summarizeDiagnosticNumber(noSpread);
    const secondsToEnd = summarizeDiagnosticNumber(eventSecondsToEnd);
    const moveFromStartPct = summarizeDiagnosticNumber(eventMoveFromStartPct);
    const feedLagSummary = summarizeDiagnosticNumber(feedLag);
    return {
        firstRecordedAtIso: first.recordedAtIso,
        lastRecordedAtIso: last.recordedAtIso,
        count: group.samples.length,
        mode: last.mode,
        symbol: last.symbol,
        marketType: last.marketType,
        candleFirstTimeSec: first.candle.timeSec,
        candleLastTimeSec: last.candle.timeSec,
        candleUniqueTimeCount: uniqueCandleTimes.size,
        candleSourceCounts: copyDiagnosticCounts(candleSourceCounts),
        closeMin: close.min,
        closeMax: close.max,
        closeAvg: close.avg,
        zeroVolumePct: diagnosticPct(zeroVolumeCount, group.samples.length),
        avgTradeCount: tradeCount.avg,
        quoteCoveragePct: diagnosticPct(group.samples.length - missingQuoteCount, group.samples.length),
        missingQuoteCount,
        quoteSourceCounts: copyDiagnosticCounts(quoteSourceCounts),
        quoteQualityFlagCounts: copyDiagnosticCounts(quoteQualityFlagCounts),
        quoteAgeMinSec: quoteAge.min,
        quoteAgeMaxSec: quoteAge.max,
        quoteAgeAvgSec: quoteAge.avg,
        quoteMinusCandleMinSec: quoteMinusCandle.min,
        quoteMinusCandleMaxSec: quoteMinusCandle.max,
        quoteMinusCandleAvgSec: quoteMinusCandle.avg,
        yesMidMin: yesMidSummary.min,
        yesMidMax: yesMidSummary.max,
        yesMidAvg: yesMidSummary.avg,
        noMidMin: noMidSummary.min,
        noMidMax: noMidSummary.max,
        noMidAvg: noMidSummary.avg,
        yesSpreadAvgCents: yesSpreadSummary.avg,
        noSpreadAvgCents: noSpreadSummary.avg,
        latestQuoteSampleTs: latestQuote?.sampleTs ?? null,
        latestQuoteAgeSec: latestQuote?.quoteAgeSec ?? null,
        latestYesBid: latestQuote?.yesBid ?? null,
        latestYesAsk: latestQuote?.yesAsk ?? null,
        latestNoBid: latestQuote?.noBid ?? null,
        latestNoAsk: latestQuote?.noAsk ?? null,
        eventSlug: last.event?.marketSlug ?? null,
        eventStartTs: last.event?.eventStartTs ?? null,
        eventEndTs: last.event?.eventEndTs ?? null,
        secondsToEndMin: secondsToEnd.min,
        secondsToEndMax: secondsToEnd.max,
        secondsToEndAvg: secondsToEnd.avg,
        moveFromStartPctMin: moveFromStartPct.min,
        moveFromStartPctMax: moveFromStartPct.max,
        moveFromStartPctAvg: moveFromStartPct.avg,
        warnings: last.warnings,
        warningCounts: copyDiagnosticCounts(warningCounts),
        feedLagMinSec: feedLagSummary.min,
        feedLagMaxSec: feedLagSummary.max,
        feedLagAvgSec: feedLagSummary.avg,
    };
}

function buildDiagnosticSegments(
    groups: readonly ExecutionLabDiagnosticSampleGroup[],
    segmentLimit: number
): ExecutionLabDiagnosticSegment[] {
    return groups
        .slice(-segmentLimit)
        .map((group) => buildDiagnosticSegment(group));
}

function buildDiagnosticHealth(
    latest: ExecutionLabDiagnosticSample | null,
    stats: ExecutionLabDiagnosticAccumulator,
    maxLiveCandleLagSec: number
): ExecutionLabDiagnosticHealth {
    const total = stats.totalSamples;
    const issues: ExecutionLabDiagnosticHealthIssue[] = [];
    const addIssue = (code: string, severity: ExecutionLabDiagnosticHealthIssue["severity"], detail: string) => {
        issues.push({ code, severity, detail });
    };

    const latestFeedLag = latest?.feedLagSec ?? null;
    if (latestFeedLag !== null && latestFeedLag > maxLiveCandleLagSec) {
        addIssue(
            "binance_feed_lag",
            latestFeedLag >= 30 ? "critical" : "warning",
            `latest Binance candle is ${latestFeedLag}s behind local time`
        );
    }
    const fillCount = stats.warningCounts.binance_fill_candle ?? 0;
    const repeatedCount = stats.warningCounts.binance_repeated_candle ?? 0;
    const zeroVolumeCount = stats.warningCounts.binance_zero_volume_candle ?? 0;
    const quotedSampleCount = Math.max(0, total - stats.missingQuoteCount);
    const missingQuotePct = diagnosticPct(stats.missingQuoteCount, total) ?? 0;
    const invertedYesSpreadPct = diagnosticPct(stats.invertedYesSpreadCount, quotedSampleCount) ?? 0;
    const invertedNoSpreadPct = diagnosticPct(stats.invertedNoSpreadCount, quotedSampleCount) ?? 0;
    const latestYesSpread = latest?.quote ? spreadCents(latest.quote.yesBid, latest.quote.yesAsk) : null;
    const latestNoSpread = latest?.quote ? spreadCents(latest.quote.noBid, latest.quote.noAsk) : null;
    if (total > 0 && fillCount === total) {
        addIssue("binance_fill_only", "critical", "all diagnostics use fill-derived Binance candles");
    } else if ((diagnosticPct(fillCount, total) ?? 0) >= 50) {
        addIssue("binance_fill_heavy", "warning", `${fillCount}/${total} diagnostics use fill-derived Binance candles`);
    }
    if ((diagnosticPct(repeatedCount, total) ?? 0) >= 50) {
        addIssue("binance_repeated_candle", "warning", `${repeatedCount}/${total} diagnostics repeated the previous Binance candle`);
    }
    if (total > 0 && zeroVolumeCount === total) {
        addIssue("binance_zero_volume_only", "critical", "all diagnostics have zero Binance candle volume");
    }
    if (latest && !latest.quote) {
        addIssue("missing_latest_polymarket_quote", "warning", "latest diagnostic has no active CLOB quote");
    }
    if (missingQuotePct >= 25) {
        addIssue("polymarket_quote_gaps", missingQuotePct >= 50 ? "critical" : "warning", `${missingQuotePct}% of diagnostics missed a CLOB quote`);
    }
    if (latestYesSpread !== null && latestYesSpread < 0) {
        addIssue("inverted_yes_spread", "warning", "latest YES quote had bid greater than ask");
    } else if (invertedYesSpreadPct >= DIAGNOSTIC_INVERTED_SPREAD_HEALTH_PCT) {
        addIssue("inverted_yes_spread", "warning", `${stats.invertedYesSpreadCount} YES quotes had bid greater than ask`);
    }
    if (latestNoSpread !== null && latestNoSpread < 0) {
        addIssue("inverted_no_spread", "warning", "latest NO quote had bid greater than ask");
    } else if (invertedNoSpreadPct >= DIAGNOSTIC_INVERTED_SPREAD_HEALTH_PCT) {
        addIssue("inverted_no_spread", "warning", `${stats.invertedNoSpreadCount} NO quotes had bid greater than ask`);
    }

    const nullYesBidAskCount = stats.quoteQualityFlagCounts.missing_yes_bid_ask ?? 0;
    const nullNoBidAskCount = stats.quoteQualityFlagCounts.missing_no_bid_ask ?? 0;
    const nullQuotePct = diagnosticPct(Math.max(nullYesBidAskCount, nullNoBidAskCount), quotedSampleCount) ?? 0;
    if (nullQuotePct >= DIAGNOSTIC_NULL_QUOTE_HEALTH_PCT) {
        addIssue("null_bid_ask_quotes", nullQuotePct >= 5 ? "critical" : "warning", `${nullQuotePct}% of CLOB quotes had null bid/ask`);
    }

    const status = issues.some((issue) => issue.severity === "critical")
        ? "critical"
        : issues.length > 0 ? "warning" : "ok";
    return { status, issues };
}

export function recordExecutionLabDiagnosticStats(
    stats: ExecutionLabDiagnosticAccumulator,
    sample: ExecutionLabDiagnosticSample
): void {
    if (stats.totalSamples === 0) {
        stats.firstSampleAtIso = sample.recordedAtIso;
    }
    stats.latestSampleAtIso = sample.recordedAtIso;
    stats.totalSamples += 1;
    incrementDiagnosticCount(stats.modeCounts, sample.mode);
    incrementDiagnosticCount(stats.symbolCounts, sample.symbol);
    incrementDiagnosticCount(stats.marketTypeCounts, sample.marketType);
    incrementDiagnosticCount(stats.candleSourceCounts, sample.candle.source ?? "unknown");
    for (const warning of sample.warnings) {
        incrementDiagnosticCount(stats.warningCounts, warning);
    }
    if (!sample.quote) {
        stats.missingQuoteCount += 1;
    } else {
        incrementDiagnosticCount(stats.quoteSourceCounts, sample.quote.source);
        for (const flag of sample.quote.qualityFlags) {
            incrementDiagnosticCount(stats.quoteQualityFlagCounts, flag);
        }
        recordDiagnosticNumber(stats.quoteAgeSec, sample.quote.quoteAgeSec);
        recordDiagnosticNumber(stats.quoteSourceAgeSec, sample.quote.sourceAgeSec);
        recordDiagnosticNumber(stats.quoteMinusCandleSec, sample.quote.sampleMinusCandleSec);
        recordDiagnosticNumber(stats.quoteAbsMinusCandleSec, Math.abs(sample.quote.sampleMinusCandleSec));
        const yesSpread = spreadCents(sample.quote.yesBid, sample.quote.yesAsk);
        const noSpread = spreadCents(sample.quote.noBid, sample.quote.noAsk);
        if (yesSpread !== null && yesSpread < 0) stats.invertedYesSpreadCount += 1;
        if (noSpread !== null && noSpread < 0) stats.invertedNoSpreadCount += 1;
        recordDiagnosticNumber(stats.yesSpreadCents, yesSpread);
        recordDiagnosticNumber(stats.noSpreadCents, noSpread);
    }
    recordDiagnosticNumber(stats.feedLagSec, sample.feedLagSec);
    recordDiagnosticNumber(stats.candleTradeCount, sample.candle.tradeCount);
    recordDiagnosticNumber(stats.candleVolume, sample.candle.volume);
    recordDiagnosticNumber(stats.eventSecondsToEnd, sample.event?.secondsToEnd);
    recordDiagnosticNumber(stats.eventMoveFromStartPct, sample.event?.moveFromStartPct);
}

export function buildExecutionLabDiagnostics(
    samples: readonly ExecutionLabDiagnosticSample[],
    stats: ExecutionLabDiagnosticAccumulator,
    options: ExecutionLabDiagnosticBuildOptions
): ExecutionLabDiagnostics | null {
    if (samples.length === 0) return null;
    const sampleGroups = groupDiagnosticSamples(samples);
    const segments = buildDiagnosticSegments(sampleGroups, options.segmentLimit);
    const totalSamples = stats.totalSamples;
    const feedLagWarningCount = stats.warningCounts.binance_feed_lag ?? 0;
    const fillCandleCount = stats.warningCounts.binance_fill_candle ?? 0;
    const repeatedCandleCount = stats.warningCounts.binance_repeated_candle ?? 0;
    const zeroVolumeCandleCount = stats.warningCounts.binance_zero_volume_candle ?? 0;
    const candleGapCount = stats.warningCounts.binance_candle_gap ?? 0;
    const quotedSampleCount = Math.max(0, totalSamples - stats.missingQuoteCount);
    const latest = samples[samples.length - 1] ?? null;
    return {
        schema: "execution_lab.price_alignment.v6",
        generatedAtIso: new Date().toISOString(),
        latest,
        segments,
        summary: {
            totalSamples,
            retainedSampleCount: samples.length,
            retainedSampleLimit: options.retainedSampleLimit,
            exportedSegmentCount: segments.length,
            segmentLimit: options.segmentLimit,
            firstSampleAtIso: stats.firstSampleAtIso,
            latestSampleAtIso: stats.latestSampleAtIso,
            modeCounts: copyDiagnosticCounts(stats.modeCounts),
            symbolCounts: copyDiagnosticCounts(stats.symbolCounts),
            marketTypeCounts: copyDiagnosticCounts(stats.marketTypeCounts),
            warningCounts: copyDiagnosticCounts(stats.warningCounts),
            quoteSourceCounts: copyDiagnosticCounts(stats.quoteSourceCounts),
            quoteQualityFlagCounts: copyDiagnosticCounts(stats.quoteQualityFlagCounts),
            candleSourceCounts: copyDiagnosticCounts(stats.candleSourceCounts),
            missingQuoteCount: stats.missingQuoteCount,
            quoteCoveragePct: diagnosticPct(quotedSampleCount, totalSamples),
            missingQuotePct: diagnosticPct(stats.missingQuoteCount, totalSamples),
            fillCandlePct: diagnosticPct(fillCandleCount, totalSamples),
            repeatedCandlePct: diagnosticPct(repeatedCandleCount, totalSamples),
            zeroVolumeCandlePct: diagnosticPct(zeroVolumeCandleCount, totalSamples),
            candleGapPct: diagnosticPct(candleGapCount, totalSamples),
            feedLagWarningPct: diagnosticPct(feedLagWarningCount, totalSamples),
            invertedYesSpreadCount: stats.invertedYesSpreadCount,
            invertedYesSpreadPct: diagnosticPct(stats.invertedYesSpreadCount, quotedSampleCount),
            invertedNoSpreadCount: stats.invertedNoSpreadCount,
            invertedNoSpreadPct: diagnosticPct(stats.invertedNoSpreadCount, quotedSampleCount),
            health: buildDiagnosticHealth(latest, stats, options.maxLiveCandleLagSec),
            feedLagSec: summarizeDiagnosticNumber(stats.feedLagSec),
            quoteAgeSec: summarizeDiagnosticNumber(stats.quoteAgeSec),
            quoteSourceAgeSec: summarizeDiagnosticNumber(stats.quoteSourceAgeSec),
            quoteMinusCandleSec: summarizeDiagnosticNumber(stats.quoteMinusCandleSec),
            quoteAbsMinusCandleSec: summarizeDiagnosticNumber(stats.quoteAbsMinusCandleSec),
            candleTradeCount: summarizeDiagnosticNumber(stats.candleTradeCount),
            candleVolume: summarizeDiagnosticNumber(stats.candleVolume),
            yesSpreadCents: summarizeDiagnosticNumber(stats.yesSpreadCents),
            noSpreadCents: summarizeDiagnosticNumber(stats.noSpreadCents),
            eventSecondsToEnd: summarizeDiagnosticNumber(stats.eventSecondsToEnd),
            eventMoveFromStartPct: summarizeDiagnosticNumber(stats.eventMoveFromStartPct),
        },
    };
}
