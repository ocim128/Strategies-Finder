export type PolymarketSyncEventLike = {
    slug: string;
};

export type PolymarketSyncPlan<T extends PolymarketSyncEventLike> = {
    toFetch: T[];
    skippedExisting: number;
    missing: number;
    refreshedExisting: number;
};

export function planPolymarketEventSync<T extends PolymarketSyncEventLike>(
    events: T[],
    existingSlugs: ReadonlySet<string>,
    refreshRecentCount = 0
): PolymarketSyncPlan<T> {
    const normalizedRefreshRecent = Math.max(0, Math.floor(refreshRecentCount));
    const refreshStartIndex = Math.max(0, events.length - normalizedRefreshRecent);
    const forceRefreshSlugs = new Set(
        normalizedRefreshRecent > 0
            ? events.slice(refreshStartIndex).map((event) => event.slug)
            : []
    );

    const toFetch: T[] = [];
    let skippedExisting = 0;
    let missing = 0;
    let refreshedExisting = 0;

    for (const event of events) {
        const exists = existingSlugs.has(event.slug);
        const forceRefresh = forceRefreshSlugs.has(event.slug);
        if (!exists || forceRefresh) {
            toFetch.push(event);
            if (exists) {
                refreshedExisting += 1;
            } else {
                missing += 1;
            }
            continue;
        }
        skippedExisting += 1;
    }

    return {
        toFetch,
        skippedExisting,
        missing,
        refreshedExisting,
    };
}
