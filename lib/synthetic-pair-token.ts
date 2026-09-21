/**
 * Pure synthetic-pair token parser, extracted from `lib/finder-manager.ts` so
 * server-side surfaces (the Batch Backtest Vite plugin / server data loader)
 * can parse synthetic tokens WITHOUT dragging in the browser-bound
 * `dataManager` / `uiManager` / `settingsManager` graph that `finder-manager`
 * transitively pulls in. That graph reaches `lightweight-charts` (an ESM-only
 * package), which fails to load when esbuild bundles `vite.config.ts` for the
 * Node dev server.
 *
 * Browser and server consumers import this leaf directly so the parser does
 * not pull browser-bound Finder state into the Vite config bundle.
 */

import { isIbkrSymbol, isMarkedLocalStockSymbol, markIbkrSymbol } from "./local-daily-datasets";

// Quote suffix list used by the batch/Finder synthetic-pair contract.
// (`lib/synthetic-pair-parser.ts` has its own
// shorter list — that's a pre-existing duplication, intentionally untouched
// here; do not "fix" it without auditing every synthetic-pair-parser caller.)
const QUOTE_SUFFIXES = ['USDT', 'BUSD', 'USDC', 'FDUSD', 'TUSD', 'BTC', 'ETH', 'BNB', 'EUR', 'TRY', 'BRL'];

/**
 * Resolve a bare token to its Binance symbol form by appending `USDT` when no
 * known quote suffix is present. Mirrors the private helper in
 * `lib/finder-manager.ts` exactly so server-side and browser-side batch
 * loading produce identical leg symbols.
 */
function resolveToBinanceSymbol(token: string): string {
    const upper = token.toUpperCase();
    if (QUOTE_SUFFIXES.some((s) => upper.endsWith(s) && upper.length > s.length)) {
        return upper;
    }
    return `${upper}USDT`;
}

/**
 * Preserve the provider namespace of a mixed local synthetic pair. A pair
 * such as `AAL•+AMAT` uses the IBKR marker on one leg and intentionally leaves
 * the shared bare stock ticker on the other; without this normalization the
 * parser turns the bare leg into `AMATUSDT` and sends it to Binance.
 * Explicit quote-suffixed market symbols remain unchanged.
 */
export function normalizeSyntheticPairProviderMarkers(symbol: string): string {
    const normalized = symbol.trim().toUpperCase();
    const plusIdx = normalized.indexOf("+");
    if (plusIdx < 1 || plusIdx === normalized.length - 1 || normalized.indexOf("+", plusIdx + 1) !== -1) {
        return normalized;
    }

    const base = normalized.slice(0, plusIdx).trim();
    const quote = normalized.slice(plusIdx + 1).trim();
    if (!isIbkrSymbol(base) && !isIbkrSymbol(quote)) return normalized;

    const normalizeLeg = (leg: string): string => {
        if (isMarkedLocalStockSymbol(leg)) return leg;
        if (QUOTE_SUFFIXES.some((suffix) => leg.endsWith(suffix) && leg.length > suffix.length)) return leg;
        return markIbkrSymbol(leg);
    };

    return `${normalizeLeg(base)}+${normalizeLeg(quote)}`;
}

/**
 * Parse a synthetic pair token of the form `BASE+QUOTE` (e.g. `ZEC+APT`,
 * `NVDA•+AAPL•`, `♦JPM+♦BAC`). Returns the marked-or-Binance-resolved leg
 * symbols, or `null` when the token is not a synthetic pair.
 *
 * Diamond-marked (♦) and bullet-marked (•) legs are offline stock / IBKR
 * tickers and must NOT be funneled through `resolveToBinanceSymbol`, which
 * would append `USDT` and strip the marker's provider-routing hint.
 */
export function parseSyntheticPairToken(symbol: string): { baseSymbol: string; quoteSymbol: string } | null {
    const plusIdx = symbol.indexOf("+");
    if (plusIdx < 1 || plusIdx === symbol.length - 1) return null;
    const baseRaw = symbol.slice(0, plusIdx).trim().toUpperCase();
    const quoteRaw = symbol.slice(plusIdx + 1).trim().toUpperCase();
    if (!baseRaw || !quoteRaw) return null;
    return {
        baseSymbol: isMarkedLocalStockSymbol(baseRaw) ? baseRaw : resolveToBinanceSymbol(baseRaw),
        quoteSymbol: isMarkedLocalStockSymbol(quoteRaw) ? quoteRaw : resolveToBinanceSymbol(quoteRaw),
    };
}
