import type {
    LedgerSweepDiagnosticsV1,
    LedgerSweepMode,
} from "./trade-ledger-sweep-diagnostics";

export interface LedgerSweepDiagnosticsSummaryV1 {
    schema: "trade_ledger_sweep.diagnostics-summary.v1";
    runId: string;
    mode: LedgerSweepMode;
    terminalPhase: "done" | "cancelled" | "fatal";
    controlExecution: "synchronous" | "server_worker_threads";
    controlWorkers: number;
    phases: {
        load: {
            ledgerMs: number;
            ranksMs: number;
            joinMs: number;
            totalMs: number;
        };
        ruleLoading: { totalMs: number };
        prepare: { totalMs: number };
        ruleReplay: { totalMs: number };
        controls: { totalMs: number };
        reportWriting: { totalMs: number };
        other: { totalMs: number };
    };
    wallMs: number;
    controlsShareOfCompute: number | null;
    controlsShareOfWall: number | null;
    throughput: {
        rulesCompleted: number;
        rulesPerHour: number;
        rowsLoadedPerSecond: number;
        aggregateRowsPerSecond: number;
        aggregateRuleRowsPerSecond: number;
        aggregateControlRowsPerSecond: number;
    };
    memory: {
        peakHeapUsed: number | null;
        peakRss: number | null;
        maxRss: number | null;
    };
    persistence: {
        resultAppendMs: number;
        diagnosticAppendMs: number;
        summaryBuildMs: number;
        summaryWriteMs: number;
    };
    topSlowestRules: Array<{
        ruleId: string;
        name: string;
        candidates: number;
        kept: number;
        controlReplayMs: number;
    }>;
    verdictCounts: Record<string, number>;
    errors: {
        count: number;
        samples: string[];
        omitted: number;
    };
    optimizationTarget: {
        file: "lib/batch-backtest/trade-ledger-replay-core.ts";
        symbol: "random controls loop";
        constraint: "two-pass calibration, independent seeds, exact control math are frozen";
    };
}

type TerminalPhase = LedgerSweepDiagnosticsSummaryV1["terminalPhase"];

