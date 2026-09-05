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

function readJson(filename: string): Record<string, unknown> | null {
    try { return JSON.parse(readFileSync(filename, "utf8")) as Record<string, unknown>; } catch { return null; }
}

function record(registration: Registration, marker: string): CampaignPipeRecord | null {
    return registration.records.get(marker) ?? null;
}

function checkFormatAndC6(logText: string, _registration: Registration, featureContractPath: string): V2CampaignAuditCheck[] {
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
    const featureContractSha = fileSha(featureContractPath);
    const c6Passed = c6?.fields.campaign === CAMPAIGN
        && c6.fields.predecessor === "TM-L1-C1"
        && c6.fields.NGStart === "57"
        && c6.fields.NDsurfaceStart === "0"
        && featureContractSha !== null
        && c6.fields.featureContractSha256 === featureContractSha
        && c6.fields.humanApproved === "yes";
    checks.push(check("C6", c6Passed, c6Line ?? "missing C6"));
    return checks;
}

function checkL6Identity(logText: string, registration: Registration, root: string): V2CampaignAuditCheck {
    const l6Records = parseRecords(logText, "L6");
    const l6 = l6Records.length === 1 ? l6Records[0] : null;
    if (l6 === null) {
        return check("L6_IDENTITY", false, `${l6Records.length} L6 records; expected exactly one`);
    }
    const registrationMeta = record(registration, "REGISTRATION");
    const ledgerRunId = l6.fields.ledgerRunId;
    const ledgerDir = ledgerRunId ? path.join(root, "archive", "batch-open-score", ledgerRunId) : "";
    const meta = ledgerDir ? readJson(path.join(ledgerDir, "meta.json")) : null;
    const registrationRunId = registrationMeta?.fields.ledgerRunId;
    const expectedRunId = registrationRunId ?? (typeof meta?.runId === "string" ? meta.runId : undefined);
    const featurePath = path.join(ledgerDir, "candidate-features.jsonl");
    const featureSha = fileSha(featurePath);
    const featureRowCount = featureSha === null
        ? null
        : readFileSync(featurePath, "utf8").split(/\r?\n/).filter((line) => line.length > 0).length;
    const ledgerFingerprint = typeof meta?.postAssemblyFingerprint === "string"
        ? meta.postAssemblyFingerprint
        : typeof meta?.fingerprint === "string" ? meta.fingerprint : undefined;
    const passed = l6.fields.campaign === CAMPAIGN
        && l6.fields.humanApproved === "yes"
        && ledgerRunId !== undefined
        && ledgerRunId.length > 0
        && expectedRunId === ledgerRunId
        && meta?.runId === ledgerRunId
        && validSha(l6.fields.ledgerFingerprint)
        && ledgerFingerprint === l6.fields.ledgerFingerprint
        && validSha(l6.fields.featureFileSha256)
        && featureSha === l6.fields.featureFileSha256
        && l6.fields.featureRowCount !== undefined
        && Number(l6.fields.featureRowCount) === featureRowCount;
    return check(
        "L6_IDENTITY",
        passed,
        `records=${l6Records.length}|ledgerRunId=${ledgerRunId ?? "missing"}|registrationLedgerRunId=${registrationRunId ?? "derived-from-ledger"}|featureSha=${featureSha ?? "missing"}|featureRows=${featureRowCount ?? "missing"}`,
    );
}

interface RegisteredRuleBytes {
    valid: boolean;
    detail: string;
}

function registrationRuleDigest(recordValue: CampaignPipeRecord): string {
    const fields = recordValue.fields;
    return [
        `ordinal=${fields.ordinal ?? ""}`,
        `candidate=${fields.candidate ?? ""}`,
        `key=${fields.key ?? ""}`,
        `kind=${fields.kind ?? ""}`,
        `family=${fields.family ?? ""}`,
        `familyKey=${fields.familyKey ?? ""}`,
        `mechanism=${fields.mechanism ?? ""}`,
        `mechanismLineage=${fields.mechanismLineage ?? ""}`,
        `path=${fields.path ?? ""}`,
        `sourceBody=${fields.sourceBody ?? ""}`,
        `sha256=${fields.sha256 ?? ""}`,
    ].join("|");
}

function registrationDigest(records: readonly CampaignPipeRecord[]): string {
    return sha256Bytes(records.map(registrationRuleDigest).join("\n") + "\n");
}

function registrationBatch(recordValue: CampaignPipeRecord): string | null {
    return recordValue.fields.batchLabel
        ?? recordValue.fields.batch
        ?? recordValue.positional.find((value) => /^L2[DV]\d+$/.test(value))
        ?? null;
}

function resolveRegisteredRulePath(root: string, rulePath: string): string {
    if (path.isAbsolute(rulePath)) return rulePath;
    const normalized = rulePath.replaceAll("\\", "/");
    const archivePrefix = "archive/top-mean-mining/";
    if (normalized.startsWith(archivePrefix)) return path.join(root, normalized);
    return path.join(root, "archive", "top-mean-mining", normalized);
}

