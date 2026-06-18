import type { OHLCVData } from "../strategies";
import { deriveSyntheticSymbol } from "../../scripts/lib/synthetic-pair";
import type { SyntheticPairConnection } from "./portfolio-lab-types";

const QUOTE_SUFFIXES = ["USDT", "USDC", "USD", "BTC", "ETH", "BNB"] as const;

export interface ParsedSyntheticPairSymbol {
    baseAsset: string;
    quoteAsset: string;
    baseSymbol: string;
    quoteSymbol: string;
    syntheticSymbol: string;
}

function stripKnownQuoteSuffix(symbol: string): string {
    const suffix = QUOTE_SUFFIXES.find((candidate) => symbol.endsWith(candidate) && symbol.length > candidate.length);
    return suffix ? symbol.slice(0, -suffix.length) : symbol;
}

function resolveToBinanceSymbol(token: string): string {
    const upper = token.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!upper) {
        return "";
    }
    if (QUOTE_SUFFIXES.some((suffix) => upper.endsWith(suffix) && upper.length > suffix.length)) {
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

    const baseSymbol = resolveToBinanceSymbol(normalized.slice(0, plusIdx));
    const quoteSymbol = resolveToBinanceSymbol(normalized.slice(plusIdx + 1));
    if (!baseSymbol || !quoteSymbol || baseSymbol === quoteSymbol) {
        return null;
    }

    return {
        baseAsset: stripKnownQuoteSuffix(baseSymbol),
        quoteAsset: stripKnownQuoteSuffix(quoteSymbol),
        baseSymbol,
        quoteSymbol,
        syntheticSymbol: deriveSyntheticSymbol(baseSymbol, quoteSymbol),
    };
}

function closeMovePercent(data: OHLCVData[]): number | null {
    const first = data.find((bar) => Number.isFinite(bar.close) && bar.close > 0);
    let last: OHLCVData | undefined;
    for (let index = data.length - 1; index >= 0; index -= 1) {
        const bar = data[index];
        if (Number.isFinite(bar.close) && bar.close > 0) {
            last = bar;
            break;
        }
    }
    if (!first || !last || first === last) {
        return null;
    }
    return ((last.close / first.close) - 1) * 100;
}

export function buildSyntheticPairConnection(args: {
    parsed: ParsedSyntheticPairSymbol;
    ratioData: OHLCVData[];
    baseData: OHLCVData[];
    quoteData: OHLCVData[];
    alignedBars: number;
    droppedBars: number;
}): SyntheticPairConnection {
    return {
        baseAsset: args.parsed.baseAsset,
        quoteAsset: args.parsed.quoteAsset,
        baseSymbol: args.parsed.baseSymbol,
        quoteSymbol: args.parsed.quoteSymbol,
        syntheticSymbol: args.parsed.syntheticSymbol,
        baseMovePercent: closeMovePercent(args.baseData),
        quoteMovePercent: closeMovePercent(args.quoteData),
        ratioMovePercent: closeMovePercent(args.ratioData),
        alignedBars: args.alignedBars,
        droppedBars: args.droppedBars,
    };
}
