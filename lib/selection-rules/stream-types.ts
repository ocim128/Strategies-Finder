import type { PairSelectionResult, PairSelectionTally } from "../pair-selection/tally";

export type SelectionRulesPhase = "loading" | "tallying" | "done" | "cancelled" | "fatal";

/** One scalar table row, emitted after one pair rule/horizon has been tallied. */
export interface SelectionRuleResult {
    ruleKey: string;
    ruleName: string;
    horizonBars: number;
    n: number;
    othersMeanDeltaMeanPp: number | null;
    othersMeanDeltaMedianPp: number | null;
    referenceAlphabeticalDeltaMeanPp: number | null;
    referenceAlphabeticalDeltaMedianPp: number | null;
    referenceLoudestAtrDeltaMeanPp: number | null;
    referenceLoudestAtrDeltaMedianPp: number | null;
    successBarPass: boolean;
    dominantPair: string | null;
    dominantPairShare: number | null;
    dominantBaseLeg: string | null;
    dominantBaseShare: number | null;
    dominantQuoteLeg: string | null;
    dominantQuoteShare: number | null;
    excludingDominantPair: string | null;
    excludingDominantN: number | null;
    excludingDominantOthersMeanDeltaMeanPp: number | null;
    excludingDominantOthersMeanDeltaMedianPp: number | null;
    excludingDominantAlphabeticalDeltaMeanPp: number | null;
    excludingDominantAlphabeticalDeltaMedianPp: number | null;
    excludingDominantLoudestAtrDeltaMeanPp: number | null;
    excludingDominantLoudestAtrDeltaMedianPp: number | null;
    reportLines: string[];
}

export interface SelectionRulesSummary {
    runId: string;
    folderPath: string;
    totalRules: number;
    completedRules: number;
    resultCount: number;
    passedCount: number;
    results: SelectionRuleResult[];
    reportLines: string[];
}

export interface SelectionRulesStartEvent {
    type: "start";
    runId: string;
    folderPath: string;
    totalRules: number;
    startedAt: number;
}

export interface SelectionRulesPhaseEvent {
    type: "phase";
    runId: string;
    phase: "loading" | "tallying";
    detail: string;
    completedRules: number;
    totalRules: number;
    currentRuleKey: string | null;
    currentHorizonBars: number | null;
}

export interface SelectionRulesResultEvent {
    type: "rule_result";
    runId: string;
    result: SelectionRuleResult;
    completedRules: number;
    totalRules: number;
}

export interface SelectionRulesDoneEvent {
    type: "done";
    runId: string;
    ok: true;
    cancelled: false;
    finishedAt: number;
    summary: SelectionRulesSummary;
    results: SelectionRuleResult[];
    reportLines: string[];
    diagnosticsLines: string[];
}

export interface SelectionRulesCancelledEvent {
    type: "cancelled";
    runId: string;
    ok: false;
    cancelled: true;
    finishedAt: number;
    summary: SelectionRulesSummary;
    results: SelectionRuleResult[];
    reportLines: string[];
    diagnosticsLines: string[];
}

export interface SelectionRulesFatalEvent {
    type: "fatal";
    runId: string;
    ok: false;
    cancelled: false;
    finishedAt: number;
    error: string;
    summary: SelectionRulesSummary | null;
    results: SelectionRuleResult[];
    reportLines: string[];
    diagnosticsLines: string[];
}

export type SelectionRulesStreamEvent =
    | SelectionRulesStartEvent
    | SelectionRulesPhaseEvent
    | SelectionRulesResultEvent
    | SelectionRulesDoneEvent
    | SelectionRulesCancelledEvent
    | SelectionRulesFatalEvent;

export interface SelectionRulesStatusRun {
    runId: string;
    folderPath: string;
    startedAt: number;
    finishedAt: number | null;
    phase: SelectionRulesPhase;
    totalRules: number;
    completedRules: number;
    currentRuleKey: string | null;
    currentHorizonBars: number | null;
    results: SelectionRuleResult[];
    reportLines: string[];
    diagnosticsLines: string[];
    summary: SelectionRulesSummary | null;
    error: string | null;
}

export interface SelectionRulesCatalogEntry {
    folderId: string;
    runId: string;
    startedAt: string;
    finishedAt: string;
    interval: string;
    strategyKey: string;
    ledgerHorizons: number[];
    totals: { signals: number; pairs: number };
}

export interface SelectionRulesCatalogResponse {
    ok: true;
    catalogRoot: string;
    generatedAt: number;
    folders: SelectionRulesCatalogEntry[];
    rules: Array<{ key: string; name: string; description: string }>;
}

export interface SelectionRulesStatusResponse {
    ok: true;
    runMismatch: boolean;
    running: boolean;
    run: SelectionRulesStatusRun | null;
    lastRun: SelectionRulesStatusRun | null;
}

function assertScalar(value: unknown, path: string): void {
    if (value === null || typeof value === "string" || typeof value === "boolean") return;
    if (typeof value === "number") {
        if (!Number.isFinite(value)) throw new Error(`Non-finite selection-rules wire number at ${path}.`);
        return;
    }
    throw new Error(`Non-scalar selection-rules wire value at ${path}.`);
}