function checkRegisteredRuleBytes(root: string, rule: CampaignPipeRecord, registrationDir?: string): RegisteredRuleBytes {
    const sourceBody = rule.fields.sourceBody;
    const rulePath = rule.fields.path;
    const expectedSha = rule.fields.sha256;
    if (!sourceBody || !rulePath || !validSha(expectedSha)) return { valid: false, detail: `incomplete registration fields for ${rule.fields.key ?? "unknown"}` };
    const normalizedRulePath = rulePath.replaceAll("\\", "/");
    let filename = registrationDir
        ? path.join(registrationDir, normalizedRulePath)
        : resolveRegisteredRulePath(root, rulePath);
    if (!existsSync(filename)) filename = resolveRegisteredRulePath(root, rulePath);
    if (!existsSync(filename) && rulePath.replaceAll("\\", "/").startsWith("rules/")) {
        filename = path.join(root, "archive", "top-mean-mining", "tm-l2-c1", normalizedRulePath);
    }
    if (!existsSync(filename)) return { valid: false, detail: `missing rule file ${rulePath}` };
    const bytes = readFileSync(filename);
    const source = bytes.toString("utf8");
    if (sha256Bytes(bytes) !== expectedSha) return { valid: false, detail: `SHA mismatch for ${rule.fields.key ?? rulePath}` };
    if (source !== sourceBody + "\n") return { valid: false, detail: `source body mismatch for ${rule.fields.key ?? rulePath}` };
    return { valid: true, detail: `rule file matches ${rule.fields.key ?? rulePath}` };
}

function hasOrderedOrdinals(records: readonly CampaignPipeRecord[], count: number): boolean {
    return records.length === count && records.every((item, index) => item.fields.ordinal === String(index + 1));
}

function matchingScreenRecord(records: readonly CampaignPipeRecord[], rule: CampaignPipeRecord): CampaignPipeRecord | null {
    const candidate = rule.fields.candidate;
    return records.find((item) => item.fields.candidate === candidate
        && item.fields.key === rule.fields.key
        && item.fields.kind === rule.fields.kind
        && item.fields.family === rule.fields.family
        && item.fields.sha256 === rule.fields.sha256) ?? null;
}

function changedCount(value: string | undefined): { changed: number; total: number } | null {
    const match = value?.match(/^(\d+)\/(\d+)$/);
    if (!match) return null;
    return { changed: Number(match[1]), total: Number(match[2]) };
}

function skippedL2D1Checks(): V2CampaignAuditCheck[] {
    return [
        "L2D1_REGISTRATION",
        "L2D1_POOL_COUNT",
        "L2D1_FINAL_COUNT",
        "L2D1_C5_COMPOSITION",
        "L2D1_POOL_BYTES",
        "L2D1_FINAL_BYTES",
        "L2D1_V2_FIELD_USAGE",
        "L2D1_ADMISSION_GATE",
        "L2D1_DIGESTS",
    ].map((name) => check(name, true, "skipped: L2D1-REGISTRATION.md does not exist"));
}

