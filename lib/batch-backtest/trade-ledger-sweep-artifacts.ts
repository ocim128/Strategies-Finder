/** Durable, Node-only artifacts for a Ledger Rule Sweep. */

import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
    TRADE_LEDGER_CONTROL_RUNS,
    TRADE_LEDGER_CONTROL_SEED,
    TRADE_LEDGER_IS_FRACTION,
} from "./trade-ledger-replay-core";
import {
    countTradeLedgerVerdicts,
    sortTradeLedgerVerdicts,
    type TradeLedgerVerdictRow,
} from "../batch-backtest/trade-ledger-verdict";
import type { LedgerSweepFolderCatalogEntry, LedgerSweepRuleCatalogEntry } from "./trade-ledger-sweep-catalog";
import type { LedgerSweepPreflightDecision } from "./trade-ledger-sweep-preflight";
import type { LedgerSweepDiagnosticsV1, LedgerSweepDiagnosticEntry, LedgerSweepMode } from "./trade-ledger-sweep-diagnostics";
import { buildTradeLedgerSweepDiagnosticsSummary } from "./trade-ledger-sweep-diagnostics-summary";
import type { LedgerSweepRuleResult } from "./trade-ledger-sweep-stream-types";

export interface TradeLedgerSweepManifest {
    schema: "trade_ledger_sweep.manifest.v1";
    runId: string;
    folderId: string;
    folderName: string;
    ledgerFolder: string;
    outputDir: string;
    ledgerBytes: number;
    ledgerModifiedAt: number;
    rankBytes: number;
    rankModifiedAt: number | null;
    provenanceSha256: string | null;
    summarySha256: string | null;
    rules: Array<{ ruleId: string; ruleName: string; sourceHash: string }>;
    replay: { isFraction: number; controlRuns: number; controlSeed: number };
    preflight: LedgerSweepPreflightDecision;
    mode: LedgerSweepMode;
    startedAt: number;
    finishedAt: number | null;
    terminalPhase: "running" | "done" | "cancelled" | "fatal";
    complete: boolean;
    error: string | null;
}

export interface CreateSweepArtifactsArgs {
    outputAbsolutePath: string;
    outputDir: string;
    runId: string;
    folder: LedgerSweepFolderCatalogEntry;
    folderAbsolutePath: string;
    rules: readonly LedgerSweepRuleCatalogEntry[];
    mode: LedgerSweepMode;
    preflight: LedgerSweepPreflightDecision;
    startedAt: number;
}

export interface FinalizeSweepArtifactsArgs {
    terminalPhase: "done" | "cancelled" | "fatal";
    finishedAt: number;
    results: readonly LedgerSweepRuleResult[];
    diagnostics: LedgerSweepDiagnosticsV1;
    summary: string | null;
    error: string | null;
}

export interface TradeLedgerSweepArtifacts {
    readonly outputAbsolutePath: string;
    readonly manifest: TradeLedgerSweepManifest;
    appendRuleResult(result: LedgerSweepRuleResult): Promise<void>;
    appendDiagnostic(entry: LedgerSweepDiagnosticEntry): Promise<void>;
    writeRuleReport(ruleId: string, reportText: string): Promise<string>;
    finalize(args: FinalizeSweepArtifactsArgs): Promise<void>;
}

export interface TradeLedgerSweepVerdictDifference {
    ruleId: string;
    artifactVerdict: string;
    ideaLogVerdict: string;
}

async function hashSmallFile(filePath: string): Promise<string | null> {
    try {
        const bytes = await readFile(filePath);
        return createHash("sha256").update(bytes).digest("hex");
    } catch {
        return null;
    }
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
    const temporary = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(temporary, content, "utf8");
    await rename(temporary, filePath);
}

function jsonLine(value: unknown): string {
    return `${JSON.stringify(value)}\n`;
}

function ruleRows(results: readonly LedgerSweepRuleResult[]): TradeLedgerVerdictRow[] {
    return results.map((result) => ({
        ruleName: result.ruleName,
        keptPct: result.keptPct,
        isMeanPnlDeltaPp: result.isMeanPnlDeltaPp,
        isMedianPnlDeltaPp: result.isMedianPnlDeltaPp,
        holdoutMeanPnlDeltaPp: result.holdoutMeanPnlDeltaPp,
        holdoutMedianPnlDeltaPp: result.holdoutMedianPnlDeltaPp,
        error: result.error,
        verdict: result.verdict,
        weak: result.weak,
        note: result.note ?? "",
    }));
}

