import { setImmediate } from "node:timers/promises";
import { loadSelectionArchive, tallySelectionRule, type SelectionArchive } from "./tally";
import type { SelectionRule } from "./types";
import {
    resultFromHorizon,
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
    rules: readonly SelectionRule[];
    signal: AbortSignal;
    loadArchive?: (folderPath: string) => SelectionArchive;
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
    const loadArchiveFn = args.loadArchive ?? loadSelectionArchive;

    args.update({ phase: "loading", currentRuleKey: null, currentHorizonBars: null });
    args.emit({
        type: "phase",
        runId: args.runId,
        phase: "loading",
        detail: "Loading and verifying archive files…",
        completedRules: 0,
        totalRules: args.rules.length,
        currentRuleKey: null,
        currentHorizonBars: null,
    });

    // This is intentionally the only archive load in the job. The core does
    // all file hashing and parsing; each horizon below reuses the loaded maps.
    const archive = loadArchiveFn(args.archiveFolderPath ?? args.folderPath);
    if (args.signal.aborted) {
        args.emit(cancelledEvent(args, results, reportLines));
        return;
    }

    args.update({ phase: "tallying" });
    args.emit({
        type: "phase",
        runId: args.runId,
        phase: "tallying",
        detail: "Tallying selection rules…",
        completedRules: 0,
        totalRules: args.rules.length,
        currentRuleKey: null,
        currentHorizonBars: null,
    });

    for (let ruleIndex = 0; ruleIndex < args.rules.length; ruleIndex += 1) {
        const rule = args.rules[ruleIndex]!;
        args.update({ phase: "tallying", currentRuleKey: rule.key, currentHorizonBars: null });
        for (let horizonIndex = 0; horizonIndex < archive.horizons.length; horizonIndex += 1) {
            const horizonBars = archive.horizons[horizonIndex]!;
            if (args.signal.aborted) {
                args.emit(cancelledEvent(args, results, reportLines));
                return;
            }
            args.update({ currentRuleKey: rule.key, currentHorizonBars: horizonBars });
            // Running the existing leaf once per horizon lets cancellation
            // land at a horizon boundary without changing its semantics.
            const horizonArchive: SelectionArchive = { ...archive, horizons: [horizonBars] };
            const tally = tallySelectionRule(horizonArchive, rule);
            const horizon = tally.horizons[0];
            if (!horizon) throw new Error(`Selection rule ${rule.key} returned no horizon ${horizonBars}.`);
            const result = resultFromHorizon(rule.key, rule.name, horizon, tally.reportLines);
            results.push(result);
            reportLines.push(...tally.reportLines);
            args.update({
                completedRules: horizonIndex === archive.horizons.length - 1 ? ruleIndex + 1 : ruleIndex,
                results: [...results],
                reportLines: [...reportLines],
            });
            args.emit({
                type: "rule_result",
                runId: args.runId,
                result,
                completedRules: horizonIndex === archive.horizons.length - 1 ? ruleIndex + 1 : ruleIndex,
                totalRules: args.rules.length,
            });
            // Yield to the HTTP event loop so Stop can be observed between
            // horizons/rules without introducing worker or queue machinery.
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
