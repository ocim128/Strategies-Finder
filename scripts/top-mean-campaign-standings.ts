import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { campaignLogSha256 } from "./top-mean-campaign-log";
import {
    parseRecords,
    sha256Bytes,
    type CampaignRegistrationRule,
    type PipeRecord,
} from "./top-mean-campaign-audit";

export const TOP_MEAN_STANDINGS_SCHEMA = "top_mean_standings.v1";
export const TOP_MEAN_STANDINGS_CONTRACT = "v1.5";
export const TOP_MEAN_STANDINGS_MAX_LINES = 40;
export const TOP_MEAN_STANDINGS_MAX_BYTES = 8192;
export const TOP_MEAN_STANDINGS_DEFAULT_TAIL = 8;
export const TOP_MEAN_CAMPAIGN_MAX_BATCHES = 20;
export const TOP_MEAN_CAMPAIGN_MAX_DISCOVERY = 201;
export const TOP_MEAN_CAMPAIGN_MAX_VALIDATION = 30;

const RETIRED_FAMILIES = new Set(["identity:identity", "coverage:coverage"]);
const RETIRED_FAMILY_KEYS = new Set(["identity", "coverage"]);
const QUARANTINED_BATCHES = new Set(["B5", "B6", "B7"]);

export interface CampaignStandingsPaths {
    miningDir: string;
    logPath: string;
    rulesDir: string;
    registrationPath: string;
}

export interface CampaignStandingsOptions {
    campaign: string;
    tail?: number;
    family?: string;
    miningDir?: string;
}

export interface CampaignRegistrationSummary {
    pool: readonly CampaignRegistrationRule[];
    finalists: readonly CampaignRegistrationRule[];
}

export interface CampaignOutcomeRecord {
    id: string;
    batch: string;
    key: string;
    kind: string;
    family: string;
    familyKey: string;
    mechanismLineage: string;
    sha256: string;
    thesis: string | null;
    verdict: string;
    primary: number | null;
    ciLower: number | null;
    keepPercent: number | null;
    exDominant: number | null;
}

export interface CampaignScreenRecord {
    batch: string;
    candidate: string;
    key: string;
    family: string;
    familyKey: string;
    sha256: string;
    impact: string;
    advanced: string;
    thesis: string | null;
}

export interface CampaignFamilyStanding {
    familyKey: string;
    records: number;
    best: string;
    state: string;
}

export interface CampaignStandings {
    campaign: string;
    logSha256: string;
    nextBatch: string;
    nextOutcomeOrdinal: number;
    completedBatches: number;
    discoverySurface: number;
    lifetimeEvaluations: number;
    validationViews: number;
    l2: string;
    closedDisposition: string | null;
    i2Count: number;
    s3Count: number;
    testedCount: number;
    quarantinedCount: number;
    strictOpen: readonly CampaignOutcomeRecord[];
    replicationOpen: number;
    confirmationOpen: number;
    familyStandings: readonly CampaignFamilyStanding[];
    retiredFamilies: readonly string[];
    retiredRuleCount: number;
    cloneKeyCount: number;
    cloneShaCount: number;
    thesisUnknownCount: number;
    tail: readonly string[];
    familyDetail?: CampaignFamilyDetail;
}

export interface CampaignFamilyDetail {
    familyKey: string;
    outcomes: readonly CampaignOutcomeRecord[];
    screens: readonly CampaignScreenRecord[];
}

export interface IdeaCandidate {
    key: string;
    rule: string;
    kind: string;
    familyKey: string;
    mechanism: string;
    flipArgument: string;
    thesis: string;
}

export interface IdeaCheckViolation {
    code: string;
    detail: string;
}

export interface IdeaCheckResult {
    valid: boolean;
    violations: readonly IdeaCheckViolation[];
}

interface RuleFileRecord {
    name: string;
    source: string;
}

interface CampaignHistory {
    logBytes: Uint8Array;
    logText: string;
    logLines: readonly string[];
    outcomes: readonly CampaignOutcomeRecord[];
    screens: readonly CampaignScreenRecord[];
    registration: CampaignRegistrationSummary;
    ruleFiles: readonly RuleFileRecord[];
    legacyRule: { key: string; sha256: string; family: string; familyKey: string } | null;
    closedDisposition: string | null;
}

interface ParsedBatchRecord {
    batch: string;
    ordinal: number;
}

