export async function mapWithConcurrencyLimit<T, R>(
    items: readonly T[],
    limit: number,
    worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
    if (items.length === 0) return [];

    const normalizedLimit = Number.isFinite(limit) ? Math.floor(limit) : 1;
    const workerCount = Math.max(1, Math.min(normalizedLimit, items.length));
    const results = new Array<R>(items.length);
    let nextIndex = 0;

    await Promise.all(Array.from({ length: workerCount }, async () => {
        while (nextIndex < items.length) {
            const index = nextIndex;
            nextIndex += 1;
            results[index] = await worker(items[index], index);
        }
    }));

    return results;
}
