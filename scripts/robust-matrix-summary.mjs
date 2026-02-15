#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { buildSummary, collectRecords } from "./robust-log-utils.mjs";

function printUsage() {
    console.log([
        "Usage:",
        "  node scripts/robust-matrix-summary.mjs [--format table|json] [--out <file>] <run-file> [more-files...]",
        "",
        "Accepted input files:",
        "  1) Debug copy text containing [Finder][robust_random_wf][cell_audit] lines",
        "  2) JSON arrays from Finder 'Copy Top Results' (PASS rows only)",
        "  3) JSON arrays/objects containing cell audit payloads",
        "",
        "Output includes:",
        "  - Per-cell seed pass metrics",
        "  - Decision reason counts",
        "  - Candidate reject reason aggregation (stage A/B/C reject diagnostics)",
        "",
        "Examples:",
        "  node scripts/robust-matrix-summary.mjs runs/seed-1337.txt runs/seed-7331.txt",
        "  node scripts/robust-matrix-summary.mjs --format json --out matrix-summary.json runs/*.txt",
    ].join("\n"));
}

function parseArgs(argv) {
    const options = {
        format: "table",
        outPath: null,
        files: [],
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--help" || arg === "-h") {
            options.help = true;
            continue;
        }
        if (arg === "--format") {
            options.format = String(argv[i + 1] ?? "").trim().toLowerCase();
            i += 1;
            continue;
        }
        if (arg === "--out") {
            options.outPath = String(argv[i + 1] ?? "").trim();
            i += 1;
            continue;
        }
        options.files.push(arg);
    }

    if (!["table", "json"].includes(options.format)) {
        throw new Error(`Invalid --format: ${options.format}`);
    }
    return options;
}

function appendReasonTable(lines, heading, counts) {
    lines.push("");
    lines.push(heading);
    const entries = Object.entries(counts ?? {});
    if (entries.length === 0) {
        lines.push("Reason | Count");
        lines.push("---|---:");
        lines.push("(none) | 0");
        return;
    }
    lines.push("Reason | Count");
    lines.push("---|---:");
    for (const [reason, count] of entries) {
        lines.push(`${reason} | ${count}`);
    }
}

function formatTable(summary) {
    const lines = [];
    lines.push("Cell | Runs | Pass | SeedPassRate | MedianPassRate | MedianRobust | MedianStageC | MedianDDBreach | TopFailReason | TopRejectReason");
    lines.push("---|---:|---:|---:|---:|---:|---:|---:|---|---");
    for (const cell of summary.cells) {
        const cellName = `${cell.symbol}:${cell.timeframe}:${cell.strategyKey}:${cell.tradeFilterMode}:${cell.tradeDirection}`;
        lines.push([
            cellName,
            cell.runs,
            `${cell.passCount}/${cell.runs}`,
            `${(cell.seedPassRate * 100).toFixed(1)}%`,
            `${(cell.medianCellPassRate * 100).toFixed(2)}%`,
            cell.medianRobustScore.toFixed(2),
            cell.medianStageCSurvivors.toFixed(1),
            `${(cell.medianDDBreachRate * 100).toFixed(2)}%`,
            cell.topFailReason || "-",
            cell.topRejectReason || "-",
        ].join(" | "));
    }

    appendReasonTable(lines, "Global FAIL Decision Reasons", summary.globalFailDecisionReasonCounts);
    appendReasonTable(lines, "Global Stage Reject Reasons", summary.globalRejectReasonCounts);

    lines.push("");
    lines.push("Global Reject Volume by Stage");
    lines.push("Stage | Rejects");
    lines.push("---|---:");
    lines.push(`A | ${summary.globalRejectReasonCountsByStage.A}`);
    lines.push(`B | ${summary.globalRejectReasonCountsByStage.B}`);
    lines.push(`C | ${summary.globalRejectReasonCountsByStage.C}`);
    lines.push(`other | ${summary.globalRejectReasonCountsByStage.other}`);

    return lines.join("\n");
}

function main() {
    let options;
    try {
        options = parseArgs(process.argv.slice(2));
    } catch (error) {
        console.error(String(error));
        process.exitCode = 1;
        return;
    }

    if (options.help || options.files.length === 0) {
        printUsage();
        return;
    }

    const { records, warnings } = collectRecords(options.files);
    if (records.length === 0) {
        console.error("No robust_random_wf audit records found in input files.");
        process.exitCode = 1;
        return;
    }

    const summary = buildSummary(records);
    const outputPayload = {
        generatedAt: new Date().toISOString(),
        inputFiles: options.files.map((f) => path.resolve(f)),
        recordCount: records.length,
        cellCount: summary.cells.length,
        warnings,
        summary,
    };

    const rendered = options.format === "json"
        ? JSON.stringify(outputPayload, null, 2)
        : formatTable(summary);

    if (options.outPath) {
        fs.writeFileSync(path.resolve(options.outPath), rendered, "utf8");
        console.log(`Wrote summary: ${path.resolve(options.outPath)}`);
    } else {
        console.log(rendered);
    }

    if (warnings.topResultsInference) {
        console.warn("Warning: some records inferred from 'Copy Top Results' (PASS-only). Include cell_audit logs for FAIL coverage.");
    }
    if (warnings.missingSeed) {
        console.warn("Warning: some records are missing seed values.");
    }
}

main();
