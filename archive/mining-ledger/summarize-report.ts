/**
 * Summarize a test-all-rules sweep report into a plain verdict table.
 * Classification mirrors archive/mining-ledger/mining-loop-guide.md:
 *   EDGE-CANDIDATE : IS mean delta >= +0.3pp AND kept >= 2% AND holdout mean delta > 0
 *   HOLDOUT-NEG    : passes the IS bar but the sealed holdout said no
 *   TOO-RARE       : passes the IS bar but keeps < 2% of candidates (fragile sample)
 *   NO-EDGE        : below the IS bar
 *   ERROR          : checker refused or failed for this rule
 * Median delta is shown because a positive median is the trust signal;
 * an "EDGE-CANDIDATE (weak)" flag is added when the IS median is negative.
 *
 * Usage: esno summarize-report.ts <report.txt>
 * Writes <report.txt>.summary.txt next to the input.
 */
import { readFileSync, writeFileSync } from "node:fs";

const EDGE_BAR_PP = 0.3;
const EDGE_MIN_KEPT_PCT = 2;

interface Row {
    name: string;
    verdict: string;
    keptPct: number | null;
    isMean: number | null;
    isMedian: number | null;
    holdMean: number | null;
    holdMedian: number | null;
    note: string;
}

function parseNum(text: string, pattern: RegExp): number | null {
    const m = text.match(pattern);
    if (!m) return null;
    const v = Number.parseFloat(m[1]!);
    return Number.isFinite(v) ? v : null;
}

function classify(block: string): Row {
    const nameMatch = block.match(/^===== (.+?) =====$/m);
    const name = nameMatch ? nameMatch[1]! : "(unknown)";
    const failMatch = block.match(/trade-ledger-checker failed: (.+)/);
    if (failMatch) {
        return { name, verdict: "ERROR", keptPct: null, isMean: null, isMedian: null, holdMean: null, holdMedian: null, note: failMatch[1]!.slice(0, 90) };
    }
    const keptMatch = block.match(/kept=(\d+)\/(\d+) \(([\d.]+)%/);
    const isMean = parseNum(block, /isMeanPnlVsControl=([+-][\d.]+)pp/);
    const isMedian = parseNum(block, /isMedianPnlVsControl=([+-][\d.]+)pp/);
    const holdMean = parseNum(block, /holdoutMeanPnlDelta=([+-][\d.]+)pp/);
    const holdMedian = parseNum(block, /holdoutMedianPnlDelta=([+-][\d.]+)pp/);
    if (!keptMatch || isMean === null || isMedian === null || holdMean === null || holdMedian === null) {
        return { name, verdict: "ERROR", keptPct: null, isMean, isMedian, holdMean, holdMedian, note: "no RULE summary found in block" };
    }
    const keptPct = Number.parseFloat(keptMatch[3]!);

    let verdict: string;
    let note = "";
    if (isMean >= EDGE_BAR_PP && keptPct >= EDGE_MIN_KEPT_PCT) {
        verdict = holdMean > 0 ? "EDGE-CANDIDATE" : "HOLDOUT-NEG";
        if (isMedian < 0) note = "weak: IS median negative";
    } else if (isMean >= EDGE_BAR_PP) {
        verdict = "TOO-RARE";
        note = "passes delta bar but kept < 2%";
    } else {
        verdict = "NO-EDGE";
    }
    return { name, verdict, keptPct, isMean, isMedian, holdMean, holdMedian, note };
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
const rows = blocks.map(classify);

const order: Record<string, number> = { "EDGE-CANDIDATE": 0, "HOLDOUT-NEG": 1, "TOO-RARE": 2, "NO-EDGE": 3, "ERROR": 4 };
rows.sort((a, b) =>
    (order[a.verdict]! - order[b.verdict]!)
    || (b.holdMean ?? -Infinity) - (a.holdMean ?? -Infinity)
    || (b.isMean ?? -Infinity) - (a.isMean ?? -Infinity));

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
lines.push(`SWEEP SUMMARY — ${rows.length} rules — bar: IS >= +${EDGE_BAR_PP}pp & kept >= ${EDGE_MIN_KEPT_PCT}% & holdout > 0`);
lines.push("=".repeat(100));
lines.push(header.join(""));
lines.push("-".repeat(100));
for (const r of rows) {
    lines.push([
        r.verdict.padEnd(15),
        r.keptPct === null ? "n/a".padStart(8) : `${r.keptPct.toFixed(2)}%`.padStart(8),
        fmt(r.isMean).padStart(9),
        fmt(r.isMedian).padStart(9),
        fmt(r.holdMean).padStart(10),
        fmt(r.holdMedian).padStart(9),
        `  ${r.name}${r.note ? `   [${r.note}]` : ""}`,
    ].join(""));
}
lines.push("-".repeat(100));
const counts = new Map<string, number>();
for (const r of rows) counts.set(r.verdict, (counts.get(r.verdict) ?? 0) + 1);
lines.push([...counts.entries()].map(([v, c]) => `${v}: ${c}`).join(" | "));
lines.push("NOTE: verdicts are specific to THIS ledger folder. EDGE-CANDIDATE still needs cross-surface replication.");
lines.push("NOTE: 'weak' = the typical (median) trade is not better than control; the mean is carried by big winners.");

const table = lines.join("\n");
console.log(table);
writeFileSync(`${file}.summary.txt`, table + "\n");
console.log(`\nSummary written to: ${file}.summary.txt`);
