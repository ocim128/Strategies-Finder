/**
 * Summarize a test-all-rules sweep report into a plain verdict table.
 * Classification and ordering are delegated to the shared verdict leaf.
 *
 * Usage: esno summarize-report.ts <report.txt>
 * Writes <report.txt>.summary.txt next to the input.
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
    TRADE_LEDGER_EDGE_BAR_PP,
    TRADE_LEDGER_EDGE_MIN_KEPT_PCT,
    classifyTradeLedgerVerdict,
    countTradeLedgerVerdicts,
    sortTradeLedgerVerdicts,
    type TradeLedgerVerdictRow,
} from "../../lib/batch-backtest/trade-ledger-verdict";

function parseNum(text: string, pattern: RegExp): number | null {
    const m = text.match(pattern);
    if (!m) return null;
    const v = Number.parseFloat(m[1]!);
    return Number.isFinite(v) ? v : null;
}

function classify(block: string): TradeLedgerVerdictRow {
    const nameMatch = block.match(/^===== (.+?) =====$/m);
    const ruleName = nameMatch ? nameMatch[1]! : "(unknown)";
    const failMatch = block.match(/trade-ledger-checker failed: (.+)/);
    if (failMatch) {
        return classifyTradeLedgerVerdict({
            ruleName,
            keptPct: null,
            isMeanPnlDeltaPp: null,
            isMedianPnlDeltaPp: null,
            holdoutMeanPnlDeltaPp: null,
            holdoutMedianPnlDeltaPp: null,
            error: failMatch[1]!,
        });
    }
    const keptMatch = block.match(/kept=(\d+)\/(\d+) \(([\d.]+)%/);
    return classifyTradeLedgerVerdict({
        ruleName,
        keptPct: keptMatch ? Number.parseFloat(keptMatch[3]!) : null,
        isMeanPnlDeltaPp: parseNum(block, /isMeanPnlVsControl=([+-][\d.]+)pp/),
        isMedianPnlDeltaPp: parseNum(block, /isMedianPnlVsControl=([+-][\d.]+)pp/),
        holdoutMeanPnlDeltaPp: parseNum(block, /holdoutMeanPnlDelta=([+-][\d.]+)pp/),
        holdoutMedianPnlDeltaPp: parseNum(block, /holdoutMedianPnlDelta=([+-][\d.]+)pp/),
    });
}

function fmt(v: number | null, digits = 2): string {
    if (v === null) return "n/a";
    return `${v >= 0 ? "+" : ""}${v.toFixed(digits)}`;
}

const file = process.argv[2];
if (!file) {
    console.error("usage: esno summarize-report.ts <report.txt>");
    process.exit(1);
}
const text = readFileSync(file, "utf8");

const blocks: string[] = [];
for (const line of text.split(/\r?\n/)) {
    if (/^===== .+ =====$/.test(line)) blocks.push(line + "\n");
    else if (blocks.length > 0) blocks[blocks.length - 1] += line + "\n";
}
const rows = sortTradeLedgerVerdicts(blocks.map(classify));

const header = [
    "verdict".padEnd(15),
    "kept%".padStart(8),
    "IS mean".padStart(9),
    "IS med".padStart(9),
    "hold mean".padStart(10),
    "hold med".padStart(9),
    "  rule",
];
const lines: string[] = [];
lines.push(`SWEEP SUMMARY — ${rows.length} rules — bar: IS >= +${TRADE_LEDGER_EDGE_BAR_PP}pp & kept >= ${TRADE_LEDGER_EDGE_MIN_KEPT_PCT}% & holdout > 0`);
lines.push("=".repeat(100));
lines.push(header.join(""));
lines.push("-".repeat(100));
for (const r of rows) {
    lines.push([
        r.verdict.padEnd(15),
        r.keptPct === null ? "n/a".padStart(8) : `${r.keptPct.toFixed(2)}%`.padStart(8),
        fmt(r.isMeanPnlDeltaPp).padStart(9),
        fmt(r.isMedianPnlDeltaPp).padStart(9),
        fmt(r.holdoutMeanPnlDeltaPp).padStart(10),
        fmt(r.holdoutMedianPnlDeltaPp).padStart(9),
        `  ${r.ruleName}${r.note ? `   [${r.note}]` : ""}`,
    ].join(""));
}
lines.push("-".repeat(100));
const counts = countTradeLedgerVerdicts(rows);
lines.push([...counts.entries()].map(([v, c]) => `${v}: ${c}`).join(" | "));
lines.push("NOTE: verdicts are specific to THIS ledger folder. EDGE-CANDIDATE still needs cross-surface replication.");
lines.push("NOTE: 'weak' = the typical (median) trade is not better than control; the mean is carried by big winners.");

const table = lines.join("\n");
console.log(table);
writeFileSync(`${file}.summary.txt`, table + "\n");
console.log(`\nSummary written to: ${file}.summary.txt`);
