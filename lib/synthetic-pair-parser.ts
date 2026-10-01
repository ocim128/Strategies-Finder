/**
 * Shared synthetic-pair parsing utilities, previously in
 * `lib/synthetic-pair-parser.ts`. Extracted here so
 * batch-backtest, crypto-data, and other non-Portfolio-Lab consumers
 * can import without pulling in the full synthetic-pair-parser module graph.
 */

import {
    isIbkrSymbol,
    stripIbkrMarker,
} from "./local-daily-datasets";
import { deriveSyntheticSymbol } from "../scripts/lib/synthetic-pair";

export const PORTFOLIO_QUOTE_SUFFIXES = ["USDT", "USDC", "USD", "BTC", "ETH", "BNB"] as const;

export interface ParsedSyntheticPairSymbol {
    baseAsset: string;
    quoteAsset: string;
    baseSymbol: string;
    quoteSymbol: string;
    syntheticSymbol: string;
}

export function stripKnownQuoteSuffix(symbol: string): string {
    const suffix = PORTFOLIO_QUOTE_SUFFIXES.find((candidate) => symbol.endsWith(candidate) && symbol.length > candidate.length);
    return suffix ? symbol.slice(0, -suffix.length) : symbol;
}

function resolveToBinanceSymbol(token: string): string {
    const upper = token.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!upper) {
        return "";
    }
    if (PORTFOLIO_QUOTE_SUFFIXES.some((suffix) => upper.endsWith(suffix) && upper.length > suffix.length)) {
        return upper;
    }
    return `${upper}USDT`;
}

export function parsePortfolioSyntheticPairSymbol(symbol: string): ParsedSyntheticPairSymbol | null {
    const normalized = symbol.trim().toUpperCase();
    const plusIdx = normalized.indexOf("+");
    if (plusIdx < 1 || plusIdx === normalized.length - 1 || normalized.indexOf("+", plusIdx + 1) !== -1) {
        return null;
    }

    const baseRaw = normalized.slice(0, plusIdx).trim();
    const quoteRaw = normalized.slice(plusIdx + 1).trim();
    if (![baseRaw, quoteRaw].every((leg) => /^[A-Z0-9._\u2022-]+$/.test(leg))) return null;
    const baseSymbol = isIbkrSymbol(baseRaw) ? baseRaw : resolveToBinanceSymbol(baseRaw);
    const quoteSymbol = isIbkrSymbol(quoteRaw) ? quoteRaw : resolveToBinanceSymbol(quoteRaw);
    if (!baseSymbol || !quoteSymbol || baseSymbol === quoteSymbol) {
        return null;
    }

    return {
        baseAsset: isIbkrSymbol(baseSymbol) ? stripIbkrMarker(baseSymbol) : stripKnownQuoteSuffix(baseSymbol),
        quoteAsset: isIbkrSymbol(quoteSymbol) ? stripIbkrMarker(quoteSymbol) : stripKnownQuoteSuffix(quoteSymbol),
        baseSymbol,
        quoteSymbol,
        syntheticSymbol: deriveSyntheticSymbol(baseSymbol, quoteSymbol),
    };
}
