import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
    CAMPAIGN_LOG_HASH_CONVENTION,
    canonicalizeCampaignLogText,
    parsePipeRecord,
    parseRecords,
    readCampaignLog,
    sha256Bytes,
    type CampaignPipeRecord,
} from "./top-mean-campaign-log";
import { normalizeAssetPairSet } from "../lib/batch-backtest/sp500-top-mean-archive-log";

const CAMPAIGN = "TM-L2-C1";
const CONTRACT = "v2.0";
const QUARANTINED_BATCHES = new Set(["B5", "B6", "B7"]);
const FEATURE_FIELDS = ["priorCoverageSlope5", "priorSignedVoteDelta3", "priorScoreStdDev5", "priorTopMeanReturnMean3"] as const;
const SHA256 = /^[0-9a-f]{64}$/i;

export interface V2CampaignAuditOptions {
    miningDir?: string;
    root?: string;
}

export interface V2CampaignAuditCheck {
    name: string;
    passed: boolean;
    detail: string;
}

export interface V2CampaignAuditResult {
    campaign: string;
    checks: readonly V2CampaignAuditCheck[];
    passed: boolean;
}

interface Registration {
    text: string;
    records: ReadonlyMap<string, CampaignPipeRecord>;
    rules: readonly CampaignPipeRecord[];
}

function check(name: string, passed: boolean, detail: string): V2CampaignAuditCheck {
    return { name, passed, detail };
}

function resolvePaths(options: V2CampaignAuditOptions): { root: string; miningDir: string; registrationPath: string } {
    const root = path.resolve(options.root ?? process.cwd());
    const miningDir = path.resolve(options.miningDir ?? path.join(root, "archive", "top-mean-mining"));
    return { root, miningDir, registrationPath: path.join(miningDir, "tm-l2-c1", "LEDGER-REGISTRATION.md") };
}

function readRegistration(filename: string): Registration {
    const text = existsSync(filename) ? readFileSync(filename, "utf8") : "";
    const records = new Map<string, CampaignPipeRecord>();
    for (const line of text.split(/\r?\n/)) {
        const record = parsePipeRecord(line);
        if (record) records.set(record.marker, record);
    }
    const rules = parseRecords(text, "RULE").concat(parseRecords(text, "POOL")).concat(parseRecords(text, "FINAL"));
    return { text, records, rules };
}

function validSha(value: string | undefined): boolean {
    return value !== undefined && SHA256.test(value);
}

function fileSha(filename: string): string | null {
    try {
        return createHash("sha256").update(readFileSync(filename)).digest("hex");
    } catch {
        return null;
    }
}

function record(registration: Registration, marker: string): CampaignPipeRecord | null {
    return registration.records.get(marker) ?? null;
}

