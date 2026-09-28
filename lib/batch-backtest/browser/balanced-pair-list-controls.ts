/**
 * Balanced Generator controls (Batch menu): the Generate-and-Apply action, the
 * Copy Generated report, and the provenance of the pair list currently applied
 * to the Pairs textarea. The provenance is consumed by the run preflight (via
 * the facade) and verified server-side.
 */
import { uiManager } from "../../ui-manager";
import { copyToClipboard } from "../../browser-transfer";
import { parseBatchSymbols } from "../batch-run-contract";
import { fnv1a64Hex } from "../max-active-research-contract";
import {
    BALANCED_PAIR_LIST_MAX_PAIRS,
    generateBalancedPairList,
    type BalancedPairListResult,
    type PairListProvenanceV1,
} from "../balanced-pair-list-generator";
import type { BatchBacktestDom } from "../batch-backtest-dom";

/**
 * Compact one-line summary of a Balanced Generator result for the UI status
 * area. Surfaces the effective seed/maxPairs, asset/relationship counts,
 * degree range, orientation imbalance, omitted count, and asset-list hash.
 */
export function formatBalancedPairListSummary(result: BalancedPairListResult): string {
    if (!result.ok) {
        return result.errors.length > 0 ? result.errors.join("; ") : "Generation failed.";
    }
    const p = result.provenance;
    const omitted = result.omittedPairCount > 0 ? ` omitted=${result.omittedPairCount}` : "";
    const aliases = result.aliasCollisions.length > 0 ? ` aliases=${result.aliasCollisions.length}` : "";
    const invalid = result.invalidTokens.length > 0 ? ` invalid=${result.invalidTokens.length}` : "";
    return [
        `Balanced | seed=${p.effectiveSeed} max=${p.effectiveMaxPairs}`,
        `assets=${p.assetCount} pairs=${p.pairCount}`,
        `deg=${p.degree.min}-${p.degree.median.toFixed(1)}-${p.degree.max}`,
        `orientImbalance=${p.orientationImbalanceMax}`,
        `hash=${p.emittedPairListHash.slice(0, 12)}`,
    ].join(" ") + omitted + aliases + invalid;
}

/**
 * Multi-line report for Copy Generated. Mirrors the summary plus any warnings
 * and the provenance fields needed to verify the list server-side. Pair text
 * is appended separately by the caller so the report and the list stay
 * separable.
 */
export function formatBalancedPairListReportLines(result: BalancedPairListResult): string[] {
    if (!result.ok) {
        return ["Balanced Generator failed.", ...result.errors];
    }
    const p = result.provenance;
    const lines: string[] = [
        `Balanced Generator | ${p.schema} | ${p.algorithm}`,
        `seed=${p.effectiveSeed} max=${p.effectiveMaxPairs} assets=${p.assetCount} pairs=${p.pairCount}`,
        `degree min=${p.degree.min} median=${p.degree.median.toFixed(2)} max=${p.degree.max}`,
        `orientationImbalanceMax=${p.orientationImbalanceMax}`,
        `candidatePairCount=${result.candidatePairCount} omitted=${result.omittedPairCount}`,
        `assetListHash=${p.canonicalAssetListHash}`,
        `pairListHash=${p.emittedPairListHash}`,
    ];
    for (const w of result.warnings) lines.push(`WARN: ${w}`);
    return lines;
}

export class BalancedPairListControls {
    private readonly deps: {
        getDom: () => BatchBacktestDom;
        /** Facade preflight guard (run/analysis/Stop/server-run ownership). */
        actionGuard: () => boolean;
        clearStaleResults: (dom: BatchBacktestDom) => void;
        updateSummary: (dom: BatchBacktestDom) => void;
    };

    /**
     * Last successful Balanced Generator result. Used by Copy Generated so a
     * user can copy the displayed list without re-running the generator. The
     * pair list is NOT applied to the textarea on Copy; only Generate-and-Apply
     * writes the textarea (and dispatches the existing input invalidation).
     */
    private lastResult: BalancedPairListResult | null = null;
    /**
     * Provenance of the pair list CURRENTLY applied to the textarea, retained
     * only while the textarea's content still matches `provenance.emittedPairListHash`.
     * Cleared by manual edits, Generate failure, or any other textarea mutation
     * that does not come from the generator's apply path.
     */
    private activeProvenance: PairListProvenanceV1 | null = null;

    constructor(deps: {
        getDom: () => BatchBacktestDom;
        actionGuard: () => boolean;
        clearStaleResults: (dom: BatchBacktestDom) => void;
        updateSummary: (dom: BatchBacktestDom) => void;
    }) {
        this.deps = deps;
    }

    getActiveProvenance(): PairListProvenanceV1 | null {
        return this.activeProvenance;
    }

