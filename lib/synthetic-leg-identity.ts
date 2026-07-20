/**
 * Shared canonical identity for synthetic-pair legs — loader symbol, scoring
 * asset, provider kind, alias-collision key, and shared quote-suffix behavior.
 *
 * Pure leaf: only imports the marker helpers from `local-daily-datasets`.
 * No DOM, no `dataManager`, no `lightweight-charts` — safe to import from
 * the cjs-bundled vite config path AND the browser-side generator.
 *
 * The generator (balanced pair list) and the OPEN_SCORE artifact loader
 * already agree on leg symbols through `parseSyntheticPairToken`
 * (`lib/synthetic-pair-token.ts`) and `parsePortfolioSyntheticPairSymbol`
 * (`lib/portfolioLab/portfolio-lab-synthetic.ts`). Those parsers historically
 * each carried their own quote-suffix list. This leaf exposes the canonical
 * identity primitives the generator needs to:
 *   - canonicalize `BTC` and `BTCUSDT` to one loader symbol and one scoring
 *     asset (so the generator cannot emit both `BTC+ETH` and `BTCUSDT+ETH`
 *     as if they were different relationships);
 *   - reject cross-provider alias collisions loudly (`AAPL•` (IBKR) and
 *     `AAPL♦` (stock_market_data) score the same asset via different data
 *     sources; the generator must not silently pick one);
 *   - emit the exact token the Batch textarea / loader expects for a given
 *     provider (`AAPL♦`, `AAPL•`, `BTCUSDT`).
 *
 * The existing parsers are NOT modified here — they keep their public
 * results verbatim. The generator calls this leaf directly so generation,
 * loading, and scoring agree on identity.
 */

import {
    IBKR_SYMBOL_SUFFIX,
    STOCK_MARKET_SYMBOL_SUFFIX,
    isIbkrSymbol,
    isMarkedLocalStockSymbol,
    stripMarkedLocalStockSymbol,
} from "./local-daily-datasets";

// ---------------------------------------------------------------------------
// Quote suffixes
// ---------------------------------------------------------------------------

/**
 * Quote suffixes used to identify quote assets on Binance-style market
 * symbols. Matches the union of the lists in `synthetic-pair-token.ts`
 * (batch loader) and `portfolio-lab-synthetic.ts` so any token recognized
 * as quote-suffixed by EITHER existing parser is recognized here.
 *
 * Order matters: longer suffixes first so `USDC` cannot shadow `USD` and
 * `FDUSD` cannot shadow `USDT`-prefixed substrings. The longest-match-wins
 * scan in {@link stripKnownQuoteSuffix} enforces this.
 */
const SHARED_QUOTE_SUFFIXES = [
    "FDUSD",
    "USDT",
    "USDC",
    "BUSD",
    "TUSD",
    "USD",
    "BTC",
    "ETH",
    "BNB",
    "EUR",
    "TRY",
    "BRL",
] as const;

/** Sorted (longest-first) list of recognized quote suffixes. */
const QUOTE_SUFFIXES_BY_LEN: readonly string[] = [...SHARED_QUOTE_SUFFIXES].sort(
    (a, b) => b.length - a.length,
);

/** True iff `upper` ends with a known quote suffix AND has a base prefix. */
export function hasKnownQuoteSuffix(upper: string): boolean {
    for (const suffix of QUOTE_SUFFIXES_BY_LEN) {
        if (upper.length > suffix.length && upper.endsWith(suffix)) return true;
    }
    return false;
}

