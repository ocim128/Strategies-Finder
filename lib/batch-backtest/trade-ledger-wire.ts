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
        },
    };
}
