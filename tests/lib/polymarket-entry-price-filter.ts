export const DEFAULT_POLYMARKET_ENTRY_PRICE_FILTER_CENTS = 0;
export const MAX_POLYMARKET_ENTRY_PRICE_FILTER_CENTS = 49;

export function clampPolymarketEntryPriceFilterCents(value: unknown): number {
    const raw = typeof value === "number"
        ? value
        : typeof value === "string" && value.trim() !== ""
            ? Number(value)
            : Number.NaN;
    if (!Number.isFinite(raw)) {
        return DEFAULT_POLYMARKET_ENTRY_PRICE_FILTER_CENTS;
    }
    return Math.max(0, Math.min(MAX_POLYMARKET_ENTRY_PRICE_FILTER_CENTS, Math.round(raw)));
}

export function getPolymarketEntryPriceFilterBounds(value: unknown): {
    lower: number;
    upper: number;
} | null {
    const cents = clampPolymarketEntryPriceFilterCents(value);
    if (cents <= 0) {
        return null;
    }
    const lower = cents / 100;
    return {
        lower,
        upper: 1 - lower,
    };
}

export function isPolymarketEntryPriceFiltered(price: unknown, filterCents: unknown): boolean {
    const bounds = getPolymarketEntryPriceFilterBounds(filterCents);
    if (!bounds) {
        return false;
    }
    const numericPrice = typeof price === "number" ? price : Number(price);
    if (!Number.isFinite(numericPrice)) {
        return false;
    }
    return numericPrice <= bounds.lower || numericPrice >= bounds.upper;
}