/** Strip the longest known quote suffix from `upper`; idempotent on bare assets. */
export function stripKnownQuoteSuffix(upper: string): string {
    for (const suffix of QUOTE_SUFFIXES_BY_LEN) {
        if (upper.length > suffix.length && upper.endsWith(suffix)) {
            return upper.slice(0, upper.length - suffix.length);
        }
    }
    return upper;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export type LegProvider = "market" | "ibkr" | "stock";

// ---------------------------------------------------------------------------
// Canonical identity
// ---------------------------------------------------------------------------

export interface CanonicalLegIdentity {
    /** Token to emit in the generated pair list (e.g. `BTCUSDT`, `AAPL♦`, `AAPL•`). */
    emittedToken: string;
    /** Symbol the data loader expects (e.g. `BTCUSDT`, `AAPL♦`, `AAPL•`). */
    loaderSymbol: string;
    /** Scoring asset identity (e.g. `BTC`, `AAPL`). */
    scoringAsset: string;
    /** Data provider that owns this leg. */
    provider: LegProvider;
}

export interface AliasCollision {
    scoringAsset: string;
    tokens: string[];
}

/**
 * Normalize a single asset token (one textarea line) into its canonical
 * identity. Returns `null` on a malformed token. Provider markers and
 * case/whitespace are normalized here so generation, loading, and scoring
 * see one identity per asset.
 *
 * Empty input, tokens containing `+`, malformed markers, and tokens that
 * strip to empty are rejected.
 */
export function canonicalizeLegIdentity(rawToken: string): CanonicalLegIdentity | null {
    const trimmed = String(rawToken ?? "").trim().toUpperCase();
    if (!trimmed) return null;
    if (trimmed.includes("+")) return null;

    // IBKR bullet marker (U+2022) and stock diamond marker (U+2666) route
    // the leg to non-Binance providers. The marker must be a SUFFIX; a
    // marker anywhere else (e.g. `♦AAPL`, `AA♦PL`) is malformed.
    if (isMarkedLocalStockSymbol(trimmed)) {
        const bare = stripMarkedLocalStockSymbol(trimmed);
        if (!bare) return null;
        // Reject marker in the middle of the token (the strip helper removes
        // a trailing marker; if the result still contains one, the input was
        // malformed).
        if (bare !== bare.replace(/\s+/, "")) return null;
        if (isIbkrSymbol(trimmed)) {
            // IBKR bullet marker preserved end-to-end.
            if (!trimmed.endsWith(IBKR_SYMBOL_SUFFIX)) return null;
            return {
                emittedToken: `${bare}${IBKR_SYMBOL_SUFFIX}`,
                loaderSymbol: `${bare}${IBKR_SYMBOL_SUFFIX}`,
                scoringAsset: bare,
                provider: "ibkr",
            };
        }
        // Stock diamond marker preserved end-to-end.
        if (!trimmed.endsWith(STOCK_MARKET_SYMBOL_SUFFIX)) return null;
        return {
            emittedToken: `${bare}${STOCK_MARKET_SYMBOL_SUFFIX}`,
            loaderSymbol: `${bare}${STOCK_MARKET_SYMBOL_SUFFIX}`,
            scoringAsset: bare,
            provider: "stock",
        };
    }

    // Reject stray marker characters that are NOT a proper suffix marker.
    if (trimmed.includes(IBKR_SYMBOL_SUFFIX) || trimmed.includes(STOCK_MARKET_SYMBOL_SUFFIX)) {
        return null;
    }

    // Binance / market path: if the token already ends with a known quote
    // suffix, keep it verbatim (loader symbol == emitted token). Otherwise
    // append `USDT` so the bare base asset resolves like the Batch loader.
    const loaderSymbol = hasKnownQuoteSuffix(trimmed) ? trimmed : `${trimmed}USDT`;
    const scoringAsset = stripKnownQuoteSuffix(loaderSymbol);
    if (!scoringAsset) return null;
    return {
        emittedToken: loaderSymbol,
        loaderSymbol,
        scoringAsset,
        provider: "market",
    };
}

/**
 * Group canonical identities by their alias-collision key. The collision key
 * is the SCORING ASSET alone — `BTC` and `BTCUSDT` collapse to one slot
 * (same provider), while stock `AAPL♦` and IBKR `AAPL•` collide ACROSS
 * providers (the generator fails loudly instead of picking a data source).
 *
 * Within one provider, two tokens mapping to the same scoring asset are
 * treated as the SAME canonical identity (the first-emitted token wins).
 * Across providers, the same scoring asset is a fatal collision.
 */
export function detectAliasCollisions(
    identities: ReadonlyArray<CanonicalLegIdentity>,
): AliasCollision[] {
    // Track (scoringAsset -> { providers: Set, tokens: [] })
    const byScoringAsset = new Map<string, { providers: Set<LegProvider>; tokens: string[] }>();
    for (const id of identities) {
        let entry = byScoringAsset.get(id.scoringAsset);
        if (!entry) {
            entry = { providers: new Set(), tokens: [] };
            byScoringAsset.set(id.scoringAsset, entry);
        }
        entry.providers.add(id.provider);
        if (!entry.tokens.includes(id.emittedToken)) entry.tokens.push(id.emittedToken);
    }
    const collisions: AliasCollision[] = [];
    for (const [scoringAsset, entry] of byScoringAsset) {
        if (entry.providers.size > 1) {
            collisions.push({ scoringAsset, tokens: entry.tokens });
        }
    }
    return collisions.sort((a, b) => a.scoringAsset.localeCompare(b.scoringAsset));
}

/**
 * Deduplicate within-provider alias identities so `BTC` and `BTCUSDT`
 * collapse to a single canonical asset. Across-provider collisions are
 * reported separately via {@link detectAliasCollisions}; the caller fails
 * loudly on those and does not call this dedup.
 *
 * Returns identities in their FIRST-appearance order so input ordering of
 * aliases stays observable in diagnostics.
 */
export function dedupeWithinProviderAliases(
    identities: ReadonlyArray<CanonicalLegIdentity>,
): CanonicalLegIdentity[] {
    const seen = new Set<string>();
    const out: CanonicalLegIdentity[] = [];
    for (const id of identities) {
        // Dedupe key: provider + scoringAsset. Two market tokens for BTC
        // (BTC, BTCUSDT) share this key and collapse to the first-seen token.
        const key = `${id.provider}|${id.scoringAsset}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(id);
    }
    return out;
}
