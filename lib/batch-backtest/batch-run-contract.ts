import type { PairListProvenanceV1 } from "./balanced-pair-list-generator";
import type { MaxActiveResearchRegistrationV1 } from "./max-active-research-contract";

export interface BatchRunFingerprintInput {
    symbols: readonly string[];
    strategyKey: string;
    strategyParams: unknown;
    backtestSettings: unknown;
    capitalSettings: unknown;
    interval: string;
    /**
     * Optional verified pair-list provenance attached to the run only while
     * the current pair-textarea digest matches `provenance.emittedPairListHash`.
     * The fingerprint INCLUDES the provenance so a manual textarea edit
     * (which clears the provenance in the service) changes the fingerprint
     * and invalidates retained artifacts. The optional research registration
     * is NOT included here — the registration's expected fingerprint is
     * computed WITHOUT the registration itself to avoid a recursive hash.
     */
    pairListProvenance?: PairListProvenanceV1 | null;
    /** Selected server-side Trade Gate folder/rule ids. */
    tradeGate?: unknown;
}

/** Shared intake and snapshot ceiling for one Batch run. */
export const BATCH_MAX_SYMBOLS = 2_000;
export const BATCH_MAX_SYMBOL_LENGTH = 128;

/**
 * Batch symbols eventually participate in server-side cache paths and local
 * data lookups. Keep the existing permissive symbol grammar, but reject path
 * syntax and control characters at the server boundary.
 */
export function validateBatchSymbolToken(symbol: string): string | null {
    if (!symbol || symbol.length > BATCH_MAX_SYMBOL_LENGTH) {
        return `symbol must be 1-${BATCH_MAX_SYMBOL_LENGTH} characters`;
    }
    if (/[\/\\:\u0000-\u001f\u007f]/.test(symbol) || symbol.includes("..")) {
        return "symbol contains a forbidden path/control sequence";
    }
    return null;
}

export function validateBatchSymbols(symbols: readonly string[]): string | null {
    for (const symbol of symbols) {
        const error = validateBatchSymbolToken(symbol);
        if (error) return `${symbol}: ${error}`;
    }
    return null;
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

/**
 * Build the Batch run fingerprint. The fingerprint is a JSON digest over the
 * canonical inputs and (optionally) the pair-list provenance. Including the
 * provenance here means a manual textarea edit (which clears the provenance
 * in the service) changes the fingerprint and invalidates retained artifacts
 * — preserving the "rerun Batch after any change" contract.
 *
 * The optional research registration is intentionally NOT part of the
 * fingerprint so the registration's `expectedBatchFingerprint` can be
 * computed without recursing on itself.
 */
export function buildBatchRunFingerprint(args: BatchRunFingerprintInput): string {
    return JSON.stringify({
        symbols: args.symbols,
        strategyKey: args.strategyKey,
        strategyParams: args.strategyParams,
        backtestSettings: args.backtestSettings,
        capitalSettings: args.capitalSettings,
        interval: args.interval,
        ...(args.tradeGate ? { tradeGate: args.tradeGate } : {}),
        ...(args.pairListProvenance ? { pairListProvenance: args.pairListProvenance } : {}),
    });
}

/**
 * Verify a pair-list provenance against the canonical submitted symbols.
 * Returns `null` if the provenance is valid, or a short reason string when
 * the textarea digest does not match the recorded hash, the schema/algorithm
 * is unknown, or the input is malformed. A failed verification MUST be
 * retained as `manual/unverified` metadata, never trusted.
 */
export function verifyPairListProvenance(
    provenance: PairListProvenanceV1 | null | undefined,
    submittedSymbols: readonly string[],
    fnv1a64Hex: (text: string) => string,
): { ok: true } | { ok: false; reason: string } {
    if (!provenance) return { ok: false, reason: "missing" };
    if (provenance.schema !== "batch.pair_list.v1") return { ok: false, reason: `unknown schema: ${provenance.schema}` };
    if (provenance.algorithm !== "seeded_round_robin_v1") return { ok: false, reason: `unknown algorithm: ${provenance.algorithm}` };
    if (!Array.isArray(submittedSymbols)) return { ok: false, reason: "submittedSymbols not an array" };
    // Recompute the emitted-list hash with the same normalization the
    // generator used (parseBatchSymbols dedupes + uppercases + trims).
    const normalized = normalizeBatchSymbols(submittedSymbols.join("\n"));
    const recomputed = fnv1a64Hex(normalized.join("\n"));
    if (recomputed !== provenance.emittedPairListHash) {
        return { ok: false, reason: `pair-list hash mismatch (expected ${provenance.emittedPairListHash.slice(0, 8)}, got ${recomputed.slice(0, 8)})` };
    }
    if (normalized.length !== provenance.pairCount) {
        return { ok: false, reason: `pair count mismatch (expected ${provenance.pairCount}, got ${normalized.length})` };
    }
    return { ok: true };
}

/** Optional bounded provenance metadata retained with a Batch run. */
export interface BatchRunPairListProvenanceMeta {
    /** The verified pair-list provenance, or `null` when verification failed. */
    provenance: PairListProvenanceV1 | null;
    /** "verified" when the recomputed hash matches; "manual/unverified" otherwise. */
    status: "verified" | "manual/unverified";
    /** Short reason for the status, surfaced in /status and the done event. */
    reason?: string;
}

/** Optional bounded research registration metadata retained with a Batch run. */
export interface BatchRunResearchRegistrationMeta {
    registration: MaxActiveResearchRegistrationV1 | null;
    status: "verified" | "manual/unverified";
    reason?: string;
}

/**
 * Universe counts for the MAX_ACTIVE research (Phase 3). All counts are
 * bounded scalars so `/status` cannot become a second pair-list transport.
 * The OPEN_SCORE USD report composes these with replay-acceptance counts
 * to name every insufficiency gate.
 */
export type BatchUniverseCounts = {
    /** Distinct normalized symbol tokens submitted in the request. */
    submittedSymbols: number;
    /** Distinct canonical synthetic relationships (BASE+QUOTE, deduped). */
    canonicalRelationships: number;
    /** Submitted relationships that produced an artifact-eligible row. */
    artifactEligible: number;
    /** Successfully stored Mine artifacts. */
    artifactsStored: number;
    /** Failed artifact writes. */
    artifactWriteFailures: number;
    /** Canonical scoring-asset degree map (asset -> submitted pair count). */
    submittedDegreeByAsset: Record<string, number>;
};
