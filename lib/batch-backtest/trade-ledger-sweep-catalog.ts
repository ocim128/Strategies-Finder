import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
    TRADE_LEDGER_FEATURE_VERSION,
    TRADE_LEDGER_VERSION,
    type TradeLedgerProvenance,
} from "./trade-ledger-schema";
import {
    resolveLedgerSweepPreflight,
    type LedgerSweepPreflightDecision,
} from "./trade-ledger-sweep-preflight";
import type { LedgerSweepRuleResult } from "./trade-ledger-sweep-stream-types";
import { isCompletedTradeLedgerSweepSummary } from "./trade-ledger-sweep-contract";

export interface LedgerSweepFolderCatalogEntry {
    folderId: string;
    name: string;
    startedAt: string | null;
    modifiedAt: number;
    ledgerBytes: number;
    rankBytes: number;
    rows: number | null;
    pairs: number | null;
    submittedPairs: number | null;
    loadedPairs: number | null;
    ledgerVersion: number | null;
    featureVersion: number | null;
    complete: boolean;
    replayEligible: boolean;
    runnable: boolean;
    refusalReason: string | null;
    preflight: LedgerSweepPreflightDecision | null;
    /** Most recent completed sweep; only its EDGE-CANDIDATE rules are exposed. */
    latestSweep: LedgerSweepLatestSweep | null;
}

export interface LedgerSweepRuleCatalogEntry {
    ruleId: string;
    ruleName: string;
    bytes: number;
    modifiedAt: number;
    sourceHash: string;
}

export type LedgerSweepEdgeRuleCatalogEntry = Pick<
    LedgerSweepRuleResult,
    | "ruleId"
    | "ruleName"
    | "sourceHash"
    | "keptPct"
    | "isMeanPnlDeltaPp"
    | "holdoutMeanPnlDeltaPp"
    | "isMedianPnlDeltaPp"
    | "holdoutMedianPnlDeltaPp"
> & { verdict: "EDGE-CANDIDATE" };

export interface LedgerSweepLatestSweep {
    sweepId: string;
    modifiedAt: number;
    edgeRules: LedgerSweepEdgeRuleCatalogEntry[];
}

export interface LedgerSweepCatalog {
    catalogRoot: string;
    folders: LedgerSweepFolderCatalogEntry[];
    rules: LedgerSweepRuleCatalogEntry[];
}

function isStrictChild(parent: string, child: string): boolean {
    const relative = path.relative(parent, child);
    return relative !== ""
        && !relative.startsWith(`..${path.sep}`)
        && relative !== ".."
        && !path.isAbsolute(relative);
}

async function canonicalContained(parent: string, candidate: string, canonicalParent?: string): Promise<string | null> {
    try {
        const resolvedParent = canonicalParent ?? await realpath(parent);
        const canonicalCandidate = await realpath(candidate);
        return isStrictChild(resolvedParent, canonicalCandidate) ? canonicalCandidate : null;
    } catch {
        return null;
    }
}

async function readJson<T>(filePath: string): Promise<T | null> {
    try {
        return JSON.parse(await readFile(filePath, "utf8")) as T;
    } catch {
        return null;
    }
}

async function fileBytes(filePath: string): Promise<{ bytes: number; modifiedAt: number } | null> {
    try {
        const info = await stat(filePath);
        return info.isFile() ? { bytes: info.size, modifiedAt: info.mtimeMs } : null;
    } catch {
        return null;
    }
}

async function discoverLatestSweep(folderPath: string): Promise<LedgerSweepLatestSweep | null> {
    let entries: import("node:fs").Dirent[];
    try {
        entries = await readdir(path.join(folderPath, "sweeps"), { withFileTypes: true });
    } catch {
        return null;
    }
    const candidates: LedgerSweepLatestSweep[] = [];
    for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const summaryPath = path.join(folderPath, "sweeps", entry.name, "summary.json");
        const summary = await readJson<Record<string, unknown>>(summaryPath);
        if (!summary || !isCompletedTradeLedgerSweepSummary(summary) || !Array.isArray(summary.results)) continue;
        const summaryInfo = await fileBytes(summaryPath);
        if (!summaryInfo) continue;
        const edgeRules = summary.results
            .filter((value): value is LedgerSweepRuleResult => Boolean(
                value
                && typeof value === "object"
                && (value as { verdict?: unknown }).verdict === "EDGE-CANDIDATE"
                && typeof (value as { ruleId?: unknown }).ruleId === "string"
                && typeof (value as { ruleName?: unknown }).ruleName === "string"
                && typeof (value as { sourceHash?: unknown }).sourceHash === "string",
            ))
            .map((value) => ({
                ruleId: value.ruleId,
                ruleName: value.ruleName,
                sourceHash: value.sourceHash,
                verdict: "EDGE-CANDIDATE" as const,
                keptPct: value.keptPct,
                isMeanPnlDeltaPp: value.isMeanPnlDeltaPp,
                holdoutMeanPnlDeltaPp: value.holdoutMeanPnlDeltaPp,
                isMedianPnlDeltaPp: value.isMedianPnlDeltaPp,
                holdoutMedianPnlDeltaPp: value.holdoutMedianPnlDeltaPp,
            }));
        candidates.push({ sweepId: entry.name, modifiedAt: summaryInfo.modifiedAt, edgeRules });
    }
    candidates.sort((a, b) => b.modifiedAt - a.modifiedAt || (a.sweepId < b.sweepId ? -1 : 1));
    return candidates[0] ?? null;
}

