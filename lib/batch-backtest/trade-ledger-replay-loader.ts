/**
 * Node-only streaming loader and replay eligibility validator for ledger v2/v3.
 *
 * The loader owns filesystem access and rank joining. Replay semantics stay in
 * trade-ledger-replay-core so the worker and legacy CLI share one core.
 */

import { existsSync, readFileSync, statSync, createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import {
    TRADE_LEDGER_SUPPORTED_VERSIONS,
    type TradeLedgerProvenance,
    type TradeLedgerRankRow,
    type TradeLedgerRow,
} from "./trade-ledger-schema";

const LEDGER_FILE = "ledger.jsonl";
const RANKS_FILE = "signal-ranks.jsonl";
const PROVENANCE_FILE = "provenance.json";
const SUMMARY_FILE = "summary.json";

export interface LedgerJsonlDiagnostics {
    streamWallMs: number;
    jsonParseMs: number;
    rowsParsed: number;
    bytesRead: number;
    readResidualMs: number;
}

export interface LedgerReplayLoadDiagnostics {
    ledger: LedgerJsonlDiagnostics;
    ranks: LedgerJsonlDiagnostics;
    rankJoinMs: number;
    joinedRows: number;
    unmatchedRows: number;
}

function nowMs(): number {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function emptyJsonlDiagnostics(bytesRead = 0): LedgerJsonlDiagnostics {
    return { streamWallMs: 0, jsonParseMs: 0, rowsParsed: 0, bytesRead, readResidualMs: 0 };
}

/**
 * Async-generator over JSONL lines using a chunked read stream + readline, so
 * a multi-million-row ledger is never materialized as one Buffer/string.
 * Handles CRLF, empty lines, missing trailing newline, and UTF-8 pair names.
 */
export async function* iterateJsonlLines(filePath: string): AsyncGenerator<string> {
    const stream = createReadStream(filePath, { encoding: "utf8" });
    const reader = createInterface({ input: stream, crlfDelay: Infinity });
    let firstLine = true;
    try {
        for await (const rawLine of reader) {
            let line = rawLine.trim();
            if (firstLine) {
                // Tolerate a UTF-8 BOM on the first line.
                if (line.startsWith("\uFEFF")) line = line.slice(1).trim();
                firstLine = false;
            }
            if (line) yield line;
        }
    } finally {
        reader.close();
        stream.destroy();
    }
}

async function readJsonl<T>(
    filePath: string,
    consume?: (value: T) => void,
): Promise<{ values: T[]; diagnostics: LedgerJsonlDiagnostics }> {
    const diagnostics = emptyJsonlDiagnostics(statSync(filePath).size);
    const values: T[] | null = consume ? null : [];
    const startedAt = nowMs();
    for await (const line of iterateJsonlLines(filePath)) {
        const parseStartedAt = nowMs();
        const value = JSON.parse(line) as T;
        if (consume) consume(value);
        else values!.push(value);
        diagnostics.jsonParseMs += nowMs() - parseStartedAt;
        diagnostics.rowsParsed += 1;
    }
    diagnostics.streamWallMs = nowMs() - startedAt;
    diagnostics.readResidualMs = Math.max(0, diagnostics.streamWallMs - diagnostics.jsonParseMs);
    return { values: values ?? [], diagnostics };
}

export async function loadLedgerRows(folder: string): Promise<TradeLedgerRow[]> {
    return (await readJsonl<TradeLedgerRow>(path.join(folder, LEDGER_FILE))).values;
}

/** Keyed by `${signalTime}|${pair}` — the join the checker performs. */
export async function loadSignalRanks(folder: string): Promise<Map<string, TradeLedgerRankRow>> {
    const ranksFile = path.join(folder, RANKS_FILE);
    const map = new Map<string, TradeLedgerRankRow>();
    if (!existsSync(ranksFile)) return map;
    await readJsonl<TradeLedgerRankRow>(ranksFile, (rank) => {
        map.set(`${rank.signalTime}|${rank.pair}`, rank);
    });
    return map;
}

/**
 * Mutates each row's `feat_rank` / `feat_candidatesAtTime` in place from the
 * ranks map. Returns the number of rows that matched a rank entry.
 */
export function joinSignalRanks(rows: TradeLedgerRow[], ranks: Map<string, TradeLedgerRankRow>): number {
    let joined = 0;
    for (const row of rows) {
        const rank = ranks.get(`${row.signalTime}|${row.pair}`);
        if (!rank) continue;
        row.feat_rank = rank.rank;
        row.feat_candidatesAtTime = rank.candidatesAtTime;
        joined += 1;
    }
    return joined;
}

export interface LoadedLedger {
    rows: TradeLedgerRow[];
    joinedRankCount: number;
    provenance: TradeLedgerProvenance;
    replayParams: { maxOpenTrades: number; cooldownBars: number; shift: number };
    /** Set ONLY when the folder is incomplete and --allow-incomplete overrode the refusal. */
    incomplete?: { failedWrites: number; failedPairs: string[] };
    diagnostics: LedgerReplayLoadDiagnostics;
}

export interface LoadLedgerOptions {
    /** Proceed on an incomplete ledger — the report carries a loud warning. */
    allowIncomplete?: boolean;
}

export function formatFailedPairList(failedPairs: readonly string[]): string {
    return failedPairs.length <= 20
        ? failedPairs.join(", ")
        : `${failedPairs.slice(0, 20).join(", ")} … and ${failedPairs.length - 20} more`;
}

/**
 * Load + validate a ledger folder for replay. Throws with a clear message on
 * v1 folders, replay-ineligible configs, and incomplete ledgers. The
 * `allowIncomplete` escape hatch feeds the report warning banner.
 */
export async function loadLedgerForReplay(folder: string, options: LoadLedgerOptions = {}): Promise<LoadedLedger> {
    const provenancePath = path.join(folder, PROVENANCE_FILE);
    if (!existsSync(provenancePath)) {
        throw new Error(`${PROVENANCE_FILE} not found in "${folder}" — not a trade-ledger run folder.`);
    }
    const provenance = JSON.parse(readFileSync(provenancePath, "utf8")) as TradeLedgerProvenance;
    if (!(TRADE_LEDGER_SUPPORTED_VERSIONS as readonly number[]).includes(provenance.ledgerVersion)) {
        throw new Error(
            `ledger v${provenance.ledgerVersion} — re-run the batch to regenerate (supported ledger versions: ${TRADE_LEDGER_SUPPORTED_VERSIONS.join(", ")}).`
        );
    }
    const replay = provenance.replay;
    if (!replay || replay.replayEligible !== true) {
        throw new Error(
            `Replay is not eligible for this run config. Blockers: ${replay?.replayBlockers?.join("; ") ?? "unknown"}. `
            + "Re-run the batch with a replay-eligible configuration (see docs/trade-ledger.md)."
        );
    }
    // The summary certifies that failed pair appends did not make the replay
    // silently incomplete.
    const summaryPath = path.join(folder, SUMMARY_FILE);
    if (!existsSync(summaryPath)) {
        throw new Error(
            `${SUMMARY_FILE} not found in "${folder}" — ledger completeness cannot be verified. `
            + "Re-run the batch or point at the correct per-run folder."
        );
    }
    const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as {
        ledgerVersion?: number;
        ledgerComplete?: boolean;
        failedWrites?: number;
        failedPairs?: string[];
    };
    if (summary.ledgerVersion !== provenance.ledgerVersion) {
        throw new Error(
            `summary.json ledgerVersion ${String(summary.ledgerVersion)} is unsupported or does not match provenance ledgerVersion ${String(provenance.ledgerVersion)}. Re-run the batch.`
        );
    }
    const failedPairs = Array.isArray(summary.failedPairs) ? summary.failedPairs : [];
    let incomplete: LoadedLedger["incomplete"];
    if (summary.ledgerComplete !== true || (summary.failedWrites ?? 0) !== 0) {
        const reason = summary.ledgerComplete !== true
            ? `ledgerComplete=false, failedWrites=${String(summary.failedWrites ?? 0)}`
            : `failedWrites=${String(summary.failedWrites ?? 0)}`;
        const message = `Refusing incomplete ledger: ${reason}. Dropped pair rows (${failedPairs.length}): ${formatFailedPairList(failedPairs) || "(none recorded — pre-W2 summary)"}. `
            + "Re-run the batch, or pass --allow-incomplete to proceed with a loud warning banner in the report.";
        if (options.allowIncomplete !== true) throw new Error(message);
        incomplete = { failedWrites: summary.failedWrites ?? 0, failedPairs };
    }
    const ledgerPath = path.join(folder, LEDGER_FILE);
    if (!existsSync(ledgerPath)) {
        throw new Error(`${LEDGER_FILE} not found in "${folder}" — the run wrote no ledger rows.`);
    }
    const shift = replay.executionModel === "signal_close" ? 0 : 1;
    const loadedRows = await readJsonl<TradeLedgerRow>(ledgerPath);
    const rows = loadedRows.values;
    const ranksFile = path.join(folder, RANKS_FILE);
    const ranks = new Map<string, TradeLedgerRankRow>();
    const loadedRanks = existsSync(ranksFile)
        ? await readJsonl<TradeLedgerRankRow>(ranksFile, (rank) => {
            ranks.set(`${rank.signalTime}|${rank.pair}`, rank);
        })
        : { values: [], diagnostics: emptyJsonlDiagnostics() };
    const joinStartedAt = nowMs();
    const joinedRankCount = joinSignalRanks(rows, ranks);
    const rankJoinMs = nowMs() - joinStartedAt;
    return {
        rows,
        joinedRankCount,
        provenance,
        replayParams: {
            maxOpenTrades: replay.maxOpenTrades === "unlimited" ? Number.POSITIVE_INFINITY : Number(replay.maxOpenTrades),
            cooldownBars: replay.cooldownBars,
            shift,
        },
        incomplete,
        diagnostics: {
            ledger: loadedRows.diagnostics,
            ranks: loadedRanks.diagnostics,
            rankJoinMs,
            joinedRows: joinedRankCount,
            unmatchedRows: rows.length - joinedRankCount,
        },
    };
}
