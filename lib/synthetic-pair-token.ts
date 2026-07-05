/**
 * Pure synthetic-pair token parser, extracted from `lib/finder-manager.ts` so
 * server-side surfaces (the Batch Backtest Vite plugin / server data loader)
 * can parse synthetic tokens WITHOUT dragging in the browser-bound
 * `dataManager` / `uiManager` / `settingsManager` graph that `finder-manager`
 * transitively pulls in. That graph reaches `lightweight-charts` (an ESM-only
 * package), which fails to load when esbuild bundles `vite.config.ts` for the
 * Node dev server.
 *
 * Browser-side consumers continue to import `parseSyntheticPairToken` from
 * `lib/finder-manager.ts` (re-exported there for backward compat). New
 * server-side consumers should import from here directly.
 */

import { isMarkedLocalStockSymbol } from "./local-daily-datasets";

// Quote suffix list verbatim from `lib/finder-manager.ts` so this leaf produces
// identical symbol resolution to the browser-side batch loader, which imports
// `parseSyntheticPairToken` from finder-manager. Keep in sync if you change
// either copy. (`lib/portfolioLab/portfolio-lab-synthetic.ts` has its own
// shorter list — that's a pre-existing duplication, intentionally untouched
// here; do not "fix" it without auditing every portfolio-lab caller.)
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