function checkL2D1Registration(logText: string, root: string, registrationPath: string): V2CampaignAuditCheck[] {
    if (!existsSync(registrationPath)) return skippedL2D1Checks();
    const registrationText = readFileSync(registrationPath, "utf8");
    const headers = parseRecords(registrationText, "REGISTRATION");
    const pool = parseRecords(registrationText, "POOL");
    const finalists = parseRecords(registrationText, "FINAL");
    const header = headers.length === 1 ? headers[0] : null;
    const headerPassed = header !== null
        && (header.fields.schema === "top_mean_campaign_registration.v1" || header.fields.schema === "top_mean_v2_campaign_registration.v1")
        && (header.fields.campaign === undefined || header.fields.campaign === CAMPAIGN)
        && (header.fields.batchLabel ?? header.fields.batch) === "L2D1"
        && header.fields.outcomeOrdinal === "1"
        && header.fields.humanApproved === "yes";
    const poolCountPassed = hasOrderedOrdinals(pool, 30)
        && new Set(pool.map((item) => item.fields.candidate)).size === 30;
    const finalCountPassed = hasOrderedOrdinals(finalists, 10)
        && new Set(finalists.map((item) => item.fields.candidate)).size === 10
        && finalists.every((item) => pool.some((candidate) => registrationRuleDigest(candidate) === registrationRuleDigest(item)));
    const finalFamilies = new Map<string, number>();
    for (const item of finalists) {
        const family = item.fields.familyKey ?? "";
        finalFamilies.set(family, (finalFamilies.get(family) ?? 0) + 1);
    }
    const c5Passed = finalFamilies.size >= 6
        && !finalFamilies.has("")
        && [...finalFamilies.values()].every((count) => count <= 2);
    const registrationDir = path.dirname(registrationPath);
    const poolBytes = pool.map((item) => checkRegisteredRuleBytes(root, item, registrationDir));
    const finalBytes = finalists.map((item) => checkRegisteredRuleBytes(root, item, registrationDir));
    const poolBytesPassed = poolBytes.length === 30 && poolBytes.every((item) => item.valid);
    const finalBytesPassed = finalBytes.length === 10 && finalBytes.every((item) => item.valid);
    const allRules = [...pool, ...finalists];
    const v2UsagePassed = allRules.length === 40
        && allRules.every((item) => FEATURE_FIELDS.some((field) => (item.fields.sourceBody ?? "").includes(field)));
    const screenRecords = parseRecords(logText, "S3").filter((item) => registrationBatch(item) === "L2D1"
        && (item.fields.campaign === undefined || item.fields.campaign === CAMPAIGN));
    const admissionResults = pool.map((item) => {
        const screen = matchingScreenRecord(screenRecords, item);
        const changed = changedCount(screen?.fields.changed);
        const threshold = changed === null ? Number.POSITIVE_INFINITY : Math.max(60, Math.ceil(changed.total * 0.10));
        const passed = screen !== null
            && changed !== null
            && changed.changed >= threshold
            && (screen.fields.advanced === undefined || screen.fields.advanced === "yes")
            && (screen.fields.impact === undefined || screen.fields.impact !== "ZERO");
        return { passed, screen, changed, threshold };
    });
    const admissionPassed = admissionResults.length === 30 && admissionResults.every((item) => item.passed);
    const registeredF4 = parseRecords(registrationText, "F4").filter((item) => registrationBatch(item) === "L2D1");
    const loggedF4 = parseRecords(logText, "F4").filter((item) => registrationBatch(item) === "L2D1"
        && (item.fields.campaign === undefined || item.fields.campaign === CAMPAIGN));
    const f4 = registeredF4.at(-1) ?? loggedF4.at(-1) ?? null;
    const poolDigest = registrationDigest(pool);
    const finalDigest = registrationDigest(finalists);
    const headerDigestPassed = header !== null
        && (header.fields.poolDigest === undefined || header.fields.poolDigest === poolDigest)
        && (header.fields.finalDigest === undefined || header.fields.finalDigest === finalDigest);
    const f4Passed = f4 !== null
        && f4.fields.outcomeOrdinal === "1"
        && f4.fields.poolCount === "30"
        && f4.fields.finalCount === "10"
        && f4.fields.poolDigest === poolDigest
        && f4.fields.finalDigest === finalDigest
        && f4.fields.audit === "PASS"
        && f4.fields.humanApproved === "yes";
    const allF4Agree = [...registeredF4, ...loggedF4].every((item) => item.fields.poolDigest === poolDigest
        && item.fields.finalDigest === finalDigest
        && item.fields.poolCount === "30"
        && item.fields.finalCount === "10");
    return [
        check("L2D1_REGISTRATION", headerPassed, `${headers.length} v1 schema header(s); campaign=${header?.fields.campaign ?? "missing"}; batch=${header?.fields.batchLabel ?? header?.fields.batch ?? "missing"}`),
        check("L2D1_POOL_COUNT", poolCountPassed, `${pool.length}/30 ordered unique POOL records`),
        check("L2D1_FINAL_COUNT", finalCountPassed, `${finalists.length}/10 ordered FINAL records`),
        check("L2D1_C5_COMPOSITION", c5Passed, `${finalFamilies.size} distinct familyKeys; maxFamily=${Math.max(0, ...finalFamilies.values())}`),
        check("L2D1_POOL_BYTES", poolBytesPassed, poolBytes.find((item) => !item.valid)?.detail ?? "30 POOL rule files match registered source bytes"),
        check("L2D1_FINAL_BYTES", finalBytesPassed, finalBytes.find((item) => !item.valid)?.detail ?? "10 FINAL rule files match registered source bytes"),
        check("L2D1_V2_FIELD_USAGE", v2UsagePassed, `${allRules.filter((item) => FEATURE_FIELDS.some((field) => (item.fields.sourceBody ?? "").includes(field))).length}/40 registered rules read a V2 field`),
        check("L2D1_ADMISSION_GATE", admissionPassed, `${admissionResults.filter((item) => item.passed).length}/30 POOL records meet changed >= max(60, 10% of base events)`),
        check("L2D1_DIGESTS", headerDigestPassed && f4Passed && allF4Agree, `poolDigest=${poolDigest}|finalDigest=${finalDigest}|registrationF4=${registeredF4.length}|loggedF4=${loggedF4.length}`),
    ];
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
        checkL6Identity(log.text, registration, paths.root),
        ...checkRegistration(registration, paths.root),
        ...checkL2D1Registration(log.text, paths.root, path.join(paths.miningDir, "tm-l2-c1", "L2D1-REGISTRATION.md")),
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