    hasResult(): boolean {
        return this.lastResult !== null;
    }

    /**
     * If the textarea's content no longer matches the active provenance hash,
     * clear the remembered provenance. Called from the input handler so a
     * manual edit (or any other mutation) drops the link while a generator
     * apply re-sets it before the dispatch reaches here.
     */
    clearActiveProvenanceIfStale(dom: BatchBacktestDom): void {
        if (!this.activeProvenance) return;
        const currentText = dom.batchBacktestSymbols.value;
        // Recompute the emitted-list hash with the same normalization the
        // generator used (parseBatchSymbols dedupes + uppercases + trims).
        const normalized = parseBatchSymbols(currentText);
        const currentHash = fnv1a64Hex(normalized.join("\n"));
        if (currentHash !== this.activeProvenance.emittedPairListHash) {
            this.activeProvenance = null;
        }
    }

    /**
     * Balanced Generator — Generate-and-Apply. Reads the assets textarea,
     * maxPairs, and seed; runs the pure generator; on success writes the
     * generated pair list to the existing Pairs textarea and dispatches its
     * input event so the existing fingerprint/result invalidation path runs
     * exactly as if the user had pasted the list manually. On failure the
     * textarea and provenance are left untouched and actionable errors are
     * shown in the summary area.
     */
    public async generateAndApply(): Promise<void> {
        const dom = this.deps.getDom();
        // Authoritative guard fires before any work; the disabled button is
        // the visual signal but cannot be the only gate (a stale tab could
        // re-enable it via reattach).
        if (this.deps.actionGuard()) {
            dom.batchBacktestBalancedSummary.textContent =
                "Generator unavailable while a Batch run, analysis, or Stop transition is in progress.";
            return;
        }
        const rawAssets = dom.batchBacktestBalancedAssets.value;
        const assets = rawAssets.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
        const maxPairs = readClampedInt(dom.batchBacktestBalancedMaxPairs.value, BALANCED_PAIR_LIST_MAX_PAIRS, 1, BALANCED_PAIR_LIST_MAX_PAIRS);
        const seedRaw = Number.parseInt(dom.batchBacktestBalancedSeed.value, 10);
        const seed = Number.isFinite(seedRaw) ? Math.max(1, Math.floor(seedRaw)) : 1;
        // The pure generator is synchronous; wrap in await so future async
        // extensions (canonicalization that needs a loader) plug in cleanly.
        const result = generateBalancedPairList({ assets, maxPairs, seed });
        if (!result.ok) {
            // Leave the textarea AND the provenance untouched.
            const errors = result.errors.length > 0 ? result.errors : ["Generation failed."];
            dom.batchBacktestBalancedSummary.textContent = errors.join("\n");
            dom.batchBacktestBalancedCopyBtn.disabled = true;
            return;
        }
        // Apply: write the textarea and dispatch the input event so the
        // existing fingerprint/result invalidation path runs identically to
        // a manual paste. Set the remembered provenance BEFORE the dispatch
        // so the input listener's stale-check sees the matching hash and
        // keeps it.
        this.lastResult = result;
        this.activeProvenance = result.provenance;
        dom.batchBacktestSymbols.value = result.pairs.join("\n");
        dom.batchBacktestBalancedCopyBtn.disabled = false;
        dom.batchBacktestBalancedSummary.textContent = formatBalancedPairListSummary(result);
        // Dispatch the existing input invalidation path. Fall back to a
        // plain Event when InputEvent is not available (older Node test
        // harnesses without a DOM polyfill); the bound handler does not read
        // any InputEvent-specific field.
        const EventCtor = typeof InputEvent !== "undefined" ? InputEvent : Event;
        dom.batchBacktestSymbols.dispatchEvent(new EventCtor("input", { bubbles: true }));
        // The dispatched input handler runs clearStaleResults + updateSummary;
        // we then re-affirm the provenance (clearActivePairListProvenanceIfStale
        // inside the input handler keeps it because the hash matches).
    }

    public async copyGenerated(): Promise<void> {
        const result = this.lastResult;
        if (!result || !result.ok) {
            uiManager.showToast("No balanced pair list to copy", "info");
            return;
        }
        const text = [
            ...formatBalancedPairListReportLines(result),
            "",
            ...result.pairs,
        ].join("\n");
        const copied = await copyToClipboard(text);
        if (copied) {
            uiManager.showToast(`Copied ${result.pairs.length} generated pairs`, "success");
        } else {
            this.deps.getDom().batchBacktestStatus.textContent = "Copy failed.";
        }
    }
}

function readClampedInt(raw: string, fallback: number, min: number, max: number): number {
    const parsed = Number.parseInt(raw, 10);
    const value = Number.isFinite(parsed) ? parsed : fallback;
    return Math.max(min, Math.min(max, Math.floor(value)));
}
