import type {
    Binance1sCandleRow,
    PolymarketClob1sQuoteRow,
    PolymarketGammaSnapshotRow,
    PolymarketReference1sPriceRow,
    SecondDataQualityRunRow,
    SecondMarketSymbol,
} from "./types";
import { getClobQuoteTimeSec, getReferenceTimeSec } from "./alignment";

function countGaps(times: readonly number[], expectedStepSec: number): number {
    if (times.length < 2) return 0;
    const sorted = Array.from(new Set(times.filter(Number.isFinite))).sort((a, b) => a - b);
    let gaps = 0;
    for (let i = 1; i < sorted.length; i += 1) {
        if (sorted[i]! - sorted[i - 1]! > expectedStepSec) {
            gaps += 1;
        }
    }
    return gaps;
}

function maxAgeSec(valuesMs: readonly (number | null)[]): number | null {
    let max: number | null = null;
    for (const value of valuesMs) {
        if (value === null || value === undefined || !Number.isFinite(value)) continue;
        const sec = Math.ceil(Math.max(0, value) / 1000);
        max = max === null ? sec : Math.max(max, sec);
    }
    return max;
}

export function buildSecondDataQualityRun(args: {
    id: string;
    symbol: SecondMarketSymbol;
    startTs: number;
    endTs: number;
    binance: readonly Binance1sCandleRow[];
    clob: readonly PolymarketClob1sQuoteRow[];
    reference: readonly PolymarketReference1sPriceRow[];
    gamma: readonly PolymarketGammaSnapshotRow[];
    createdAt?: number;
}): SecondDataQualityRunRow {
    const startTs = Math.floor(args.startTs);
    const endTs = Math.floor(args.endTs);
    const expectedSeconds = Math.max(0, endTs - startTs + 1);
    const exactQuoteSeconds = new Set<number>();
    for (const quote of args.clob) {
        const quoteTs = getClobQuoteTimeSec(quote);
        if (quoteTs !== null && quoteTs === quote.sample_ts && quoteTs >= startTs && quoteTs <= endTs) {
            exactQuoteSeconds.add(quoteTs);
        }
    }

    return {
        id: args.id,
        symbol: args.symbol,
        start_ts: startTs,
        end_ts: endTs,
        binance_seconds: new Set(args.binance.map((row) => row.ts)).size,
        clob_quote_seconds: new Set(args.clob.map((row) => row.sample_ts)).size,
        reference_price_seconds: new Set(args.reference.map((row) => getReferenceTimeSec(row) ?? row.ts)).size,
        gamma_snapshot_count: args.gamma.length,
        binance_gap_count: countGaps(args.binance.map((row) => row.ts), 1),
        clob_gap_count: countGaps(args.clob.map((row) => row.sample_ts), 1),
        reference_gap_count: countGaps(args.reference.map((row) => getReferenceTimeSec(row) ?? row.ts), 1),
        exact_quote_coverage_pct: expectedSeconds > 0 ? (exactQuoteSeconds.size / expectedSeconds) * 100 : 0,
        max_quote_age_sec: maxAgeSec(args.clob.map((row) => row.quote_age_ms)),
        max_reference_age_sec: maxAgeSec(args.reference.map((row) =>
            row.received_ts_ms === null ? null : row.received_ts_ms - row.source_ts_ms
        )),
        created_at: args.createdAt ?? Math.floor(Date.now() / 1000),
    };
}

