import { setImmediate } from "node:timers/promises";
import { cpus } from "node:os";
import { loadPairSelectionArchive, tallyPairSelectionRule, type PairSelectionArchive } from "../pair-selection/tally";
import type { PairSelectionRule } from "../pair-selection/types";
import type { PairSelectionTallyDiagnostics } from "../pair-selection/tally";
import {
    resultFromPairSelection,
    type SelectionRuleResult,
    type SelectionRulesCancelledEvent,
    type SelectionRulesDoneEvent,
    type SelectionRulesFatalEvent,
    type SelectionRulesStreamEvent,
    type SelectionRulesSummary,
} from "./stream-types";

export interface SelectionRulesJobArgs {
    runId: string;
    folderPath: string;
    archiveFolderPath?: string;
    horizonBars?: number;
    rules: readonly PairSelectionRule[];
    signal: AbortSignal;
    loadArchive?: (folderPath: string) => PairSelectionArchive | PromiseLike<PairSelectionArchive>;
    emit: (event: SelectionRulesStreamEvent) => void;
    update: (patch: {
        phase?: "loading" | "tallying" | "done" | "cancelled" | "fatal";
        completedRules?: number;
        currentRuleKey?: string | null;
        currentHorizonBars?: number | null;
        results?: SelectionRuleResult[];
        reportLines?: string[];
        diagnosticsLines?: string[];
        summary?: SelectionRulesSummary | null;
        finishedAt?: number | null;
        error?: string | null;
    }) => void;
}

interface SelectionRuleDiagnostics {
    wallMs: number;
    eventsPerSec: number;
    scoredCandidates: number;
    gateMs: number;
    scoreMs: number;
    refsMs: number;
    freqMs: number;
    heapAfterMb: number | null;
}

interface SelectionRulesDiagnosticsState {
    loadWallMs: number;
    archiveDiagnostics: PairSelectionArchive["diagnostics"] | null;
    heapAfterLoad: number | null;
    peakHeapUsed: number | null;
    rules: Map<string, SelectionRuleDiagnostics>;
}

function emptyTallyDiagnostics(): PairSelectionTallyDiagnostics {
    return { gateMs: 0, scoreMs: 0, refsMs: 0, freqMs: 0, scoredCandidates: 0 };
}

function addTallyDiagnostics(target: PairSelectionTallyDiagnostics, source: PairSelectionTallyDiagnostics): void {
    target.gateMs += source.gateMs;
    target.scoreMs += source.scoreMs;
    target.refsMs += source.refsMs;
    target.freqMs += source.freqMs;
    target.scoredCandidates += source.scoredCandidates;
}

function formatMs(value: number): string {
    return value.toFixed(2);
}

function formatMb(value: number | null): string {
    return value === null ? "n/a" : (value / 1024 / 1024).toFixed(2);
}

function buildDiagnosticsLines(
    args: SelectionRulesJobArgs,
    state: SelectionRulesDiagnosticsState,
    horizons: readonly number[],
): string[] {
    const load = state.archiveDiagnostics;
    const peakDelta = state.peakHeapUsed === null || state.heapAfterLoad === null
        ? null
        : Math.max(0, state.peakHeapUsed - state.heapAfterLoad);
    return [
        `env nodeVersion=${process.version} cpus=${cpus().length} heapLimitHint=heapUsed-only`,
        `load folder=${args.folderPath} horizon=${horizons.join(",")} loadWallMs=${formatMs(state.loadWallMs)} jsonParseMs=${formatMs(load?.jsonParseMs ?? 0)} streamWallMs=${formatMs(load?.streamWallMs ?? 0)} readResidualMs=${formatMs(load?.readResidualMs ?? 0)} rows=${load?.rows ?? 0} events=${load?.events ?? 0} candidates=${load?.candidates ?? 0}`,
        `heap afterLoadMb=${formatMb(state.heapAfterLoad)}`,
        `heap peakDeltaMb=${formatMb(peakDelta)} peakAfterRulesMb=${formatMb(state.peakHeapUsed)}`,
        ...args.rules.map((rule) => {
            const diagnostics = state.rules.get(rule.key);
            const wallMs = diagnostics?.wallMs ?? 0;
            const events = load?.events ?? 0;
            const eventsPerSec = diagnostics?.eventsPerSec ?? 0;
            return `rule=${rule.key} horizon=${horizons.join(",")} wallMs=${formatMs(wallMs)} eventsPerSec=${eventsPerSec.toFixed(2)} scoredCandidates=${diagnostics?.scoredCandidates ?? 0} gateMs=${formatMs(diagnostics?.gateMs ?? 0)} scoreMs=${formatMs(diagnostics?.scoreMs ?? 0)} refsMs=${formatMs(diagnostics?.refsMs ?? 0)} freqMs=${formatMs(diagnostics?.freqMs ?? 0)} heapAfterMb=${formatMb(diagnostics?.heapAfterMb ?? null)} events=${events}`;
        }),
    ];
}

