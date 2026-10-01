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
 * (`lib/synthetic-pair-parser.ts`). Those parsers historically
 * each carried their own quote-suffix list. This leaf exposes the canonical
 * identity primitives the generator needs to:
 *   - canonicalize `BTC` and `BTCUSDT` to one loader symbol and one scoring
 *     asset (so the generator cannot emit both `BTC+ETH` and `BTCUSDT+ETH`
 *     as if they were different relationships);
 *   - reject cross-provider alias collisions loudly (`AAPL•` (IBKR) and
 *     `AAPLUSDT` (market) score the same asset via different data
 *     sources; the generator must not silently pick one);
 *   - emit the exact token the Batch textarea / loader expects for a given
 *     provider (`AAPLUSDT`, `AAPL•`, `BTCUSDT`).
 *
 * The existing parsers are NOT modified here — they keep their public
 * results verbatim. The generator calls this leaf directly so generation,
 * loading, and scoring agree on identity.
 */

import {
    IBKR_SYMBOL_SUFFIX,
    isIbkrSymbol,
    stripIbkrMarker,
} from "./local-daily-datasets";

// ---------------------------------------------------------------------------
// Quote suffixes
// ---------------------------------------------------------------------------

/**
 * Quote suffixes used to identify quote assets on Binance-style market
 * symbols. Matches the union of the lists in `synthetic-pair-token.ts`
 * (batch loader) and `synthetic-pair-parser.ts` so any token recognized
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

export type LegProvider = "market" | "ibkr";

// ---------------------------------------------------------------------------
// Canonical identity
// ---------------------------------------------------------------------------

export interface CanonicalLegIdentity {
    /** Token to emit in the generated pair list (e.g. `BTCUSDT`, `AAPLUSDT`, `AAPL•`). */
    emittedToken: string;
    /** Symbol the data loader expects (e.g. `BTCUSDT`, `AAPLUSDT`, `AAPL•`). */
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

    if (isIbkrSymbol(trimmed)) {
        const bare = stripIbkrMarker(trimmed);
        if (!bare || !/^[A-Z0-9._-]+$/.test(bare)) return null;
        return {
            emittedToken: `${bare}${IBKR_SYMBOL_SUFFIX}`,
            loaderSymbol: `${bare}${IBKR_SYMBOL_SUFFIX}`,
            scoringAsset: bare,
            provider: "ibkr",
        };
    }
    if (!/^[A-Z0-9._-]+$/.test(trimmed)) return null;

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
 * (same provider), while market `AAPLUSDT` and IBKR `AAPL•` collide ACROSS
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
