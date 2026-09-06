import { setImmediate } from "node:timers/promises";
import { loadPairSelectionArchive, tallyPairSelectionRule, type PairSelectionArchive } from "../pair-selection/tally";
import type { PairSelectionRule } from "../pair-selection/types";
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
        summary?: SelectionRulesSummary | null;
        finishedAt?: number | null;
        error?: string | null;
    }) => void;
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
    };
}

export async function runSelectionRulesJob(args: SelectionRulesJobArgs): Promise<void> {
    const results: SelectionRuleResult[] = [];
    const reportLines: string[] = [];
    const loadArchiveFn = args.loadArchive ?? loadPairSelectionArchive;

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
    const archive = await loadArchiveFn(args.archiveFolderPath ?? args.folderPath);
    if (args.signal.aborted) {
        args.emit(cancelledEvent(args, results, reportLines));
        return;
    }
    const horizons = args.horizonBars === undefined ? [...archive.ledgerHorizons] : [args.horizonBars];

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
        args.update({ phase: "tallying", currentRuleKey: rule.key, currentHorizonBars: null });
        for (let horizonIndex = 0; horizonIndex < horizons.length; horizonIndex += 1) {
            const horizonBars = horizons[horizonIndex]!;
            if (args.signal.aborted) {
                args.emit(cancelledEvent(args, results, reportLines));
                return;
            }
            args.update({ currentRuleKey: rule.key, currentHorizonBars: horizonBars });
            const tally = tallyPairSelectionRule(archive, rule, undefined, horizonBars);
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
                args.emit(cancelledEvent(args, results, reportLines));
                return;
            }
        }
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
    };
    args.update({
        phase: "done",
        completedRules: args.rules.length,
        currentRuleKey: null,
        currentHorizonBars: null,
        results: [...results],
        reportLines: [...reportLines],
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
    };
}

export function createSelectionRulesCancelledEvent(
    args: Pick<SelectionRulesJobArgs, "runId" | "folderPath" | "rules">,
    results: SelectionRuleResult[],
    reportLines: string[],
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
    };
}