function buildSummary(
    runId: string,
    folderPath: string,
    totalRules: number,
    results: SelectionRuleResult[],
    reportLines: string[],
): SelectionRulesSummary {
    return {
        runId,
        folderPath,
        totalRules,
        completedRules: new Set(results.map((result) => result.ruleKey)).size,
        resultCount: results.length,
        passedCount: results.filter((result) => result.successBarPass).length,
        results: [...results],
        reportLines: [...reportLines],
    };
}

function cancelledEvent(
    args: SelectionRulesJobArgs,
    results: SelectionRuleResult[],
    reportLines: string[],
    diagnosticsLines: string[],
): SelectionRulesCancelledEvent {
    const summary = buildSummary(args.runId, args.folderPath, args.rules.length, results, reportLines);
    return {
        type: "cancelled",
        runId: args.runId,
        ok: false,
        cancelled: true,
        finishedAt: Date.now(),
        summary,
        results: [...results],
        reportLines: [...reportLines],
        diagnosticsLines: [...diagnosticsLines],
    };
}

export async function runSelectionRulesJob(args: SelectionRulesJobArgs): Promise<void> {
    const results: SelectionRuleResult[] = [];
    const reportLines: string[] = [];
    const loadArchiveFn = args.loadArchive ?? loadPairSelectionArchive;
    const diagnosticsState: SelectionRulesDiagnosticsState = {
        loadWallMs: 0,
        archiveDiagnostics: null,
        heapAfterLoad: null,
        peakHeapUsed: null,
        rules: new Map(),
    };
    let horizons: number[] = [];

    args.update({ phase: "loading", currentRuleKey: null, currentHorizonBars: null });
    args.emit({
        type: "phase",
        runId: args.runId,
        phase: "loading",
        detail: "Loading and verifying pair-selection ledger…",
        completedRules: 0,
        totalRules: args.rules.length,
        currentRuleKey: null,
        currentHorizonBars: null,
    });

    // This is intentionally the only archive load in the job. Each rule and
    // horizon reuses the parsed, validated pair-selection archive.
    const loadStartedAt = performance.now();
    let archive: PairSelectionArchive;
    try {
        archive = await loadArchiveFn(args.archiveFolderPath ?? args.folderPath);
    } catch (error) {
        diagnosticsState.loadWallMs = performance.now() - loadStartedAt;
        args.update({ diagnosticsLines: buildDiagnosticsLines(args, diagnosticsState, horizons) });
        throw error;
    }
    diagnosticsState.loadWallMs = performance.now() - loadStartedAt;
    diagnosticsState.archiveDiagnostics = archive.diagnostics;
    diagnosticsState.heapAfterLoad = process.memoryUsage().heapUsed;
    diagnosticsState.peakHeapUsed = diagnosticsState.heapAfterLoad;
    horizons = args.horizonBars === undefined ? [...archive.ledgerHorizons] : [args.horizonBars];
    args.update({ diagnosticsLines: buildDiagnosticsLines(args, diagnosticsState, horizons) });
    if (args.signal.aborted) {
        args.emit(cancelledEvent(args, results, reportLines, buildDiagnosticsLines(args, diagnosticsState, horizons)));
        return;
    }

    args.update({ phase: "tallying" });
    args.emit({
        type: "phase",
        runId: args.runId,
        phase: "tallying",
        detail: "Tallying pair-selection rules…",
        completedRules: 0,
        totalRules: args.rules.length,
        currentRuleKey: null,
        currentHorizonBars: null,
    });

    for (let ruleIndex = 0; ruleIndex < args.rules.length; ruleIndex += 1) {
        const rule = args.rules[ruleIndex]!;
        const ruleStartedAt = performance.now();
        const ruleDiagnostics = emptyTallyDiagnostics();
        args.update({ phase: "tallying", currentRuleKey: rule.key, currentHorizonBars: null });
        for (let horizonIndex = 0; horizonIndex < horizons.length; horizonIndex += 1) {
            const horizonBars = horizons[horizonIndex]!;
            if (args.signal.aborted) {
                args.emit(cancelledEvent(args, results, reportLines, buildDiagnosticsLines(args, diagnosticsState, horizons)));
                return;
            }
            args.update({ currentRuleKey: rule.key, currentHorizonBars: horizonBars });
            const tally = tallyPairSelectionRule(archive, rule, undefined, horizonBars);
            addTallyDiagnostics(ruleDiagnostics, tally.diagnostics);
            const result = resultFromPairSelection(tally, horizonBars);
            results.push(result);
            reportLines.push(...result.reportLines);
            const completedRules = horizonIndex === horizons.length - 1 ? ruleIndex + 1 : ruleIndex;
            args.update({
                completedRules,
                results: [...results],
                reportLines: [...reportLines],
            });
            args.emit({
                type: "rule_result",
                runId: args.runId,
                result,
                completedRules,
                totalRules: args.rules.length,
            });
            // Yield between rule/horizon tallies so Stop remains observable.
            await setImmediate();
            if (args.signal.aborted) {
                args.emit(cancelledEvent(args, results, reportLines, buildDiagnosticsLines(args, diagnosticsState, horizons)));
                return;
            }
        }
        const ruleWallMs = performance.now() - ruleStartedAt;
        const heapAfter = process.memoryUsage().heapUsed;
        diagnosticsState.peakHeapUsed = Math.max(diagnosticsState.peakHeapUsed ?? heapAfter, heapAfter);
        diagnosticsState.rules.set(rule.key, {
            wallMs: ruleWallMs,
            eventsPerSec: archive.events.length * horizons.length / Math.max(ruleWallMs / 1000, Number.EPSILON),
            scoredCandidates: ruleDiagnostics.scoredCandidates,
            gateMs: ruleDiagnostics.gateMs,
            scoreMs: ruleDiagnostics.scoreMs,
            refsMs: ruleDiagnostics.refsMs,
            freqMs: ruleDiagnostics.freqMs,
            heapAfterMb: heapAfter,
        });
        args.update({ diagnosticsLines: buildDiagnosticsLines(args, diagnosticsState, horizons) });
    }

    const summary = buildSummary(args.runId, args.folderPath, args.rules.length, results, reportLines);
    const done: SelectionRulesDoneEvent = {
        type: "done",
        runId: args.runId,
        ok: true,
        cancelled: false,
        finishedAt: Date.now(),
        summary,
        results: [...results],
        reportLines: [...reportLines],
        diagnosticsLines: buildDiagnosticsLines(args, diagnosticsState, horizons),
    };
    args.update({
        phase: "done",
        completedRules: args.rules.length,
        currentRuleKey: null,
        currentHorizonBars: null,
        results: [...results],
        reportLines: [...reportLines],
        diagnosticsLines: done.diagnosticsLines,
        summary,
        finishedAt: done.finishedAt,
    });
    args.emit(done);
}

