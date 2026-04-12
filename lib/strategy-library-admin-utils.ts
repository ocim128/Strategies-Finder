export function parseStrategyLibraryBulkEntries(rawValue: string): string[] {
    const segments = rawValue
        .split(/[\r\n,;]+/)
        .map((value) => value.trim())
        .filter((value) => value.length > 0);

    const seen = new Set<string>();
    const keys: string[] = [];
    for (const key of segments) {
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        keys.push(key);
    }

    return keys;
}
