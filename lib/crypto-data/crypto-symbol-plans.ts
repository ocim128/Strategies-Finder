import { DATA_CHART_TOTAL_LIMIT, SYNTHETIC_TARGET_BARS } from "../data/constants";
import { parsePortfolioSyntheticPairSymbol, PORTFOLIO_QUOTE_SUFFIXES } from "../portfolioLab/portfolio-lab-synthetic";
import { pickSourceInterval } from "../../scripts/lib/synthetic-pair";

/** Keep symbol parsing independent of browser-bound Crypto service imports. */
function ensureBinanceSymbol(token: string): string {
    const upper = token.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!upper) return "";
    if (PORTFOLIO_QUOTE_SUFFIXES.some((suffix) => upper.endsWith(suffix) && upper.length > suffix.length)) {
        return upper;
    }
    return `${upper}USDT`;
}

export function expandCryptoSymbols(raw: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const token of raw.split(/[\s,]+/)) {
        const trimmed = token.trim().toUpperCase();
        if (!trimmed) continue;
        const parsed = parsePortfolioSyntheticPairSymbol(trimmed);
        const legs = parsed ? [parsed.baseSymbol, parsed.quoteSymbol] : [ensureBinanceSymbol(trimmed)];
        for (const leg of legs) {
            const upper = leg.toUpperCase();
            if (upper && !seen.has(upper)) {
                seen.add(upper);
                out.push(upper);
            }
        }
    }
    return out;
}

export interface CryptoSyncRequestPlan {
    symbols: string[];
    interval: string;
    totalBars?: number;
}

/** Plan both target snapshots and finer seeds consumed by Batch/Finder miners. */
export function buildCryptoSyncRequestPlans(raw: string, targetInterval: string): CryptoSyncRequestPlan[] {
    const normalizedTarget = targetInterval.trim().toLowerCase() || "4h";
    const plans = new Map<string, { symbols: Set<string>; interval: string; totalBars?: number }>();

    const add = (symbol: string, interval: string, totalBars?: number): void => {
        const key = `${interval}|${totalBars ?? "default"}`;
        let plan = plans.get(key);
        if (!plan) {
            plan = { symbols: new Set<string>(), interval, ...(totalBars ? { totalBars } : {}) };
            plans.set(key, plan);
        }
        plan.symbols.add(symbol);
    };

    for (const token of raw.split(/[\s,]+/)) {
        const trimmed = token.trim().toUpperCase();
        if (!trimmed) continue;
        const pair = parsePortfolioSyntheticPairSymbol(trimmed);
        if (!pair) {
            const symbol = ensureBinanceSymbol(trimmed);
            if (symbol) add(symbol, normalizedTarget);
            continue;
        }

        const legs = [pair.baseSymbol.toUpperCase(), pair.quoteSymbol.toUpperCase()];
        for (const leg of legs) add(leg, normalizedTarget);

        const source = pickSourceInterval(normalizedTarget);
        if (source && source.sourceInterval !== normalizedTarget) {
            const totalBars = Math.min(SYNTHETIC_TARGET_BARS * source.ratio, DATA_CHART_TOTAL_LIMIT);
            for (const leg of legs) add(leg, source.sourceInterval, totalBars);
        }
    }

    return Array.from(plans.values(), (plan) => ({
        symbols: Array.from(plan.symbols),
        interval: plan.interval,
        ...(plan.totalBars ? { totalBars: plan.totalBars } : {}),
    }));
}
