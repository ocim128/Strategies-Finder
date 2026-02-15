#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildSummary, collectRecords } from "./robust-log-utils.mjs";

export const DEFAULT_POLICY = {
    minSeedRuns: 5,
    minSeedPasses: 3,
    minMedianCellPassRate: 0.01,
    minMedianStageCSurvivors: 2,
    maxMedianDDBreachRate: 0.20,
    maxMedianFoldStabilityPenalty: 1.8,
};

export const NOGO_REASON_LABELS = {
    insufficient_seed_runs: "Not enough seeded runs",
    low_seed_pass_count: "Seed pass rule failed",
    low_median_stage_c_survivors: "Stage C survivor density too low",
    low_median_stage_c_pass_rate: "Stage C pass rate too low",
    high_median_dd_breach_rate: "Drawdown breach rate too high",
    high_median_fold_variance: "Fold variance too high",
};

function printUsage() {
    console.log([
        "Usage:",
        "  node scripts/robust-go-no-go-report.mjs [options] <run-file> [more-files...]",
        "",
        "Options:",
        "  --format table|json                   Output format (default: table)",
        "  --out <file>                          Write output to file",
        "  --min-seed-runs <n>                   Minimum run count per cell (default: 5)",
        "  --min-seed-passes <n>                 Minimum PASS count per cell (default: 3)",
        "  --min-pass-rate <ratio|percent>       Minimum median Stage-C passRate (default: 0.01)",
        "  --min-stage-c-survivors <n>           Minimum median Stage-C survivors (default: 2)",
        "  --max-dd-breach <ratio|percent>       Max median top-decile DD breach rate (default: 0.20)",
        "  --max-fold-variance <n>               Max median fold stability penalty (default: 1.8)",
        "",
        "Examples:",
        "  node scripts/robust-go-no-go-report.mjs run-seed-1337.txt run-seed-7331.txt",
        "  node scripts/robust-go-no-go-report.mjs --min-seed-runs 5 --min-seed-passes 3 run-seed-*.txt",
        "  node scripts/robust-go-no-go-report.mjs --format json --out go-no-go.json run-seed-*.txt",
    ].join("\n"));
}

function toRatio(raw, flagName) {
    const value = Number(raw);
    if (!Number.isFinite(value)) {
        throw new Error(`Invalid ${flagName}: ${raw}`);
    }
    const ratio = value > 1 ? value / 100 : value;
    if (ratio < 0 || ratio > 1) {
        throw new Error(`Out of range ${flagName}: ${raw}`);
    }
    return ratio;
}

function toNonNegativeNumber(raw, flagName) {
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
        throw new Error(`Invalid ${flagName}: ${raw}`);
    }
    return value;
}

function toNonNegativeInteger(raw, flagName) {
    const value = toNonNegativeNumber(raw, flagName);
    return Math.floor(value);
}

function parseArgs(argv) {
    const options = {
        format: "table",
        outPath: null,
        files: [],
        policy: { ...DEFAULT_POLICY },
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
        if (arg === "--min-seed-runs") {
            options.policy.minSeedRuns = toNonNegativeInteger(argv[i + 1], "--min-seed-runs");
            i += 1;
            continue;
        }
        if (arg === "--min-seed-passes") {
            options.policy.minSeedPasses = toNonNegativeInteger(argv[i + 1], "--min-seed-passes");
            i += 1;
            continue;
        }
        if (arg === "--min-pass-rate") {
            options.policy.minMedianCellPassRate = toRatio(argv[i + 1], "--min-pass-rate");
            i += 1;
            continue;
        }
        if (arg === "--min-stage-c-survivors") {
            options.policy.minMedianStageCSurvivors = toNonNegativeNumber(argv[i + 1], "--min-stage-c-survivors");
            i += 1;
            continue;
        }
        if (arg === "--max-dd-breach") {
            options.policy.maxMedianDDBreachRate = toRatio(argv[i + 1], "--max-dd-breach");
            i += 1;
            continue;
        }
        if (arg === "--max-fold-variance") {
            options.policy.maxMedianFoldStabilityPenalty = toNonNegativeNumber(argv[i + 1], "--max-fold-variance");
            i += 1;
            continue;
        }
        options.files.push(arg);
    }

    if (!["table", "json"].includes(options.format)) {
        throw new Error(`Invalid --format: ${options.format}`);
    }
    if (options.policy.minSeedPasses > options.policy.minSeedRuns) {
        throw new Error("Invalid policy: --min-seed-passes cannot exceed --min-seed-runs");
    }

    return options;
}

export function evaluateCell(cell, policy) {
    const reasons = [];
    if (cell.runs < policy.minSeedRuns) {
        reasons.push("insufficient_seed_runs");
    }
    if (cell.passCount < policy.minSeedPasses) {
        reasons.push("low_seed_pass_count");
    }
    if (cell.medianStageCSurvivors < policy.minMedianStageCSurvivors) {
        reasons.push("low_median_stage_c_survivors");
    }
    if (cell.medianCellPassRate < policy.minMedianCellPassRate) {
        reasons.push("low_median_stage_c_pass_rate");
    }
    if (cell.medianDDBreachRate > policy.maxMedianDDBreachRate) {
        reasons.push("high_median_dd_breach_rate");
    }
    if (cell.medianFoldStabilityPenalty > policy.maxMedianFoldStabilityPenalty) {
        reasons.push("high_median_fold_variance");
    }

    return {
        ...cell,
        verdict: reasons.length === 0 ? "GO" : "NO_GO",
        noGoReasons: reasons,
        noGoReasonLabels: reasons.map((reason) => NOGO_REASON_LABELS[reason] ?? reason),
    };
}

