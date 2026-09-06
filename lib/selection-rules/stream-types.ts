import type { SelectionHorizonTally } from "./tally";

export type SelectionRulesPhase = "loading" | "tallying" | "done" | "cancelled" | "fatal";

/** One scalar table row, emitted after one rule/horizon has been tallied. */
export interface SelectionRuleResult {
    ruleKey: string;
    ruleName: string;
    horizonBars: number;
    n: number;
    topRawDeltaMeanPp: number | null;
    topRawDeltaMedianPp: number | null;
    topMeanDeltaMeanPp: number | null;
    topMeanDeltaMedianPp: number | null;
    othersMeanDeltaMeanPp: number | null;
    othersMeanDeltaMedianPp: number | null;
    successBarPass: boolean;
    dominantAsset: string | null;
    dominantShare: number | null;
    excludingDominantAsset: string | null;
    excludingDominantN: number | null;
    excludingDominantDeltaMeanPp: number | null;
    excludingDominantDeltaMedianPp: number | null;
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
    summary: SelectionRulesSummary | null;
    error: string | null;
}

export interface SelectionRulesCatalogEntry {
    runId: string;
    completedAt: string;
    interval: string;
    horizons: number[];
    fingerprint: string;
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
        if (!Array.isArray(event.results) || !Array.isArray(event.reportLines)) {
            throw new Error(`Terminal ${String(event.type)} event is missing its summary arrays.`);
        }
        for (const result of event.results) {
            assertSelectionRuleResultIsScalar(result);
        }
        return;
    }
    for (const [key, child] of Object.entries(event)) {
        assertScalar(child, `$.${key}`);
    }
}

export function resultFromHorizon(
    ruleKey: string,
    ruleName: string,
    horizon: SelectionHorizonTally,
    reportLines: string[],
): SelectionRuleResult {
    const toPp = (value: number | null): number | null => value === null ? null : value * 100;
    const topRawDelta = horizon.comparisons.topRaw.delta;
    const topMeanDelta = horizon.comparisons.topMean.delta;
    const othersDelta = horizon.comparisons.othersMean.delta;
    const successBarPass = [topRawDelta, topMeanDelta, othersDelta]
        .every((delta) => delta.mean !== null && delta.median !== null && delta.mean > 0 && delta.median > 0);
    return {
        ruleKey,
        ruleName,
        horizonBars: horizon.horizonBars,
        n: horizon.eligibleEvents,
        topRawDeltaMeanPp: toPp(topRawDelta.mean),
        topRawDeltaMedianPp: toPp(topRawDelta.median),
        topMeanDeltaMeanPp: toPp(topMeanDelta.mean),
        topMeanDeltaMedianPp: toPp(topMeanDelta.median),
        othersMeanDeltaMeanPp: toPp(othersDelta.mean),
        othersMeanDeltaMedianPp: toPp(othersDelta.median),
        successBarPass,
        dominantAsset: horizon.dominantAsset,
        dominantShare: horizon.selectedAssets[0]?.share ?? null,
        excludingDominantAsset: horizon.dominantAsset,
        excludingDominantN: horizon.excludingDominant?.selected.count ?? null,
        excludingDominantDeltaMeanPp: toPp(horizon.excludingDominant?.delta.mean ?? null),
        excludingDominantDeltaMedianPp: toPp(horizon.excludingDominant?.delta.median ?? null),
        reportLines: [...reportLines],
    };
}
