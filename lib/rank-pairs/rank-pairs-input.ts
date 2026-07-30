export interface PreparedRankPairRelationships {
    symbols: string[];
    reciprocalDuplicates: number;
    selfPairs: number;
}

/** Keep one orientation per relationship and discard meaningless A+A pairs. */
export function prepareRankPairRelationships(
    symbols: string[],
): PreparedRankPairRelationships {
    const seen = new Set<string>();
    const unique: string[] = [];
    let reciprocalDuplicates = 0;
    let selfPairs = 0;
    for (const symbol of symbols) {
        const plus = symbol.indexOf("+");
        const base = plus > 0 ? symbol.slice(0, plus).trim() : "";
        const quote = plus > 0 ? symbol.slice(plus + 1).trim() : "";
        if (base && quote && base.toUpperCase() === quote.toUpperCase()) {
            selfPairs += 1;
            continue;
        }
        const key = base && quote
            ? [base.toUpperCase(), quote.toUpperCase()].sort().join("+")
            : symbol.toUpperCase();
        if (seen.has(key)) {
            reciprocalDuplicates += 1;
            continue;
        }
        seen.add(key);
        unique.push(symbol);
    }
    return { symbols: unique, reciprocalDuplicates, selfPairs };
}