function checkFormatAndC6(logText: string, registration: Registration, featureContractPath: string): V2CampaignAuditCheck[] {
    const checks: V2CampaignAuditCheck[] = [];
    const canonicalLogText = canonicalizeCampaignLogText(logText);
    const formatLine = canonicalLogText.split("\n").find((line) => line.startsWith("FORMAT6|"));
    const format = formatLine ? parsePipeRecord(formatLine) : null;
    const formatPassed = format?.fields.effective === CAMPAIGN
        && format.fields.contract === CONTRACT
        && format.fields.adds === "C6,L6"
        && formatLine?.endsWith("|legacy-records-immutable") === true;
    checks.push(check("FORMAT6", formatPassed, formatLine ?? "missing FORMAT6"));
    if (formatLine && formatPassed) {
        const offset = canonicalLogText.indexOf(formatLine);
        const prefix = offset >= 0 ? canonicalLogText.slice(0, offset) : "";
        const declaredPrefix = format.fields.prefixSha256?.split("|", 1)[0];
        const canonicalPrefix = sha256Bytes(prefix);
        const correctionLine = canonicalLogText.split("\n").find((line) => line.startsWith("X6|"));
        const correction = correctionLine ? parsePipeRecord(correctionLine) : null;
        const correctionPassed = correction?.fields.scope === "FORMAT6-prefix"
            && correction.fields.issue === "crlf-contaminated-prefix-hash"
            && correction.fields.declared === declaredPrefix
            && correction.fields.canonical === canonicalPrefix
            && correction.fields.disposition === "canonical-authoritative-going-forward";
        checks.push(check("FORMAT6_CORRECTION", correctionPassed, correctionLine ?? "missing X6 FORMAT6 correction"));
        checks.push(check("FORMAT6_PREFIX", correctionPassed, `declared=${declaredPrefix ?? "missing"} canonical=${canonicalPrefix} hashConvention=${CAMPAIGN_LOG_HASH_CONVENTION}`));
    } else checks.push(check("FORMAT6_PREFIX", false, "FORMAT6 is missing or malformed"));

    const c6Line = logText.split(/\r?\n/).find((line) => line.startsWith("C6|"));
    const c6 = c6Line ? parsePipeRecord(c6Line) : null;
    const registrationFile = registration.text;
    const registrationSha = sha256Bytes(registrationFile);
    const featureContractSha = fileSha(featureContractPath);
    const c6Passed = c6?.fields.campaign === CAMPAIGN
        && c6.fields.predecessor === "TM-L1-C1"
        && c6.fields.NGStart === "57"
        && c6.fields.NDsurfaceStart === "0"
        && c6.fields.registrationSha256 === registrationSha
        && featureContractSha !== null
        && c6.fields.featureContractSha256 === featureContractSha
        && c6.fields.humanApproved === "yes";
    checks.push(check("C6", c6Passed, c6Line ?? "missing C6"));
    return checks;
}