function certifiedNumber(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function refusalReason(args: {
    provenance: TradeLedgerProvenance | null;
    summary: Record<string, unknown> | null;
    ledgerVersion: number | null;
    featureVersion: number | null;
}): string | null {
    if (!args.provenance) return "provenance.json is missing or malformed";
    if (!args.summary) return "summary.json is missing or malformed";
    if (args.ledgerVersion !== TRADE_LEDGER_VERSION) return `unsupported ledger version ${String(args.ledgerVersion)}`;
    if (args.featureVersion !== TRADE_LEDGER_FEATURE_VERSION) return `unsupported feature version ${String(args.featureVersion)}`;
    if (args.summary.ledgerComplete !== true || (certifiedNumber(args.summary.failedWrites) ?? 0) !== 0) {
        return "ledger is incomplete or has failed writes";
    }
    if (args.provenance.replay?.replayEligible !== true) return "replay is not eligible for this run config";
    return null;
}

async function discoverFolders(
    catalogRoot: string,
    freeSystemMemoryBytes?: number,
): Promise<LedgerSweepFolderCatalogEntry[]> {
    let entries: import("node:fs").Dirent[];
    try {
        entries = await readdir(catalogRoot, { withFileTypes: true });
    } catch {
        return [];
    }
    let canonicalCatalogRoot: string;
    try {
        canonicalCatalogRoot = await realpath(catalogRoot);
    } catch {
        return [];
    }
    const folders: LedgerSweepFolderCatalogEntry[] = [];
    for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const folderId = entry.name;
        const folderPath = path.join(catalogRoot, folderId);
        const containedFolder = await canonicalContained(catalogRoot, folderPath, canonicalCatalogRoot);
        if (!containedFolder) continue;
        const ledger = await fileBytes(path.join(containedFolder, "ledger.jsonl"));
        if (!ledger) continue;
        const rank = await fileBytes(path.join(containedFolder, "signal-ranks.jsonl"));
        const provenance = await readJson<TradeLedgerProvenance>(path.join(containedFolder, "provenance.json"));
        const summary = await readJson<Record<string, unknown>>(path.join(containedFolder, "summary.json"));
        const totals = summary?.totals && typeof summary.totals === "object"
            ? summary.totals as Record<string, unknown>
            : null;
        const ledgerVersion = certifiedNumber(provenance?.ledgerVersion ?? summary?.ledgerVersion);
        const featureVersion = certifiedNumber(provenance?.featureVersion ?? summary?.featureVersion);
        const refusal = refusalReason({ provenance, summary, ledgerVersion, featureVersion });
        const latestSweep = await discoverLatestSweep(containedFolder);
        const rows = certifiedNumber(totals?.signals);
        const pairs = certifiedNumber(totals?.pairs);
        const modifiedAt = ledger.modifiedAt;
        folders.push({
            folderId,
            name: folderId,
            startedAt: typeof provenance?.startedAt === "string" ? provenance.startedAt : null,
            modifiedAt,
            ledgerBytes: ledger.bytes,
            rankBytes: rank?.bytes ?? 0,
            rows,
            pairs,
            submittedPairs: certifiedNumber(summary?.submittedPairs),
            loadedPairs: certifiedNumber(summary?.loadedPairs),
            ledgerVersion,
            featureVersion,
            complete: summary?.ledgerComplete === true && (certifiedNumber(summary.failedWrites) ?? 0) === 0,
            replayEligible: provenance?.replay?.replayEligible === true,
            runnable: refusal === null,
            refusalReason: refusal,
            preflight: refusal === null && rows !== null
                ? resolveLedgerSweepPreflight(rows, freeSystemMemoryBytes)
                : null,
            latestSweep,
        });
    }
    folders.sort((a, b) => {
        const aStarted = a.startedAt ? Date.parse(a.startedAt) : Number.NaN;
        const bStarted = b.startedAt ? Date.parse(b.startedAt) : Number.NaN;
        const aSort = Number.isFinite(aStarted) ? aStarted : a.modifiedAt;
        const bSort = Number.isFinite(bStarted) ? bStarted : b.modifiedAt;
        return bSort - aSort
            || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    });
    return folders;
}

