import { setImmediate } from "node:timers/promises";
import { cpus } from "node:os";
import {
    loadPairSelectionArchive,
    tallyPairSelectionRule,
    type LoadPairSelectionArchiveOptions,
    type PairSelectionArchive,
    type PairSelectionResult,
} from "../pair-selection/tally";
import {
    activatePairFeatures,
    ensurePairFeatures,
    releasePairFeatures,
    writePairSelectionCheckReceipt,
} from "../pair-selection/feature-access";
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
    loadArchive?: (
        folderPath: string,
        options?: LoadPairSelectionArchiveOptions,
    ) => PairSelectionArchive | PromiseLike<PairSelectionArchive>;
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
    activationMs: number;
    eventsPerSec: number;
    scoredCandidates: number;
    unscoredEvents: number;
    gateMs: number;
    scoreMs: number;
    refsMs: number;
    freqMs: number;
    heapAfterMb: number | null;
}

interface SelectionRulesDiagnosticsState {
    loadWallMs: number;
    featurePreparationMs: number;
    featurePreparationMode: "none" | "hash-only" | "full";
    sourceValidationMs: number;
    featureGenerationMs: number;
    featureGenerationWorkers: number;
    archiveDiagnostics: PairSelectionArchive["diagnostics"] | null;
    heapAfterLoad: number | null;
    peakHeapUsed: number | null;
    rules: Map<string, SelectionRuleDiagnostics>;
}

function emptyTallyDiagnostics(): PairSelectionTallyDiagnostics {
    return { gateMs: 0, scoreMs: 0, refsMs: 0, freqMs: 0, scoredCandidates: 0, unscoredEvents: 0 };
}

