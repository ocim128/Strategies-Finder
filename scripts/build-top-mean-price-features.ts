/**
 * Offline TOP_MEAN price-feature sidecar builder.
 *
 * Only pool snapshots and IBKR 30m price files are read. Outcomes and report
 * files are deliberately not part of this pipeline.
 */
import { createHash } from "node:crypto";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    TOP_MEAN_PRICE_FEATURE_FIELDS,
    TOP_MEAN_PRICE_FEATURES_SCHEMA,
    TOP_MEAN_PRICE_FEATURE_CONTRACT_VERSION,
    TOP_MEAN_PRICE_FEATURE_FORMULA_VERSION,
    TOP_MEAN_PRICE_FEATURE_AVAILABILITY_POLICY,
    TOP_MEAN_PRICE_SESSION_SCHEDULE_VERSION,
    buildTopMeanLeaveOneOutCatalogReturns,
    buildTopMeanRegularSessionSchedule,
    computeTopMeanPriceFeatureValues,
    explainTopMeanPriceFeatures,
    summarizeTopMeanPriceSession,
    type TopMeanPriceBar,
    type TopMeanPriceFeatureField,
    type TopMeanPriceFeatureRow,
    type TopMeanPriceFeatureValues,
    type TopMeanPriceSessionSummary,
    type TopMeanRegularSessionSchedule,
} from "./lib/top-mean-price-features";

const IBKR_HEADER = "time,open,high,low,close,volume";
const PRICE_SIDECAR_FILE = "candidate-price-features.jsonl";
const PRICE_AUDIT_FILE = "price-feature-audit.jsonl";
const PRICE_MANIFEST_FILE = "price-feature-manifest.json";

export interface TopMeanPriceSnapshot {
    eventId: string;
    decisionTimeSec: number;
    interval: string;
    asset: string;
}

export interface TopMeanPriceManifest {
    schema: typeof TOP_MEAN_PRICE_FEATURES_SCHEMA;
    contractVersion: typeof TOP_MEAN_PRICE_FEATURE_CONTRACT_VERSION;
    formulaVersion: typeof TOP_MEAN_PRICE_FEATURE_FORMULA_VERSION;
    availabilityPolicy: typeof TOP_MEAN_PRICE_FEATURE_AVAILABILITY_POLICY;
    sessionScheduleVersion: typeof TOP_MEAN_PRICE_SESSION_SCHEDULE_VERSION;
    fields: readonly typeof TOP_MEAN_PRICE_FEATURE_FIELDS[number][];
    enrichmentId: string;
    parentRunId: string;
    parentMetaSha256: string;
    parentPoolSnapshotsSha256: string;
    parentTemporalFeatureSha256: string | null;
    parentPostAssemblyFingerprint: string | null;
    catalog: {
        assets: readonly string[];
        sha256: string;
    };
    sourceCsvSha256: Readonly<Record<string, string>>;
    sessionScheduleSha256: string;
    builderSourceSha256: string;
    rowCount: number;
    sidecarFile: typeof PRICE_SIDECAR_FILE;
    sidecarSha256: string;
    auditFile: typeof PRICE_AUDIT_FILE;
    auditSha256: string;
}

interface TopMeanPriceAuditRow {
    eventId: string;
    decisionTimeSec: number;
    asset: string;
    availability: Readonly<Record<TopMeanPriceFeatureField, string>>;
    maxSourceBarEndSec: Readonly<Record<TopMeanPriceFeatureField, number | null>>;
}

interface TopMeanPriceBuildOptions {
    ledgerDir: string;
    sourceDir: string;
    outputDir: string;
}

interface ParentMeta {
    schema?: unknown;
    runId?: unknown;
    interval?: unknown;
    canonicalAssets?: unknown;
    postAssemblyFingerprint?: unknown;
    manifest?: { catalog?: { assets?: unknown } };
    featureSet?: { sha256?: unknown };
}

interface ParsedAssetCsv {
    sessions: Map<string, TopMeanPriceSessionSummary>;
    sha256: string;
}