async function discoverRules(rulesRoot: string): Promise<LedgerSweepRuleCatalogEntry[]> {
    let entries: import("node:fs").Dirent[];
    try {
        entries = await readdir(rulesRoot, { withFileTypes: true });
    } catch {
        return [];
    }
    let canonicalRulesRoot: string;
    try {
        canonicalRulesRoot = await realpath(rulesRoot);
    } catch {
        return [];
    }
    const rules: LedgerSweepRuleCatalogEntry[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
        if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".ts")) continue;
        const ruleId = entry.name.slice(0, -3);
        if (seen.has(ruleId)) throw new Error(`Duplicate rule id: ${ruleId}`);
        const filePath = path.join(rulesRoot, entry.name);
        const contained = await canonicalContained(rulesRoot, filePath, canonicalRulesRoot);
        if (!contained) continue;
        const info = await fileBytes(contained);
        if (!info) continue;
        const sourceHash = createHash("sha256").update(await readFile(contained)).digest("hex");
        seen.add(ruleId);
        rules.push({
            ruleId,
            ruleName: entry.name,
            bytes: info.bytes,
            modifiedAt: info.modifiedAt,
            sourceHash,
        });
    }
    rules.sort((a, b) => a.ruleName < b.ruleName ? -1 : a.ruleName > b.ruleName ? 1 : 0);
    return rules;
}

/** Discover only safe immediate ledger folders and regular trusted rules. */
export async function discoverLedgerSweepCatalog(
    serverRoot: string,
    options: { freeSystemMemoryBytes?: number } = {},
): Promise<LedgerSweepCatalog> {
    const catalogRoot = path.resolve(serverRoot, "archive", "mining-ledger");
    const rulesRoot = path.join(catalogRoot, "rules");
    const [folders, rules] = await Promise.all([
        discoverFolders(catalogRoot, options.freeSystemMemoryBytes),
        discoverRules(rulesRoot),
    ]);
    return {
        catalogRoot: path.relative(path.resolve(serverRoot), catalogRoot).replace(/\\/g, "/"),
        folders,
        rules,
    };
}

/** Resolve an opaque folder id through fresh safe discovery at Run time. */
export async function resolveLedgerSweepFolder(
    serverRoot: string,
    folderId: string,
    catalogOverride?: LedgerSweepCatalog,
): Promise<{ entry: LedgerSweepFolderCatalogEntry; absolutePath: string } | null> {
    if (!folderId || folderId.includes("/") || folderId.includes("\\") || folderId === "." || folderId === "..") return null;
    const catalogRoot = path.resolve(serverRoot, "archive", "mining-ledger");
    const candidate = path.join(catalogRoot, folderId);
    const contained = await canonicalContained(catalogRoot, candidate);
    if (!contained || path.basename(contained) !== folderId) return null;
    const catalog = catalogOverride ?? await discoverLedgerSweepCatalog(serverRoot);
    const entry = catalog.folders.find((folder) => folder.folderId === folderId);
    return entry ? { entry, absolutePath: contained } : null;
}

/** Resolve one frozen rule id from a fresh safe catalog. */
export async function resolveLedgerSweepRule(
    serverRoot: string,
    ruleId: string,
): Promise<{ entry: LedgerSweepRuleCatalogEntry; absolutePath: string } | null> {
    if (!ruleId || ruleId.includes("/") || ruleId.includes("\\") || ruleId === "." || ruleId === "..") return null;
    const catalogRoot = path.resolve(serverRoot, "archive", "mining-ledger");
    const rulesRoot = path.join(catalogRoot, "rules");
    const filePath = path.join(rulesRoot, `${ruleId}.ts`);
    const contained = await canonicalContained(rulesRoot, filePath);
    if (!contained || path.basename(contained) !== `${ruleId}.ts`) return null;
    const catalog = await discoverLedgerSweepCatalog(serverRoot);
    const entry = catalog.rules.find((rule) => rule.ruleId === ruleId);
    return entry ? { entry, absolutePath: contained } : null;
}
