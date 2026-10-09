/** Import externally measured agent runs; compare paired efficiency and reviewed outcomes.
 * This CLI does not launch models or invent provider usage. See docs/testing.md.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import tasks from "./agent-benchmark-tasks.json";

export const BENCHMARK_TASKS = tasks;
export const TASK_SET_HASH = createHash("sha256").update(JSON.stringify(tasks)).digest("hex");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const storage = path.join(root, "artifacts", "agent-benchmark");
const slug = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type AgentRun = {
    formatVersion: 1;
    taskSetHash: string;
    taskId: string;
    trial: number;
    variant: string;
    fixtureRevision: string;
    model: string;
    reasoningEffort: string;
    metrics: {
        inputTokens: number;
        outputTokens: number;
        cachedInputTokens: number;
        reasoningTokens: number;
        wallTimeMs: number;
        toolCalls: number;
        correctiveFollowups: number;
    };
    review: { passed: boolean; reviewer: string; notes: string };
    checks: Array<{ name: string; exitCode: number }>;
    evidence: string[];
};

function object(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
    return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
    if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be nonempty text`);
    return value;
}

function count(value: unknown, label: string): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a nonnegative safe integer`);
    return value as number;
}

export function validateAgentRun(value: unknown): AgentRun {
    const input = object(value, "run");
    if (input.formatVersion !== 1 || input.taskSetHash !== TASK_SET_HASH) throw new Error("Unsupported format or different task set");
    const taskId = text(input.taskId, "taskId");
    const task = tasks.find(item => item.id === taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    const variant = text(input.variant, "variant");
    if (!slug.test(variant)) throw new Error("variant must be a lowercase slug of at most 64 characters");
    const trial = count(input.trial, "trial");
    if (trial < 1) throw new Error("trial must start at 1");
    const fixtureRevision = text(input.fixtureRevision, "fixtureRevision");
    if (!/^[a-f0-9]{40}$/i.test(fixtureRevision)) throw new Error("fixtureRevision must be a full Git commit hash");
    const rawMetrics = object(input.metrics, "metrics");
    const metrics = {
        inputTokens: count(rawMetrics.inputTokens, "inputTokens"),
        outputTokens: count(rawMetrics.outputTokens, "outputTokens"),
        cachedInputTokens: count(rawMetrics.cachedInputTokens ?? 0, "cachedInputTokens"),
        reasoningTokens: count(rawMetrics.reasoningTokens ?? 0, "reasoningTokens"),
        wallTimeMs: count(rawMetrics.wallTimeMs, "wallTimeMs"),
        toolCalls: count(rawMetrics.toolCalls, "toolCalls"),
        correctiveFollowups: count(rawMetrics.correctiveFollowups, "correctiveFollowups"),
    };
    if (metrics.cachedInputTokens > metrics.inputTokens || metrics.reasoningTokens > metrics.outputTokens) {
        throw new Error("Cached/reasoning tokens are subsets of input/output, not additional totals");
    }
    const rawReview = object(input.review, "review");
    if (typeof rawReview.passed !== "boolean") throw new Error("review.passed must be independently graded true or false");
    const review = { passed: rawReview.passed, reviewer: text(rawReview.reviewer, "reviewer"), notes: text(rawReview.notes, "review notes") };
    if (!Array.isArray(input.checks)) throw new Error("checks must be an array");
    const checks = input.checks.map((item: unknown) => {
        const check = object(item, "check");
        const exitCode = count(check.exitCode, "exitCode");
        return { name: text(check.name, "check name"), exitCode };
    });
    if (new Set(checks.map(check => check.name)).size !== checks.length) throw new Error("Duplicate check names");
    if (review.passed && (checks.some(check => check.exitCode !== 0)
        || task.requiredChecks.some(name => !checks.some(check => check.name === name)))) {
        throw new Error("A passed implementation needs every minimum check passing; failed runs must still be recorded as failed");
    }
    if (!Array.isArray(input.evidence) || input.evidence.length === 0) throw new Error("Attach transcript/review/check evidence paths");
    const evidence = input.evidence.map((item: unknown) => text(item, "evidence path"));
    return {
        formatVersion: 1, taskSetHash: TASK_SET_HASH, taskId, trial, variant, fixtureRevision: fixtureRevision.toLowerCase(),
        model: text(input.model, "model"), reasoningEffort: text(input.reasoningEffort, "reasoningEffort"),
        metrics, review, checks, evidence,
    };
}

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function compareAgentRuns(
    runs: readonly AgentRun[], baseline: string, candidate: string,
    taskIds: readonly string[] = tasks.map(task => task.id), minimumTrials = 2,
) {
    if (!slug.test(baseline) || !slug.test(candidate) || baseline === candidate) throw new Error("Choose two distinct variant slugs");
    if (taskIds.length === 0 || new Set(taskIds).size !== taskIds.length || !Number.isSafeInteger(minimumTrials) || minimumTrials < 1) {
        throw new Error("Comparison needs unique tasks and at least one trial");
    }
    const selected = runs.filter(run => run.variant === baseline || run.variant === candidate);
    const byKey = new Map<string, AgentRun>();
    for (const run of selected) {
        const key = `${run.variant}:${run.taskId}:${run.trial}`;
        if (byKey.has(key)) throw new Error(`Duplicate run: ${key}`);
        byKey.set(key, run);
    }
    const issues: string[] = [];
    const pairs: Array<{ baseline: AgentRun; candidate: AgentRun }> = [];
    for (const taskId of taskIds) {
        const trials = [...new Set(selected.filter(run => run.taskId === taskId).map(run => run.trial))].sort((a, b) => a - b);
        if (trials.length < minimumTrials) issues.push(`${taskId}: needs at least ${minimumTrials} paired trials`);
        for (const trial of trials) {
            const a = byKey.get(`${baseline}:${taskId}:${trial}`);
            const b = byKey.get(`${candidate}:${taskId}:${trial}`);
            if (!a || !b) { issues.push(`${taskId}/${trial}: missing ${a ? candidate : baseline}`); continue; }
            if (a.fixtureRevision !== b.fixtureRevision || a.model !== b.model || a.reasoningEffort !== b.reasoningEffort || a.taskSetHash !== b.taskSetHash) {
                issues.push(`${taskId}/${trial}: fixture, task set, model, or reasoning effort differs`);
                continue;
            }
            pairs.push({ baseline: a, candidate: b });
        }
    }
    // Keep one model/configuration and fixture throughout the suite, not just within pairs.
    const configurations = new Set(selected.map(run => JSON.stringify([run.fixtureRevision, run.model, run.reasoningEffort, run.taskSetHash])));
    if (configurations.size > 1) issues.push("Suite mixes fixtures, models, reasoning efforts, or task sets");
    const qualityRegressions = pairs.filter(pair => pair.baseline.review.passed && !pair.candidate.review.passed)
        .map(pair => `${pair.baseline.taskId}/${pair.baseline.trial}`);
    const candidateFailures = pairs.filter(pair => !pair.candidate.review.passed).length;
    const rows = taskIds.map(taskId => {
        const group = pairs.filter(pair => pair.baseline.taskId === taskId);
        if (group.length === 0) return { taskId, pairedTrials: 0 };
        const row: Record<string, string | number> = { taskId, pairedTrials: group.length };
        for (const variant of ["baseline", "candidate"] as const) {
            row[`${variant}Tokens`] = median(group.map(pair => pair[variant].metrics.inputTokens + pair[variant].metrics.outputTokens));
            row[`${variant}WallTimeMs`] = median(group.map(pair => pair[variant].metrics.wallTimeMs));
        }
        return row;
    });
    function totals(variant: "baseline" | "candidate") {
        return pairs.reduce((sum, pair) => {
            const run = pair[variant];
            sum.tokens += run.metrics.inputTokens + run.metrics.outputTokens;
            sum.wallTimeMs += run.metrics.wallTimeMs;
            sum.toolCalls += run.metrics.toolCalls;
            sum.correctiveFollowups += run.metrics.correctiveFollowups;
            sum.passed += Number(run.review.passed);
            return sum;
        }, { tokens: 0, wallTimeMs: 0, toolCalls: 0, correctiveFollowups: 0, passed: 0 });
    }
    const a = totals("baseline"), b = totals("candidate");
    const complete = issues.length === 0;
    const tokenReductionPct = a.tokens > 0 ? (a.tokens - b.tokens) / a.tokens * 100 : null;
    const status = !complete ? "insufficient-evidence"
        : candidateFailures > 0 || qualityRegressions.length > 0 || b.correctiveFollowups > a.correctiveFollowups ? "regression"
        : b.tokens < a.tokens ? "improved" : "no-improvement";
    return {
        formatVersion: 1, baseline, candidate, status, issues, pairedRuns: pairs.length,
        qualityRegressions, candidateFailures, rows,
        // Do not advertise savings from an incomplete/mismatched subset.
        aggregate: complete ? { baseline: a, candidate: b, tokenReductionPct } : null,
        caveat: "Small paired benchmark with externally supplied metrics and independent review; not proof of zero regression on other tasks. Cached/reasoning tokens are not double-counted. Costs are not estimated.",
    };
}

function json(file: string): unknown {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

/** Snapshot evidence before later test runs replace latest/ logs. Refuse overwrites. */
export function saveAgentRun(value: unknown, appRoot = root): string {
    const run = validateAgentRun(value);
    const resolvedRoot = fs.realpathSync(appRoot);
    const evidence = run.evidence.map(source => {
        const file = fs.realpathSync(path.resolve(appRoot, source));
        const relative = path.relative(resolvedRoot, file);
        if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !fs.statSync(file).isFile()) {
            throw new Error("Evidence must be a file inside the repo; archive external evidence into artifacts/ first");
        }
        return file;
    });
    const parent = path.join(appRoot, "artifacts", "agent-benchmark", run.variant);
    fs.mkdirSync(parent, { recursive: true });
    const directory = path.join(parent, `${run.taskId}-${run.trial}`);
    fs.mkdirSync(directory); // exclusive: previous runs/evidence cannot be replaced
    const savedEvidence = evidence.map((source, index) => {
        const destination = path.join(directory, `${index}-${path.basename(source)}`);
        fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
        return path.relative(appRoot, destination);
    });
    const destination = path.join(directory, "run.json");
    fs.writeFileSync(destination, JSON.stringify({ ...run, evidence: savedEvidence }, null, 2) + "\n", { flag: "wx" });
    return destination;
}