function codeUnitCompare(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function numericSuffix(value: string): number {
    const match = value.match(/^(?:B|Q)(\d+)$/);
    return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function finiteNumber(value: string | undefined): number | null {
    if (value === undefined) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function parseMetric(text: string | undefined, name: string): number | null {
    if (!text) return null;
    const match = text.match(new RegExp(`(?:^|\\s)${name}=([+-]?\\d+(?:\\.\\d+)?)`));
    return finiteNumber(match?.[1]);
}

function parsePercent(text: string | undefined, name: string): number | null {
    return parseMetric(text, name);
}

function parseFamily(value: string): { family: string; familyKey: string } {
    const separator = value.indexOf(":");
    return separator < 0
        ? { family: value, familyKey: value }
        : { family: value.slice(0, separator), familyKey: value.slice(separator + 1) };
}

function registrationRule(record: PipeRecord): CampaignRegistrationRule | null {
    const ordinal = Number(record.fields.ordinal);
    if (!Number.isInteger(ordinal)) return null;
    return {
        ordinal,
        candidate: record.fields.candidate ?? "",
        key: record.fields.key ?? "",
        kind: record.fields.kind ?? "",
        family: record.fields.family ?? "",
        familyKey: record.fields.familyKey ?? "",
        mechanism: record.fields.mechanism ?? "",
        mechanismLineage: record.fields.mechanismLineage ?? "",
        path: record.fields.path ?? "",
        sourceBody: record.fields.sourceBody ?? "",
        sha256: record.fields.sha256 ?? "",
    };
}

function parseRegistration(text: string): CampaignRegistrationSummary {
    const pool = parseRecords(text, "POOL").map(registrationRule).filter((record): record is CampaignRegistrationRule => record !== null);
    const finalists = parseRecords(text, "FINAL").map(registrationRule).filter((record): record is CampaignRegistrationRule => record !== null);
    return { pool, finalists };
}

function parseOutcome(record: PipeRecord): CampaignOutcomeRecord | null {
    const id = record.positional[0];
    const batch = record.positional[1];
    const family = parseFamily(record.fields.family ?? "");
    const detail = record.fields.D ?? "";
    if (!id || !batch || !record.fields.key || !record.fields.sha256) return null;
    const ci = detail.match(/\bci=\[([+-]?\d+(?:\.\d+)?)pp,([+-]?\d+(?:\.\d+)?)pp\]/);
    return {
        id,
        batch,
        key: record.fields.key,
        kind: record.fields.kind ?? "",
        family: record.fields.family ?? family.family,
        familyKey: family.familyKey,
        mechanismLineage: "unknown",
        sha256: record.fields.sha256,
        thesis: record.fields.thesis ?? null,
        verdict: detail.match(/^([^\s]+)/)?.[1] ?? "INCONCLUSIVE",
        primary: parseMetric(detail, "primary"),
        ciLower: finiteNumber(ci?.[1]),
        keepPercent: parsePercent(detail, "keep"),
        exDominant: parseMetric(detail, "exDom"),
    };
}

function parseScreen(record: PipeRecord): CampaignScreenRecord | null {
    const family = parseFamily(record.fields.family ?? "");
    if (!record.positional[0] || !record.fields.candidate || !record.fields.key) return null;
    return {
        batch: record.positional[0],
        candidate: record.fields.candidate,
        key: record.fields.key,
        family: record.fields.family ?? family.family,
        familyKey: family.familyKey,
        sha256: record.fields.sha256 ?? "",
        impact: record.fields.impact ?? "",
        advanced: record.fields.advanced ?? "",
        thesis: record.fields.thesis ?? null,
    };
}

function parseF4(record: PipeRecord): ParsedBatchRecord | null {
    const batch = record.positional[0];
    const ordinal = Number(record.fields.outcomeOrdinal);
    return batch && Number.isInteger(ordinal) ? { batch, ordinal } : null;
}

function readRuleFiles(rulesDir: string): RuleFileRecord[] {
    if (!existsSync(rulesDir)) return [];
    return readdirSync(rulesDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
        .map((entry) => {
            const bytes = readFileSync(path.join(rulesDir, entry.name));
            return { name: entry.name, source: bytes.toString("utf8") };
        })
        .sort((left, right) => codeUnitCompare(left.name, right.name));
}

function resolvePaths(options: CampaignStandingsOptions): CampaignStandingsPaths {
    const miningDir = path.resolve(options.miningDir ?? path.join(process.cwd(), "archive", "top-mean-mining"));
    return {
        miningDir,
        logPath: path.join(miningDir, "idea-log.txt"),
        rulesDir: path.join(miningDir, "rules"),
        registrationPath: path.join(miningDir, "B8-REGISTRATION.md"),
    };
}

function readHistory(options: CampaignStandingsOptions): CampaignHistory {
    const paths = resolvePaths(options);
    const logBytes = readFileSync(paths.logPath);
    const logText = logBytes.toString("utf8");
    const registrationText = readFileSync(paths.registrationPath, "utf8");
    const closedDisposition = parseRecords(logText, "CLOSED")
        .find((record) => record.fields.campaign === options.campaign)?.fields.disposition ?? null;
    const outcomes = parseRecords(logText, "I2").map(parseOutcome).filter((record): record is CampaignOutcomeRecord => record !== null);
    // v1.5: collapse byte-identical duplicate appends of the same S3 record.
    const screens = [...new Set(parseRecords(logText, "S3").map((r) => JSON.stringify(r)))]
        .map((s) => JSON.parse(s) as PipeRecord)
        .map(parseScreen)
        .filter((record): record is CampaignScreenRecord => record !== null);
    const registration = parseRegistration(registrationText);
    const p2 = parseRecords(logText, "P2")[0];
    const legacyRule = p2?.fields.key && p2.fields.sha256
        ? { key: p2.fields.key, sha256: p2.fields.sha256, ...parseFamily(p2.fields.family ?? "") }
        : null;
    return {
        logBytes,
        logText,
        logLines: logText.split(/\r?\n/).filter((line) => line.length > 0),
        outcomes,
        screens,
        registration,
        ruleFiles: readRuleFiles(paths.rulesDir),
        legacyRule,
        closedDisposition,
    };
}

function mechanismLineageFor(outcome: CampaignOutcomeRecord, registration: CampaignRegistrationSummary): string {
    const registered = [...registration.pool, ...registration.finalists].find((record) => record.key === outcome.key);
    return registered?.mechanismLineage || outcome.mechanismLineage;
}

function withRegistrationLineage(outcomes: readonly CampaignOutcomeRecord[], registration: CampaignRegistrationSummary): CampaignOutcomeRecord[] {
    return outcomes.map((outcome) => ({ ...outcome, mechanismLineage: mechanismLineageFor(outcome, registration) }));
}

function isStrictLead(record: CampaignOutcomeRecord): boolean {
    return record.verdict === "EDGE"
        && record.primary !== null
        && record.primary >= 0.5
        && record.ciLower !== null
        && record.ciLower > 0
        && record.keepPercent !== null
        && record.keepPercent >= 5
        && record.exDominant !== null
        && record.exDominant > 0;
}

function isReplicationSeed(record: CampaignOutcomeRecord): boolean {
    return record.primary !== null
        && record.primary >= 1
        && record.keepPercent !== null
        && record.keepPercent >= 5
        && record.exDominant !== null
        && record.exDominant > 0;
}

function hasDifferentBatchSibling(record: CampaignOutcomeRecord, outcomes: readonly CampaignOutcomeRecord[]): boolean {
    return outcomes.some((other) => other.familyKey === record.familyKey
        && other.mechanismLineage === record.mechanismLineage
        && other.batch !== record.batch
        && other.sha256 !== record.sha256);
}

function bestOutcome(outcomes: readonly CampaignOutcomeRecord[]): CampaignOutcomeRecord | null {
    return [...outcomes].sort((left, right) =>
        (right.primary ?? -Number.MAX_VALUE) - (left.primary ?? -Number.MAX_VALUE)
        || numericSuffix(left.id) - numericSuffix(right.id)
        || codeUnitCompare(left.id, right.id))[0] ?? null;
}

function formatPp(value: number | null): string {
    if (value === null) return "n/a";
    return `${value >= 0 ? "+" : ""}${value.toFixed(2)}pp`;
}

function outcomeBestText(outcome: CampaignOutcomeRecord | null): string {
    return outcome ? `${outcome.id}:${formatPp(outcome.primary)}` : "n/a";
}

function familyState(familyKey: string, outcomes: readonly CampaignOutcomeRecord[], strictOpen: ReadonlySet<string>): string {
    if (strictOpen.has(familyKey)) return "STRICT_OPEN";
    if (outcomes.some((outcome) => outcome.verdict === "EDGE")) return "EDGE_TESTED";
    return "TESTED";
}

function familyStandings(outcomes: readonly CampaignOutcomeRecord[], strictOpen: readonly CampaignOutcomeRecord[]): CampaignFamilyStanding[] {
    const strictKeys = new Set(strictOpen.map((record) => record.familyKey));
    const grouped = new Map<string, CampaignOutcomeRecord[]>();
    for (const outcome of outcomes) (grouped.get(outcome.familyKey) ?? (grouped.set(outcome.familyKey, []), grouped.get(outcome.familyKey)!)).push(outcome);
    return [...grouped.entries()]
        .filter(([familyKey]) => !RETIRED_FAMILY_KEYS.has(familyKey))
        .map(([familyKey, familyOutcomes]) => ({
            familyKey,
            records: familyOutcomes.length,
            best: outcomeBestText(bestOutcome(familyOutcomes)),
            state: familyState(familyKey, familyOutcomes, strictKeys),
        }))
        .sort((left, right) => {
            const leftLead = left.state === "STRICT_OPEN" ? 1 : 0;
            const rightLead = right.state === "STRICT_OPEN" ? 1 : 0;
            return rightLead - leftLead
                || right.records - left.records
                || codeUnitCompare(left.familyKey, right.familyKey);
        });
}

function familyDetail(history: CampaignHistory, familyKey: string, outcomes: readonly CampaignOutcomeRecord[]): CampaignFamilyDetail | undefined {
    const normalized = familyKey.includes(":") ? familyKey.slice(familyKey.indexOf(":") + 1) : familyKey;
    const matchingOutcomes = outcomes.filter((outcome) => outcome.familyKey === normalized);
    const matchingScreens = history.screens.filter((screen) => screen.familyKey === normalized);
    if (matchingOutcomes.length === 0 && matchingScreens.length === 0) return undefined;
    return { familyKey: normalized, outcomes: matchingOutcomes, screens: matchingScreens };
}

function historyCloneCounts(history: CampaignHistory): { keys: number; shas: number; thesisUnknown: number } {
    const keys = new Set<string>();
    const shas = new Set<string>();
    if (history.legacyRule) {
        keys.add(history.legacyRule.key);
        shas.add(history.legacyRule.sha256);
    }
    for (const outcome of history.outcomes) {
        keys.add(outcome.key);
        if (outcome.sha256) shas.add(outcome.sha256);
    }
    for (const screen of history.screens) {
        if (screen.key) keys.add(screen.key);
        if (screen.sha256) shas.add(screen.sha256);
    }
    for (const record of history.registration.pool) {
        if (record.key) keys.add(record.key);
        if (record.sha256) shas.add(record.sha256);
    }
    return { keys: keys.size, shas: shas.size, thesisUnknown: history.screens.filter((screen) => screen.thesis === null).length };
}

function historicalBodies(history: CampaignHistory): string[] {
    return [
        ...history.ruleFiles.map((file) => file.source),
        ...history.registration.pool.map((record) => record.sourceBody + "\n"),
        ...history.registration.finalists.map((record) => record.sourceBody + "\n"),
    ];
}

function canonicalSource(source: string): string {
    return source.replace(/\/\/.*$/gm, "").replace(/\s+/g, " ").replace(/;\s*$/, "").trim();
}

function candidateSource(idea: IdeaCandidate): string {
    return `export default (cand, event) => ${idea.rule};\n`;
}

function normalizeThesis(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function validateIdeaShape(value: unknown, index: number, violations: IdeaCheckViolation[]): value is IdeaCandidate {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        violations.push({ code: "schema", detail: `index=${index}|expected=object` });
        return false;
    }
    const candidate = value as Record<string, unknown>;
    const fields = ["key", "rule", "kind", "familyKey", "mechanism", "flipArgument", "thesis"] as const;
    for (const field of fields) {
        if (typeof candidate[field] !== "string" || candidate[field].trim().length === 0) {
            violations.push({ code: "schema", detail: `index=${index}|field=${field}` });
        }
    }
    return fields.every((field) => typeof candidate[field] === "string" && (candidate[field] as string).trim().length > 0);
}

function checkIdeas(value: unknown, history: CampaignHistory): IdeaCheckResult {
    const violations: IdeaCheckViolation[] = [];
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return { valid: false, violations: [{ code: "schema", detail: "top-level=object-with-ideas-array" }] };
    }
    const rawIdeas = (value as Record<string, unknown>).ideas;
    if (!Array.isArray(rawIdeas)) return { valid: false, violations: [{ code: "schema", detail: "field=ideas" }] };
    const ideas: IdeaCandidate[] = [];
    rawIdeas.forEach((idea, index) => {
        if (validateIdeaShape(idea, index, violations)) ideas.push(idea);
    });
    const keyIndexes = new Map<string, number>();
    const bodyIndexes = new Map<string, number>();
    const canonicalBodyIndexes = new Map<string, number>();
    const canonicalBodies = new Set(historicalBodies(history).map(canonicalSource));
    const historicalKeys = new Set<string>();
    if (history.legacyRule) historicalKeys.add(history.legacyRule.key);
    for (const outcome of history.outcomes) historicalKeys.add(outcome.key);
    for (const screen of history.screens) historicalKeys.add(screen.key);
    for (const record of history.registration.pool) historicalKeys.add(record.key);
    const historicalShas = new Set<string>();
    if (history.legacyRule) historicalShas.add(history.legacyRule.sha256);
    for (const outcome of history.outcomes) historicalShas.add(outcome.sha256);
    for (const screen of history.screens) historicalShas.add(screen.sha256);
    for (const record of history.registration.pool) historicalShas.add(record.sha256);
    for (const file of history.ruleFiles) historicalShas.add(sha256Bytes(file.source));
    const knownTheses = new Set(history.outcomes.map((outcome) => outcome.thesis).filter((thesis): thesis is string => thesis !== null).map(normalizeThesis));
    const familyCounts = new Map<string, number>();
    for (let index = 0; index < ideas.length; index += 1) {
        const idea = ideas[index]!;
        const previousKey = keyIndexes.get(idea.key);
        if (previousKey !== undefined) violations.push({ code: "duplicate-key", detail: `index=${index}|previous=${previousKey}|key=${idea.key}` });
        else keyIndexes.set(idea.key, index);
        if (historicalKeys.has(idea.key)) violations.push({ code: "duplicate-key", detail: `index=${index}|history=true|key=${idea.key}` });
        historicalKeys.add(idea.key);
        const source = candidateSource(idea);
        const exactBody = source.trim();
        const previousBody = bodyIndexes.get(exactBody);
        if (previousBody !== undefined) violations.push({ code: "duplicate-body", detail: `index=${index}|previous=${previousBody}` });
        else bodyIndexes.set(exactBody, index);
        const canonicalBody = canonicalSource(source);
        const previousCanonicalBody = canonicalBodyIndexes.get(canonicalBody);
        if (previousCanonicalBody !== undefined) violations.push({ code: "canonical-duplicate-body", detail: `index=${index}|previous=${previousCanonicalBody}` });
        else canonicalBodyIndexes.set(canonicalBody, index);
        if (canonicalBodies.has(canonicalBody)) violations.push({ code: "canonical-duplicate-body", detail: `index=${index}|history=true|key=${idea.key}` });
        const sha = sha256Bytes(source);
        if (historicalShas.has(sha)) violations.push({ code: "sha-collision", detail: `index=${index}|key=${idea.key}|sha256=${sha}` });
        historicalShas.add(sha);
        const thesis = normalizeThesis(idea.thesis);
        if (knownTheses.has(thesis)) violations.push({ code: "known-thesis", detail: `index=${index}|key=${idea.key}` });
        if (idea.rule.includes("|") || source.includes("|")) violations.push({ code: "banned-grammar", detail: `index=${index}|key=${idea.key}|byte=U+007C` });
        if (/\bcand\.asset\b/.test(idea.rule)) violations.push({ code: "identity-reference", detail: `index=${index}|key=${idea.key}` });
        familyCounts.set(idea.familyKey, (familyCounts.get(idea.familyKey) ?? 0) + 1);
        if (!idea.familyKey.includes(":")) violations.push({ code: "family-schema", detail: `index=${index}|familyKey=${idea.familyKey}` });
        if (idea.kind !== "ranking" && idea.kind !== "filter") violations.push({ code: "kind-schema", detail: `index=${index}|kind=${idea.kind}` });
        if (idea.kind === "ranking" && idea.mechanism !== "ranking-reorder") violations.push({ code: "mechanism-schema", detail: `index=${index}|mechanism=${idea.mechanism}` });
        if (idea.kind === "filter" && (!idea.mechanism.startsWith("candidate-filter:") || idea.mechanism.length === "candidate-filter:".length)) violations.push({ code: "mechanism-schema", detail: `index=${index}|mechanism=${idea.mechanism}` });
        if (idea.kind === "filter") {
            const lineage = idea.mechanism.slice("candidate-filter:".length);
            const priorLineages = history.registration.pool
                .filter((record) => record.familyKey === idea.familyKey.slice(idea.familyKey.indexOf(":") + 1))
                .map((record) => record.mechanismLineage)
                .filter((value) => value.length > 0);
            if (priorLineages.length > 0 && !priorLineages.includes(lineage)) violations.push({ code: "lineage-reuse", detail: `index=${index}|familyKey=${idea.familyKey}|lineage=${lineage}` });
        }
    }
    for (const [familyKey, count] of familyCounts) {
        if (count > 2) violations.push({ code: "family-cap", detail: `familyKey=${familyKey}|count=${count}|max=2` });
    }
    return { valid: violations.length === 0, violations };
}

export function resolveCampaignStandingsPaths(options: CampaignStandingsOptions): CampaignStandingsPaths {
    return resolvePaths(options);
}

export function checkCampaignIdeas(value: unknown, options: CampaignStandingsOptions): IdeaCheckResult {
    return checkIdeas(value, readHistory(options));
}

export function buildCampaignStandings(options: CampaignStandingsOptions): CampaignStandings {
    const history = readHistory(options);
    const outcomes = withRegistrationLineage(history.outcomes, history.registration);
    const f4 = parseRecords(history.logText, "F4").map(parseF4).filter((record): record is ParsedBatchRecord => record !== null);
    const outcomeBatchLabels = new Set(outcomes.map((outcome) => outcome.batch));
    for (const record of f4) outcomeBatchLabels.add(record.batch);
    const completedBatches = [...outcomeBatchLabels].sort((left, right) => numericSuffix(left) - numericSuffix(right));
    const maxBatch = Math.max(0, ...completedBatches.map(numericSuffix));
    const maxOrdinal = Math.max(0, ...f4.map((record) => record.ordinal));
    const strict = outcomes
        .filter(isStrictLead)
        .filter((record) => !hasDifferentBatchSibling(record, outcomes))
        .sort((left, right) => numericSuffix(left.id) - numericSuffix(right.id) || codeUnitCompare(left.id, right.id));
    const seeds = outcomes.filter(isReplicationSeed);
    const replicationOpen = seeds.filter((record) => !hasDifferentBatchSibling(record, outcomes)).length;
    const validationViews = parseRecords(history.logText, "G2").filter((record) => record.fields.stage === "L1V").length
        + parseRecords(history.logText, "V2").filter((record) => record.fields.surface === "L1V").length;
    const cloneCounts = historyCloneCounts(history);
    const retiredOutcomes = outcomes.filter((outcome) => RETIRED_FAMILIES.has(outcome.family));
    if (history.legacyRule) retiredOutcomes.push({
        id: "Q1",
        batch: "B0",
        key: history.legacyRule.key,
        kind: "",
        family: history.legacyRule.family,
        familyKey: history.legacyRule.familyKey,
        mechanismLineage: "unknown",
        sha256: history.legacyRule.sha256,
        thesis: null,
        verdict: "LEGACY",
        primary: null,
        ciLower: null,
        keepPercent: null,
        exDominant: null,
    });
    const retiredFamilies = [...new Set(retiredOutcomes.map((outcome) => outcome.family))].sort(codeUnitCompare);
    const requestedFamilyDetail = options.family ? familyDetail(history, options.family, outcomes) : undefined;
    if (options.family && !requestedFamilyDetail) throw new Error(`family not found: ${options.family}`);
    return {
        campaign: options.campaign,
        logSha256: campaignLogSha256(history.logText),
        nextBatch: history.closedDisposition ? "CLOSED" : `B${maxBatch + 1}`,
        nextOutcomeOrdinal: Math.max(maxOrdinal, completedBatches.length) + 1,
        completedBatches: completedBatches.length,
        discoverySurface: 1 + new Set(outcomes.map((outcome) => outcome.sha256)).size,
        lifetimeEvaluations: 1 + outcomes.length,
        validationViews,
        l2: parseRecords(history.logText, "V2").length > 0 ? "registered" : "unregistered",
        closedDisposition: history.closedDisposition,
        i2Count: outcomes.length,
        s3Count: history.screens.length,
        testedCount: 1 + outcomes.length,
        quarantinedCount: history.screens.filter((screen) => QUARANTINED_BATCHES.has(screen.batch)).length,
        strictOpen: strict,
        replicationOpen,
        confirmationOpen: parseRecords(history.logText, "V2").filter((record) => record.fields.surface === "L1V" && record.fields.result === "PASS").length,
        familyStandings: familyStandings(outcomes, strict).slice(0, 12),
        retiredFamilies,
        retiredRuleCount: retiredOutcomes.length,
        cloneKeyCount: cloneCounts.keys,
        cloneShaCount: cloneCounts.shas,
        thesisUnknownCount: cloneCounts.thesisUnknown,
        tail: (options.tail ?? TOP_MEAN_STANDINGS_DEFAULT_TAIL) > 0 ? history.logLines.slice(-(options.tail ?? TOP_MEAN_STANDINGS_DEFAULT_TAIL)) : [],
        familyDetail: requestedFamilyDetail,
    };
}

function finalizeDigest(linesBeforeEnd: readonly string[]): string {
    let end = "END|lines=0|bytes=0";
    for (let attempt = 0; attempt < 8; attempt += 1) {
        const output = [...linesBeforeEnd, end].join("\n") + "\n";
        const next = `END|lines=${linesBeforeEnd.length + 1}|bytes=${Buffer.byteLength(output, "utf8")}`;
        if (next === end) break;
        end = next;
    }
    const output = [...linesBeforeEnd, end].join("\n") + "\n";
    const lineCount = linesBeforeEnd.length + 1;
    const byteCount = Buffer.byteLength(output, "utf8");
    if (lineCount > TOP_MEAN_STANDINGS_MAX_LINES || byteCount > TOP_MEAN_STANDINGS_MAX_BYTES) {
        throw new Error(`DIGEST OVERFLOW | lines=${lineCount} | bytes=${byteCount} | limits=${TOP_MEAN_STANDINGS_MAX_LINES}/${TOP_MEAN_STANDINGS_MAX_BYTES}`);
    }
    return output;
}

function renderFamilyDetail(detail: CampaignFamilyDetail): string[] {
    const lines = [`FAMILY_DETAIL|key=${detail.familyKey}|outcomes=${detail.outcomes.length}|screens=${detail.screens.length}`];
    for (const outcome of detail.outcomes) {
        lines.push(`FAMILY_OUTCOME|id=${outcome.id}|batch=${outcome.batch}|key=${outcome.key}|sha256=${outcome.sha256}|verdict=${outcome.verdict}|primary=${formatPp(outcome.primary)}|thesis=${outcome.thesis ?? "thesis-unknown"}`);
    }
    for (const screen of detail.screens) {
        lines.push(`FAMILY_SCREEN|batch=${screen.batch}|candidate=${screen.candidate}|key=${screen.key}|sha256=${screen.sha256}|impact=${screen.impact}|thesis=${screen.thesis ?? "thesis-unknown"}`);
    }
    return lines;
}

export function renderCampaignStandings(result: CampaignStandings): string {
    const lines = [
        `TOP_MEAN_STANDINGS|schema=${TOP_MEAN_STANDINGS_SCHEMA}|campaign=${result.campaign}|contract=${TOP_MEAN_STANDINGS_CONTRACT}|hashConvention=crlf-stripped|logSha256=${result.logSha256}`,
        `STATE|nextBatch=${result.nextBatch}|nextOutcomeOrdinal=${result.nextOutcomeOrdinal}|completed=${result.completedBatches}/${TOP_MEAN_CAMPAIGN_MAX_BATCHES}|NDsurface=${result.discoverySurface}/${TOP_MEAN_CAMPAIGN_MAX_DISCOVERY}|NG=${result.lifetimeEvaluations}|L1V=${result.validationViews}/${TOP_MEAN_CAMPAIGN_MAX_VALIDATION}|L2=${result.l2}${result.closedDisposition ? `|closed=${result.closedDisposition}` : ""}`,
        `COUNTS|I2=${result.i2Count}|S3=${result.s3Count}|tested=${result.testedCount}|quarantined=${result.quarantinedCount}`,
        `ROUTES|strictOpen=${result.strictOpen.length}|replicationOpen=${result.replicationOpen}|confirmationOpen=${result.confirmationOpen}`,
    ];
    for (const lead of result.strictOpen.slice(0, 12)) lines.push(`LEAD|id=${lead.id}|familyKey=${lead.familyKey}|lineage=${lead.mechanismLineage}|stage=STRICT_OPEN`);
    for (const family of result.familyStandings.slice(0, 12)) lines.push(`FAMILY|key=${family.familyKey}|records=${family.records}|best=${family.best}|state=${family.state}`);
    lines.push(`RETIRED|families=${result.retiredFamilies.length > 0 ? result.retiredFamilies.join(",") : "none"}|rules=${result.retiredRuleCount}`);
    lines.push(`CLONES|keys=${result.cloneKeyCount}|shas=${result.cloneShaCount}|thesisUnknown=${result.thesisUnknownCount}`);
    if (result.familyDetail) lines.push(...renderFamilyDetail(result.familyDetail));
    lines.push(`TAIL_BEGIN|count=${result.tail.length}`);
    for (const line of result.tail) lines.push(`TAIL|line=${line}`);
    lines.push("TAIL_END");
    return finalizeDigest(lines);
}

interface ParsedCliOptions {
    campaign: string;
    tail: number;
    family?: string;
    checkIdeas?: string;
}

const USAGE = "Usage: esno scripts/top-mean-campaign-standings.ts --campaign TM-L1-C1 [--tail N] [--family <familyKey>] [--check-ideas ideas.json]";

function parseCli(argv: readonly string[]): ParsedCliOptions {
    let campaign: string | undefined;
    let tail = TOP_MEAN_STANDINGS_DEFAULT_TAIL;
    let family: string | undefined;
    let checkIdeasPath: string | undefined;
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index]!;
        const next = (): string => argv[++index] ?? "";
        if (arg === "--campaign") {
            if (campaign !== undefined) throw new Error("duplicate --campaign");
            campaign = next();
            if (!campaign) throw new Error("--campaign requires a value");
        } else if (arg === "--tail") {
            const value = next();
            tail = Number(value);
            if (!/^\d+$/.test(value) || !Number.isSafeInteger(tail) || tail < 0) throw new Error("--tail requires a non-negative integer");
        } else if (arg === "--family") {
            if (family !== undefined) throw new Error("duplicate --family");
            family = next();
            if (!family) throw new Error("--family requires a value");
        } else if (arg === "--check-ideas") {
            if (checkIdeasPath !== undefined) throw new Error("duplicate --check-ideas");
            checkIdeasPath = next();
            if (!checkIdeasPath) throw new Error("--check-ideas requires a path");
        } else if (arg !== "--help" && arg !== "-h") {
            throw new Error(`unknown option ${arg}`);
        } else if (argv.length !== 1) {
            throw new Error("--help must be used alone");
        }
    }
    if (!campaign) throw new Error("--campaign is required");
    return { campaign, tail, family, checkIdeas: checkIdeasPath };
}

export function runCampaignStandingsCli(argv: readonly string[] = process.argv.slice(2)): number {
    try {
        if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
            process.stdout.write(`${USAGE}\n`);
            return 0;
        }
        const options = parseCli(argv);
        const standingsOptions: CampaignStandingsOptions = { campaign: options.campaign, tail: options.tail, family: options.family };
        if (options.checkIdeas) {
            const value = JSON.parse(readFileSync(path.resolve(options.checkIdeas), "utf8")) as unknown;
            const result = checkCampaignIdeas(value, standingsOptions);
            for (const violation of result.violations) process.stdout.write(`IDEA_CHECK|${violation.code}|${violation.detail}\n`);
            return result.valid ? 0 : 1;
        }
        process.stdout.write(renderCampaignStandings(buildCampaignStandings(standingsOptions)));
        return 0;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`${message.includes("DIGEST OVERFLOW") ? message : `STANDINGS FAIL | ${message}`}\n`);
        return message.includes("DIGEST OVERFLOW") ? 1 : 2;
    }
}

const isMain = process.argv[1] !== undefined
    && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) process.exitCode = runCampaignStandingsCli();