function formatSigned(value: number | null, digits = 2): string {
    if (value === null || !Number.isFinite(value)) return "n/a";
    return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

export function buildTradeLedgerSweepSummary(
    results: readonly LedgerSweepRuleResult[],
    warning = "NOTE: verdicts are specific to THIS ledger folder. EDGE-CANDIDATE still needs cross-surface replication.",
    diagnostics?: LedgerSweepDiagnosticsV1,
): string {
    const sorted = sortTradeLedgerVerdicts(ruleRows(results));
    const lines = [
        `SWEEP SUMMARY — ${sorted.length} rules — bar: IS >= +0.3pp & kept >= 2% & holdout > 0`,
        "=".repeat(100),
        ["verdict".padEnd(15), "kept%".padStart(8), "IS mean".padStart(9), "IS med".padStart(9), "hold mean".padStart(10), "hold med".padStart(9), "  rule"].join(""),
        "-".repeat(100),
        ...sorted.map((row) => [
            row.verdict.padEnd(15),
            row.keptPct === null ? "n/a".padStart(8) : `${row.keptPct.toFixed(2)}%`.padStart(8),
            formatSigned(row.isMeanPnlDeltaPp).padStart(9),
            formatSigned(row.isMedianPnlDeltaPp).padStart(9),
            formatSigned(row.holdoutMeanPnlDeltaPp).padStart(10),
            formatSigned(row.holdoutMedianPnlDeltaPp).padStart(9),
            `  ${row.ruleName}${row.note ? `   [${row.note}]` : ""}`,
        ].join("")),
        "-".repeat(100),
        [...countTradeLedgerVerdicts(sorted).entries()].map(([verdict, count]) => `${verdict}: ${count}`).join(" | "),
        warning,
        "NOTE: 'weak' = the typical (median) trade is not better than control; the mean is carried by big winners.",
        ...(diagnostics ? [buildTradeLedgerSweepDiagnosticsFooter(diagnostics)] : []),
    ];
    return lines.join("\n");
}

export function buildTradeLedgerSweepDiagnosticsFooter(diagnostics: LedgerSweepDiagnosticsV1): string {
    const replayMs = diagnostics.perRule.reduce((sum, row) => sum + row.ruleReplayMs, 0);
    const controlsMs = diagnostics.perRule.reduce((sum, row) => sum + row.controlReplayMs, 0);
    const wallMs = Number(diagnostics.throughput.elapsedMs);
    const replayPlusControlsMs = replayMs + controlsMs;
    const controlsOfReplay = replayPlusControlsMs > 0 ? controlsMs / replayPlusControlsMs * 100 : null;
    const controlsOfWall = wallMs > 0 ? controlsMs / wallMs * 100 : null;
    const format = (value: number | null): string => value === null || !Number.isFinite(value) ? "n/a" : `${value.toFixed(3)}%`;
    return `DIAGNOSTIC BOTTLENECK: random controls = ${format(controlsOfReplay)} of aggregate replay+controls and ${format(controlsOfWall)} of total wall; optimization target: lib/batch-backtest/trade-ledger-replay-core.ts:replayRandomControlRows; preserve calibration, seeds, and exact replay math.`;
}

function normalizedIdeaLogVerdict(value: string): string {
    return value === "EDGE" ? "EDGE-CANDIDATE" : value;
}

async function readVerdictDifferences(folderAbsolutePath: string, results: readonly LedgerSweepRuleResult[]): Promise<TradeLedgerSweepVerdictDifference[]> {
    let text: string;
    try {
        text = await readFile(path.join(path.dirname(folderAbsolutePath), "idea-log.txt"), "utf8");
    } catch {
        return [];
    }
    const logVerdicts = new Map<string, string>();
    for (const line of text.split(/\r?\n/)) {
        const match = /^Q(\d+)\|[^|]+\|[^|]*\|([^\s|]+)/.exec(line);
        if (match) logVerdicts.set(`q${match[1]}`, normalizedIdeaLogVerdict(match[2]!));
    }
    return results.flatMap((result) => {
        const id = /^q(\d+)(?:-|$)/i.exec(result.ruleId)?.[1];
        const ideaLogVerdict = id ? logVerdicts.get(`q${id}`) : undefined;
        if (!ideaLogVerdict || ideaLogVerdict === result.verdict) return [];
        return [{ ruleId: result.ruleId, artifactVerdict: result.verdict, ideaLogVerdict }];
    });
}

async function fileMtime(filePath: string): Promise<number | null> {
    try { return (await stat(filePath)).mtimeMs; } catch { return null; }
}

function sortedResults(results: readonly LedgerSweepRuleResult[]): LedgerSweepRuleResult[] {
    const decorated = results.map((result) => ({ result, verdict: ruleRows([result])[0]! }));
    return sortTradeLedgerVerdicts(decorated.map((item) => item.verdict))
        .map((verdict) => decorated.find((item) => item.verdict === verdict)!.result);
}

export async function createTradeLedgerSweepArtifacts(args: CreateSweepArtifactsArgs): Promise<TradeLedgerSweepArtifacts> {
    await mkdir(path.dirname(args.outputAbsolutePath), { recursive: true });
    await mkdir(args.outputAbsolutePath, { recursive: false });
    await mkdir(path.join(args.outputAbsolutePath, "reports"), { recursive: false });
    const rankPath = path.join(args.folderAbsolutePath, "signal-ranks.jsonl");
    const manifest: TradeLedgerSweepManifest = {
        schema: "trade_ledger_sweep.manifest.v1",
        runId: args.runId,
        folderId: args.folder.folderId,
        folderName: args.folder.name,
        ledgerFolder: path.posix.join("archive/mining-ledger", args.folder.folderId),
        outputDir: args.outputDir,
        ledgerBytes: args.folder.ledgerBytes,
        ledgerModifiedAt: args.folder.modifiedAt,
        rankBytes: args.folder.rankBytes,
        rankModifiedAt: args.folder.rankBytes > 0 ? await fileMtime(rankPath) : null,
        provenanceSha256: await hashSmallFile(path.join(args.folderAbsolutePath, "provenance.json")),
        summarySha256: await hashSmallFile(path.join(args.folderAbsolutePath, "summary.json")),
        rules: args.rules.map((rule) => ({ ruleId: rule.ruleId, ruleName: rule.ruleName, sourceHash: rule.sourceHash })),
        replay: { isFraction: TRADE_LEDGER_IS_FRACTION, controlRuns: TRADE_LEDGER_CONTROL_RUNS, controlSeed: TRADE_LEDGER_CONTROL_SEED },
        preflight: args.preflight,
        mode: args.mode,
        startedAt: args.startedAt,
        finishedAt: null,
        terminalPhase: "running",
        complete: false,
        error: null,
    };
    await atomicWrite(path.join(args.outputAbsolutePath, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    await writeFile(path.join(args.outputAbsolutePath, "rule-results.jsonl"), "", "utf8");
    await writeFile(path.join(args.outputAbsolutePath, "diagnostics.jsonl"), "", "utf8");
    await writeFile(path.join(args.outputAbsolutePath, "full-report.txt"), "", "utf8");
    return {
        outputAbsolutePath: args.outputAbsolutePath,
        manifest,
        appendRuleResult: (result) => appendFile(path.join(args.outputAbsolutePath, "rule-results.jsonl"), jsonLine(result), "utf8"),
        appendDiagnostic: (entry) => appendFile(path.join(args.outputAbsolutePath, "diagnostics.jsonl"), jsonLine(entry), "utf8"),
        async writeRuleReport(ruleId, reportText) {
            const reportPath = path.join(args.outputAbsolutePath, "reports", `${ruleId}.txt`);
            await atomicWrite(reportPath, reportText.endsWith("\n") ? reportText : `${reportText}\n`);
            await appendFile(path.join(args.outputAbsolutePath, "full-report.txt"), `===== ${ruleId} =====\n${reportText}\n\n`, "utf8");
            return path.posix.join("reports", `${ruleId}.txt`);
        },
        async finalize(finalArgs) {
            manifest.finishedAt = finalArgs.finishedAt;
            manifest.terminalPhase = finalArgs.terminalPhase;
            manifest.complete = finalArgs.terminalPhase === "done";
            manifest.error = finalArgs.error;
            const diagnosticFooter = buildTradeLedgerSweepDiagnosticsFooter(finalArgs.diagnostics);
            const verdictDifferences = await readVerdictDifferences(args.folderAbsolutePath, finalArgs.results);
            const summaryText = finalArgs.summary ?? buildTradeLedgerSweepSummary(finalArgs.results, undefined, finalArgs.diagnostics);
            await atomicWrite(path.join(args.outputAbsolutePath, "summary.txt"), `${summaryText}\n`);
            await atomicWrite(path.join(args.outputAbsolutePath, "summary.json"), JSON.stringify({
                schema: "trade_ledger_sweep.summary.v1",
                runId: args.runId,
                folderId: args.folder.folderId,
                terminalPhase: finalArgs.terminalPhase,
                complete: manifest.complete,
                results: sortedResults(finalArgs.results),
                verdictCounts: Object.fromEntries(countTradeLedgerVerdicts(ruleRows(finalArgs.results))),
                diagnosticFooter,
                artifactVsIdeaLogVerdictDifferences: verdictDifferences,
                outputDir: args.outputDir,
                error: finalArgs.error,
            }, null, 2) + "\n");
            await atomicWrite(path.join(args.outputAbsolutePath, "diagnostics.json"), JSON.stringify(finalArgs.diagnostics, null, 2) + "\n");
            await atomicWrite(path.join(args.outputAbsolutePath, "diagnostics-summary.json"), JSON.stringify(buildTradeLedgerSweepDiagnosticsSummary(finalArgs.diagnostics, finalArgs.terminalPhase), null, 2) + "\n");
            await atomicWrite(path.join(args.outputAbsolutePath, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
        },
    };
}