function addTallyDiagnostics(target: PairSelectionTallyDiagnostics, source: PairSelectionTallyDiagnostics): void {
    target.gateMs += source.gateMs;
    target.scoreMs += source.scoreMs;
    target.refsMs += source.refsMs;
    target.freqMs += source.freqMs;
    target.scoredCandidates += source.scoredCandidates;
    target.unscoredEvents += source.unscoredEvents;
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
        `load folder=${args.folderPath} horizon=${horizons.join(",")} loadWallMs=${formatMs(state.loadWallMs)} jsonParseMs=${formatMs(load?.jsonParseMs ?? 0)} streamWallMs=${formatMs(load?.streamWallMs ?? 0)} readResidualMs=${formatMs(load?.readResidualMs ?? 0)} rankRows=${load?.rankRowsParsed ?? 0} rankJsonParseMs=${formatMs(load?.rankJsonParseMs ?? 0)} rankStreamWallMs=${formatMs(load?.rankStreamWallMs ?? 0)} rankReadResidualMs=${formatMs(load?.rankReadResidualMs ?? 0)} rankJoinMs=${formatMs(load?.rankJoinMs ?? 0)} rankJoinMode=${load?.rankJoinFused ? "fused" : "separate"} ranksLoaded=${load?.ranksLoaded === true} rows=${load?.rows ?? 0} events=${load?.events ?? 0} candidates=${load?.candidates ?? 0}`,
        `heap afterLoadMb=${formatMb(state.heapAfterLoad)}`,
        `preparation featurePreparationMs=${formatMs(state.featurePreparationMs)} sourceValidationMode=${state.featurePreparationMode} sourceValidationMs=${formatMs(state.sourceValidationMs)} featureGenerationMs=${formatMs(state.featureGenerationMs)} featureGenerationWorkers=${state.featureGenerationWorkers} consumeMs=${formatMs(load?.consumeMs ?? 0)} streamOverheadMs=${formatMs(Math.max(0, (load?.readResidualMs ?? 0) - (load?.consumeMs ?? 0)))} readResidualIncludesConsume=true refsIncludesOutcomeIndex=true heapSampling=after-load-and-each-rule`,
        `heap peakDeltaMb=${formatMb(peakDelta)} peakAfterRulesMb=${formatMb(state.peakHeapUsed)}`,
        ...args.rules.map((rule) => {
            const diagnostics = state.rules.get(rule.key);
            const wallMs = diagnostics?.wallMs ?? 0;
            const events = load?.events ?? 0;
            const eventsPerSec = diagnostics?.eventsPerSec ?? 0;
            return `rule=${rule.key} horizon=${horizons.join(",")} wallMs=${formatMs(wallMs)} activationMs=${formatMs(diagnostics?.activationMs ?? 0)} eventsPerSec=${eventsPerSec.toFixed(2)} scoredCandidates=${diagnostics?.scoredCandidates ?? 0} unscoredEvents=${diagnostics?.unscoredEvents ?? 0} gateMs=${formatMs(diagnostics?.gateMs ?? 0)} scoreMs=${formatMs(diagnostics?.scoreMs ?? 0)} refsMs=${formatMs(diagnostics?.refsMs ?? 0)} freqMs=${formatMs(diagnostics?.freqMs ?? 0)} heapAfterMb=${formatMb(diagnostics?.heapAfterMb ?? null)} events=${events}`;
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
    const featureResults: PairSelectionResult[] = [];
    const reportLines: string[] = [];
    const loadArchiveFn = args.loadArchive ?? loadPairSelectionArchive;
    const includeSignalRanks = args.rules.some((rule) => rule.metadata?.usesRankFeatures === true);
    const diagnosticsState: SelectionRulesDiagnosticsState = {
        loadWallMs: 0,
        featurePreparationMs: 0,
        featurePreparationMode: "none",
        sourceValidationMs: 0,
        featureGenerationMs: 0,
        featureGenerationWorkers: 0,
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
        detail: includeSignalRanks
            ? "Loading and verifying pair-selection ledger and rank sidecar…"
            : "Loading and verifying pair-selection ledger…",
        completedRules: 0,
        totalRules: args.rules.length,
        currentRuleKey: null,
        currentHorizonBars: null,
    });

    const archiveFolderPath = args.archiveFolderPath ?? args.folderPath;
    const featurePreparationStartedAt = performance.now();
    const prepared = await ensurePairFeatures(archiveFolderPath, args.rules, args.signal, (progress) => {
        const coverage = progress.allNullFeatureIds.length > 0
            ? ` all-null=${progress.allNullFeatureIds.join(",")}`
            : "";
        const detail = `Preparing pair features (${progress.familyId}: ${progress.featureIds.join(",")}; computed=${progress.computedColumns}; reused=${progress.reusedColumns}; compressedBytes=${progress.compressedBytes})${coverage}…`;
        args.update({ phase: "loading" });
        args.emit({
            type: "phase",
            runId: args.runId,
            phase: "loading",
            detail,
            completedRules: 0,
            totalRules: args.rules.length,
            currentRuleKey: null,
            currentHorizonBars: null,
        });
    });
    diagnosticsState.featurePreparationMs = performance.now() - featurePreparationStartedAt;
    diagnosticsState.featurePreparationMode = prepared.sourceValidationMode;
    diagnosticsState.sourceValidationMs = prepared.sourceValidationMs;
    diagnosticsState.featureGenerationMs = prepared.featureGenerationMs;
    diagnosticsState.featureGenerationWorkers = prepared.featureGenerationWorkers;
    if (args.signal.aborted) {
        args.emit(cancelledEvent(args, results, reportLines, buildDiagnosticsLines(args, diagnosticsState, horizons)));
        return;
    }

    // This is intentionally the only archive load in the job. Each rule and
    // horizon reuses the parsed, validated pair-selection archive.
    const loadStartedAt = performance.now();
    let archive: PairSelectionArchive;
    try {
        const archiveOptions: LoadPairSelectionArchiveOptions = {
            includeSignalRanks,
            onProgress: ({ file, rowsParsed }) => {
                args.emit({
                    type: "phase",
                    runId: args.runId,
                    phase: "loading",
                    detail: file === "ledger"
                        ? `Loading and verifying pair-selection ledger (${rowsParsed.toLocaleString()} rows)…`
                        : `Loading pair-selection rank sidecar (${rowsParsed.toLocaleString()} rows)…`,
                    completedRules: 0,
                    totalRules: args.rules.length,
                    currentRuleKey: null,
                    currentHorizonBars: null,
                });
            },
        };
        if (args.horizonBars !== undefined) archiveOptions.retainHorizonBars = args.horizonBars;
        archive = await loadArchiveFn(
            archiveFolderPath,
            archiveOptions,
        );
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
        const activeFeatures = await activatePairFeatures(prepared, rule, args.signal);
        const activationMs = performance.now() - ruleStartedAt;
        if (args.signal.aborted) {
            releasePairFeatures(prepared);
            args.emit(cancelledEvent(args, results, reportLines, buildDiagnosticsLines(args, diagnosticsState, horizons)));
            return;
        }
        const ruleDiagnostics = emptyTallyDiagnostics();
        args.update({ phase: "tallying", currentRuleKey: rule.key, currentHorizonBars: null });
        for (let horizonIndex = 0; horizonIndex < horizons.length; horizonIndex += 1) {
            const horizonBars = horizons[horizonIndex]!;
            if (args.signal.aborted) {
                args.emit(cancelledEvent(args, results, reportLines, buildDiagnosticsLines(args, diagnosticsState, horizons)));
                return;
            }
            args.update({ currentRuleKey: rule.key, currentHorizonBars: horizonBars });
            const tally = tallyPairSelectionRule(archive, rule, undefined, horizonBars, activeFeatures ?? undefined);
            addTallyDiagnostics(ruleDiagnostics, tally.diagnostics);
            featureResults.push(tally);
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
            activationMs,
            eventsPerSec: archive.events.length * horizons.length / Math.max(ruleWallMs / 1000, Number.EPSILON),
            scoredCandidates: ruleDiagnostics.scoredCandidates,
            unscoredEvents: ruleDiagnostics.unscoredEvents,
            gateMs: ruleDiagnostics.gateMs,
            scoreMs: ruleDiagnostics.scoreMs,
            refsMs: ruleDiagnostics.refsMs,
            freqMs: ruleDiagnostics.freqMs,
            heapAfterMb: heapAfter,
        });
        args.update({ diagnosticsLines: buildDiagnosticsLines(args, diagnosticsState, horizons) });
    }

    if (prepared.sourceSnapshotSha256 !== null) {
        if (args.signal.aborted) {
            releasePairFeatures(prepared);
            args.emit(cancelledEvent(args, results, reportLines, buildDiagnosticsLines(args, diagnosticsState, horizons)));
            return;
        }
        try {
            await writePairSelectionCheckReceipt({
                prepared,
                rules: args.rules,
                horizons,
                results: featureResults,
                signal: args.signal,
            });
        } catch (error) {
            if (args.signal.aborted) {
                releasePairFeatures(prepared);
                args.emit(cancelledEvent(args, results, reportLines, buildDiagnosticsLines(args, diagnosticsState, horizons)));
                return;
            }
            throw error;
        }
        if (args.signal.aborted) {
            releasePairFeatures(prepared);
            args.emit(cancelledEvent(args, results, reportLines, buildDiagnosticsLines(args, diagnosticsState, horizons)));
            return;
        }
    }
    releasePairFeatures(prepared);

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
    if (args.signal.aborted) {
        args.emit(cancelledEvent(args, results, reportLines, buildDiagnosticsLines(args, diagnosticsState, horizons)));
        return;
    }
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
