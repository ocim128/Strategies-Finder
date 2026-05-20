import { parseInputNumber } from "./dom-input-readers";
import { readNumber } from "./settings-parse-utils";

export const DEFAULT_POLYMARKET_BACKTEST_SLIPPAGE_CENTS = 5;

export function clampPolymarketBacktestSlippageCents(
    value: unknown,
    fallback = DEFAULT_POLYMARKET_BACKTEST_SLIPPAGE_CENTS
): number {
    const parsed = readNumber(value, fallback, { parseString: parseInputNumber });
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(0, Math.min(99, Math.round(parsed * 10) / 10));
}

export function resolvePolymarketBacktestSlippagePrice(
    value: unknown,
    fallback = DEFAULT_POLYMARKET_BACKTEST_SLIPPAGE_CENTS
): number {
    return clampPolymarketBacktestSlippageCents(value, fallback) / 100;
}

function clampPolymarketPrice(value: number): number {
    return Math.round(Math.min(1, Math.max(0, value)) * 1_000_000_000) / 1_000_000_000;
}

export function applyPolymarketBacktestEntrySlippage(
    price: number | null,
    slippageCents: unknown
): number | null {
    if (price === null || !Number.isFinite(price)) return null;
    const slippage = resolvePolymarketBacktestSlippagePrice(slippageCents, 0);
    return clampPolymarketPrice(price + slippage);
}

export function applyPolymarketBacktestExitSlippage(
    price: number | null,
    slippageCents: unknown
): number | null {
    if (price === null || !Number.isFinite(price)) return null;
    const slippage = resolvePolymarketBacktestSlippagePrice(slippageCents, 0);
    return clampPolymarketPrice(price - slippage);
}
