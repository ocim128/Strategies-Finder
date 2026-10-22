/** Symbol-level execution contract. Omitted mode preserves legacy ratio results. */
export type SyntheticPairExecutionMode = 'equal_weight';

export function splitSyntheticPairMode(symbol: string): {
    pair: string;
    executionMode?: SyntheticPairExecutionMode;
} | null {
    const normalized = symbol.trim().toUpperCase();
    const at = normalized.indexOf('@');
    if (at < 0) return { pair: normalized };
    const suffix = normalized.slice(at);
    if (suffix !== '@' && suffix !== '@50/50') return null;
    return { pair: normalized.slice(0, at).trim(), executionMode: 'equal_weight' };
}

export function syntheticPairModeSuffix(mode?: SyntheticPairExecutionMode): string {
    return mode === 'equal_weight' ? '@50/50' : '';
}

/** Canonicalize the lazy suffix before list deduplication, retaining invalid input for validation. */
export function normalizeSyntheticPairExecutionSymbol(symbol: string): string {
    const mode = splitSyntheticPairMode(symbol);
    return mode?.pair.includes('+')
        ? mode.pair + syntheticPairModeSuffix(mode.executionMode)
        : symbol.trim().toUpperCase();
}
