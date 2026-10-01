import { stripIbkrMarker } from '../local-daily-datasets';
import type { IbkrIntervalMeta } from './ibkr-data-stream-types';

export type AlpacaPriceSettings = { feed: string; adjustment: string };
export type AlpacaRefreshReason = 'missing_adjustment_history' | 'price_settings_changed';
export type AlpacaRefreshCandidate = { symbol: string; reason: AlpacaRefreshReason };
export type AlpacaRefreshListResponse = {
    ok: boolean;
    interval: string;
    candidates: AlpacaRefreshCandidate[];
    error?: string;
};

/** The metadata-only part of the split-adjusted merge guard; no provider calls. */
export function getAlpacaMetadataRefreshReason(
    meta: IbkrIntervalMeta | undefined,
    settings: AlpacaPriceSettings,
): AlpacaRefreshReason | null {
    const adjustments = settings.adjustment.toLowerCase().split(',').map(part => part.trim());
    if (!adjustments.includes('split') && !adjustments.includes('all')) return null;
    if (!meta || (meta.source !== 'alpaca' && meta.source !== 'mixed')) return null;
    if (!meta.alpacaFeed || !meta.alpacaAdjustment || !meta.splitAdjustedThrough) return 'missing_adjustment_history';
    return meta.alpacaFeed !== settings.feed || meta.alpacaAdjustment !== settings.adjustment
        ? 'price_settings_changed' : null;
}

export function findAlpacaRefreshSymbols(
    entries: readonly { symbol: string; intervals: Partial<Record<string, IbkrIntervalMeta>> }[],
    interval: string,
    settings: AlpacaPriceSettings,
): AlpacaRefreshCandidate[] {
    const candidates = new Map<string, AlpacaRefreshCandidate>();
    for (const entry of entries) {
        const meta = entry.intervals[interval];
        if (!meta || !(meta.bars > 0)) continue;
        const symbol = stripIbkrMarker(entry.symbol);
        const reason = getAlpacaMetadataRefreshReason(meta, settings);
        if (symbol && reason) candidates.set(symbol, { symbol, reason });
    }
    return [...candidates.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
}
