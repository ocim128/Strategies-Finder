/**
 * Trade-ledger scale benchmark (audit W7 — throwaway/manual tool, NOT a spec).
 *
 * Generates a synthetic ~2M-row ledger v2 folder (fake pairs, valid row shape
 * including asIf) and runs the offline checker over it once, reporting:
 *   - generation time + folder size
 *   - checker load (provenance/summary/ledger/ranks parse) duration
 *   - full replay + report duration
 *   - peak heap (sampled heapUsed + process.resourceUsage().maxRSS)
 *
 * Usage:
 *   NODE_OPTIONS=--max-old-space-size=8192 ..\..\..\node_modules\.bin\esno scripts/bench-trade-ledger-scale.ts [rowsPerPair] [pairCount]
 *
 * Defaults: 4000 rows/pair x 500 pairs = 2,000,000 rows. The generated folder
 * lands in archive/trade-ledger-scale-bench (gitignored) — delete it after use.
 */

import { createWriteStream, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
    TRADE_LEDGER_VERSION,
    type TradeLedgerRow,
} from "../lib/batch-backtest/trade-ledger-exporter";
import { buildCheckerReport, loadLedgerForReplay, type LedgerRule } from "./trade-ledger-checker";

const REPO_ROOT = process.cwd();
const OUT_DIR = path.join(REPO_ROOT, "archive", "trade-ledger-scale-bench");

function synthRow(pair: string, i: number, pairIndex: number): TradeLedgerRow {
    const entry = 100 + i * 0.01;
    const exit = entry * (1 + ((i % 7) - 3) * 0.001);
    return {
        ledgerVersion: TRADE_LEDGER_VERSION,
        pair,
        direction: "long",
        signalTime: 1_600_000_000 + i * 3600 + pairIndex,
        signalBarIndex: i,
        fillTime: 1_600_000_000 + (i + 1) * 3600 + pairIndex,
        fillPrice: entry,
        executed: i % 8 === 0,
        notExecutedReason: i % 8 === 0 ? null : "position_open",
        feat_entryRangePosition: 50,
        feat_atrPct: 1 + (i % 5) * 0.1,
        feat_return20: 0.5,
        feat_gapPct: 0.01,
        feat_dow: 1,
        feat_hour: 12,
        feat_pairWinRatePrior: null,
        feat_pairTradesPrior: 0,
        feat_rank: null,
        feat_candidatesAtTime: null,
        asIf: {
            fillTime: 1_600_000_000 + (i + 1) * 3600 + pairIndex,
            fillPrice: entry,
            exitTime: 1_600_000_000 + (i + 2) * 3600 + pairIndex,
            exitPrice: exit,
            pnlPercent: ((exit - entry) / entry) * 100,
            barsHeld: 1,
            exitReason: "signal",
        },
        asIfReason: null,
        ...(i % 8 === 0
            ? { exitTime: 1_600_000_000 + (i + 2) * 3600 + pairIndex, exitPrice: exit, pnlPercent: ((exit - entry) / entry) * 100, fees: 0.01, exitReason: "signal" as const }
            : {}),
    };
}