function checkRegistration(registration: Registration, root: string): V2CampaignAuditCheck[] {
    const checks: V2CampaignAuditCheck[] = [];
    const identity = record(registration, "IDENTITY");
    const source = record(registration, "FEATURE_SOURCE");
    const fields = record(registration, "FEATURE_FIELDS");
    const pairlist = record(registration, "PAIRLIST");
    const power = record(registration, "POWER_GATE");
    const registrationMeta = record(registration, "REGISTRATION");
    checks.push(check("CAMPAIGN_IDENTITY", registrationMeta?.fields.campaign === CAMPAIGN && registrationMeta.fields.contract === CONTRACT && identity?.fields.predecessor === "TM-L1-C1", "registration and predecessor identity"));
    const builderPath = path.join(root, "lib", "batch-backtest", "sp500-top-mean-causal-features.ts");
    const checkerPath = path.join(root, "scripts", "top-mean-rule-checker.ts");
    checks.push(check("FEATURE_HASHES", source?.fields.builder === "lib/batch-backtest/sp500-top-mean-causal-features.ts"
        && source.fields.checker === "scripts/top-mean-rule-checker.ts"
        && validSha(source.fields.builderSourceSha256)
        && validSha(source.fields.checkerSourceSha256)
        && fileSha(builderPath) === source.fields.builderSourceSha256
        && fileSha(checkerPath) === source.fields.checkerSourceSha256, "builder/checker source hashes"));
    checks.push(check("FEATURE_FIELDS", fields?.fields.fields === FEATURE_FIELDS.join(",")
        && fields.fields.schema === "top_mean_candidate_features.v1"
        && source?.fields.featureContract === "top_mean_feature_set.v2"
        && source.fields.formulaVersion === "tm_feature_formulas.v1"
        && source.fields.availabilityPolicy === "strict_prior_exit_v1", "feature schema, formula, and availability policy"));
    const pairJsonPath = path.join(root, "docs", "pairlist-pools", "BAL5555-S2.v1.json");
    const pairTextPath = path.join(root, "docs", "pairlist-pools", "BAL5555-S2.v1.txt");
    let pairJson: Record<string, unknown> | null = null;
    try { pairJson = JSON.parse(readFileSync(pairJsonPath, "utf8")) as Record<string, unknown>; } catch { /* reported below */ }
    const provenance = pairJson?.provenance as Record<string, unknown> | undefined;
    const pairValues = Array.isArray(pairJson?.pairs) && pairJson.pairs.every((value) => typeof value === "string")
        ? pairJson.pairs as string[]
        : null;
    const pairText = pairTextPath && (() => {
        try { return readFileSync(pairTextPath, "utf8"); } catch { return null; }
    })();
    const textPairs = pairText === null ? null : pairText.trim().length === 0 ? [] : pairText.trim().split(/\r?\n/);
    const pairSet = pairValues ? normalizeAssetPairSet(pairValues) : null;
    const pairAssets = Array.isArray(pairJson?.assets) && pairJson.assets.every((value) => typeof value === "string")
        ? pairJson.assets as string[]
        : null;
    const relationshipSet = pairJson?.relationshipSet as Record<string, unknown> | undefined;
    const l1MetaPath = path.join(root, "archive", "batch-open-score", "sp500_top_mean_1788443592188_cgd3", "meta.json");
    let l1PairSet: Set<string> | null = null;
    try {
        const l1Meta = JSON.parse(readFileSync(l1MetaPath, "utf8")) as { manifest?: { pairs?: { pairs?: unknown } } };
        l1PairSet = Array.isArray(l1Meta.manifest?.pairs?.pairs) && l1Meta.manifest.pairs.pairs.every((value) => typeof value === "string")
            ? normalizeAssetPairSet(l1Meta.manifest.pairs.pairs as string[])
            : null;
    } catch { /* reported below */ }
    const intersection = pairSet && l1PairSet ? [...pairSet].filter((value) => l1PairSet!.has(value)).length : null;
    const union = pairSet && l1PairSet ? new Set([...pairSet, ...l1PairSet]).size : null;
    const jaccard = intersection !== null && union !== null ? intersection / union : null;
    checks.push(check("PAIRLIST", pairlist?.fields.poolVersion === "BAL5555-S2.v1"
        && pairJson?.poolVersion === "BAL5555-S2.v1"
        && pairValues?.length === 5555
        && JSON.stringify(pairValues) === JSON.stringify(textPairs)
        && pairText !== null
        && pairJson?.pairListSha256 === sha256Bytes(pairText)
        && provenance?.algorithm === "seeded_round_robin_v1"
        && provenance.effectiveSeed === 2
        && provenance.executionOrderSha256 === pairJson?.pairListSha256
        && validSha(String(provenance.executionOrderSha256))
        && validSha(String(provenance.sortedSetSha256))
        && provenance.sortedSetSha256 === sha256Bytes(`${[...pairValues].sort().join("\n")}\n`)
        && pairAssets?.length === 136
        && pairJson?.catalogSha256 === sha256Bytes(`${pairAssets?.join("\n")}\n`)
        && relationshipSet?.normalization === "normalizeAssetPairSet; undirected canonical scoring-asset pairs"
        && relationshipSet.intersection === 3351
        && relationshipSet.union === 7759
        && typeof relationshipSet.jaccard === "number"
        && Number(relationshipSet.jaccard.toFixed(6)) === 0.431886
        && intersection === 3351
        && union === 7759
        && jaccard !== null && jaccard <= 0.8, "BAL5555-S2.v1 pair-list provenance"));
    const gatesPassed = power?.fields.primaryMinPp === "1.00"
        && power.fields.ciLowerMinPp === "0.15"
        && power.fields.positiveBlocksMin === "8/10"
        && power.fields.keepMinPercent === "20"
        && power.fields.exDominantMinPp === "0.30"
        && power.fields.fullC2 === "yes";
    checks.push(check("V2_POWER_GATE", gatesPassed, power ? JSON.stringify(power.fields) : "missing POWER_GATE"));
    const grammar = registration.rules.every((rule) => !(rule.fields.sourceBody ?? "").includes("|"));
    checks.push(check("RULE_GRAMMAR", grammar, `${registration.rules.length} registered rules checked`));
    const identityReferences = registration.rules
        .filter((rule) => /\bcand\.asset\b/.test(rule.fields.sourceBody ?? ""))
        .map((rule) => rule.fields.key ?? rule.positional.join("/"));
    checks.push(check("NO_IDENTITY_BODY", identityReferences.length === 0, identityReferences.length === 0 ? "no registered source body references cand.asset" : identityReferences.join(",")));
    const registrationBytes = record(registration, "REGISTRATION_BYTES");
    const canonicalRegistration = registration.text.split(/\r?\n/).filter((line) => !line.startsWith("REGISTRATION_BYTES|")) .join("\n") + (registration.text.endsWith("\n") ? "\n" : "");
    const expectedRegistrationBytes = registrationBytes?.fields.sha256;
    checks.push(check("REGISTRATION_BYTES", validSha(expectedRegistrationBytes) && expectedRegistrationBytes === sha256Bytes(canonicalRegistration), `canonicalSha=${sha256Bytes(canonicalRegistration)}`));
    const featureUsage = registration.rules.every((rule) => FEATURE_FIELDS.some((field) => (rule.fields.sourceBody ?? "").includes(field)));
    checks.push(check("V2_FIELD_USAGE", featureUsage, `${registration.rules.length} registered rules read at least one V2 field`));
    return checks;
}

