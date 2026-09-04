import path from "node:path";
import {
    CAMPAIGN_LOG_HASH_CONVENTION,
    campaignLogSha256,
    parsePipeRecord,
    parseRecords,
    readCampaignLog,
    type CampaignPipeRecord,
} from "./top-mean-campaign-log";

export const TOP_MEAN_V2_STANDINGS_SCHEMA = "top_mean_v2_standings.v1";
export const TOP_MEAN_V2_STANDINGS_CONTRACT = "v2.0";
export const TOP_MEAN_V2_STANDINGS_MAX_LINES = 40;
export const TOP_MEAN_V2_STANDINGS_MAX_BYTES = 8192;

export interface V2CampaignStandingsOptions {
    campaign?: string;
    tail?: number;
    family?: string;
    miningDir?: string;
}

export interface V2FamilyStanding {
    familyKey: string;
    observations: number;
    bestPrimary: number | null;
    state: "UNSEEN" | "SCREENED" | "LEAD";
}

export interface V2CampaignStandings {
    campaign: string;
    logSha256: string;
    nextBatch: string;
    nextOutcomeOrdinal: number;
    outcomeBatches: number;
    discoverySurface: number;
    lifetimeEvaluations: number;
    validationViews: number;
    familyStandings: readonly V2FamilyStanding[];
    tail: readonly string[];
    logText: string;
}

function finiteMetric(value: string | undefined): number | null {
    if (!value) return null;
    const match = value.match(/[+-]?\d+(?:\.\d+)?/);
    if (!match) return null;
    const parsed = Number(match[0]);
    return Number.isFinite(parsed) ? parsed : null;
}

function primary(record: CampaignPipeRecord): number | null {
    const direct = finiteMetric(record.fields.primary);
    if (direct !== null) return direct;
    return finiteMetric(record.fields.D?.match(/\bprimary=([+-]?\d+(?:\.\d+)?)pp/)?.[1]);
}

