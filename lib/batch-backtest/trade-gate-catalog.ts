import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
    TRADE_LEDGER_SUPPORTED_FEATURE_VERSIONS,
    TRADE_LEDGER_SUPPORTED_VERSIONS,
    type TradeLedgerProvenance,
} from "./trade-ledger-schema";

export interface TradeGateFolderCatalogEntry {
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
    /** Most recent archived certification; only its EDGE-CANDIDATE rules are exposed. */
    latestCertification: TradeGateCertification | null;
}

export interface TradeGateRuleCatalogEntry {
    ruleId: string;
    ruleName: string;
    bytes: number;
    modifiedAt: number;
    sourceHash: string;
}

export interface TradeGateCertifiedRule {
    ruleId: string;
    ruleName: string;
    sourceHash: string;
    verdict: "EDGE-CANDIDATE";
    keptPct: number | null;
    isMeanPnlDeltaPp: number | null;
    holdoutMeanPnlDeltaPp: number | null;
    isMedianPnlDeltaPp: number | null;
    holdoutMedianPnlDeltaPp: number | null;
}

export interface TradeGateCertification {
    certificationId: string;
    modifiedAt: number;
    edgeRules: TradeGateCertifiedRule[];
}

export interface TradeGateCatalog {
    catalogRoot: string;
    folders: TradeGateFolderCatalogEntry[];
    rules: TradeGateRuleCatalogEntry[];
}

export interface TradeGateCatalogResponse extends TradeGateCatalog {
    ok: true;
    generatedAt: number;
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

async function discoverLatestCertification(folderPath: string): Promise<TradeGateCertification | null> {
    let entries: import("node:fs").Dirent[];
    try {
        entries = await readdir(path.join(folderPath, "sweeps"), { withFileTypes: true });
    } catch {
        return null;
    }
    const candidates: Array<{ archiveRecordId: string; summaryPath: string; modifiedAt: number }> = [];
    let nextEntry = 0;
    const inspectEntry = async (): Promise<void> => {
        while (nextEntry < entries.length) {
            const entry = entries[nextEntry++];
            if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
            const summaryPath = path.join(folderPath, "sweeps", entry.name, "summary.json");
            const summaryInfo = await fileBytes(summaryPath);
            if (summaryInfo) candidates.push({ archiveRecordId: entry.name, summaryPath, modifiedAt: summaryInfo.modifiedAt });
        }
    };
    await Promise.all(Array.from({ length: Math.min(16, entries.length) }, () => inspectEntry()));
    candidates.sort((a, b) => b.modifiedAt - a.modifiedAt || (a.archiveRecordId < b.archiveRecordId ? -1 : 1));

    // The newest completed summary is the only one needed. Stat all small
    // metadata files first, then parse newest-first so legacy records do not
    // all incur JSON reads on every catalog refresh.
    for (const candidate of candidates) {
        const summary = await readJson<Record<string, unknown>>(candidate.summaryPath);
        if (!summary) continue;
        const terminalPhase = summary?.terminalPhase;
        const isCompleted = terminalPhase !== undefined
            ? terminalPhase === "done" && (summary.complete === undefined || summary.complete === true)
            : summary.complete === true;
        if (!isCompleted || !Array.isArray(summary.results)) continue;
        const edgeRules = summary.results
            .filter((value): value is TradeGateCertifiedRule => Boolean(
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
        return { certificationId: candidate.archiveRecordId, modifiedAt: candidate.modifiedAt, edgeRules };
    }
    return null;
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
    if (!(TRADE_LEDGER_SUPPORTED_VERSIONS as readonly number[]).includes(args.ledgerVersion ?? -1)) return `unsupported ledger version ${String(args.ledgerVersion)}`;
    if (!(TRADE_LEDGER_SUPPORTED_FEATURE_VERSIONS as readonly number[]).includes(args.featureVersion ?? -1)) {
        return `unsupported feature version ${String(args.featureVersion)}`;
    }
    if (args.summary.ledgerComplete !== true || (certifiedNumber(args.summary.failedWrites) ?? 0) !== 0) {
        return "ledger is incomplete or has failed writes";
    }
    if (args.provenance.replay?.replayEligible !== true) return "replay is not eligible for this run config";
    return null;
}

async function discoverFolders(
    catalogRoot: string,
): Promise<TradeGateFolderCatalogEntry[]> {
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
    const folders: TradeGateFolderCatalogEntry[] = [];
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
        const latestCertification = await discoverLatestCertification(containedFolder);
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
            latestCertification,
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

async function discoverRules(rulesRoot: string): Promise<TradeGateRuleCatalogEntry[]> {
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
    const rules: TradeGateRuleCatalogEntry[] = [];
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

/** Discover safe ledger archives and trusted rules for Batch Trade Gate. */
export async function discoverTradeGateCatalog(serverRoot: string): Promise<TradeGateCatalog> {
    const catalogRoot = path.resolve(serverRoot, "archive", "mining-ledger");
    const rulesRoot = path.join(catalogRoot, "rules");
    const [folders, rules] = await Promise.all([
        discoverFolders(catalogRoot),
        discoverRules(rulesRoot),
    ]);
    return {
        catalogRoot: path.relative(path.resolve(serverRoot), catalogRoot).replace(/\\/g, "/"),
        folders,
        rules,
    };
}

/** Resolve an opaque folder id through fresh safe discovery at Run time. */
export async function resolveTradeGateFolder(
    serverRoot: string,
    folderId: string,
    catalogOverride?: TradeGateCatalog,
): Promise<{ entry: TradeGateFolderCatalogEntry; absolutePath: string } | null> {
    if (!folderId || folderId.includes("/") || folderId.includes("\\") || folderId === "." || folderId === "..") return null;
    const catalogRoot = path.resolve(serverRoot, "archive", "mining-ledger");
    const candidate = path.join(catalogRoot, folderId);
    const contained = await canonicalContained(catalogRoot, candidate);
    if (!contained || path.basename(contained) !== folderId) return null;
    const catalog = catalogOverride ?? await discoverTradeGateCatalog(serverRoot);
    const entry = catalog.folders.find((folder) => folder.folderId === folderId);
    return entry ? { entry, absolutePath: contained } : null;
}

/** Resolve one frozen rule id from a fresh safe catalog. */
export async function resolveTradeGateRule(
    serverRoot: string,
    ruleId: string,
    catalogOverride?: TradeGateCatalog,
): Promise<{ entry: TradeGateRuleCatalogEntry; absolutePath: string } | null> {
    if (!ruleId || ruleId.includes("/") || ruleId.includes("\\") || ruleId === "." || ruleId === "..") return null;
    const catalogRoot = path.resolve(serverRoot, "archive", "mining-ledger");
    const rulesRoot = path.join(catalogRoot, "rules");
    const filePath = path.join(rulesRoot, `${ruleId}.ts`);
    const contained = await canonicalContained(rulesRoot, filePath);
    if (!contained || path.basename(contained) !== `${ruleId}.ts`) return null;
    const catalog = catalogOverride ?? await discoverTradeGateCatalog(serverRoot);
    const entry = catalog.rules.find((rule) => rule.ruleId === ruleId);
    return entry ? { entry, absolutePath: contained } : null;
}
