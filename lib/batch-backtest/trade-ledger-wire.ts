/**
 * Wire contract for the Batch trade-ledger request field.
 *
 * Intentionally dependency-free: the browser-bound batch service imports the
 * body builder from here without pulling the ledger exporter's engine-side
 * graph into the lazy browser chunk. The exporter re-exports it so server-side
 * and test consumers have a single surface.
 */

export interface TradeLedgerRunOptions {
    enabled: boolean;
    folder: string;
    ledgerHorizons?: number[];
    /** Optional inclusive signal-time bounds, in unix seconds. */
    fromSec?: number | null;
    toSec?: number | null;
}

/** Parse the comma-separated horizons used by the Batch ledger control. */
export function parseTradeLedgerHorizons(raw: string): number[] {
    const parts = raw.split(",").map((part) => part.trim()).filter(Boolean);
    if (parts.length === 0) throw new Error("Trade ledger horizon bars must include at least one positive integer.");
    const horizons = parts.map((part) => Number(part));
    if (horizons.some((value) => !Number.isInteger(value) || value <= 0)) {
        throw new Error("Trade ledger horizon bars must be positive integers separated by commas.");
    }
    return [...new Set(horizons)].sort((left, right) => left - right);
}

/**
 * The request-body field the browser sends on /api/batch-backtest/run when the
 * ledger toggle is ON. Empty when OFF so default request bodies are unchanged.
 */
export function buildBatchRunLedgerBodyField(
    options: TradeLedgerRunOptions | null | undefined,
): Record<string, unknown> {
    if (!options || options.enabled !== true) return {};
    return {
        tradeLedger: {
            enabled: true,
            folder: options.folder,
            ...(options.ledgerHorizons ? { ledgerHorizons: options.ledgerHorizons } : {}),
            ...(options.fromSec !== undefined && options.fromSec !== null ? { fromSec: options.fromSec } : {}),
            ...(options.toSec !== undefined && options.toSec !== null ? { toSec: options.toSec } : {}),
        },
    };
}