function checkLogSafety(logText: string): V2CampaignAuditCheck[] {
    const checks: V2CampaignAuditCheck[] = [];
    const quarantinedAdvance = parseRecords(logText, "S3").some((record) => QUARANTINED_BATCHES.has(record.positional[0] ?? "") && record.fields.advanced === "yes");
    checks.push(check("NO_QUARANTINED_ADVANCE", !quarantinedAdvance, "B5/B6/B7 advanced records"));
    const ngValues: number[] = [];
    for (const line of logText.split(/\r?\n/)) {
        const record = parsePipeRecord(line);
        if (!record) continue;
        for (const name of ["NGStart", "NG", "N_G"]) {
            const value = record.fields[name];
            if (value !== undefined && /^\d+$/.test(value)) ngValues.push(Number(value));
        }
    }
    const monotonic = ngValues.every((value, index) => index === 0 || value >= ngValues[index - 1]!);
    checks.push(check("N_G_MONOTONIC", ngValues.length > 0 && ngValues[0] === 57 && monotonic, ngValues.join(",") || "missing N_G records"));
    return checks;
}

export function auditTmL2C1(options: V2CampaignAuditOptions = {}): V2CampaignAuditResult {
    const paths = resolvePaths(options);
    const registration = readRegistration(paths.registrationPath);
    const log = readCampaignLog(path.join(paths.miningDir, "idea-log.txt"));
    const checks = [
        ...checkFormatAndC6(log.text, registration, path.join(paths.miningDir, "tm-l2-c1", "FEATURE-SET.md")),
        ...checkRegistration(registration, paths.root),
        ...checkLogSafety(log.text),
    ];
    return { campaign: CAMPAIGN, checks, passed: checks.every((item) => item.passed) };
}

export function renderTmL2C1Audit(result: V2CampaignAuditResult): string {
    const lines = [`TOP_MEAN_V2_AUDIT|campaign=${result.campaign}|hashConvention=${CAMPAIGN_LOG_HASH_CONVENTION}|passed=${result.passed ? "yes" : "no"}`];
    for (const item of result.checks) lines.push(`${item.passed ? "PASS" : "FAIL"}|check=${item.name}|${item.detail}`);
    return lines.join("\n") + "\n";
}

export function runTopMeanV2CampaignAuditCli(argv: readonly string[]): number {
    const miningDir = argv[0];
    if (argv.length > 1 || !miningDir) {
        process.stderr.write("USAGE ERROR | expected [miningDir]\n");
        return 2;
    }
    const result = auditTmL2C1({ miningDir });
    process.stdout.write(renderTmL2C1Audit(result));
    return result.passed ? 0 : 1;
}

function isMainModule(): boolean {
    if (!process.argv[1]) return false;
    let modulePath = decodeURIComponent(new URL(import.meta.url).pathname);
    if (/^\/[A-Za-z]:/.test(modulePath)) modulePath = modulePath.slice(1);
    return path.resolve(modulePath).toLowerCase() === path.resolve(process.argv[1]).toLowerCase();
}

if (isMainModule()) process.exitCode = runTopMeanV2CampaignAuditCli(process.argv.slice(2));