export function createSelectionRulesFatalEvent(
    args: Pick<SelectionRulesJobArgs, "runId" | "folderPath" | "rules">,
    results: SelectionRuleResult[],
    reportLines: string[],
    error: string,
    diagnosticsLines: string[] = [],
): SelectionRulesFatalEvent {
    const summary = results.length > 0
        ? buildSummary(args.runId, args.folderPath, args.rules.length, results, reportLines)
        : null;
    return {
        type: "fatal",
        runId: args.runId,
        ok: false,
        cancelled: false,
        finishedAt: Date.now(),
        error,
        summary,
        results: [...results],
        reportLines: [...reportLines],
        diagnosticsLines: [...diagnosticsLines],
    };
}

export function createSelectionRulesCancelledEvent(
    args: Pick<SelectionRulesJobArgs, "runId" | "folderPath" | "rules">,
    results: SelectionRuleResult[],
    reportLines: string[],
    diagnosticsLines: string[] = [],
): SelectionRulesCancelledEvent {
    const summary = buildSummary(args.runId, args.folderPath, args.rules.length, results, reportLines);
    return {
        type: "cancelled",
        runId: args.runId,
        ok: false,
        cancelled: true,
        finishedAt: Date.now(),
        summary,
        results: [...results],
        reportLines: [...reportLines],
        diagnosticsLines: [...diagnosticsLines],
    };
}