const usage = "agent:bench tasks | template --task ID --variant SLUG --trial N | record --input FILE | compare --baseline SLUG --candidate SLUG [--json] | handoff --task SLUG";

function main(args: string[]): number {
    const command = args.shift();
    if (!command || command === "--help") { console.log(usage); return 0; }
    const options = new Map<string, string>();
    let asJson = false;
    while (args.length) {
        const option = args.shift()!;
        if (option === "--json") { if (asJson) throw new Error("Duplicate --json"); asJson = true; continue; }
        if (!option.startsWith("--") || options.has(option)) throw new Error(`Invalid/duplicate option: ${option}`);
        const value = args.shift();
        if (!value || value.startsWith("--")) throw new Error(`Missing value: ${option}`);
        options.set(option, value);
    }
    const allowed: Record<string, string[]> = { tasks: [], template: ["--task", "--variant", "--trial"], record: ["--input"], compare: ["--baseline", "--candidate"], handoff: ["--task"] };
    if (!allowed[command] || [...options.keys()].some(option => !allowed[command]!.includes(option)) || (asJson && command !== "compare")) throw new Error(usage);
    const required = (option: string) => text(options.get(option), option);
    if (command === "tasks") { console.log(JSON.stringify({ taskSetHash: TASK_SET_HASH, tasks }, null, 2)); return 0; }
    if (command === "template") {
        const taskId = required("--task"), variant = required("--variant"), trial = Number(required("--trial"));
        if (!tasks.some(task => task.id === taskId) || !slug.test(variant) || !Number.isSafeInteger(trial) || trial < 1) throw new Error("Invalid task, variant, or trial");
        console.log(JSON.stringify({
            formatVersion: 1, taskSetHash: TASK_SET_HASH, taskId, trial, variant,
            fixtureRevision: "REPLACE_WITH_FULL_FIXTURE_COMMIT", model: "REPLACE_WITH_EXACT_MODEL", reasoningEffort: "REPLACE_WITH_EFFORT",
            metrics: { inputTokens: null, outputTokens: null, cachedInputTokens: 0, reasoningTokens: 0, wallTimeMs: null, toolCalls: null, correctiveFollowups: null },
            review: { passed: null, reviewer: "", notes: "" }, checks: [], evidence: [],
        }, null, 2));
        return 0;
    }
    if (command === "handoff") {
        const task = required("--task");
        if (!slug.test(task)) throw new Error("Task must be a lowercase slug of at most 64 characters");
        const directory = path.join(root, "artifacts", "agent-handoffs");
        fs.mkdirSync(directory, { recursive: true });
        const destination = path.join(directory, `${task}.md`);
        fs.copyFileSync(path.join(root, "docs", "agent-handoff.template.md"), destination, fs.constants.COPYFILE_EXCL);
        console.log(destination);
        return 0;
    }
    if (command === "record") { console.log(saveAgentRun(json(path.resolve(required("--input"))))); return 0; }
    const baseline = required("--baseline"), candidate = required("--candidate");
    if (!slug.test(baseline) || !slug.test(candidate) || baseline === candidate) throw new Error("Choose two distinct variant slugs");
    const runs: AgentRun[] = [];
    for (const variant of [baseline, candidate]) {
        const directory = path.join(storage, variant);
        if (!fs.existsSync(directory)) continue;
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const file = path.join(directory, entry.name, "run.json");
            if (!fs.existsSync(file)) throw new Error(`Incomplete recorded run: ${entry.name}`);
            const run = validateAgentRun(json(file));
            if (run.variant !== variant) throw new Error(`Variant disagrees with directory: ${file}`);
            runs.push(run);
        }
    }
    const report = compareAgentRuns(runs, baseline, candidate);
    fs.mkdirSync(storage, { recursive: true });
    const file = path.join(storage, `${baseline}-vs-${candidate}.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
    if (asJson) console.log(JSON.stringify(report, null, 2));
    else {
        console.log(`Agent benchmark: ${report.status}; ${report.pairedRuns} paired runs`);
        for (const issue of report.issues) console.log(`  ${issue}`);
        if (report.aggregate) console.log(`Tokens: ${report.aggregate.baseline.tokens} -> ${report.aggregate.candidate.tokens}; reduction ${report.aggregate.tokenReductionPct?.toFixed(1) ?? "n/a"}%`);
        console.log(`Report: ${file}\n${report.caveat}`);
    }
    return report.status === "insufficient-evidence" ? 2 : report.status === "improved" ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try { process.exitCode = main(process.argv.slice(2)); }
    catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