export function buildReport(summary, policy) {
    const cells = summary.cells.map((cell) => evaluateCell(cell, policy));
    const goCells = cells.filter((cell) => cell.verdict === "GO");
    const noGoCells = cells.filter((cell) => cell.verdict === "NO_GO");

    const noGoReasonCounts = {};
    for (const cell of noGoCells) {
        for (const reason of cell.noGoReasons) {
            noGoReasonCounts[reason] = (noGoReasonCounts[reason] ?? 0) + 1;
        }
    }

    const rankedGoCells = goCells
        .slice()
        .sort((a, b) =>
            b.passCount - a.passCount ||
            b.seedPassRate - a.seedPassRate ||
            b.medianStageCSurvivors - a.medianStageCSurvivors ||
            b.medianCellPassRate - a.medianCellPassRate
        );

    return {
        policy,
        overallVerdict: goCells.length > 0 ? "GO" : "NO_GO",
        goCellCount: goCells.length,
        noGoCellCount: noGoCells.length,
        noGoReasonCounts: Object.fromEntries(
            Object.entries(noGoReasonCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        ),
        topGoCells: rankedGoCells.slice(0, 10).map((cell) => ({
            symbol: cell.symbol,
            strategyKey: cell.strategyKey,
            strategyName: cell.strategyName,
            timeframe: cell.timeframe,
            tradeFilterMode: cell.tradeFilterMode,
            tradeDirection: cell.tradeDirection,
            passCount: cell.passCount,
            runs: cell.runs,
            seedPassRate: cell.seedPassRate,
            medianCellPassRate: cell.medianCellPassRate,
            medianStageCSurvivors: cell.medianStageCSurvivors,
            medianDDBreachRate: cell.medianDDBreachRate,
            medianFoldStabilityPenalty: cell.medianFoldStabilityPenalty,
        })),
        cells,
    };
}

export function formatTable(summary, report) {
    const lines = [];
    lines.push(`Overall Verdict: ${report.overallVerdict}`);
    lines.push([
        "Policy",
        `minSeedRuns=${report.policy.minSeedRuns}`,
        `minSeedPasses=${report.policy.minSeedPasses}`,
        `minPassRate=${(report.policy.minMedianCellPassRate * 100).toFixed(2)}%`,
        `minStageC=${report.policy.minMedianStageCSurvivors.toFixed(1)}`,
        `maxDDBreach=${(report.policy.maxMedianDDBreachRate * 100).toFixed(2)}%`,
        `maxFoldVar=${report.policy.maxMedianFoldStabilityPenalty.toFixed(2)}`,
    ].join(" | "));
    lines.push("");
    lines.push("Cell | Verdict | SeedPass | Runs | MedianPassRate | MedianStageC | MedianDDBreach | MedianFoldVar | TopFailReason | NoGoReasons");
    lines.push("---|---|---:|---:|---:|---:|---:|---:|---|---");

    for (const cell of report.cells) {
        lines.push([
            `${cell.symbol}:${cell.timeframe}:${cell.strategyKey}:${cell.tradeFilterMode}:${cell.tradeDirection}`,
            cell.verdict,
            `${cell.passCount}/${cell.runs}`,
            cell.runs,
            `${(cell.medianCellPassRate * 100).toFixed(2)}%`,
            cell.medianStageCSurvivors.toFixed(1),
            `${(cell.medianDDBreachRate * 100).toFixed(2)}%`,
            cell.medianFoldStabilityPenalty.toFixed(3),
            cell.topFailReason || "-",
            cell.noGoReasons.length > 0 ? cell.noGoReasons.join(",") : "-",
        ].join(" | "));
    }

    lines.push("");
    lines.push("No-Go Reason Counts");
    lines.push("Reason | Cells");
    lines.push("---|---:");
    const noGoEntries = Object.entries(report.noGoReasonCounts);
    if (noGoEntries.length === 0) {
        lines.push("(none) | 0");
    } else {
        for (const [reason, count] of noGoEntries) {
            const label = NOGO_REASON_LABELS[reason] ?? reason;
            lines.push(`${reason} (${label}) | ${count}`);
        }
    }

    lines.push("");
    lines.push("Global FAIL Decision Reasons");
    lines.push("Reason | Count");
    lines.push("---|---:");
    const failEntries = Object.entries(summary.globalFailDecisionReasonCounts);
    if (failEntries.length === 0) {
        lines.push("(none) | 0");
    } else {
        for (const [reason, count] of failEntries) {
            lines.push(`${reason} | ${count}`);
        }
    }

    lines.push("");
    lines.push("Global Stage Reject Reasons");
    lines.push("Reason | Count");
    lines.push("---|---:");
    const rejectEntries = Object.entries(summary.globalRejectReasonCounts);
    if (rejectEntries.length === 0) {
        lines.push("(none) | 0");
    } else {
        for (const [reason, count] of rejectEntries) {
            lines.push(`${reason} | ${count}`);
        }
    }

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
    const report = buildReport(summary, options.policy);

    const payload = {
        generatedAt: new Date().toISOString(),
        inputFiles: options.files.map((filePath) => path.resolve(filePath)),
        recordCount: records.length,
        cellCount: summary.cells.length,
        warnings,
        summary,
        report,
    };

    const rendered = options.format === "json"
        ? JSON.stringify(payload, null, 2)
        : formatTable(summary, report);

    if (options.outPath) {
        const outPath = path.resolve(options.outPath);
        fs.writeFileSync(outPath, rendered, "utf8");
        console.log(`Wrote report: ${outPath}`);
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

const invokedAsScript = (() => {
    if (!process.argv[1]) return false;
    try {
        return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
    } catch {
        return false;
    }
})();

if (invokedAsScript) {
    main();
}