/**
 * Rule rows are deliberately flat. `reportLines` is the only array allowed
 * on a streamed row; terminal events may carry the complete result summary.
 */
export function assertSelectionRuleResultIsScalar(value: unknown): asserts value is SelectionRuleResult {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Selection rule result must be an object.");
    }
    for (const [key, child] of Object.entries(value)) {
        if (key === "reportLines") {
            if (!Array.isArray(child) || child.some((line) => typeof line !== "string")) {
                throw new Error("Selection rule reportLines must be a string array.");
            }
            continue;
        }
        assertScalar(child, `$.${key}`);
    }
}

/** Validate the transport shape at the plugin boundary. */
export function assertSelectionRulesWireEventIsScalar(value: unknown): asserts value is SelectionRulesStreamEvent {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Selection-rules wire event must be an object.");
    }
    const event = value as Record<string, unknown>;
    if (event.type === "rule_result") {
        assertScalar(event.runId, "$.runId");
        assertScalar(event.completedRules, "$.completedRules");
        assertScalar(event.totalRules, "$.totalRules");
        assertSelectionRuleResultIsScalar(event.result);
        return;
    }
    if (event.type === "done" || event.type === "cancelled" || event.type === "fatal") {
        assertScalar(event.runId, "$.runId");
        if (!Array.isArray(event.results) || !Array.isArray(event.reportLines) || !Array.isArray(event.diagnosticsLines)) {
            throw new Error(`Terminal ${String(event.type)} event is missing its summary arrays.`);
        }
        for (const result of event.results) assertSelectionRuleResultIsScalar(result);
        if (event.diagnosticsLines.some((line) => typeof line !== "string")) {
            throw new Error(`Terminal ${String(event.type)} diagnosticsLines must be a string array.`);
        }
        return;
    }
    for (const [key, child] of Object.entries(event)) assertScalar(child, `$.${key}`);
}

function comparisonFields(
    comparison: PairSelectionTally["comparisons"]["othersMean"],
): { mean: number | null; median: number | null } {
    return {
        mean: comparison.delta.mean === null ? null : comparison.delta.mean * 100,
        median: comparison.delta.median === null ? null : comparison.delta.median * 100,
    };
}

export function resultFromPairSelection(result: PairSelectionResult, horizonBars: number): SelectionRuleResult {
    const { tally } = result;
    const othersMean = comparisonFields(tally.comparisons.othersMean);
    const alphabetical = comparisonFields(tally.comparisons.referenceAlphabetical);
    const loudestAtr = comparisonFields(tally.comparisons.referenceLoudestAtr);
    const excluding = tally.excludingDominantPair;
    const excludingOthers = excluding ? comparisonFields(excluding.othersMean) : null;
    const excludingAlphabetical = excluding ? comparisonFields(excluding.referenceAlphabetical) : null;
    const excludingLoudestAtr = excluding ? comparisonFields(excluding.referenceLoudestAtr) : null;
    const successBarPass = [
        tally.comparisons.othersMean.delta,
        tally.comparisons.referenceAlphabetical.delta,
        tally.comparisons.referenceLoudestAtr.delta,
    ].every((delta) => delta.mean !== null && delta.median !== null && delta.mean > 0 && delta.median > 0);
    return {
        ruleKey: result.ruleKey,
        ruleName: result.ruleName,
        horizonBars,
        n: tally.eligibleEvents,
        othersMeanDeltaMeanPp: othersMean.mean,
        othersMeanDeltaMedianPp: othersMean.median,
        referenceAlphabeticalDeltaMeanPp: alphabetical.mean,
        referenceAlphabeticalDeltaMedianPp: alphabetical.median,
        referenceLoudestAtrDeltaMeanPp: loudestAtr.mean,
        referenceLoudestAtrDeltaMedianPp: loudestAtr.median,
        successBarPass,
        dominantPair: tally.dominantPair,
        dominantPairShare: tally.selectedPairs[0]?.share ?? null,
        dominantBaseLeg: tally.dominantBaseLeg,
        dominantBaseShare: tally.selectedBaseLegs[0]?.share ?? null,
        dominantQuoteLeg: tally.dominantQuoteLeg,
        dominantQuoteShare: tally.selectedQuoteLegs[0]?.share ?? null,
        excludingDominantPair: tally.dominantPair,
        excludingDominantN: excluding?.othersMean.selected.count ?? null,
        excludingDominantOthersMeanDeltaMeanPp: excludingOthers?.mean ?? null,
        excludingDominantOthersMeanDeltaMedianPp: excludingOthers?.median ?? null,
        excludingDominantAlphabeticalDeltaMeanPp: excludingAlphabetical?.mean ?? null,
        excludingDominantAlphabeticalDeltaMedianPp: excludingAlphabetical?.median ?? null,
        excludingDominantLoudestAtrDeltaMeanPp: excludingLoudestAtr?.mean ?? null,
        excludingDominantLoudestAtrDeltaMedianPp: excludingLoudestAtr?.median ?? null,
        reportLines: [...result.reportLines],
    };
}
