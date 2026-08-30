import type { ResearchWorkloadSnapshot } from "../server-research-job-coordinator";
import {
    type LedgerSweepDiagnosticEntry,
    type LedgerSweepDiagnosticsV1,
    type LedgerSweepMemorySample,
    type LedgerSweepMode,
    type LedgerSweepPhase,
} from "./trade-ledger-sweep-diagnostics";
import type { LedgerSweepPreflightDecision } from "./trade-ledger-sweep-preflight";
import type {
    LedgerSweepFolderCatalogEntry,
    LedgerSweepRuleCatalogEntry,
} from "./trade-ledger-sweep-catalog";

export type LedgerSweepVerdict =
    | "EDGE-CANDIDATE"
    | "HOLDOUT-NEG"
    | "TOO-RARE"
    | "NO-EDGE"
    | "ERROR";

export interface LedgerSweepRuleResult {
    ruleId: string;
    ruleName: string;
    sourceHash: string;
    verdict: LedgerSweepVerdict;
    weak: boolean;
    note: string | null;
    candidates: number;
    kept: number;
    keptPct: number | null;
    isMeanPnlDeltaPp: number | null;
    isMedianPnlDeltaPp: number | null;
    holdoutMeanPnlDeltaPp: number | null;
    holdoutMedianPnlDeltaPp: number | null;
    ruleReplayMs: number;
    controlReplayMs: number;
    totalMs: number;
    reportPath: string;
    error: string | null;
}

export interface LedgerSweepStartEvent {
    type: "start";
    runId: string;
    folderId: string;
    folderName: string;
    mode: LedgerSweepMode;
    modeReason: string;
    totalRules: number;
    ledgerRows: number;
    ledgerBytes: number;
    rankBytes: number;
    outputDir: string;
    startedAt: number;
}

export interface LedgerSweepPhaseEvent {
    type: "phase";
    runId: string;
    phase: LedgerSweepPhase;
    detail: string;
    elapsedMs: number;
    completedRules: number;
    totalRules: number;
    memory: LedgerSweepMemorySample;
}

export interface LedgerSweepRuleStartEvent {
    type: "rule_start";
    runId: string;
    ruleIndex: number;
    totalRules: number;
    ruleId: string;
    ruleName: string;
    sourceHash: string;
    startedAt: number;
}

export interface LedgerSweepProgressEvent {
    type: "progress";
    runId: string;
    phase: LedgerSweepPhase;
    percent: number;
    detail: string;
    completedRules: number;
    totalRules: number;
    currentRuleId: string | null;
    elapsedMs: number;
    controlCompleted: number | null;
    controlRuns: number | null;
    rulesPerHour: number;
}

export interface LedgerSweepRuleResultEvent {
    type: "rule_result";
    runId: string;
    result: LedgerSweepRuleResult;
}

export interface LedgerSweepDiagnosticsEvent {
    type: "diagnostics";
    runId: string;
    entry: LedgerSweepDiagnosticEntry;
}

export interface LedgerSweepDoneEvent {
    type: "done";
    runId: string;
    ok: true;
    cancelled: false;
    finishedAt: number;
    summary: string;
    results: LedgerSweepRuleResult[];
    diagnostics: LedgerSweepDiagnosticsV1;
    outputDir: string;
}

export interface LedgerSweepCancelledEvent {
    type: "cancelled";
    runId: string;
    ok: false;
    cancelled: true;
    finishedAt: number;
    summary: string;
    results: LedgerSweepRuleResult[];
    diagnostics: LedgerSweepDiagnosticsV1;
    outputDir: string;
}

export interface LedgerSweepFatalEvent {
    type: "fatal";
    runId: string;
    ok: false;
    cancelled: false;
    finishedAt: number;
    error: string;
    summary: string | null;
    results: LedgerSweepRuleResult[];
    diagnostics: LedgerSweepDiagnosticsV1;
    outputDir: string;
}

