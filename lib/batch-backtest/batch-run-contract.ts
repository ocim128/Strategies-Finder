export interface BatchRunFingerprintInput {
    symbols: readonly string[];
    strategyKey: string;
    strategyParams: unknown;
    backtestSettings: unknown;
    capitalSettings: unknown;
    interval: string;
}

export function parseBatchSymbols(raw: string): string[] {
    return normalizeBatchSymbols(raw.split(/[\s,]+/));
}

export function normalizeBatchSymbols(value: unknown): string[] {
    const raw = Array.isArray(value) ? value : String(value ?? "").split(/[\s,]+/);
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of raw) {
        const text = String(item ?? "").trim().toUpperCase();
        if (!text) continue;
        if (seen.has(text)) continue;
        seen.add(text);
        out.push(text);
    }
    return out;
}

export function buildBatchRunFingerprint(args: BatchRunFingerprintInput): string {
    return JSON.stringify({
        symbols: args.symbols,
        strategyKey: args.strategyKey,
        strategyParams: args.strategyParams,
        backtestSettings: args.backtestSettings,
        capitalSettings: args.capitalSettings,
        interval: args.interval,
    });
}