async function generate(rowsPerPair: number, pairCount: number): Promise<void> {
    await mkdir(OUT_DIR, { recursive: true });
    const ledgerPath = path.join(OUT_DIR, "ledger.jsonl");
    const ranksPath = path.join(OUT_DIR, "signal-ranks.jsonl");
    const started = Date.now();
    for (const [filePath, header] of [[ledgerPath, ""], [ranksPath, ""]] as const) {
        // truncate
        const ws = createWriteStream(filePath);
        await new Promise<void>((resolve) => ws.end(header, resolve));
    }
    for (let pairIndex = 0; pairIndex < pairCount; pairIndex += 1) {
        const pair = `SYN${String(pairIndex).padStart(4, "0")}+USD`;
        const ledgerWs = createWriteStream(ledgerPath, { flags: "a" });
        const ranksWs = createWriteStream(ranksPath, { flags: "a" });
        const ledgerChunks: string[] = [];
        const rankChunks: string[] = [];
        for (let i = 0; i < rowsPerPair; i += 1) {
            ledgerChunks.push(JSON.stringify(synthRow(pair, i, pairIndex)));
            // ranks: one entry per row (1 candidate at a time keeps the file small)
            rankChunks.push(JSON.stringify({ signalTime: 1_600_000_000 + i * 3600 + pairIndex, pair, rank: 1, candidatesAtTime: 1 }));
        }
        ledgerWs.end(ledgerChunks.join("\n") + "\n");
        ranksWs.end(rankChunks.join("\n") + "\n");
        await Promise.all([
            new Promise<void>((resolve, reject) => { ledgerWs.on("error", reject); ledgerWs.on("finish", resolve); }),
            new Promise<void>((resolve, reject) => { ranksWs.on("error", reject); ranksWs.on("finish", resolve); }),
        ]);
    }
    // summary + provenance (certified complete)
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(OUT_DIR, "provenance.json"), JSON.stringify({
        ledgerVersion: TRADE_LEDGER_VERSION, featureVersion: 2, runId: "bench", startedAt: new Date().toISOString(),
        interval: "4h", strategyKey: "bench", strategyParams: {}, backtestSettings: {}, capitalSettings: {},
        engineMode: "typescript", executionModel: "next_open", tradeDirection: "long", riskMode: "percentage",
        fees: { commissionPercent: 0, slippageBps: 0 }, pairCount, symbols: [], replay: {
            replayEligible: true, replayBlockers: [], maxOpenTrades: 1, cooldownBars: 0,
            executionModel: "next_open", tradeDirection: "long", allowSameBarExit: false,
            disableSignalExits: true, slippageRate: 0, commissionRate: 0,
        },
    }));
    await writeFile(path.join(OUT_DIR, "summary.json"), JSON.stringify({
        ledgerVersion: TRADE_LEDGER_VERSION, featureVersion: 2, runId: "bench",
        startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
        cancelled: false, ledgerComplete: true, failedWrites: 0, lastError: null,
        totals: { pairs: pairCount, signals: rowsPerPair * pairCount, executed: 0, notExecuted: 0 },
        suppressionRate: 0, rightCensored: 0, duplicateSignalsCollapsed: 0,
        submittedPairs: pairCount, loadedPairs: pairCount, rowBearingPairs: pairCount,
        emptyPairs: 0, failedPairs: [],
        perPairSuppression: [], topSuppressedPairs: [],
    }));
    const bytes = statSync(ledgerPath).size + statSync(ranksPath).size;
    console.log(`generated ${pairCount * rowsPerPair} rows for ${pairCount} pairs in ${((Date.now() - started) / 1000).toFixed(1)}s (${(bytes / 1024 / 1024).toFixed(1)} MB on disk)`);
}

async function main(): Promise<void> {
    const rowsPerPair = Math.max(1, Math.floor(Number(process.argv[2] ?? 4000)));
    const pairCount = Math.max(1, Math.floor(Number(process.argv[3] ?? 500)));
    await generate(rowsPerPair, pairCount);

    const heapSamples: number[] = [];
    const sampler = setInterval(() => {
        heapSamples.push(process.memoryUsage().heapUsed);
    }, 25);
    const totalStarted = Date.now();
    const loadStarted = Date.now();
    const loaded = await loadLedgerForReplay(OUT_DIR);
    const loadMs = Date.now() - loadStarted;
    const rule: LedgerRule = (row) => row.feat_atrPct !== null && row.feat_atrPct > 1.2;
    const report = buildCheckerReport({
        folder: OUT_DIR,
        ruleName: "bench-rule",
        rows: loaded.rows,
        joinedRankCount: loaded.joinedRankCount,
        rule,
        replay: loaded.replayParams,
        // Keep the bench fast: the control is not the subject; scale is.
        controlRuns: 20,
    });
    const totalMs = Date.now() - totalStarted;
    clearInterval(sampler);
    const peakSampled = heapSamples.length > 0 ? Math.max(...heapSamples) : 0;
    const maxRssKb = process.resourceUsage?.().maxRSS ?? 0;
    const firstLines = report.split("\n").slice(0, 8).join("\n");
    console.log(`load: ${loadMs}ms | replay+report: ${totalMs - loadMs}ms | total: ${totalMs}ms`);
    console.log(`peak heapUsed (25ms sampling): ${(peakSampled / 1024 / 1024).toFixed(0)} MB | maxRSS: ${(maxRssKb / 1024).toFixed(0)} MB`);
    console.log("--- report header ---");
    console.log(firstLines);
    const kept = report.split("\n").find((l) => l.startsWith("kept:"));
    console.log(kept ?? "(kept line missing)");
}

void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