export type LedgerSweepStreamEvent =
    | LedgerSweepStartEvent
    | LedgerSweepPhaseEvent
    | LedgerSweepRuleStartEvent
    | LedgerSweepProgressEvent
    | LedgerSweepRuleResultEvent
    | LedgerSweepDiagnosticsEvent
    | LedgerSweepDoneEvent
    | LedgerSweepCancelledEvent
    | LedgerSweepFatalEvent;

export interface LedgerSweepStatusRun {
    runId: string;
    folderId: string;
    folderName: string;
    mode: LedgerSweepMode;
    modeReason: string;
    phase: LedgerSweepPhase;
    startedAt: number;
    finishedAt: number | null;
    totalRules: number;
    completedRules: number;
    currentRuleId: string | null;
    elapsedMs: number;
    percent: number;
    results: LedgerSweepRuleResult[];
    diagnostics: LedgerSweepDiagnosticsV1;
    summary: string | null;
    outputDir: string;
    error: string | null;
}

export interface LedgerSweepCatalogResponse {
    ok: true;
    catalogRoot: string;
    generatedAt: number;
    folders: LedgerSweepFolderCatalogEntry[];
    rules: LedgerSweepRuleCatalogEntry[];
    activeWorkloads: ResearchWorkloadSnapshot[];
}

export interface LedgerSweepStatusResponse {
    ok: true;
    runMismatch: boolean;
    running: boolean;
    activeWorkloads: ResearchWorkloadSnapshot[];
    run: LedgerSweepStatusRun | null;
    lastRun: LedgerSweepStatusRun | null;
}

const FORBIDDEN_KEYS = new Set(["rows", "trades", "pairRows", "report", "reportLines"]);

function assertScalarValue(value: unknown, pathText: string, root: Record<string, unknown>): void {
    if (typeof value === "number") {
        if (!Number.isFinite(value)) throw new Error(`Non-finite wire number at ${pathText}.`);
        return;
    }
    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i += 1) assertScalarValue(value[i], `${pathText}[${i}]`, root);
        return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
        const preflightRowCount = key === "rows" && pathText === "$.diagnostics.preflight";
        if (FORBIDDEN_KEYS.has(key) && !preflightRowCount) throw new Error(`Forbidden heavy wire field "${key}" at ${pathText}.`);
        const ruleReplayLedgerRowCount = key === "ledgerRows"
            && pathText === "$.entry.metrics"
            && root.type === "diagnostics"
            && ((root.entry as { group?: unknown } | undefined)?.group === "rule_replay"
                || (root.entry as { group?: unknown } | undefined)?.group === "catalog_preflight");
        const finalRuleLedgerRowCount = key === "ledgerRows"
            && /^\$\.diagnostics\.perRule\[\d+\]$/.test(pathText)
            && (root.type === "done" || root.type === "cancelled" || root.type === "fatal");
        if (key === "ledgerRows" && !(pathText === "$" && root.type === "start") && !ruleReplayLedgerRowCount && !finalRuleLedgerRowCount) {
            throw new Error(`Forbidden ledgerRows field at ${pathText}.`);
        }
        assertScalarValue(child, `${pathText}.${key}`, root);
    }
}

/** Assert that an event contains only bounded scalar/diagnostic payloads. */
export function assertLedgerSweepWireEventIsScalar(event: unknown): asserts event is LedgerSweepStreamEvent {
    if (!event || typeof event !== "object" || Array.isArray(event)) {
        throw new Error("Ledger Sweep wire event must be an object.");
    }
    const root = event as Record<string, unknown>;
    assertScalarValue(event, "$", root);
}

export function isLedgerSweepTerminalEvent(event: LedgerSweepStreamEvent): event is LedgerSweepDoneEvent | LedgerSweepCancelledEvent | LedgerSweepFatalEvent {
    return event.type === "done" || event.type === "cancelled" || event.type === "fatal";
}

export type {
    LedgerSweepDiagnosticEntry,
    LedgerSweepDiagnosticsV1,
    LedgerSweepMemorySample,
    LedgerSweepMode,
    LedgerSweepPhase,
    LedgerSweepPreflightDecision,
};
