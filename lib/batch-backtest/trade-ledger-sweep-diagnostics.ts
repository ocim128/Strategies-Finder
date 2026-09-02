import type { LedgerSweepPreflightDecision } from "./trade-ledger-sweep-preflight";
import { ledgerSweepRuntimeHeapGuardLimitBytes } from "./trade-ledger-sweep-preflight";

export type LedgerSweepMode = "load_once" | "isolated_per_rule";
export type LedgerSweepPhase =
    | "preflight"
    | "starting_worker"
    | "loading_ledger"
    | "loading_ranks"
    | "loading_rules"
    | "joining_ranks"
    | "preparing"
    | "rule_replay"
    | "random_controls"
    | "writing_report"
    | "finalizing"
    | "done"
    | "cancelled"
    | "fatal";

export type LedgerSweepDiagnosticGroup =
    | "catalog_preflight"
    | "ledger_load"
    | "ranks"
    | "rule_loading"
    | "prepare"
    | "rule_replay"
    | "controls"
    | "persistence"
    | "memory"
    | "cpu_event_loop"
    | "progress";

export interface LedgerSweepMemorySample {
    at: number;
    source: "worker" | "controller";
    phase: LedgerSweepPhase;
    ruleId: string | null;
    heapUsed: number;
    heapTotal: number;
    rss: number;
    external: number;
    arrayBuffers: number;
    maxRss: number;
}

export interface LedgerSweepRuntimeMemoryGuard {
    tripped: boolean;
    thresholdBytes: number;
    observedHeapBytes: number | null;
    phase: LedgerSweepPhase | null;
    ruleId: string | null;
    message: string | null;
}

export interface LedgerSweepDiagnosticEntry {
    at: number;
    group: LedgerSweepDiagnosticGroup;
    phase: LedgerSweepPhase;
    ruleId: string | null;
    metrics: Record<string, unknown>;
}

export interface LedgerSweepPhaseDiagnostic {
    phase: LedgerSweepPhase;
    startedAt: number;
    finishedAt: number | null;
    elapsedMs: number;
}

export interface LedgerSweepCpuDiagnostic {
    scope: string;
    userCpuMs: number;
    systemCpuMs: number;
    eventLoopUtilization: number;
    eventLoopDelayP50Ms: number;
    eventLoopDelayP99Ms: number;
}

export interface LedgerSweepRuleDiagnostic {
    ruleId: string;
    ruleName: string;
    sourceHash: string;
    ruleReplayMs: number;
    ledgerRows: number;
    eligibleCandidates: number;
    predicateCalls: number;
    admitted: number;
    rejectedByRule: number;
    blocked: number;
    rightCensored: number;
    controlReplayMs: number;
    controlRuns: number;
    calibrationReplays: number;
    controlCandidateVisits: number;
    controlsPerSecond: number;
    candidateVisitsPerSecond: number;
    reportFormatMs: number;
    reportWriteMs: number;
    reportBytes: number;
}

export interface LedgerSweepDiagnosticsV1 {
    schema: "trade_ledger_sweep.diagnostics.v1";
    runId: string;
    mode: LedgerSweepMode;
    input: Record<string, unknown>;
    preflight: LedgerSweepPreflightDecision;
    phases: LedgerSweepPhaseDiagnostic[];
    memory: {
        samples: LedgerSweepMemorySample[];
        workerPeak: LedgerSweepMemorySample | null;
        controllerPeak: LedgerSweepMemorySample | null;
        runtimeGuard: LedgerSweepRuntimeMemoryGuard;
    };
    cpu: LedgerSweepCpuDiagnostic[];
    persistence: {
        resultAppendMs: number;
        diagnosticAppendMs: number;
        summaryBuildMs: number;
        summaryWriteMs: number;
    };
    perRule: LedgerSweepRuleDiagnostic[];
    throughput: Record<string, unknown>;
    verdictCounts: Record<string, number>;
    errors: string[];
    /** Optional aggregate count used by bounded live-status projections. */
    errorCount?: number;
}

export function createEmptyLedgerSweepDiagnostics(args: {
    runId: string;
    mode: LedgerSweepMode;
    preflight: LedgerSweepPreflightDecision;
    input?: Record<string, unknown>;
}): LedgerSweepDiagnosticsV1 {
    return {
        schema: "trade_ledger_sweep.diagnostics.v1",
        runId: args.runId,
        mode: args.mode,
        input: args.input ?? {},
        preflight: args.preflight,
        phases: [],
        memory: {
            samples: [],
            workerPeak: null,
            controllerPeak: null,
            runtimeGuard: {
                tripped: false,
                thresholdBytes: ledgerSweepRuntimeHeapGuardLimitBytes(args.preflight.childHeapLimitBytes),
                observedHeapBytes: null,
                phase: null,
                ruleId: null,
                message: null,
            },
        },
        cpu: [],
        persistence: {
            resultAppendMs: 0,
            diagnosticAppendMs: 0,
            summaryBuildMs: 0,
            summaryWriteMs: 0,
        },
        perRule: [],
        throughput: {},
        verdictCounts: {},
        errors: [],
    };
}