function finiteNumber(value: unknown, fallback = 0): number {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function sum(values: readonly number[]): number {
    return values.reduce((total, value) => total + finiteNumber(value), 0);
}

function phaseTotal(diagnostics: LedgerSweepDiagnosticsV1, phase: LedgerSweepDiagnosticsV1["phases"][number]["phase"]): number {
    return sum(diagnostics.phases.filter((entry) => entry.phase === phase).map((entry) => entry.elapsedMs));
}

function throughputNumber(diagnostics: LedgerSweepDiagnosticsV1, key: string): number {
    return finiteNumber(diagnostics.throughput[key]);
}

function peakSampleValue(
    diagnostics: LedgerSweepDiagnosticsV1,
    key: "heapUsed" | "rss" | "maxRss",
): number | null {
    const values = diagnostics.memory.samples
        .map((sample) => sample[key])
        .filter((value) => Number.isFinite(value));
    return values.length > 0 ? Math.max(...values) : null;
}

export function buildTradeLedgerSweepDiagnosticsSummary(
    diagnostics: LedgerSweepDiagnosticsV1,
    terminalPhase: TerminalPhase = "done",
): LedgerSweepDiagnosticsSummaryV1 {
    const ledgerMs = phaseTotal(diagnostics, "loading_ledger");
    const ranksMs = phaseTotal(diagnostics, "loading_ranks");
    const joinMs = phaseTotal(diagnostics, "joining_ranks");
    const ruleLoadingMs = phaseTotal(diagnostics, "loading_rules");
    const prepareMs = phaseTotal(diagnostics, "preparing");
    const ruleReplayMs = sum(diagnostics.perRule.map((row) => row.ruleReplayMs));
    const controlsMs = sum(diagnostics.perRule.map((row) => row.controlReplayMs));
    const reportWritingMs = sum(diagnostics.perRule.map((row) => row.reportFormatMs + row.reportWriteMs));
    const wallMs = throughputNumber(diagnostics, "elapsedMs");
    const controlExecution = diagnostics.input.controlExecution === "server_worker_threads"
        ? "server_worker_threads"
        : "synchronous";
    const controlWorkers = Math.max(0, Math.floor(finiteNumber(diagnostics.input.controlWorkers)));
    const computeMs = ruleReplayMs + controlsMs;
    const aggregateRuleRows = sum(diagnostics.perRule.map((row) => row.ledgerRows));
    const aggregateControlRows = sum(diagnostics.perRule.map((row) => row.controlCandidateVisits));
    const aggregateRows = aggregateRuleRows + aggregateControlRows;
    const aggregateRowsPerSecond = computeMs > 0 ? aggregateRows / (computeMs / 1000) : 0;
    const topSlowestRules = [...diagnostics.perRule]
        .sort((a, b) => b.controlReplayMs - a.controlReplayMs
            || (a.ruleName < b.ruleName ? -1 : a.ruleName > b.ruleName ? 1 : 0)
            || (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0))
        .slice(0, 10)
        .map((row) => ({
            ruleId: row.ruleId,
            name: row.ruleName,
            candidates: row.eligibleCandidates,
            kept: row.admitted,
            controlReplayMs: row.controlReplayMs,
        }));
    const errors = diagnostics.errors.slice(0, 10);
    const accountedMs = ledgerMs + ranksMs + joinMs + ruleLoadingMs + prepareMs + ruleReplayMs + controlsMs + reportWritingMs;

    return {
        schema: "trade_ledger_sweep.diagnostics-summary.v1",
        runId: diagnostics.runId,
        mode: diagnostics.mode,
        terminalPhase,
        controlExecution,
        controlWorkers,
        phases: {
            load: { ledgerMs, ranksMs, joinMs, totalMs: ledgerMs + ranksMs + joinMs },
            ruleLoading: { totalMs: ruleLoadingMs },
            prepare: { totalMs: prepareMs },
            ruleReplay: { totalMs: ruleReplayMs },
            controls: { totalMs: controlsMs },
            reportWriting: { totalMs: reportWritingMs },
            other: { totalMs: Math.max(0, wallMs - accountedMs) },
        },
        wallMs,
        controlsShareOfCompute: computeMs > 0 ? controlsMs / computeMs * 100 : null,
        controlsShareOfWall: wallMs > 0 ? controlsMs / wallMs * 100 : null,
        throughput: {
            rulesCompleted: throughputNumber(diagnostics, "rulesCompleted"),
            rulesPerHour: throughputNumber(diagnostics, "rulesPerHour"),
            rowsLoadedPerSecond: throughputNumber(diagnostics, "rowsLoadedPerSecond"),
            aggregateRowsPerSecond,
            aggregateRuleRowsPerSecond: throughputNumber(diagnostics, "aggregateRuleRowsPerSecond"),
            aggregateControlRowsPerSecond: throughputNumber(diagnostics, "aggregateControlRowsPerSecond"),
        },
        memory: {
            peakHeapUsed: peakSampleValue(diagnostics, "heapUsed"),
            peakRss: peakSampleValue(diagnostics, "rss"),
            maxRss: peakSampleValue(diagnostics, "maxRss"),
        },
        persistence: { ...diagnostics.persistence },
        topSlowestRules,
        verdictCounts: { ...diagnostics.verdictCounts },
        errors: {
            count: diagnostics.errors.length,
            samples: errors,
            omitted: diagnostics.errors.length - errors.length,
        },
        optimizationTarget: {
            file: "lib/batch-backtest/trade-ledger-replay-core.ts",
            symbol: "random controls loop",
            constraint: "two-pass calibration, independent seeds, exact control math are frozen",
        },
    };
}
