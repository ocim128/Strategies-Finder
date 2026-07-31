/**
 * Batch symbol-list templates — newline-delimited pair strings keyed by
 * market regime. The data lives in the adjacent `batch-symbol-templates.json`
 * and is inlined here via Vite's `?raw` (the same asset-query pattern used
 * across `lib/layout-manager.ts` for HTML partials). The JSON string is
 * parsed once at module load; this module is only reachable through
 * `batch-backtest-service.ts`, which is itself a lazy-loaded feature chunk,
 * so the ~13 KB blob never lands in the cold-start bundle.
 */

import templatesJson from "./batch-symbol-templates.json?raw";

const BATCH_SYMBOL_TEMPLATES = JSON.parse(templatesJson) as {
    uptrend_crypto: string;
    chop_crypto: string;
    downtrend: string;
};

export type BatchSymbolTemplateKey = keyof typeof BATCH_SYMBOL_TEMPLATES;

/**
 * Look up a template by key. Returns the newline-delimited pair string.
 */
export function getBatchSymbolTemplate(key: BatchSymbolTemplateKey): string {
    return BATCH_SYMBOL_TEMPLATES[key];
}
