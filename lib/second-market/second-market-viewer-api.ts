export type SecondMarketViewerSymbol = "BTCUSDT" | "XRPUSDT";

export type SecondMarketViewerCandle = {
    symbol: string;
    market_type: string;
    ts: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    trade_count: number | null;
    updated_at: number;
};

export type SecondMarketViewerClobQuote = {
    series_id: string;
    symbol: string;
    outcome_interval: string;
    event_start_ts: number;
    event_end_ts: number;
    market_slug: string;
    sample_ts: number;
    yes_bid: number | null;
    yes_ask: number | null;
    yes_mid: number | null;
    yes_last: number | null;
    no_bid: number | null;
    no_ask: number | null;
    no_mid: number | null;
    no_last: number | null;
    source_ts_ms: number | null;
    quote_age_ms: number | null;
    quality_flags: string;
    updated_at: number;
};

export type SecondMarketViewerReferencePrice = {
    symbol: string;
    reference_source: string;
    source_symbol: string;
    ts: number;
    source_ts_ms: number;
    received_ts_ms: number | null;
    reference_price: number;
    is_carried_forward: number;
    quality_flags: string;
    updated_at: number;
};

export type SecondMarketViewerGammaSnapshot = {
    series_id: string;
    symbol: string;
    outcome_interval: string;
    market_id: string;
    market_slug: string;
    event_start_ts: number;
    event_end_ts: number;
    snapshot_ts: number;
    gamma_yes_price: number | null;
    gamma_no_price: number | null;
    last_trade_price: number | null;
    liquidity: number | null;
    volume: number | null;
    open_interest: number | null;
    active: number;
    closed: number;
    updated_at: number;
};

export type SecondMarketViewerStats = {
    binanceSeconds: number;
    clobSeconds: number;
    referenceSeconds: number;
    gammaSnapshots: number;
    missingBinanceSeconds: number;
    missingClobSeconds: number;
    missingReferenceSeconds: number;
    overlapStartTs: number | null;
    overlapEndTs: number | null;
    overlapSeconds: number;
    exactSampleCoveragePct: number;
    maxQuoteAgeSec: number | null;
    latestDataTs: number | null;
    latestLagSec: number | null;
    activeMarketSlug: string | null;
    activeEventStartTs: number | null;
    activeEventEndTs: number | null;
};

export type SecondMarketViewerWindow = {
    ok: true;
    dbPath: string;
    symbol: SecondMarketViewerSymbol;
    marketType: "spot" | "futures";
    referenceSource: string;
    startTs: number;
    endTs: number;
    candles: SecondMarketViewerCandle[];
    clobQuotes: SecondMarketViewerClobQuote[];
    referencePrices: SecondMarketViewerReferencePrice[];
    gammaSnapshots: SecondMarketViewerGammaSnapshot[];
    stats: SecondMarketViewerStats;
};

type SecondMarketViewerError = {
    ok: false;
    error?: string;
};

export async function loadSecondMarketViewerWindow(args: {
    symbol: SecondMarketViewerSymbol;
    windowSec: number;
    endTs?: number;
}): Promise<SecondMarketViewerWindow> {
    const params = new URLSearchParams({
        symbol: args.symbol,
        windowSec: String(Math.max(60, Math.floor(args.windowSec))),
    });
    if (Number.isFinite(args.endTs)) {
        params.set("endTs", String(Math.floor(args.endTs!)));
    }

    const response = await fetch(`/api/second-market/window?${params.toString()}`, {
        method: "GET",
    });
    const payload = await response.json().catch(() => ({})) as SecondMarketViewerWindow | SecondMarketViewerError;
    if (!response.ok || !payload.ok) {
        throw new Error((payload as SecondMarketViewerError).error ?? `Second-market window failed (${response.status})`);
    }
    return payload;
}
