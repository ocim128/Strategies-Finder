import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DESIGNATED_KEY = "q26_sibling_low_breadth_coverage_floor_55";
const DESIGNATED_KIND = "filter";
const DESIGNATED_FAMILY = "interaction:interaction";
const DESIGNATED_FAMILY_KEY = "low_breadth_coverage_floor";
const DESIGNATED_LINEAGE = "low_breadth_coverage_floor";
const DESIGNATED_SOURCE = "export default (cand, event) => event.breadth < 0.62 ? cand.activePairCount >= 55 : true;";
const QUARANTINED_BATCHES = new Set(["B5", "B6", "B7"]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

export interface CampaignAuditPaths {
    miningDir: string;
    logPath: string;
    rulesDir: string;
    registrationPath: string;
}

export interface CampaignAuditOptions {
    miningDir?: string;
}

export interface CampaignAuditCheck {
    name: string;
    passed: boolean;
    detail: string;
}

export interface CampaignAuditResult {
    batchLabel: string;
    checks: readonly CampaignAuditCheck[];
    passed: boolean;
}

export interface CampaignRegistrationRule {
    ordinal: number;
    candidate: string;
    key: string;
    kind: string;
    family: string;
    familyKey: string;
    mechanism: string;
    mechanismLineage: string;
    path: string;
    sourceBody: string;
    sha256: string;
}

export function sha256Bytes(value: string | Uint8Array): string {
    return createHash("sha256").update(value).digest("hex");
}

function parseFields(parts: readonly string[]): Record<string, string> {
    const fields: Record<string, string> = {};
    for (const part of parts) {
        const separator = part.indexOf("=");
        if (separator <= 0) continue;
        fields[part.slice(0, separator)] = part.slice(separator + 1);
    }
    return fields;
}

interface PipeRecord {
    marker: string;
    positional: string[];
    fields: Record<string, string>;
}

function parsePipeRecord(line: string): PipeRecord | null {
    const parts = line.split("|");
    const marker = parts.shift();
    if (!marker) return null;
    const positional: string[] = [];
    const fieldParts: string[] = [];
    for (const part of parts) {
        if (part.includes("=")) fieldParts.push(part);
        else positional.push(part);
    }
    return { marker, positional, fields: parseFields(fieldParts) };
}

function parseRecords(text: string, marker: string): PipeRecord[] {
    const records: PipeRecord[] = [];
    for (const line of text.split(/\r?\n/)) {
        if (!line.startsWith(marker + "|")) continue;
        const record = parsePipeRecord(line);
        if (record) records.push(record);
    }
    return records;
}

function parseBatchRecords(text: string, marker: string, batchLabel: string): PipeRecord[] {
    return parseRecords(text, marker).filter((record) => record.positional[0] === batchLabel);
}

function asRegistrationRule(record: PipeRecord): CampaignRegistrationRule | null {
    const fields = record.fields;
    const ordinal = Number(fields.ordinal);
    if (!Number.isInteger(ordinal)) return null;
    return {
        ordinal,
        candidate: fields.candidate ?? "",
        key: fields.key ?? "",
        kind: fields.kind ?? "",
        family: fields.family ?? "",
        familyKey: fields.familyKey ?? "",
        mechanism: fields.mechanism ?? "",
        mechanismLineage: fields.mechanismLineage ?? "",
        path: fields.path ?? "",
        sourceBody: fields.sourceBody ?? "",
        sha256: fields.sha256 ?? "",
    };
}

interface ParsedRegistration {
    meta: Record<string, string>;
    designated: Record<string, string> | null;
    pool: CampaignRegistrationRule[];
    finalists: CampaignRegistrationRule[];
}

function parseRegistration(text: string): ParsedRegistration {
    const metaRecord = parseRecords(text, "REGISTRATION")[0];
    const designatedRecord = parseRecords(text, "DESIGNATED")[0];
    const pool: CampaignRegistrationRule[] = [];
    for (const record of parseRecords(text, "POOL")) {
        const parsed = asRegistrationRule(record);
        if (parsed) pool.push(parsed);
    }
    const finalists: CampaignRegistrationRule[] = [];
    for (const record of parseRecords(text, "FINAL")) {
        const parsed = asRegistrationRule(record);
        if (parsed) finalists.push(parsed);
    }
    return {
        meta: metaRecord?.fields ?? {},
        designated: designatedRecord?.fields ?? null,
        pool,
        finalists,
    };
}

export function resolveCampaignAuditPaths(
    batchLabel: string,
    options: CampaignAuditOptions = {},
): CampaignAuditPaths {
    const miningDir = path.resolve(options.miningDir ?? path.join(process.cwd(), "archive", "top-mean-mining"));
    return {
        miningDir,
        logPath: path.join(miningDir, "idea-log.txt"),
        rulesDir: path.join(miningDir, "rules"),
        registrationPath: path.join(miningDir, batchLabel + "-REGISTRATION.md"),
    };
}

function readText(filePath: string): string {
    return existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
}

function validSha(value: string): boolean {
    return SHA256_PATTERN.test(value);
}

function ordered(records: readonly CampaignRegistrationRule[], expectedCount: number): boolean {
    return records.length === expectedCount
        && records.every((record, index) => record.ordinal === index + 1);
}

function hasPoolFields(record: CampaignRegistrationRule): boolean {
    return record.candidate.length > 0
        && record.key.length > 0
        && record.kind.length > 0
        && record.family.length > 0
        && record.familyKey.length > 0
        && record.mechanismLineage.length > 0
        && record.path.length > 0
        && record.sourceBody.length > 0
        && validSha(record.sha256);
}

function canonicalRegistrationRecord(record: CampaignRegistrationRule): string {
    return [
        "ordinal=" + record.ordinal,
        "candidate=" + record.candidate,
        "key=" + record.key,
        "kind=" + record.kind,
        "family=" + record.family,
        "familyKey=" + record.familyKey,
        "mechanism=" + record.mechanism,
        "mechanismLineage=" + record.mechanismLineage,
        "path=" + record.path,
        "sourceBody=" + record.sourceBody,
        "sha256=" + record.sha256,
    ].join("|");
}

export function computeRegistrationDigest(records: readonly CampaignRegistrationRule[]): string {
    return sha256Bytes(records.map(canonicalRegistrationRecord).join("\n") + "\n");
}

function resolveRulePath(rulePath: string, paths: CampaignAuditPaths): string {
    if (path.isAbsolute(rulePath)) return rulePath;
    const normalized = rulePath.replaceAll("\\", "/");
    const archivePrefix = "archive/top-mean-mining/";
    if (normalized.startsWith(archivePrefix)) {
        return path.join(paths.miningDir, normalized.slice(archivePrefix.length));
    }
    return path.resolve(paths.miningDir, normalized);
}

interface RuleBytesCheck {
    valid: boolean;
    identityReference: boolean;
    detail: string;
}

function checkRegisteredRuleBytes(
    record: CampaignRegistrationRule,
    paths: CampaignAuditPaths,
): RuleBytesCheck {
    if (!hasPoolFields(record)) {
        return {
            valid: false,
            identityReference: false,
            detail: "missing registration fields for " + (record.key || record.candidate || "unknown"),
        };
    }
    const filePath = resolveRulePath(record.path, paths);
    if (!existsSync(filePath)) {
        return { valid: false, identityReference: false, detail: "missing rule file " + record.path };
    }
    const bytes = readFileSync(filePath);
    const source = bytes.toString("utf8");
    const identityReference = source.includes("cand.asset");
    const hashMatches = sha256Bytes(bytes) === record.sha256;
    const bodyMatches = source === record.sourceBody + "\n";
    if (!hashMatches) return { valid: false, identityReference, detail: "SHA mismatch for " + record.key };
    if (!bodyMatches) return { valid: false, identityReference, detail: "source body mismatch for " + record.key };
    return { valid: true, identityReference, detail: "10 finalist rule files match registered source bytes" };
}

function findS3Candidate(
    records: readonly PipeRecord[],
    candidate: CampaignRegistrationRule,
): PipeRecord | undefined {
    return records.find((record) => record.fields.candidate === candidate.candidate);
}

function sameRegistrationRule(left: CampaignRegistrationRule, right: CampaignRegistrationRule): boolean {
    return left.candidate === right.candidate
        && left.key === right.key
        && left.kind === right.kind
        && left.family === right.family
        && left.familyKey === right.familyKey
        && left.mechanism === right.mechanism
        && left.mechanismLineage === right.mechanismLineage
        && left.path === right.path
        && left.sourceBody === right.sourceBody
        && left.sha256 === right.sha256;
}

function makeCheck(name: string, passed: boolean, detail: string): CampaignAuditCheck {
    return { name, passed, detail };
}

export function auditCampaignBatch(
    batchLabel: string,
    options: CampaignAuditOptions = {},
): CampaignAuditResult {
    const paths = resolveCampaignAuditPaths(batchLabel, options);
    const logText = readText(paths.logPath);
    const registrationText = readText(paths.registrationPath);
    const registration = parseRegistration(registrationText);
    const s3Records = parseBatchRecords(logText, "S3", batchLabel);
    const loggedF4Record = parseBatchRecords(logText, "F4", batchLabel).at(-1);
    const registrationF4Record = parseBatchRecords(registrationText, "F4", batchLabel).at(-1);
    const f4Record = loggedF4Record ?? registrationF4Record;
    const advancedRecords = s3Records.filter((record) => record.fields.advanced === "yes");
    const advancedEligible = advancedRecords.filter((record) =>
        Boolean(record.fields.candidate)
        && Boolean(record.fields.key)
        && Boolean(record.fields.kind)
        && Boolean(record.fields.family)
        && validSha(record.fields.sha256 ?? ""),
    );
    const advancedCandidateIds = new Set(advancedEligible.map((record) => record.fields.candidate));
    const advancedShas = new Set(advancedEligible.map((record) => record.fields.sha256));
    const poolIds = new Set(registration.pool.map((record) => record.candidate));
    const poolMatches = registration.pool.length === advancedEligible.length
        && registration.pool.every((record) => {
            const s3 = findS3Candidate(advancedEligible, record);
            return s3 !== undefined
                && s3.fields.key === record.key
                && s3.fields.kind === record.kind
                && s3.fields.family === record.family
                && s3.fields.sha256 === record.sha256;
        });
    const finalIds = new Set(registration.finalists.map((record) => record.candidate));
    const finalS3Matches = registration.finalists.every((record) => advancedCandidateIds.has(record.candidate));
    const finalPoolMatches = registration.finalists.every((record) =>
        registration.pool.some((poolRecord) => sameRegistrationRule(poolRecord, record)),
    );
    const finalFamilies = new Map<string, number>();
    for (const record of registration.finalists) {
        finalFamilies.set(record.familyKey, (finalFamilies.get(record.familyKey) ?? 0) + 1);
    }
    const familyCountsPass = finalFamilies.size >= 6
        && [...finalFamilies.values()].every((count) => count <= 2);
    const combinationCount = registration.finalists.filter((record) =>
        record.kind === "combination" || record.mechanism === "combination",
    ).length;
    const poolByteChecks = registration.pool.map((record) => checkRegisteredRuleBytes(record, paths));
    const finalByteChecks = registration.finalists.map((record) => checkRegisteredRuleBytes(record, paths));
    const finalistByteDetail = finalByteChecks.find((check) => !check.valid)?.detail
        ?? (finalByteChecks.length === 10
            ? "10 finalist rule files match registered source bytes"
            : finalByteChecks.length + " finalist rule records registered");
    const identityReferences = [...poolByteChecks, ...finalByteChecks].filter((check) => check.identityReference);
    const designated = registration.designated;
    const designatedFilePath = designated ? resolveRulePath(designated.path ?? "", paths) : "";
    const designatedFileSource = designatedFilePath && existsSync(designatedFilePath)
        ? readFileSync(designatedFilePath, "utf8")
        : "";
    const d4Records = parseRecords(logText, "D4");
    const d4 = d4Records.at(-1)?.fields;
    const registrationHeaderPass = registration.meta.schema === "top_mean_campaign_registration.v1"
        && registration.meta.batchLabel === batchLabel
        && registration.meta.outcomeOrdinal === "5"
        && registration.meta.humanApproved === "yes";
    const designatedMatches = designated !== null
        && d4 !== undefined
        && designated.key === DESIGNATED_KEY
        && designated.kind === DESIGNATED_KIND
        && designated.family === DESIGNATED_FAMILY
        && designated.familyKey === DESIGNATED_FAMILY_KEY
        && designated.mechanism === "candidate-filter"
        && designated.mechanismLineage === DESIGNATED_LINEAGE
        && designated.sourceBody === DESIGNATED_SOURCE
        && designatedFileSource === DESIGNATED_SOURCE + "\n"
        && validSha(designated.sha256 ?? "")
        && sha256Bytes(designatedFileSource) === designated.sha256
        && d4.seed === "Q26"
        && d4.family === DESIGNATED_FAMILY
        && d4.mechanism === DESIGNATED_LINEAGE
        && d4.validationTarget === "fresh-sibling"
        && d4.humanApproved === "yes";
    const designatedFinal = registration.finalists.some((record) =>
        record.key === DESIGNATED_KEY
        && record.path === designated?.path
        && record.sha256 === designated?.sha256,
    );
    const quarantinedShas = new Set<string>();
    for (const quarantinedBatch of QUARANTINED_BATCHES) {
        for (const record of parseBatchRecords(logText, "S3", quarantinedBatch)) {
            if (validSha(record.fields.sha256 ?? "")) quarantinedShas.add(record.fields.sha256);
        }
    }
    const quarantinedAdvanced = [...advancedShas].filter((sha) => quarantinedShas.has(sha));
    const f4FinalCount = Number(f4Record?.fields.finalCount);
    const f4DigestPass = f4Record !== undefined
        && f4Record.fields.audit === "PASS"
        && f4Record.fields.humanApproved === "yes"
        && f4Record.fields.outcomeOrdinal === "5"
        && f4Record.fields.poolCount === "30"
        && f4Record.fields.finalCount === "10"
        && f4Record.fields.designatedKey === designated?.key
        && f4Record.fields.designatedSha256 === designated?.sha256
        && validSha(f4Record.fields.poolDigest ?? "")
        && validSha(f4Record.fields.finalDigest ?? "")
        && f4Record.fields.poolDigest === computeRegistrationDigest(registration.pool)
        && f4Record.fields.finalDigest === computeRegistrationDigest(registration.finalists);
    const noZeroAdvanced = advancedRecords.every((record) => record.fields.impact !== "ZERO");
    const thinRecords = advancedRecords.filter((record) => record.fields.impact === "THIN");
    const thinPass = thinRecords.length <= 1
        && (thinRecords.length === 0 || f4Record?.fields.humanApproved === "yes");

    const checks: CampaignAuditCheck[] = [
        makeCheck(
            "REGISTRATION_HEADER",
            registrationHeaderPass,
            registrationHeaderPass
                ? "v1 registration header matches " + batchLabel + " outcome ordinal 5"
                : "missing or mismatched v1 registration header",
        ),
        makeCheck(
            "S3_POOL_COUNT",
            advancedEligible.length === 30
                && advancedCandidateIds.size === 30
                && advancedShas.size === 30
                && poolIds.size === 30
                && poolMatches,
            advancedEligible.length + "/30 unique advanced-eligible S3 candidates; registration=" + registration.pool.length,
        ),
        makeCheck(
            "F4_FINAL_COUNT",
            f4FinalCount === 10
                && ordered(registration.finalists, 10)
                && finalIds.size === 10
                && finalS3Matches
                && finalPoolMatches
                && registration.finalists.every((record) => poolIds.has(record.candidate)),
            "F4 finalCount=" + (Number.isFinite(f4FinalCount) ? f4FinalCount : "missing")
                + "; registered=" + registration.finalists.length,
        ),
        makeCheck(
            "C5_COMPOSITION",
            familyCountsPass && combinationCount <= 1,
            finalFamilies.size + " familyKeys; maxFamily=" + Math.max(0, ...finalFamilies.values())
                + "; combinations=" + combinationCount,
        ),
        makeCheck(
            "NO_ZERO_ADVANCED",
            noZeroAdvanced,
            advancedRecords.filter((record) => record.fields.impact === "ZERO").length + " advanced ZERO records",
        ),
        makeCheck(
            "THIN_CAP",
            thinPass,
            thinRecords.length + " advanced THIN records; cap=1",
        ),
        makeCheck(
            "FINALIST_BYTES",
            finalByteChecks.length === 10 && finalByteChecks.every((check) => check.valid),
            finalistByteDetail,
        ),
        makeCheck(
            "NO_IDENTITY_BODY",
            identityReferences.length === 0,
            identityReferences.length === 0
                ? "no finalist source body references cand.asset"
                : identityReferences.length + " finalist source body references cand.asset",
        ),
        makeCheck(
            "DESIGNATED_RULE",
            designatedMatches && designatedFinal,
            designatedMatches && designatedFinal
                ? "D4 and registration match the frozen Q26 sibling bytes"
                : "designated Q26 sibling drifted or is absent from the frozen finalists",
        ),
        makeCheck(
            "NO_QUARANTINED_ADVANCE",
            quarantinedAdvanced.length === 0,
            quarantinedAdvanced.length === 0
                ? "no B5/B6/B7 S3 SHA advanced"
                : quarantinedAdvanced.length + " quarantined S3 SHA advanced",
        ),
        makeCheck(
            "F4_DIGESTS",
            f4DigestPass,
            f4DigestPass
                ? "F4 pool/final digests match ordered registration records"
                : "F4 record or ordered registration digests are missing or mismatched",
        ),
    ];
    return {
        batchLabel,
        checks,
        passed: checks.every((check) => check.passed),
    };
}

export function renderCampaignAuditReport(result: CampaignAuditResult): string {
    return [
        "TOP_MEAN CAMPAIGN AUDIT | batch=" + result.batchLabel,
        ...result.checks.map((check) => (check.passed ? "PASS" : "FAIL") + " | " + check.name + " | " + check.detail),
        "RESULT | " + (result.passed ? "PASS" : "FAIL"),
    ].join("\n");
}

export function runCampaignAuditCli(
    argv: readonly string[] = process.argv.slice(2),
    options: CampaignAuditOptions = {},
): number {
    if (argv.length !== 1 || argv[0].length === 0) {
        console.error("Usage: esno scripts/top-mean-campaign-audit.ts <batchLabel>");
        return 2;
    }
    const result = auditCampaignBatch(argv[0], options);
    console.log(renderCampaignAuditReport(result));
    return result.passed ? 0 : 1;
}

const isMain = process.argv[1] !== undefined
    && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
    process.exitCode = runCampaignAuditCli();
}