function finite(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

function integer(value: unknown): value is number {
    return finite(value) && Number.isInteger(value);
}

function sha256Bytes(value: Uint8Array): string {
    return createHash("sha256").update(value).digest("hex");
}

function sha256Text(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
    return JSON.stringify(value);
}

function jsonl<T>(rows: readonly T[]): string {
    return rows.map((row) => `${canonicalJson(row)}\n`).join("");
}

function isWithin(child: string, parent: string): boolean {
    const relative = path.relative(parent, child);
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function requireBuild(condition: boolean, message: string): asserts condition {
    if (!condition) throw new Error(`PRICE FEATURE BUILD FAIL | ${message}`);
}

function parentAssets(meta: ParentMeta): string[] {
    const value = meta.manifest?.catalog?.assets ?? meta.canonicalAssets;
    requireBuild(Array.isArray(value) && value.length > 0, "parent catalog is missing");
    const assets = value.map((asset) => {
        requireBuild(typeof asset === "string" && /^[A-Z0-9._-]+$/.test(asset), `invalid catalog asset ${String(asset)}`);
        return asset;
    });
    requireBuild(new Set(assets).size === assets.length, "parent catalog contains duplicate assets");
    return [...assets].sort();
}

async function readSnapshots(filename: string, expectedAssets: ReadonlySet<string>): Promise<{ rows: TopMeanPriceSnapshot[]; sha256: string; minDate: string; maxDate: string }> {
    const sourceStat = await stat(filename);
    const hash = createHash("sha256");
    const rows: TopMeanPriceSnapshot[] = [];
    const seen = new Set<string>();
    const stream = createReadStream(filename, { encoding: "utf8" });
    stream.on("data", (chunk: string) => hash.update(chunk, "utf8"));
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    let lineNumber = 0;
    let minDate = "9999-12-31";
    let maxDate = "0000-01-01";
    try {
        for await (const line of rl) {
            lineNumber += 1;
            if (line.trim().length === 0) continue;
            let value: unknown;
            try {
                value = JSON.parse(line) as unknown;
            } catch {
                throw new Error(`pool-snapshots.jsonl:${lineNumber} is not valid JSON`);
            }
            requireBuild(typeof value === "object" && value !== null && !Array.isArray(value), `pool snapshot line ${lineNumber} is not an object`);
            const row = value as Record<string, unknown>;
            requireBuild(typeof row.eventId === "string" && row.eventId.length > 0, `pool snapshot line ${lineNumber} has no eventId`);
            requireBuild(integer(row.decisionTimeSec), `pool snapshot ${row.eventId} has invalid decisionTimeSec`);
            requireBuild(row.interval === "4h", `pool snapshot ${row.eventId} has unsupported interval`);
            requireBuild(typeof row.asset === "string" && expectedAssets.has(row.asset), `pool snapshot ${row.eventId} has unknown asset`);
            const key = `${row.eventId}|${row.asset}`;
            requireBuild(!seen.has(key), `duplicate pool snapshot ${key}`);
            seen.add(key);
            const date = new Date(Number(row.decisionTimeSec) * 1000).toISOString().slice(0, 10);
            minDate = date < minDate ? date : minDate;
            maxDate = date > maxDate ? date : maxDate;
            rows.push({ eventId: row.eventId, decisionTimeSec: Number(row.decisionTimeSec), interval: "4h", asset: row.asset as string });
        }
    } finally {
        rl.close();
    }
    const after = await stat(filename);
    requireBuild(sourceStat.size === after.size && sourceStat.mtimeMs === after.mtimeMs, "pool snapshot input changed during build");
    requireBuild(rows.length > 0, "pool snapshot list is empty");
    return { rows, sha256: hash.digest("hex"), minDate, maxDate };
}

function parseCsvLine(line: string, lineNumber: number): TopMeanPriceBar {
    const columns = line.split(",");
    requireBuild(columns.length === 6 && !line.includes('"'), `CSV line ${lineNumber} must have six unquoted columns`);
    const timeMs = Date.parse(columns[0]!);
    const open = Number(columns[1]);
    const high = Number(columns[2]);
    const low = Number(columns[3]);
    const close = Number(columns[4]);
    const rawVolume = columns[5]!.trim();
    const volume = rawVolume.length > 0 ? Number(rawVolume) : Number.NaN;
    requireBuild(Number.isFinite(timeMs) && Number.isInteger(timeMs / 1000), `CSV line ${lineNumber} has invalid time`);
    requireBuild([open, high, low, close].every((value) => positivePrice(value)), `CSV line ${lineNumber} has invalid OHLC`);
    requireBuild(high >= Math.max(open, close) && low <= Math.min(open, close) && high >= low, `CSV line ${lineNumber} has inconsistent OHLC`);
    return {
        timeSec: Math.floor(timeMs / 1000),
        open,
        high,
        low,
        close,
        volume: Number.isFinite(volume) && volume >= 0 ? volume : null,
    };
}

function positivePrice(value: number): boolean {
    return Number.isFinite(value) && value > 0;
}

async function readAssetCsv(filename: string, schedulesByDate: ReadonlyMap<string, TopMeanRegularSessionSchedule>): Promise<ParsedAssetCsv> {
    const before = await stat(filename);
    const hash = createHash("sha256");
    const barsByDate = new Map<string, TopMeanPriceBar[]>();
    const seenTimes = new Set<number>();
    let previousTime = -Infinity;
    let lineNumber = 0;
    const stream = createReadStream(filename, { encoding: "utf8" });
    stream.on("data", (chunk: string) => hash.update(chunk, "utf8"));
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    try {
        for await (const rawLine of rl) {
            lineNumber += 1;
            const line = rawLine.replace(/^\uFEFF/, "").trim();
            if (lineNumber === 1) {
                requireBuild(line.toLowerCase() === IBKR_HEADER, `${path.basename(filename)} has unsupported header`);
                continue;
            }
            if (line.length === 0) continue;
            const bar = parseCsvLine(line, lineNumber);
            requireBuild(bar.timeSec > previousTime, `${path.basename(filename)} has duplicate or non-monotonic timestamps at line ${lineNumber}`);
            previousTime = bar.timeSec;
            requireBuild(!seenTimes.has(bar.timeSec), `${path.basename(filename)} repeats timestamp ${bar.timeSec}`);
            seenTimes.add(bar.timeSec);
            const date = new Date(bar.timeSec * 1000).toISOString().slice(0, 10);
            const schedule = schedulesByDate.get(date);
            if (!schedule || !schedule.slotStartSec.includes(bar.timeSec)) continue;
            const bars = barsByDate.get(date);
            if (bars) bars.push(bar);
            else barsByDate.set(date, [bar]);
        }
    } finally {
        rl.close();
    }
    const after = await stat(filename);
    requireBuild(before.size === after.size && before.mtimeMs === after.mtimeMs, `${path.basename(filename)} changed during build`);
    const sessions = new Map<string, TopMeanPriceSessionSummary>();
    for (const [date, bars] of barsByDate) sessions.set(date, summarizeTopMeanPriceSession(schedulesByDate.get(date)!, bars));
    return { sessions, sha256: hash.digest("hex") };
}

function snapshotOrder(left: TopMeanPriceSnapshot, right: TopMeanPriceSnapshot): number {
    return left.decisionTimeSec - right.decisionTimeSec || (left.eventId < right.eventId ? -1 : left.eventId > right.eventId ? 1 : 0) || (left.asset < right.asset ? -1 : left.asset > right.asset ? 1 : 0);
}

function manifestWithoutIdentity(manifest: Omit<TopMeanPriceManifest, "enrichmentId">): string {
    return canonicalJson(manifest);
}

function sourceFileForAsset(sourceDir: string, asset: string): string {
    const filename = path.resolve(sourceDir, `${asset}.csv`);
    requireBuild(path.dirname(filename) === path.resolve(sourceDir), `source asset path escaped source directory for ${asset}`);
    return filename;
}

function builderSourceHash(): string {
    return sha256Bytes(readFileSync(fileURLToPath(import.meta.url)));
}

export async function buildTopMeanPriceFeatureSidecar(options: TopMeanPriceBuildOptions): Promise<{ outputDir: string; manifest: TopMeanPriceManifest }> {
    const ledgerDir = path.resolve(options.ledgerDir);
    const sourceDir = path.resolve(options.sourceDir);
    const outputDir = path.resolve(options.outputDir);
    requireBuild(!isWithin(outputDir, ledgerDir), "output directory cannot be inside the parent ledger");
    requireBuild(!isWithin(outputDir, sourceDir), "output directory cannot be inside the price-data source tree");
    requireBuild(!outputDir.toLowerCase().includes(`${path.sep}archive${path.sep}batch-open-score${path.sep}`), "output directory cannot be inside the frozen batch-open-score tree");
    requireBuild(!outputDir.toLowerCase().includes(`${path.sep}price-data${path.sep}`), "output directory cannot be inside price-data");
    requireBuild(!statSyncSafe(outputDir), `output directory already exists: ${outputDir}`);

    const metaPath = path.join(ledgerDir, "meta.json");
    const snapshotsPath = path.join(ledgerDir, "pool-snapshots.jsonl");
    const metaBytes = await readFile(metaPath);
    const meta = JSON.parse(metaBytes.toString("utf8")) as ParentMeta;
    requireBuild(typeof meta.runId === "string" && meta.runId.length > 0, "parent runId is missing");
    requireBuild(meta.schema === "top_mean_archive.v2" || meta.schema === "top_mean_archive.v3", "unsupported parent archive schema");
    const assets = parentAssets(meta);
    const snapshots = await readSnapshots(snapshotsPath, new Set(assets));
    const sourceMinDate = snapshots.minDate < "9999-12-31"
        ? new Date(`${snapshots.minDate}T12:00:00.000Z`).toISOString().slice(0, 10)
        : "2020-01-01";
    const warmupDate = new Date(`${sourceMinDate}T12:00:00.000Z`);
    warmupDate.setUTCDate(warmupDate.getUTCDate() - 400);
    const scheduleFromDate = warmupDate.toISOString().slice(0, 10);
    const sourceMaxDate = snapshots.maxDate > "0000-01-01" ? snapshots.maxDate : snapshots.maxDate;
    const schedules = buildTopMeanRegularSessionSchedule(scheduleFromDate, sourceMaxDate);
    requireBuild(schedules.length > 0, "session schedule is empty");
    const schedulesByDate = new Map(schedules.map((schedule) => [schedule.date, schedule] as const));
    const sessionsByAsset = new Map<string, Map<string, TopMeanPriceSessionSummary>>();
    const sourceCsvSha256: Record<string, string> = {};
    const stagingDir = `${outputDir}.staging-${process.pid}-${Date.now()}`;
    await mkdir(stagingDir, { recursive: true });
    try {
        for (const asset of assets) {
            const parsed = await readAssetCsv(sourceFileForAsset(sourceDir, asset), schedulesByDate);
            sessionsByAsset.set(asset, parsed.sessions);
            sourceCsvSha256[asset] = parsed.sha256;
        }
        const catalogReturnsByAsset = buildTopMeanLeaveOneOutCatalogReturns({ assets, schedules, sessionsByAsset });
        const orderedSnapshots = [...snapshots.rows].sort(snapshotOrder);
        const rows: TopMeanPriceFeatureRow[] = [];
        const audit: TopMeanPriceAuditRow[] = [];
        const cached = new Map<string, { values: TopMeanPriceFeatureValues; details: ReturnType<typeof explainTopMeanPriceFeatures> }>();
        for (const snapshot of orderedSnapshots) {
            const cacheKey = `${snapshot.asset}|${snapshot.decisionTimeSec}`;
            let computed = cached.get(cacheKey);
            if (!computed) {
                const sessions = sessionsByAsset.get(snapshot.asset)!;
                const input = {
                    asset: snapshot.asset,
                    eventId: snapshot.eventId,
                    decisionTimeSec: snapshot.decisionTimeSec,
                    schedules,
                    sessions,
                    catalogReturns: catalogReturnsByAsset.get(snapshot.asset)!,
                };
                computed = { values: computeTopMeanPriceFeatureValues(input), details: explainTopMeanPriceFeatures(input) };
                cached.set(cacheKey, computed);
            }
            rows.push({ eventId: snapshot.eventId, decisionTimeSec: snapshot.decisionTimeSec, asset: snapshot.asset, ...computed.values });
            audit.push({
                eventId: snapshot.eventId,
                decisionTimeSec: snapshot.decisionTimeSec,
                asset: snapshot.asset,
                availability: computed.details.reasons,
                maxSourceBarEndSec: computed.details.maxSourceBarEndSec,
            });
        }
        requireBuild(rows.length === orderedSnapshots.length && audit.length === rows.length, "sidecar row count does not match snapshots");
        const sidecarText = jsonl(rows);
        const auditText = jsonl(audit);
        const sidecarSha256 = sha256Text(sidecarText);
        const auditSha256 = sha256Text(auditText);
        const parentTemporalFeatureSha256 = typeof meta.featureSet?.sha256 === "string" ? meta.featureSet.sha256 : null;
        const manifestBase: Omit<TopMeanPriceManifest, "enrichmentId"> = {
            schema: TOP_MEAN_PRICE_FEATURES_SCHEMA,
            contractVersion: TOP_MEAN_PRICE_FEATURE_CONTRACT_VERSION,
            formulaVersion: TOP_MEAN_PRICE_FEATURE_FORMULA_VERSION,
            availabilityPolicy: TOP_MEAN_PRICE_FEATURE_AVAILABILITY_POLICY,
            sessionScheduleVersion: TOP_MEAN_PRICE_SESSION_SCHEDULE_VERSION,
            fields: [...TOP_MEAN_PRICE_FEATURE_FIELDS],
            parentRunId: meta.runId as string,
            parentMetaSha256: sha256Bytes(metaBytes),
            parentPoolSnapshotsSha256: snapshots.sha256,
            parentTemporalFeatureSha256,
            parentPostAssemblyFingerprint: typeof meta.postAssemblyFingerprint === "string" ? meta.postAssemblyFingerprint : null,
            catalog: { assets, sha256: sha256Text(canonicalJson(assets)) },
            sourceCsvSha256,
            sessionScheduleSha256: sha256Text(canonicalJson(schedules)),
            builderSourceSha256: builderSourceHash(),
            rowCount: rows.length,
            sidecarFile: PRICE_SIDECAR_FILE,
            sidecarSha256,
            auditFile: PRICE_AUDIT_FILE,
            auditSha256,
        };
        const manifest: TopMeanPriceManifest = { ...manifestBase, enrichmentId: sha256Text(manifestWithoutIdentity(manifestBase)) };
        await writeFile(path.join(stagingDir, PRICE_SIDECAR_FILE), sidecarText, "utf8");
        await writeFile(path.join(stagingDir, PRICE_AUDIT_FILE), auditText, "utf8");
        await writeFile(path.join(stagingDir, PRICE_MANIFEST_FILE), `${canonicalJson(manifest)}\n`, "utf8");
        await mkdir(path.dirname(outputDir), { recursive: true });
        await rename(stagingDir, outputDir);
        return { outputDir, manifest };
    } catch (error) {
        await rm(stagingDir, { recursive: true, force: true });
        throw error;
    }
}

function statSyncSafe(filename: string): boolean {
    try {
        statSync(filename);
        return true;
    } catch {
        return false;
    }
}

interface CliOptions {
    ledgerDir: string;
    sourceDir: string;
    outputDir: string;
}

function usage(): string {
    return [
        "Usage:",
        "  esno scripts/build-top-mean-price-features.ts <ledgerDir> --source-dir <price-data/ibkr/csv/30m> --output <enrichmentDir>",
        "",
        "The builder reads only meta.json, pool-snapshots.jsonl, and canonical <asset>.csv files.",
    ].join("\n");
}

function parseCli(argv: readonly string[]): CliOptions | "help" {
    if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) return "help";
    const positional: string[] = [];
    let sourceDir: string | undefined;
    let outputDir: string | undefined;
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index]!;
        if (arg === "--source-dir") sourceDir = argv[++index];
        else if (arg === "--output" || arg === "--enrichment-dir") outputDir = argv[++index];
        else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
        else positional.push(arg);
    }
    if (positional.length !== 1 || !sourceDir || !outputDir) throw new Error("ledgerDir, --source-dir, and --output are required");
    return { ledgerDir: positional[0]!, sourceDir: path.resolve(sourceDir), outputDir: path.resolve(outputDir) };
}

function isMainModule(): boolean {
    return process.argv[1] !== undefined && path.resolve(fileURLToPath(import.meta.url)).toLowerCase() === path.resolve(process.argv[1]).toLowerCase();
}

if (isMainModule()) {
    const parsed = parseCli(process.argv.slice(2));
    if (parsed === "help") console.log(usage());
    else void buildTopMeanPriceFeatureSidecar(parsed).then(({ outputDir, manifest }) => {
        console.log(`PRICE FEATURE BUILD PASS | output=${outputDir} rows=${manifest.rowCount} enrichmentId=${manifest.enrichmentId}`);
    }).catch((error: unknown) => {
        console.error(error instanceof Error ? error.stack ?? error.message : String(error));
        process.exitCode = 1;
    });
}
