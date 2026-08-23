/**
 * Fresh-window research analyzer.
 *
 * S0 is deliberately a hard gate: if the program archive cannot prove that
 * its point-in-time folds, full-pool denominators, identity rows, and
 * execution outcomes are valid, this script exits after S0 and prints no
 * research verdict. The analysis below S0 is intentionally small and fixed;
 * it is not a metric scanner.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type {
    FinderAssetOpportunityCandidateSummaryRow,
} from "../lib/finder/finder-asset-opportunity-research-types";
import { buildFinderAssetOpportunityControlTrace } from "../lib/finder/finder-asset-opportunity-control-trace";
import {
    isFinderFreshWindowBatchRole,
    type FinderFreshWindowBatchRole,
} from "../lib/finder/finder-asset-opportunity-research-types";

const SEPARATOR = "=".repeat(80);
const IDENTITY_FILE = /^oos-fold-identities-(\d+)-bars\.txt$/;
const HOLDOUT_FILE = /^oos-holdout-(\d+)-bars\.txt$/;
const DEFAULT_HORIZON = 12;
const DEFAULT_STRIDE = 12;
const DEFAULT_SEED = 42;
const EXPECTED_WINDOWS = 25;
const COMPLETE_MARKER = "Record complete: true";

export type FreshWindowExitReason = "take_profit" | "stop_loss" | "end_of_data";

export interface FreshWindowOutcome {
    exitReason: FreshWindowExitReason;
    barsHeld: number;
    grossReturnPercent: number;
    slippagePercent: number;
    commissionPercent: number;
    netReturnPercent: number;
    entryPrice: number;
    exitPrice: number;
    entryTimestamp: string;
    exitTimestamp: string;
}

export interface FreshWindowIdentityFold {
    timestamp: string;
    batchRunId: string;
    batchRole: FinderFreshWindowBatchRole | null;
    holdoutBars: number;
    declaredRowCount: number;
    expectedRowCount: number | null;
    outcomeRowCount: number | null;
    controlSeed: number | null;
    controlDrawIdentities: Array<{ symbol: string; identityHash: string | null }> | null;
    controlDrawDigest: string | null;
    foldEnd: number | null;
    searchWindowEnd: number | null;
    oosStart: number | null;
    oosEnd: number | null;
    rows: FinderAssetOpportunityCandidateSummaryRow[];
    judgmentStatus?: "VALID" | "INVALID";
}

export interface FreshWindowConfig {
    runId?: string;
    interval?: string;
    strategyKeys?: string[];
    finder?: Record<string, unknown> & {
        assetOpportunity?: {
            evalLastBars?: number;
            oosIgnoreLastBars?: number;
            oosHorizons?: number[];
        };
    };
    freshWindowIdentity?: Record<string, unknown>;
    judgmentStatus?: "VALID" | "INVALID";
    backtestSettings?: Record<string, unknown>;
    capitalSettings?: Record<string, unknown>;
}

interface ParsedConfigRecord {
    timestamp: string;
    batchRunId: string;
    config: FreshWindowConfig;
}

export interface S0Result {
    ok: boolean;
    errors: string[];
    windows: FreshWindowIdentityFold[];
    config: FreshWindowConfig | null;
    handChecks: Record<FreshWindowExitReason, number>;
    fullPoolRows: number;
    eligibleRows: number;
    finiteExecutionRows: number;
    randomControls: number;
    controlSeed: number;
    controlDrawDigest: string;
    batchRole: FinderFreshWindowBatchRole | null;
}

interface FoldMetric {
    fold: FreshWindowIdentityFold;
    selected: number;
    control: number;
    delta: number;
    selectedNet: number | null;
    controlNet: number | null;
}

interface VerdictSummary {
    mean: number;
    median: number;
    positiveWindows: number;
    windows: number;
    signStability: number;
    bootstrapP5: number;
    bootstrapP50: number;
    verdict: "STABLE+" | "WEAK+" | "UNSTABLE";
}

function argument(argv: string[], name: string): string | undefined {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
}

function sha256Tuple(symbol: string, strategyKey: string, fingerprint: string): string {
    return createHash("sha256")
        .update(JSON.stringify([symbol, strategyKey, fingerprint]))
        .digest("hex");
}

function sha256Json(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function finiteNumber(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseHeaderNumber(lines: string[], prefix: string): number | null {
    const line = lines.find((value) => value.startsWith(prefix));
    if (!line) return null;
    const value = Number(line.slice(prefix.length).trim().replace(/ bars$/, ""));
    return Number.isFinite(value) ? value : null;
}

function parseHeaderText(lines: string[], prefix: string): string | null {
    const line = lines.find((value) => value.startsWith(prefix));
    return line ? line.slice(prefix.length).trim() : null;
}

function parseHeaderJson<T>(lines: string[], prefix: string): T | null {
    const value = parseHeaderText(lines, prefix);
    if (!value || value === "unknown") return null;
    try {
        return JSON.parse(value) as T;
    } catch {
        return null;
    }
}

function parseBlocks(text: string): string[] {
    const sections = text.split(SEPARATOR);
    const blocks: string[] = [];
    // Every archive block has exactly two delimiters: one before the headers
    // and one before the scalar JSON payload. The payload may span lines in
    // config.txt, so splitting only on the delimiter is safer than a greedy
    // JSON-line regex.
    for (let index = 1; index + 1 < sections.length; index += 2) {
        const block = `${sections[index]}${SEPARATOR}${sections[index + 1]}`;
        const lastLine = block.trimEnd().split(/\r?\n/).at(-1);
        if (lastLine === COMPLETE_MARKER) blocks.push(block);
    }
    return blocks;
}

function parseIdentityBlock(body: string): FreshWindowIdentityFold | null {
    const marker = body.indexOf(SEPARATOR);
    if (marker < 0) return null;
    const header = body.slice(0, marker).split(/\r?\n/).filter(Boolean);
    const payload = body.slice(marker + SEPARATOR.length).split(/\r?\n/).find((line) => line.trim());
    if (!payload) return null;
    let rows: FinderAssetOpportunityCandidateSummaryRow[];
    try {
        rows = JSON.parse(payload) as FinderAssetOpportunityCandidateSummaryRow[];
    } catch {
        return null;
    }
    if (!Array.isArray(rows)) return null;
    const status = parseHeaderText(header, "Judgment: ");
    return {
        timestamp: parseHeaderText(header, "Timestamp: ") ?? "",
        batchRunId: parseHeaderText(header, "Batch run id: ") ?? "",
        batchRole: (() => {
            const value = parseHeaderText(header, "Batch role: ");
            return isFinderFreshWindowBatchRole(value) ? value : null;
        })(),
        holdoutBars: parseHeaderNumber(header, "OOS holdout: ") ?? 0,
        declaredRowCount: parseHeaderNumber(header, "Declared row count: ") ?? -1,
        expectedRowCount: parseHeaderNumber(header, "Expected evaluated row count: "),
        outcomeRowCount: parseHeaderNumber(header, "Forward outcome row count: "),
        controlSeed: parseHeaderNumber(header, "Control seed: "),
        controlDrawIdentities: parseHeaderJson<Array<{ symbol: string; identityHash: string | null }>>(
            header,
            "Control draw identities: ",
        ),
        controlDrawDigest: parseHeaderText(header, "Control draw digest: "),
        foldEnd: parseHeaderNumber(header, "Fold end: "),
        searchWindowEnd: parseHeaderNumber(header, "Search window end: "),
        oosStart: parseHeaderNumber(header, "OOS start: "),
        oosEnd: parseHeaderNumber(header, "OOS end: "),
        rows,
        ...(status === "VALID" || status === "INVALID" ? { judgmentStatus: status } : {}),
    };
}

function parseConfigRecords(text: string): ParsedConfigRecord[] {
    const blocks = parseBlocks(text);
    const parsed: ParsedConfigRecord[] = [];
    for (const body of blocks) {
        if (!body.includes("Run configuration: JSON")) continue;
        const start = body.indexOf("{", body.indexOf(SEPARATOR));
        const end = body.lastIndexOf("}");
        if (start < 0 || end <= start) continue;
        try {
            const config = JSON.parse(body.slice(start, end + 1)) as FreshWindowConfig;
            parsed.push({
                timestamp: parseHeaderText(body.split(/\r?\n/), "Timestamp: ") ?? "",
                batchRunId: parseHeaderText(body.split(/\r?\n/), "Batch run id: ") ?? "",
                config,
            });
        } catch {
            // The newest parseable config block wins; malformed blocks are not
            // silently accepted because S0 reports the missing identity.
        }
    }
    parsed.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
    return parsed;
}

function parseConfig(text: string): FreshWindowConfig | null {
    return parseConfigRecords(text).at(-1)?.config ?? null;
}

function latestIdentityBlock(fileText: string): FreshWindowIdentityFold | null {
    const blocks = parseBlocks(fileText)
        .map(parseIdentityBlock)
        .filter((block): block is FreshWindowIdentityFold => block !== null);
    blocks.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
    return blocks.at(-1) ?? null;
}

function expectedHoldouts(stride: number): Set<number> {
    const output = new Set<number>();
    for (let holdout = stride; holdout <= 300; holdout += stride) output.add(holdout);
    return output;
}

function normalizeOutcome(row: FinderAssetOpportunityCandidateSummaryRow, horizon: number): FreshWindowOutcome | null {
    const outcome = row.forwardOutcomes?.[String(horizon)] as FreshWindowOutcome | undefined;
    if (!outcome) return null;
    if (
        (outcome.exitReason !== "take_profit"
            && outcome.exitReason !== "stop_loss"
            && outcome.exitReason !== "end_of_data")
        || finiteNumber(outcome.barsHeld) === null
        || finiteNumber(outcome.netReturnPercent) === null
        || finiteNumber(outcome.grossReturnPercent) === null
        || finiteNumber(outcome.slippagePercent) === null
        || finiteNumber(outcome.commissionPercent) === null
        || finiteNumber(outcome.entryPrice) === null
        || finiteNumber(outcome.exitPrice) === null
        || typeof outcome.entryTimestamp !== "string"
        || outcome.entryTimestamp.length === 0
        || typeof outcome.exitTimestamp !== "string"
        || outcome.exitTimestamp.length === 0
    ) return null;
    return outcome;
}

function createRng(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6D2B79F5) | 0;
        let value = Math.imul(state ^ (state >>> 15), 1 | state);
        value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

function median(values: number[]): number {
    if (values.length === 0) return Number.NaN;
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[middle - 1]! + sorted[middle]!) / 2
        : sorted[middle]!;
}

function mean(values: number[]): number {
    return values.length > 0
        ? values.reduce((sum, value) => sum + value, 0) / values.length
        : Number.NaN;
}

function sampleOne<T>(values: readonly T[], rng: () => number): T | null {
    return values.length > 0 ? values[Math.floor(rng() * values.length)]! : null;
}

function topByProfitFactor(rows: readonly FinderAssetOpportunityCandidateSummaryRow[]): FinderAssetOpportunityCandidateSummaryRow | null {
    return [...rows]
        .filter((row) => row.evaluationOk && row.passesTradeFilter && row.profitFactor !== null)
        .sort((left, right) => (right.profitFactor ?? -Infinity) - (left.profitFactor ?? -Infinity)
            || left.candidateIndex - right.candidateIndex)
        .at(0) ?? null;
}

function topByTimeToTp(rows: readonly FinderAssetOpportunityCandidateSummaryRow[]): FinderAssetOpportunityCandidateSummaryRow | null {
    return [...rows]
        .filter((row) => row.tpHitCount !== null
            && row.tpHitCount >= 3
            && row.medianBarsToTP !== null
            && Number.isFinite(row.medianBarsToTP))
        .sort((left, right) => (left.medianBarsToTP ?? Infinity) - (right.medianBarsToTP ?? Infinity)
            || left.symbol.localeCompare(right.symbol)
            || left.strategyKey.localeCompare(right.strategyKey)
            || left.candidateFingerprint.localeCompare(right.candidateFingerprint)
            || left.candidateIndex - right.candidateIndex)
        .at(0) ?? null;
}

function orderedByFoldEnd(windows: readonly FreshWindowIdentityFold[]): FreshWindowIdentityFold[] {
    return [...windows].sort((left, right) => (left.foldEnd ?? Infinity) - (right.foldEnd ?? Infinity));
}

function eligibleRows(rows: readonly FinderAssetOpportunityCandidateSummaryRow[], horizon: number): FinderAssetOpportunityCandidateSummaryRow[] {
    return rows.filter((row) => row.evaluationOk && row.passesTradeFilter && normalizeOutcome(row, horizon) !== null);
}

function buildControlDrawDigest(
    windows: readonly FreshWindowIdentityFold[],
    horizon: number,
    seed: number,
): string {
    const trace = orderedByFoldEnd(windows).map((fold) => {
        const draw = buildFinderAssetOpportunityControlTrace(
            fold.rows,
            Math.max(0, Math.floor(fold.holdoutBars / DEFAULT_STRIDE) - 1),
            horizon,
            seed,
        );
        return { holdoutBars: fold.holdoutBars, draws: draw.draws };
    });
    return sha256Json(trace);
}

function computeWindowMetrics(
    fold: FreshWindowIdentityFold,
    horizon: number,
    rng: () => number,
): FoldMetric | null {
    const bySymbol = new Map<string, FinderAssetOpportunityCandidateSummaryRow[]>();
    for (const row of fold.rows) {
        const rows = bySymbol.get(row.symbol) ?? [];
        rows.push(row);
        bySymbol.set(row.symbol, rows);
    }
    const selectedNet: number[] = [];
    const controlNet: number[] = [];
    for (const [, rows] of [...bySymbol.entries()].sort(([left], [right]) => left.localeCompare(right))) {
        const eligible = eligibleRows(rows, horizon);
        const selected = topByTimeToTp(eligible);
        const control = sampleOne(eligible, rng);
        if (!selected || !control) continue;
        const selectedOutcome = normalizeOutcome(selected, horizon)!;
        const controlOutcome = normalizeOutcome(control, horizon)!;
        selectedNet.push(selectedOutcome.netReturnPercent);
        controlNet.push(controlOutcome.netReturnPercent);
    }
    if (selectedNet.length === 0) return null;
    const selected = mean(selectedNet);
    const control = mean(controlNet);
    return {
        fold,
        selected,
        control,
        delta: selected - control,
        selectedNet: selected,
        controlNet: control,
    };
}

function percentile(values: number[], fraction: number): number {
    if (values.length === 0) return Number.NaN;
    const sorted = [...values].sort((left, right) => left - right);
    const position = (sorted.length - 1) * fraction;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    return lower === upper
        ? sorted[lower]!
        : sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}

export function summarizeVerdict(deltas: number[], seed = DEFAULT_SEED): VerdictSummary {
    const finite = deltas.filter(Number.isFinite);
    if (finite.length === 0) {
        return {
            mean: Number.NaN,
            median: Number.NaN,
            positiveWindows: 0,
            windows: 0,
            signStability: 0,
            bootstrapP5: Number.NaN,
            bootstrapP50: Number.NaN,
            verdict: "UNSTABLE",
        };
    }
    const rng = createRng(seed);
    const bootstrap: number[] = [];
    for (let iteration = 0; iteration < 2000; iteration += 1) {
        const sample: number[] = [];
        for (let index = 0; index < finite.length; index += 1) sample.push(finite[Math.floor(rng() * finite.length)]!);
        bootstrap.push(mean(sample));
    }
    const p5 = percentile(bootstrap, 0.05);
    const p50 = percentile(bootstrap, 0.5);
    const positiveWindows = finite.filter((value) => value > 0).length;
    const signStability = finite.length > 0 ? positiveWindows / finite.length : 0;
    const verdict = p5 > 0 && signStability >= 0.6
        ? "STABLE+"
        : p50 > 0 && signStability >= 0.55 ? "WEAK+" : "UNSTABLE";
    return {
        mean: mean(finite),
        median: median(finite),
        positiveWindows,
        windows: finite.length,
        signStability,
        bootstrapP5: p5,
        bootstrapP50: p50,
        verdict,
    };
}

function loadFolds(archiveDirectory: string): FreshWindowIdentityFold[] {
    const entries = fs.readdirSync(archiveDirectory)
        .map((file) => file.match(IDENTITY_FILE))
        .filter((match): match is RegExpMatchArray => match !== null)
        .map((match) => ({ holdoutBars: Number(match[1]), file: match.input! }))
        .sort((left, right) => left.holdoutBars - right.holdoutBars);
    return entries
        .map(({ file }) => latestIdentityBlock(fs.readFileSync(path.join(archiveDirectory, file), "utf8")))
        .filter((fold): fold is FreshWindowIdentityFold => fold !== null);
}

function loadAllIdentityBlocks(archiveDirectory: string): FreshWindowIdentityFold[] {
    return fs.readdirSync(archiveDirectory)
        .map((file) => file.match(IDENTITY_FILE))
        .filter((match): match is RegExpMatchArray => match !== null)
        .flatMap((match) => {
            const file = match.input!;
            return parseBlocks(fs.readFileSync(path.join(archiveDirectory, file), "utf8"))
                .map(parseIdentityBlock)
                .filter((block): block is FreshWindowIdentityFold => block !== null);
        });
}

function loadConfig(archiveDirectory: string): FreshWindowConfig | null {
    const filename = path.join(archiveDirectory, "config.txt");
    return fs.existsSync(filename) ? parseConfig(fs.readFileSync(filename, "utf8")) : null;
}

function loadConfigRecords(archiveDirectory: string): ParsedConfigRecord[] {
    const filename = path.join(archiveDirectory, "config.txt");
    return fs.existsSync(filename)
        ? parseConfigRecords(fs.readFileSync(filename, "utf8"))
        : [];
}

function hasValidPriorArchiveRole(
    records: readonly ParsedConfigRecord[],
    allIdentityBlocks: readonly FreshWindowIdentityFold[],
    role: FinderFreshWindowBatchRole,
    currentWindows: readonly FreshWindowIdentityFold[],
): boolean {
    const currentTimestamp = records.at(-1)?.timestamp ?? "";
    const currentRunId = records.at(-1)?.config.runId ?? "";
    const currentFoldEnds = currentWindows
        .map((fold) => fold.foldEnd)
        .filter((value): value is number => value !== null && Number.isFinite(value));
    const currentLatestFoldEnd = Math.max(...currentFoldEnds);
    for (const record of records) {
        if (record.timestamp >= currentTimestamp || record.batchRunId === currentRunId) continue;
        if (record.config.judgmentStatus !== "VALID") continue;
        const identity = record.config.freshWindowIdentity as Record<string, unknown> | undefined;
        if (identity?.batchRole !== role) continue;
        const digest = identity?.configIdentityDigest;
        if (typeof digest !== "string") continue;
        const { configIdentityDigest, ...withoutDigest } = identity;
        if (sha256Json(withoutDigest) !== digest) continue;
        const blocks = allIdentityBlocks.filter((block) =>
            block.batchRunId === (record.config.runId ?? record.batchRunId)
            && block.batchRole === role
            && block.judgmentStatus === "VALID",
        );
        const byHoldout = new Map(blocks.map((block) => [block.holdoutBars, block]));
        if (expectedHoldouts(DEFAULT_STRIDE).size !== byHoldout.size) continue;
        if (![...expectedHoldouts(DEFAULT_STRIDE)].every((holdout) => byHoldout.has(holdout))) continue;
        const priorFoldEnds = blocks
            .map((block) => block.foldEnd)
            .filter((value): value is number => value !== null && Number.isFinite(value));
        if (priorFoldEnds.length === EXPECTED_WINDOWS
            && priorFoldEnds.some((foldEnd) => foldEnd < currentLatestFoldEnd)) {
            return true;
        }
    }
    return false;
}

function checkS0(
    archiveDirectory: string,
    stride: number,
    horizon: number,
): S0Result {
    const allFolds = loadFolds(archiveDirectory);
    const expected = expectedHoldouts(stride);
    const windows = allFolds.filter((fold) => expected.has(fold.holdoutBars));
    const configRecords = loadConfigRecords(archiveDirectory);
    const allIdentityBlocks = loadAllIdentityBlocks(archiveDirectory);
    const config = loadConfig(archiveDirectory);
    const errors: string[] = [];
    if (windows.length !== EXPECTED_WINDOWS) errors.push(`expected ${EXPECTED_WINDOWS} stride-${stride} windows, found ${windows.length}`);
    if (!config) errors.push("config.txt has no parseable configuration block");
    if (config?.judgmentStatus !== "VALID") errors.push("configuration judgmentStatus is not VALID");
    const identity = config?.freshWindowIdentity;
    const requiredIdentityFields = [
        "researchProgram",
        "symbolDigest",
        "strategyDigest",
        "providerBySymbol",
        "engine",
        "foldSchedule",
        "foldScheduleDigest",
        "controlSeed",
        "batchRole",
        "dataSyncSnapshot",
        "gitCommit",
        "configIdentityDigest",
    ];
    for (const field of requiredIdentityFields) {
        if (identity?.[field] === undefined || identity?.[field] === null || identity?.[field] === "") {
            errors.push(`fresh-window identity field is missing: ${field}`);
        }
    }
    if (identity?.researchProgram !== "fresh-window") errors.push("identity researchProgram is not fresh-window");
    if (identity?.dataSyncSnapshot === "unknown") errors.push("dataSyncSnapshot is unknown");
    if (identity?.gitCommit === "unknown") errors.push("gitCommit is unknown");
    if (identity?.controlSeed !== DEFAULT_SEED) errors.push(`control seed must be ${DEFAULT_SEED}`);
    const batchRole = isFinderFreshWindowBatchRole(identity?.batchRole) ? identity.batchRole : null;
    if (!batchRole) errors.push("fresh-window identity batchRole is missing or invalid");
    if (batchRole && config?.freshWindowIdentity && config.freshWindowIdentity.batchRole !== batchRole) {
        errors.push("configuration and identity batchRole differ");
    }
    if (batchRole === "judged"
        && config
        && !hasValidPriorArchiveRole(configRecords, allIdentityBlocks, "collection", windows)) {
        errors.push("judged batch has no prior VALID collection archive with strictly-earlier folds");
    }
    if (batchRole === "replication"
        && config
        && !hasValidPriorArchiveRole(configRecords, allIdentityBlocks, "judged", windows)) {
        errors.push("replication batch has no prior VALID judged archive with strictly-earlier folds");
    }
    if (identity) {
        const { configIdentityDigest, ...identityWithoutDigest } = identity;
        if (typeof configIdentityDigest !== "string"
            || sha256Json(identityWithoutDigest) !== configIdentityDigest) {
            errors.push("config identity digest mismatch");
        }
        if (!Array.isArray(identity.symbols) || sha256Json(identity.symbols) !== identity.symbolDigest) {
            errors.push("symbol list digest mismatch");
        }
        if (!Array.isArray(identity.strategyKeys) || sha256Json(identity.strategyKeys) !== identity.strategyDigest) {
            errors.push("strategy list digest mismatch");
        }
        if (!Array.isArray(identity.foldSchedule) || identity.foldSchedule.length !== EXPECTED_WINDOWS) {
            errors.push(`fold schedule must contain ${EXPECTED_WINDOWS} entries`);
        } else if (sha256Json(identity.foldSchedule) !== identity.foldScheduleDigest) {
            errors.push("fold schedule digest mismatch");
        }
    }
    const engine = identity?.engine as { effective?: unknown } | undefined;
    if (engine?.effective !== "typescript") errors.push("fresh-window effective engine is not recorded as TypeScript");
    const backtestSettings = config?.backtestSettings;
    const capitalSettings = config?.capitalSettings;
    if (config?.interval !== "4h") errors.push(`config interval is ${String(config?.interval)}`);
    const frozenSettings: Record<string, unknown> = {
        executionModel: "next_open",
        tradeDirection: "long",
        allowSameBarExit: false,
        riskMode: "percentage",
        stopLossEnabled: true,
        stopLossPercent: 2,
        takeProfitEnabled: true,
        takeProfitPercent: 2,
    };
    for (const [key, expectedValue] of Object.entries(frozenSettings)) {
        if (backtestSettings?.[key] !== expectedValue) {
            errors.push(`backtest setting ${key} is ${String(backtestSettings?.[key])}, expected ${String(expectedValue)}`);
        }
    }
    if (finiteNumber(backtestSettings?.slippageBps) === null) errors.push("slippageBps is missing from the execution identity");
    if (finiteNumber(capitalSettings?.commission) === null) errors.push("commission is missing from the execution identity");
    if (finiteNumber(backtestSettings?.slippageBps) !== 10) errors.push("slippageBps must be 10");
    if (finiteNumber(capitalSettings?.commission) !== 0.1) errors.push("commission must be 0.1");
    const finder = config?.finder as Record<string, unknown> | undefined;
    if (finder?.scope !== "asset_opportunity") errors.push("finder scope is not asset_opportunity");
    if (finder?.mode !== "random") errors.push("finder mode is not random");
    const runIds = new Set(windows.map((fold) => fold.batchRunId));
    if (runIds.size !== 1) errors.push(`identity blocks contain ${runIds.size} batch run ids`);
    const foldEnds = windows.map((fold) => fold.foldEnd).filter((value): value is number => value !== null);
    if (foldEnds.length !== windows.length || new Set(foldEnds).size !== foldEnds.length) {
        errors.push("fold ends are missing or repeated; point-in-time folds are not distinct");
    }
    const foldSchedule = Array.isArray(identity?.foldSchedule)
        ? identity.foldSchedule as Array<{ holdoutBars?: unknown; foldEnd?: unknown }>
        : [];
    for (const fold of windows) {
        const marker = foldSchedule.find((entry) => entry.holdoutBars === fold.holdoutBars);
        if (!marker || marker.foldEnd !== fold.foldEnd) {
            errors.push(`fold marker does not match the declared schedule at holdout ${fold.holdoutBars} (archive=${String(fold.foldEnd)}, schedule=${String(marker?.foldEnd)})`);
        }
        if (fold.foldEnd === null || !Number.isFinite(fold.foldEnd) || fold.foldEnd <= 0) {
            errors.push(`invalid foldEnd at holdout ${fold.holdoutBars}`);
        }
        if (fold.foldEnd === null || fold.searchWindowEnd === null || fold.oosStart === null || fold.oosEnd === null) {
            errors.push(`fold bounds are incomplete at holdout ${fold.holdoutBars}`);
        } else if (fold.searchWindowEnd > fold.foldEnd!) {
            errors.push(`search window exceeds foldEnd at holdout ${fold.holdoutBars}`);
        } else if (fold.oosStart <= fold.foldEnd!) {
            errors.push(`OOS starts at or before foldEnd at holdout ${fold.holdoutBars}`);
        } else if (fold.oosEnd < fold.oosStart) {
            errors.push(`OOS interval is inverted at holdout ${fold.holdoutBars}`);
        }
    }
    const ordered = [...windows].sort((left, right) => (left.oosStart ?? Infinity) - (right.oosStart ?? Infinity));
    for (let index = 1; index < ordered.length; index += 1) {
        if (ordered[index - 1]!.oosEnd !== null
            && ordered[index]!.oosStart !== null
            && ordered[index - 1]!.oosEnd! >= ordered[index]!.oosStart!) {
            errors.push("forward target intervals overlap");
            break;
        }
    }
    const identityRows = windows.flatMap((fold) => fold.rows);
    for (const fold of windows) {
        if (fold.judgmentStatus !== "VALID") {
            errors.push(`fold judgment is not VALID at holdout ${fold.holdoutBars}`);
        }
        if (fold.declaredRowCount !== fold.rows.length) errors.push(`row count mismatch at holdout ${fold.holdoutBars}`);
        if (fold.expectedRowCount === null || fold.expectedRowCount < 0) {
            errors.push(`expected evaluated row count is missing at holdout ${fold.holdoutBars}`);
        } else if (fold.expectedRowCount !== fold.rows.length) {
            errors.push(`expected evaluated row count mismatch at holdout ${fold.holdoutBars}`);
        }
        const validOutcomeCount = fold.rows.filter((row) => normalizeOutcome(row, horizon) !== null).length;
        if (fold.outcomeRowCount === null || fold.outcomeRowCount < 0) {
            errors.push(`forward outcome row count is missing at holdout ${fold.holdoutBars}`);
        } else if (fold.expectedRowCount !== null
            && fold.expectedRowCount > 0
            && fold.outcomeRowCount / fold.expectedRowCount < 0.95) {
            errors.push(`forward outcome coverage below 95% at holdout ${fold.holdoutBars}`);
        } else if (fold.outcomeRowCount !== validOutcomeCount) {
            errors.push(`forward outcome validity count mismatch at holdout ${fold.holdoutBars}`);
        } else if (fold.expectedRowCount !== null
            && fold.expectedRowCount > 0
            && validOutcomeCount / fold.expectedRowCount < 0.95) {
            errors.push(`valid forward outcome coverage below 95% at holdout ${fold.holdoutBars}`);
        }
        for (const row of fold.rows) {
            if (!row.symbol || !row.strategyKey || !row.candidateFingerprint || !row.identityHash) {
                errors.push(`incomplete candidate identity at holdout ${fold.holdoutBars}`);
                break;
            }
            if (sha256Tuple(row.symbol, row.strategyKey, row.candidateFingerprint) !== row.identityHash) {
                errors.push(`candidate tuple hash mismatch at holdout ${fold.holdoutBars}`);
                break;
            }
        }
    }
    const orderedTraceWindows = orderedByFoldEnd(windows);
    for (const fold of orderedTraceWindows) {
        const archivedDraws = fold.controlDrawIdentities;
        if (fold.controlSeed !== DEFAULT_SEED
            || archivedDraws === null
            || fold.controlDrawDigest === null
            || fold.controlDrawDigest === "unknown") {
            errors.push(`control draw trace is missing at holdout ${fold.holdoutBars}`);
            continue;
        }
        const recomputed = buildFinderAssetOpportunityControlTrace(
            fold.rows,
            Math.max(0, Math.floor(fold.holdoutBars / stride) - 1),
            horizon,
            fold.controlSeed,
        );
        if (recomputed.digest !== fold.controlDrawDigest
            || JSON.stringify(recomputed.draws) !== JSON.stringify(archivedDraws)) {
            errors.push(`control draw trace mismatch at holdout ${fold.holdoutBars}`);
        }
    }
    const handChecks: Record<FreshWindowExitReason, number> = {
        take_profit: 0,
        stop_loss: 0,
        end_of_data: 0,
    };
    let eligibleRows = 0;
    let finiteExecutionRows = 0;
    for (const row of identityRows) {
        if (row.evaluationOk && row.passesTradeFilter) eligibleRows += 1;
        const outcome = normalizeOutcome(row, horizon);
        if (!outcome) continue;
        finiteExecutionRows += 1;
        handChecks[outcome.exitReason] += 1;
    }
    for (const reason of ["take_profit", "stop_loss", "end_of_data"] as const) {
        if (handChecks[reason] === 0) errors.push(`no hand-checkable ${reason} execution outcome`);
    }
    if (identityRows.length === 0) errors.push("full-pool identity rows are absent");
    const selectedControls = windows
        .map((fold, index) => computeWindowMetrics(fold, horizon, createRng(DEFAULT_SEED + index)))
        .filter((metric): metric is FoldMetric => metric !== null);
    if (selectedControls.length !== windows.length) errors.push("full-pool random control is missing in one or more windows");
    const options = config?.finder?.assetOpportunity;
    if (options?.evalLastBars !== 1000) errors.push(`config evalLastBars is ${String(options?.evalLastBars)}`);
    if (options?.oosIgnoreLastBars !== 26) errors.push(`config oosIgnoreLastBars is ${String(options?.oosIgnoreLastBars)}`);
    if (JSON.stringify(options?.oosHorizons ?? []) !== JSON.stringify([12, 18, 24])) errors.push("config horizons are not [12,18,24]");
    const controlSeed = identity?.controlSeed === DEFAULT_SEED ? DEFAULT_SEED : -1;
    const controlDrawDigest = controlSeed === DEFAULT_SEED
        ? buildControlDrawDigest(windows, horizon, controlSeed)
        : "invalid";
    return {
        ok: errors.length === 0,
        errors: [...new Set(errors)],
        windows,
        config,
        handChecks,
        fullPoolRows: identityRows.length,
        eligibleRows,
        finiteExecutionRows,
        randomControls: selectedControls.length,
        controlSeed,
        controlDrawDigest,
        batchRole,
    };
}

function recurrenceReport(
    windows: FreshWindowIdentityFold[],
    horizon: number,
    seed: number,
    batchRole: FinderFreshWindowBatchRole | null,
): string[] {
    if (batchRole === "collection") {
        return [
            "Recurrence: NOT AUTHORIZED (collection archive; judged role requires a prior collection)",
            "Recurrence budget: collection=PASS, judged=NOT AUTHORIZED, replication=NOT AUTHORIZED",
        ];
    }
    const ordered = orderedByFoldEnd(windows);
    const seenCounts = new Map<string, number>();
    const foldDeltas: Array<{ foldEnd: number; delta: number }> = [];
    const densities: number[] = [];
    for (const fold of ordered) {
        const currentRows = fold.rows.filter((row) => row.evaluationOk && row.passesTradeFilter);
        const priorCounts = new Map<string, number>();
        let recurring = 0;
        for (const row of currentRows) {
            const count = seenCounts.get(row.identityHash) ?? 0;
            priorCounts.set(row.identityHash, count);
            if (count > 0) recurring += 1;
        }
        const density = currentRows.length > 0 ? recurring / currentRows.length : 0;
        densities.push(density);
        if (density >= 0.05) {
            const rowsBySymbol = new Map<string, FinderAssetOpportunityCandidateSummaryRow[]>();
            for (const row of currentRows) {
                const rows = rowsBySymbol.get(row.symbol) ?? [];
                rows.push(row);
                rowsBySymbol.set(row.symbol, rows);
            }
            const rng = createRng(seed + (fold.foldEnd ?? fold.holdoutBars));
            const deltas: number[] = [];
            for (const [, rows] of [...rowsBySymbol.entries()].sort(([left], [right]) => left.localeCompare(right))) {
                const eligible = rows.filter((row) => normalizeOutcome(row, horizon) !== null);
                const selected = [...eligible]
                    .sort((left, right) => (priorCounts.get(right.identityHash) ?? 0) - (priorCounts.get(left.identityHash) ?? 0)
                        || left.strategyKey.localeCompare(right.strategyKey)
                        || left.candidateFingerprint.localeCompare(right.candidateFingerprint)
                        || left.candidateIndex - right.candidateIndex)
                    .at(0);
                const control = sampleOne(eligible, rng);
                if (!selected || !control) continue;
                const selectedOutcome = normalizeOutcome(selected, horizon)!;
                const controlOutcome = normalizeOutcome(control, horizon)!;
                deltas.push(selectedOutcome.netReturnPercent - controlOutcome.netReturnPercent);
            }
            if (deltas.length > 0 && fold.foldEnd !== null) {
                foldDeltas.push({ foldEnd: fold.foldEnd, delta: mean(deltas) });
            }
        }
        for (const row of currentRows) seenCounts.set(row.identityHash, (seenCounts.get(row.identityHash) ?? 0) + 1);
    }
    if (foldDeltas.length === 0) {
        const latestDensity = densities.at(-1) ?? 0;
        return [
            `Recurrence: INSUFFICIENT DATA (no judged fold at density >=5%; latest density ${(latestDensity * 100).toFixed(2)}%)`,
            batchRole === "replication"
                ? "Recurrence budget: collection=PASS, judged=PASS, replication=INSUFFICIENT"
                : "Recurrence budget: collection=PASS, judged=PASS, replication=NOT AUTHORIZED",
        ];
    }
    const deltas = foldDeltas.map(({ delta }) => delta);
    const verdict = summarizeVerdict(deltas, seed);
    const midpoint = Math.ceil(foldDeltas.length / 2);
    const firstHalf = mean(foldDeltas.slice(0, midpoint).map(({ delta }) => delta));
    const secondHalf = mean(foldDeltas.slice(midpoint).map(({ delta }) => delta));
    const kill = verdict.verdict === "UNSTABLE"
        || verdict.mean <= 0
        || verdict.signStability < 0.55
        || firstHalf <= 0
        || secondHalf <= 0;
    const latestDensity = densities.at(-1) ?? 0;
    return [
        `Recurrence: ${kill ? "KILL" : verdict.verdict} execution-net delta=${verdict.mean.toFixed(4)}% positive=${verdict.positiveWindows}/${verdict.windows} halves=${firstHalf.toFixed(4)}/${secondHalf.toFixed(4)} latest density ${(latestDensity * 100).toFixed(2)}%`,
        batchRole === "replication"
            ? `Recurrence budget: collection=PASS, judged=PASS, replication=${kill ? "KILL" : "PASS"}`
            : "Recurrence budget: collection=PASS, judged=PASS, replication=REQUIRED before any promotion",
    ];
}

function strategyGateReport(windows: FreshWindowIdentityFold[], horizon: number, seed: number): string[] {
    const deltas: number[] = [];
    const ungated: number[] = [];
    const gated: number[] = [];
    const foldIncrements: Array<number | null> = [];
    let totalPairs = 0;
    let gatedPairs = 0;
    const orderedWindows = orderedByFoldEnd(windows);
    for (const fold of orderedWindows) {
        const rowsBySymbol = new Map<string, FinderAssetOpportunityCandidateSummaryRow[]>();
        for (const row of fold.rows) {
            const rows = rowsBySymbol.get(row.symbol) ?? [];
            rows.push(row);
            rowsBySymbol.set(row.symbol, rows);
        }
        const foldUngated: number[] = [];
        const foldGated: number[] = [];
        for (const [symbol, rows] of rowsBySymbol) {
            const eligible = eligibleRows(rows, horizon);
            if (eligible.length === 0) continue;
            totalPairs += 1;
            const distinct = new Set(eligible.map((row) => row.strategyKey)).size;
            const selected = topByProfitFactor(eligible);
            const random = sampleOne(eligible, createRng(seed + fold.holdoutBars + symbol.length));
            if (!selected || !random) continue;
            const selectedOutcome = normalizeOutcome(selected, horizon)!;
            const randomOutcome = normalizeOutcome(random, horizon)!;
            const delta = selectedOutcome.netReturnPercent - randomOutcome.netReturnPercent;
            ungated.push(delta);
            foldUngated.push(delta);
            if (distinct >= 3) {
                gatedPairs += 1;
                gated.push(delta);
                deltas.push(delta);
                foldGated.push(delta);
            }
        }
        foldIncrements.push(foldGated.length > 0 && foldUngated.length > 0
            ? mean(foldGated) - mean(foldUngated)
            : null);
    }
    const coverage = totalPairs > 0 ? gatedPairs / totalPairs : 0;
    if (coverage < 0.1) return [`Strategy gate: KILL (coverage ${(coverage * 100).toFixed(2)}% < 10%)`];
    const gatedSummary = summarizeVerdict(deltas, seed);
    const ungatedMean = mean(ungated);
    const gatedMean = mean(gated);
    const increment = gatedMean - ungatedMean;
    const midpoint = Math.ceil(orderedWindows.length / 2);
    const firstHalfIncrements = foldIncrements.slice(0, midpoint).filter((value): value is number => value !== null);
    const secondHalfIncrements = foldIncrements.slice(midpoint).filter((value): value is number => value !== null);
    const firstIncrement = mean(firstHalfIncrements);
    const secondIncrement = mean(secondHalfIncrements);
    const kill = gatedSummary.verdict === "UNSTABLE"
        || !Number.isFinite(firstIncrement)
        || !Number.isFinite(secondIncrement)
        || firstIncrement < 0
        || secondIncrement < 0;
    return [
        `Strategy gate: ${kill ? "KILL" : gatedSummary.verdict}, coverage ${(coverage * 100).toFixed(2)}%, delta mean ${gatedMean.toFixed(4)}%, ungated increment ${increment.toFixed(4)}% halves=${firstIncrement.toFixed(4)}/${secondIncrement.toFixed(4)}`,
        `Strategy gate diagnostic: ungated pairs ${ungated.length}, gated pairs ${gated.length}`,
    ];
}

function legacyDiagnostic(archiveDirectory: string): string {
    const rows = fs.readdirSync(archiveDirectory)
        .filter((file) => HOLDOUT_FILE.test(file))
        .reduce((count, file) => count + parseBlocks(fs.readFileSync(path.join(archiveDirectory, file), "utf8")).length, 0);
    return `Legacy visible-pool diagnostic only: ${rows} parsed holdout blocks; not used for any fresh-window verdict.`;
}

export function runFreshWindowAnalysis(args: {
    archiveDirectory: string;
    stride?: number;
    horizon?: number;
    seed?: number;
}): string[] {
    const stride = args.stride ?? DEFAULT_STRIDE;
    const horizon = args.horizon ?? DEFAULT_HORIZON;
    const seed = args.seed ?? DEFAULT_SEED;
    const s0 = checkS0(args.archiveDirectory, stride, horizon);
    const lines = [
        "Fresh-window research analyzer",
        `Archive: ${args.archiveDirectory}`,
        `S0: ${s0.ok ? "PASS" : "FAIL"}`,
        `S0 windows=${s0.windows.length}, fullPoolRows=${s0.fullPoolRows}, eligibleRows=${s0.eligibleRows}, finiteExecutionRows=${s0.finiteExecutionRows}, randomControls=${s0.randomControls}`,
        `S0 hand checks: TP=${s0.handChecks.take_profit}, SL=${s0.handChecks.stop_loss}, horizon=${s0.handChecks.end_of_data}`,
        `S0 control trace: seed=${s0.controlSeed}, drawDigest=${s0.controlDrawDigest}`,
    ];
    if (!s0.ok) {
        lines.push(...s0.errors.map((error) => `S0 ERROR: ${error}`));
        return lines;
    }
    const metrics = orderedByFoldEnd(s0.windows)
        .map((fold, index) => computeWindowMetrics(fold, horizon, createRng(seed + index)))
        .filter((metric): metric is FoldMetric => metric !== null);
    const verdict = summarizeVerdict(metrics.map((metric) => metric.delta), seed);
    const midpoint = Math.ceil(metrics.length / 2);
    const firstHalf = mean(metrics.slice(0, midpoint).map((metric) => metric.delta));
    const secondHalf = mean(metrics.slice(midpoint).map((metric) => metric.delta));
    const timeToTpKill = verdict.mean <= 0
        || verdict.signStability < 0.55
        || verdict.verdict === "UNSTABLE"
        || firstHalf <= 0
        || secondHalf <= 0;
    lines.push(
        `Time-to-TP: ${timeToTpKill ? "KILL" : verdict.verdict} execution-net delta(selected-control)=${verdict.mean.toFixed(4)}% positive=${verdict.positiveWindows}/${verdict.windows} p5=${verdict.bootstrapP5.toFixed(4)} halves=${firstHalf.toFixed(4)}/${secondHalf.toFixed(4)}`,
    );
    lines.push(...recurrenceReport(s0.windows, horizon, seed, s0.batchRole));
    lines.push(...strategyGateReport(s0.windows, horizon, seed));
    lines.push(legacyDiagnostic(args.archiveDirectory));
    lines.push("Decision budget: collection -> judged batch -> one untouched replication; no deployment from this report alone.");
    return lines;
}

function main(): void {
    const archiveDirectory = argument(process.argv.slice(2), "--archive-dir");
    if (!archiveDirectory) throw new Error("--archive-dir is required");
    const lines = runFreshWindowAnalysis({
        archiveDirectory,
        stride: Number(argument(process.argv.slice(2), "--stride-bars") ?? DEFAULT_STRIDE),
        horizon: Number(argument(process.argv.slice(2), "--horizon") ?? DEFAULT_HORIZON),
        seed: Number(argument(process.argv.slice(2), "--seed") ?? DEFAULT_SEED),
    });
    console.log(lines.join("\n"));
    if (lines[2] === "S0: FAIL") process.exitCode = 1;
}

function isMainModule(): boolean {
    if (!process.argv[1]) return false;
    try {
        let modulePath = decodeURIComponent(new URL(import.meta.url).pathname);
        if (/^\/[A-Za-z]:/.test(modulePath)) modulePath = modulePath.slice(1);
        return path.resolve(modulePath).toLowerCase() === path.resolve(process.argv[1]).toLowerCase();
    } catch {
        return false;
    }
}

if (isMainModule()) {
    try {
        main();
    } catch (error) {
        console.error(`Fresh-window analyzer failed before S0: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    }
}