function parseCiLower(record: CampaignPipeRecord): number | null {
    return finiteMetric(record.fields.ciLower)
        ?? finiteMetric(record.fields.D?.match(/\bci=\[([+-]?\d+(?:\.\d+)?)pp,/)?.[1]);
}

function isQualifiedLead(record: CampaignPipeRecord): boolean {
    const value = primary(record);
    const lower = parseCiLower(record);
    const blocks = record.fields.positiveBlocks ?? record.fields.blocks;
    const keep = finiteMetric(record.fields.keep ?? record.fields.keepPercent ?? record.fields.keepPct);
    const exDom = finiteMetric(record.fields.exDom ?? record.fields.exDominant);
    return value !== null && value >= 1
        && lower !== null && lower >= 0.15
        && (blocks === "8/10" || blocks === "10/10")
        && keep !== null && keep >= 20
        && exDom !== null && exDom >= 0.30
        && (record.fields.fullC2 ?? "") === "yes";
}

function familyKey(record: CampaignPipeRecord): string {
    const value = record.fields.familyKey ?? record.fields.family ?? "UNSPECIFIED";
    const separator = value.indexOf(":");
    return separator < 0 ? value : value.slice(separator + 1);
}

function explicitCampaign(record: CampaignPipeRecord): string | undefined {
    return record.fields.campaign ?? record.positional.find((value) => /^TM-[A-Z0-9-]+$/.test(value));
}

function declaredSuccessorBatch(record: CampaignPipeRecord): string | null {
    return record.fields.batchLabel
        ?? record.fields.batch
        ?? record.positional.find((value) => /^L2[DV](?:\d+)?$/.test(value))
        ?? null;
}

function belongsToCampaign(record: CampaignPipeRecord, campaign: string): boolean {
    const declared = explicitCampaign(record);
    if (declared !== undefined) return declared === campaign;
    return record.marker === "C6" || declaredSuccessorBatch(record) !== null;
}

function successorBatch(record: CampaignPipeRecord, campaign: string): string | null {
    return belongsToCampaign(record, campaign) ? declaredSuccessorBatch(record) : null;
}

function successorClosed(record: CampaignPipeRecord, campaign: string): boolean {
    return record.marker === "CLOSED" && belongsToCampaign(record, campaign);
}

function successorOrdinal(record: CampaignPipeRecord): number | null {
    const field = record.fields.ordinal ?? record.fields.batchOrdinal;
    if (field !== undefined && /^\d+$/.test(field)) return Number(field);
    const positional = record.positional.find((value) => /^\d+$/.test(value));
    return positional === undefined ? null : Number(positional);
}

interface MonotonicCounterState {
    label: string;
    names: readonly string[];
    value: number;
    seen: boolean;
    requireInitial: boolean;
}

const MONOTONIC_COUNTERS: readonly Omit<MonotonicCounterState, "value" | "seen">[] = [
    { label: "N_G", names: ["NGStart", "NG", "N_G"], requireInitial: true },
    { label: "N_D_surface", names: ["NDsurfaceStart", "NDsurface", "N_D_surface"], requireInitial: true },
    { label: "validationViews", names: ["validationViews"], requireInitial: false },
];

function batchSequenceValue(label: string): number | null {
    const match = label.match(/^L2([DV])(\d+)$/);
    if (!match) return null;
    return (match[1] === "D" ? 0 : 1) * 1_000_000_000 + Number(match[2]);
}

function assertMonotonicity(
    lines: readonly string[],
    campaign: string,
): { lifetimeEvaluations: number; discoverySurface: number } {
    const counters = MONOTONIC_COUNTERS.map((counter) => ({ ...counter, value: counter.label === "N_G" ? 57 : 0, seen: false }));
    let lastOrdinal: number | null = null;
    let lastBatchValue: number | null = null;
    for (const [lineIndex, line] of lines.entries()) {
        const record = parsePipeRecord(line);
        if (!record || !belongsToCampaign(record, campaign)) continue;
        for (const counter of counters) {
            for (const name of counter.names) {
                const raw = record.fields[name];
                if (raw === undefined || !/^\d+$/.test(raw)) continue;
                const value = Number(raw);
                if (!counter.seen && counter.requireInitial && value !== counter.value) {
                    throw new Error(`MONOTONICITY VIOLATION|counter=${counter.label}|line=${lineIndex + 1}|expectedInitial=${counter.value}|actual=${value}`);
                }
                if (counter.seen && value < counter.value) {
                    throw new Error(`MONOTONICITY VIOLATION|counter=${counter.label}|line=${lineIndex + 1}|previous=${counter.value}|actual=${value}`);
                }
                counter.value = value;
                counter.seen = true;
            }
        }
        const batch = successorBatch(record, campaign);
        if (record.marker === "I2" && batch !== null) {
            const ordinal = successorOrdinal(record);
            if (ordinal !== null) {
                if (ordinal < 1 || (lastOrdinal !== null && ordinal < lastOrdinal)) {
                    throw new Error(`MONOTONICITY VIOLATION|counter=outcomeOrdinal|line=${lineIndex + 1}|previous=${lastOrdinal ?? 1}|actual=${ordinal}`);
                }
                lastOrdinal = ordinal;
            }
            const batchValue = batchSequenceValue(batch);
            if (batchValue !== null && lastBatchValue !== null && batchValue < lastBatchValue) {
                throw new Error(`MONOTONICITY VIOLATION|counter=batchSequence|line=${lineIndex + 1}|previous=${lastBatchValue}|actual=${batchValue}`);
            }
            if (batchValue !== null) lastBatchValue = batchValue;
        }
    }
    return {
        lifetimeEvaluations: counters.find((counter) => counter.label === "N_G")!.value,
        discoverySurface: counters.find((counter) => counter.label === "N_D_surface")!.value,
    };
}

function nextBatchFromSequence(labels: readonly string[], closed: boolean): string {
    if (closed) return "CLOSED";
    const last = labels[labels.length - 1];
    if (!last) return "L2D";
    const match = last.match(/^L2([DV])(\d+)$/);
    return match ? `L2${match[1]}${Number(match[2]) + 1}` : last;
}

export function buildV2CampaignStandings(options: V2CampaignStandingsOptions): V2CampaignStandings {
    const campaign = options.campaign ?? "TM-L2-C1";
    const miningDir = path.resolve(options.miningDir ?? path.join(process.cwd(), "archive", "top-mean-mining"));
    const logPath = path.join(miningDir, "idea-log.txt");
    const log = readCampaignLog(logPath);
    const outcomes = parseRecords(log.text, "I2").filter((record) => successorBatch(record, campaign) !== null);
    const screens = parseRecords(log.text, "S3").filter((record) => successorBatch(record, campaign) !== null);
    const outcomeBatchLabels: string[] = [];
    for (const outcome of outcomes) {
        const batch = successorBatch(outcome, campaign);
        if (batch !== null && !outcomeBatchLabels.includes(batch)) outcomeBatchLabels.push(batch);
    }
    const outcomeOrdinals = outcomes.map(successorOrdinal).filter((value): value is number => value !== null);
    const expectedNextOrdinal = Math.max(0, ...outcomeOrdinals, outcomeBatchLabels.length) + 1;
    if (outcomeOrdinals.some((ordinal) => ordinal < 1 || !Number.isInteger(ordinal))) throw new Error("Invalid successor outcome ordinal");
    const families = new Map<string, { observations: number; bestPrimary: number | null; lead: boolean }>();
    for (const item of [...outcomes, ...screens]) {
        const key = familyKey(item);
        const current = families.get(key) ?? { observations: 0, bestPrimary: null, lead: false };
        current.observations += 1;
        const metric = primary(item);
        if (metric !== null && (current.bestPrimary === null || metric > current.bestPrimary)) current.bestPrimary = metric;
        current.lead ||= isQualifiedLead(item);
        families.set(key, current);
    }
    const counters = assertMonotonicity(log.lines, campaign);
    const closed = parseRecords(log.text, "CLOSED").some((record) => successorClosed(record, campaign));
    const tailCount = Math.max(0, Math.floor(options.tail ?? 8));
    const tail = log.lines.filter((line) => line.length > 0).slice(-tailCount);
    const familyStandings = [...families.entries()]
        .map(([key, value]) => ({ familyKey: key, observations: value.observations, bestPrimary: value.bestPrimary, state: value.lead ? "LEAD" as const : "SCREENED" as const }))
        .sort((left, right) => right.observations - left.observations || left.familyKey.localeCompare(right.familyKey));
    return {
        campaign,
        logSha256: campaignLogSha256(log.text),
        nextBatch: nextBatchFromSequence(outcomeBatchLabels, closed),
        nextOutcomeOrdinal: expectedNextOrdinal,
        outcomeBatches: outcomeBatchLabels.length,
        discoverySurface: counters.discoverySurface,
        lifetimeEvaluations: counters.lifetimeEvaluations,
        validationViews: screens.filter((record) => record.fields.window === "validation" || record.fields.view === "L2V").length,
        familyStandings: options.family === undefined
            ? familyStandings
            : familyStandings.filter((standing) => standing.familyKey === options.family || standing.familyKey === options.family!.split(":").pop()),
        tail,
        logText: log.text,
    };
}

export const buildCampaignStandings = buildV2CampaignStandings;

export function renderV2CampaignStandings(standing: V2CampaignStandings): string {
    const lines = [
        `TOP_MEAN_V2_STANDINGS|schema=${TOP_MEAN_V2_STANDINGS_SCHEMA}|campaign=${standing.campaign}|contract=${TOP_MEAN_V2_STANDINGS_CONTRACT}|hashConvention=${CAMPAIGN_LOG_HASH_CONVENTION}|logSha256=${standing.logSha256}`,
        `STATE|nextBatch=${standing.nextBatch}|nextOutcomeOrdinal=${standing.nextOutcomeOrdinal}|outcomeBatches=${standing.outcomeBatches}|NDsurface=${standing.discoverySurface}|NG=${standing.lifetimeEvaluations}|validationViews=${standing.validationViews}`,
        `BOUNDS|outcomeBatches=3|outcomeShas=30|validationViews=6`,
    ];
    for (const family of standing.familyStandings) lines.push(`FAMILY|key=${family.familyKey}|observations=${family.observations}|bestPrimary=${family.bestPrimary === null ? "n/a" : family.bestPrimary.toFixed(2)}pp|state=${family.state}`);
    for (const line of standing.tail) lines.push(`TAIL|${line}`);
    const endLineCount = lines.length + 1;
    let endLine = `END|lines=${endLineCount}|bytes=0`;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const output = [...lines, endLine].join("\n") + "\n";
        const nextEndLine = `END|lines=${endLineCount}|bytes=${Buffer.byteLength(output, "utf8")}`;
        if (nextEndLine === endLine) break;
        endLine = nextEndLine;
    }
    lines.push(endLine);
    const output = lines.join("\n") + "\n";
    if (lines.length > TOP_MEAN_V2_STANDINGS_MAX_LINES || Buffer.byteLength(output, "utf8") > TOP_MEAN_V2_STANDINGS_MAX_BYTES) throw new Error("DIGEST OVERFLOW");
    return output;
}

export const renderCampaignStandings = renderV2CampaignStandings;

export function runTopMeanV2CampaignStandingsCli(argv: readonly string[]): number {
    const miningDir = argv[0];
    if (argv.length > 1 || !miningDir) {
        process.stderr.write("USAGE ERROR | expected [miningDir]\n");
        return 2;
    }
    process.stdout.write(renderV2CampaignStandings(buildV2CampaignStandings({ miningDir })));
    return 0;
}

function isMainModule(): boolean {
    if (!process.argv[1]) return false;
    let modulePath = decodeURIComponent(new URL(import.meta.url).pathname);
    if (/^\/[A-Za-z]:/.test(modulePath)) modulePath = modulePath.slice(1);
    return path.resolve(modulePath).toLowerCase() === path.resolve(process.argv[1]).toLowerCase();
}

if (isMainModule()) process.exitCode = runTopMeanV2CampaignStandingsCli(process.argv.slice(2));
