import fs from "node:fs";
import path from "node:path";

export function asFiniteNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

export function median(values) {
    const clean = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    if (clean.length === 0) return 0;
    const mid = Math.floor(clean.length / 2);
    return clean.length % 2 === 0 ? (clean[mid - 1] + clean[mid]) / 2 : clean[mid];
}

function tryParseJson(text) {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

function sortCountObject(counts) {
    return Object.fromEntries(
        Object.entries(counts)
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    );
}

function incrementCount(target, key, amount = 1) {
    if (!key) return;
    target[key] = (target[key] ?? 0) + amount;
}

function mergeCounts(target, counts) {
    if (!counts || typeof counts !== "object") return;
    for (const [reason, rawCount] of Object.entries(counts)) {
        const count = asFiniteNumber(rawCount, 0);
        if (!reason || count <= 0) continue;
        incrementCount(target, reason, count);
    }
}

function normalizeRejectionReasons(raw) {
    const normalized = {};
    if (!raw || typeof raw !== "object") return normalized;
    for (const [reason, rawCount] of Object.entries(raw)) {
        const count = asFiniteNumber(rawCount, 0);
        if (!reason || count <= 0) continue;
        normalized[reason] = count;
    }
    return normalized;
}

function normalizeDecision(rawDecision) {
    const decision = String(rawDecision ?? "").trim().toUpperCase();
    return decision === "PASS" ? "PASS" : "FAIL";
}

function parseStageFromRejectReason(reason) {
    if (reason.startsWith("stage_a_")) return "A";
    if (reason.startsWith("stage_b_")) return "B";
    if (reason.startsWith("stage_c_")) return "C";
    return "other";
}

function compareBySeed(a, b) {
    const aSeed = Number.isFinite(a.seed) ? a.seed : Number.POSITIVE_INFINITY;
    const bSeed = Number.isFinite(b.seed) ? b.seed : Number.POSITIVE_INFINITY;
    if (aSeed !== bSeed) return aSeed - bSeed;
    return a.sourceFile.localeCompare(b.sourceFile);
}

export function normalizeAuditRecord(raw, source, sourceFile, warnings) {
    if (!raw || typeof raw !== "object") return null;

    const robust = raw.robustMetrics && typeof raw.robustMetrics === "object" ? raw.robustMetrics : raw;
    const strategyKey = String(raw.strategyKey ?? raw.strategyId ?? "").trim();
    const strategyName = String(raw.strategyName ?? raw.name ?? "").trim();
    const timeframe = String(
        robust.timeframe ??
        (Array.isArray(raw.timeframes) && raw.timeframes.length === 1 ? raw.timeframes[0] : "") ??
        ""
    ).trim();

    if (!strategyKey || !timeframe) return null;

    let decision = String(robust.decision ?? "").toUpperCase();
    let decisionReason = String(robust.decisionReason ?? "").trim();
    if (!decision) {
        // "Copy Top Results" payload includes only shown rows, which are PASS rows.
        decision = "PASS";
        decisionReason = decisionReason || "inferred_from_top_results";
        warnings.topResultsInference = true;
    }

    const seed = asFiniteNumber(robust.seed, Number.NaN);
    if (!Number.isFinite(seed)) {
        warnings.missingSeed = true;
    }

    return {
        source,
        sourceFile,
        strategyKey,
        strategyName: strategyName || strategyKey,
        timeframe,
        seed,
        cellSeed: asFiniteNumber(robust.cellSeed, Number.NaN),
        decision: normalizeDecision(decision),
        decisionReason: decisionReason || "unknown",
        sampledParams: asFiniteNumber(robust.sampledParams, 0),
        stageASurvivors: asFiniteNumber(robust.stageASurvivors, 0),
        stageBSurvivors: asFiniteNumber(robust.stageBSurvivors, 0),
        stageCSurvivors: asFiniteNumber(robust.stageCSurvivors, 0),
        passRate: asFiniteNumber(robust.passRate, 0),
        topDecileMedianOOSExpectancy: asFiniteNumber(robust.topDecileMedianOOSExpectancy, 0),
        topDecileMedianProfitableFoldRatio: asFiniteNumber(robust.topDecileMedianProfitableFoldRatio, 0),
        medianFoldStabilityPenalty: asFiniteNumber(robust.medianFoldStabilityPenalty, 0),
        topDecileMedianDDBreachRate: asFiniteNumber(robust.topDecileMedianDDBreachRate, 0),
        robustScore: asFiniteNumber(robust.robustScore, 0),
        rejectionReasons: normalizeRejectionReasons(robust.rejectionReasons ?? raw.rejectionReasons),
    };
}

function readRecordsFromJson(doc, sourceFile, warnings) {
    const records = [];
    const add = (raw, source) => {
        const normalized = normalizeAuditRecord(raw, source, sourceFile, warnings);
        if (normalized) records.push(normalized);
    };

    if (Array.isArray(doc)) {
        for (const item of doc) {
            if (!item || typeof item !== "object") continue;
            if (item.message === "[Finder][robust_random_wf][cell_audit]" && item.data) {
                add(item.data, "debug_entries_json");
                continue;
            }
            if (item.mode === "robust_random_wf" && item.strategyKey) {
                add(item, "cell_audit_json");
                continue;
            }
            if (item.robustMetrics && item.strategyId) {
                add(item, "top_results_json");
            }
        }
    } else if (doc && typeof doc === "object") {
        if (doc.message === "[Finder][robust_random_wf][cell_audit]" && doc.data) {
            add(doc.data, "debug_entry_json");
        } else if (doc.mode === "robust_random_wf" && doc.strategyKey) {
            add(doc, "cell_audit_json");
        } else if (Array.isArray(doc.records)) {
            for (const item of doc.records) {
                if (item && typeof item === "object") add(item, "records_json");
            }
        }
    }

    return records;
}

function readRecordsFromText(text, sourceFile, warnings) {
    const lines = text.split(/\r?\n/);
    const records = [];
    for (const line of lines) {
        if (!line.includes("[Finder][robust_random_wf][cell_audit]")) continue;
        const start = line.indexOf("{");
        if (start < 0) continue;
        const parsed = tryParseJson(line.slice(start).trim());
        if (!parsed) continue;
        const normalized = normalizeAuditRecord(parsed, "debug_copy_text", sourceFile, warnings);
        if (normalized) records.push(normalized);
    }
    return records;
}

export function collectRecords(files) {
    const warnings = {
        missingSeed: false,
        topResultsInference: false,
    };
    const records = [];

    for (const filePath of files) {
        const abs = path.resolve(filePath);
        const text = fs.readFileSync(abs, "utf8");
        const parsed = tryParseJson(text);

        if (parsed !== null) {
            records.push(...readRecordsFromJson(parsed, abs, warnings));
            continue;
        }
        records.push(...readRecordsFromText(text, abs, warnings));
    }

    return { records, warnings };
}

export function buildSummary(records) {
    const byCell = new Map();
    const globalFailDecisionReasonCounts = {};
    const globalRejectReasonCounts = {};
    const globalRejectReasonCountsByStage = { A: 0, B: 0, C: 0, other: 0 };

    for (const row of records) {
        const key = `${row.strategyKey}|${row.timeframe}`;
        const bucket = byCell.get(key) ?? {
            strategyKey: row.strategyKey,
            strategyName: row.strategyName,
            timeframe: row.timeframe,
            rows: [],
        };
        bucket.rows.push(row);
        byCell.set(key, bucket);

        if (row.decision === "FAIL") {
            incrementCount(globalFailDecisionReasonCounts, row.decisionReason, 1);
        }
        mergeCounts(globalRejectReasonCounts, row.rejectionReasons);
        for (const [reason, rawCount] of Object.entries(row.rejectionReasons)) {
            const count = asFiniteNumber(rawCount, 0);
            const stage = parseStageFromRejectReason(reason);
            globalRejectReasonCountsByStage[stage] += count;
        }
    }

    const cells = [];
    for (const bucket of byCell.values()) {
        const rows = bucket.rows.slice().sort(compareBySeed);
        const seeds = Array.from(
            new Set(rows.filter((r) => Number.isFinite(r.seed)).map((r) => r.seed))
        ).sort((a, b) => a - b);
        const passes = rows.filter((r) => r.decision === "PASS");
        const fails = rows.filter((r) => r.decision === "FAIL");

        const failReasonCounts = {};
        for (const row of fails) {
            incrementCount(failReasonCounts, row.decisionReason, 1);
        }

        const rejectReasonCounts = {};
        const rejectReasonCountsByStage = { A: 0, B: 0, C: 0, other: 0 };
        for (const row of rows) {
            mergeCounts(rejectReasonCounts, row.rejectionReasons);
            for (const [reason, rawCount] of Object.entries(row.rejectionReasons)) {
                const count = asFiniteNumber(rawCount, 0);
                const stage = parseStageFromRejectReason(reason);
                rejectReasonCountsByStage[stage] += count;
            }
        }

        const topFailReason = Object.entries(failReasonCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
        const topRejectReason = Object.entries(rejectReasonCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";

        cells.push({
            strategyKey: bucket.strategyKey,
            strategyName: bucket.strategyName,
            timeframe: bucket.timeframe,
            runs: rows.length,
            seeds,
            passCount: passes.length,
            failCount: fails.length,
            seedPassRate: rows.length > 0 ? passes.length / rows.length : 0,
            medianCellPassRate: median(rows.map((r) => r.passRate)),
            medianRobustScore: median(rows.map((r) => r.robustScore)),
            medianTopDecileExpectancy: median(rows.map((r) => r.topDecileMedianOOSExpectancy)),
            medianFoldStabilityPenalty: median(rows.map((r) => r.medianFoldStabilityPenalty)),
            medianDDBreachRate: median(rows.map((r) => r.topDecileMedianDDBreachRate)),
            medianStageCSurvivors: median(rows.map((r) => r.stageCSurvivors)),
            topFailReason,
            topRejectReason,
            failReasonCounts: sortCountObject(failReasonCounts),
            rejectReasonCounts: sortCountObject(rejectReasonCounts),
            rejectReasonCountsByStage,
            perSeed: rows.map((r) => ({
                seed: r.seed,
                decision: r.decision,
                decisionReason: r.decisionReason,
                passRate: r.passRate,
                robustScore: r.robustScore,
                stageCSurvivors: r.stageCSurvivors,
                ddBreachRate: r.topDecileMedianDDBreachRate,
                foldStabilityPenalty: r.medianFoldStabilityPenalty,
                rejectionReasons: r.rejectionReasons,
            })),
        });
    }

    cells.sort((a, b) => a.strategyKey.localeCompare(b.strategyKey) || a.timeframe.localeCompare(b.timeframe));

    return {
        cells,
        globalFailDecisionReasonCounts: sortCountObject(globalFailDecisionReasonCounts),
        globalRejectReasonCounts: sortCountObject(globalRejectReasonCounts),
        globalRejectReasonCountsByStage,
    };
}
