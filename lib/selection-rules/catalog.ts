import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { SelectionRulesCatalogEntry } from "./stream-types";

export const SELECTION_RULES_ARCHIVE_RELATIVE_ROOT = path.join("archive", "mining-ledger");
export const SELECTION_RULES_LEDGER_VERSION = 3;
export const SELECTION_RULES_FEATURE_VERSION = 3;

function isStrictChild(parent: string, child: string): boolean {
    const relative = path.relative(parent, child);
    return relative !== ""
        && relative !== ".."
        && !relative.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relative);
}

function catalogRootFor(serverRoot: string): string {
    return path.resolve(serverRoot, SELECTION_RULES_ARCHIVE_RELATIVE_ROOT);
}

function isValidFolderId(value: unknown): value is string {
    return typeof value === "string"
        && value.length > 0
        && value !== "."
        && value !== ".."
        && !value.includes("/")
        && !value.includes("\\");
}

function nonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

function positiveIntegers(value: unknown): value is number[] {
    return Array.isArray(value)
        && value.length > 0
        && value.every((item) => typeof item === "number" && Number.isInteger(item) && item > 0)
        && new Set(value).size === value.length;
}

function nonNegativeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

async function readJson(filePath: string): Promise<Record<string, unknown> | null> {
    try {
        const value = JSON.parse(await readFile(filePath, "utf8")) as unknown;
        return value && typeof value === "object" && !Array.isArray(value)
            ? value as Record<string, unknown>
            : null;
    } catch {
        return null;
    }
}

async function readEntryMeta(folderPath: string, folderId: string): Promise<SelectionRulesCatalogEntry | null> {
    const provenance = await readJson(path.join(folderPath, "provenance.json"));
    const summary = await readJson(path.join(folderPath, "summary.json"));
    if (!provenance || !summary) return null;
    if (provenance.ledgerVersion !== SELECTION_RULES_LEDGER_VERSION) return null;
    if (provenance.featureVersion !== SELECTION_RULES_FEATURE_VERSION) return null;
    const replay = provenance.replay;
    if (!replay || typeof replay !== "object" || Array.isArray(replay) || (replay as Record<string, unknown>).replayEligible !== true) return null;
    if (summary.ledgerComplete !== true) return null;
    const totals = summary.totals;
    if (!totals || typeof totals !== "object" || Array.isArray(totals)) return null;
    const totalsRecord = totals as Record<string, unknown>;
    if (!nonNegativeInteger(totalsRecord.signals) || !nonNegativeInteger(totalsRecord.pairs)) return null;
    if (!isValidFolderId(folderId)
        || !nonEmptyString(provenance.runId)
        || !nonEmptyString(provenance.startedAt)
        || !nonEmptyString(summary.finishedAt)
        || !nonEmptyString(provenance.interval)
        || !nonEmptyString(provenance.strategyKey)
        || !positiveIntegers(provenance.ledgerHorizons)) {
        return null;
    }
    return {
        folderId,
        runId: provenance.runId,
        startedAt: provenance.startedAt,
        finishedAt: summary.finishedAt,
        interval: provenance.interval,
        strategyKey: provenance.strategyKey,
        ledgerHorizons: [...provenance.ledgerHorizons],
        totals: { signals: totalsRecord.signals, pairs: totalsRecord.pairs },
    };
}

export async function discoverSelectionRulesCatalog(serverRoot: string): Promise<{
    catalogRoot: string;
    folders: SelectionRulesCatalogEntry[];
}> {
    const requestedRoot = catalogRootFor(serverRoot);
    let canonicalRoot: string;
    try {
        canonicalRoot = await realpath(requestedRoot);
    } catch {
        return { catalogRoot: requestedRoot, folders: [] };
    }

    let entries;
    try {
        entries = await readdir(canonicalRoot, { withFileTypes: true });
    } catch {
        return { catalogRoot: canonicalRoot, folders: [] };
    }

    const folders: SelectionRulesCatalogEntry[] = [];
    for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const candidate = path.join(canonicalRoot, entry.name);
        let canonicalCandidate: string;
        try {
            canonicalCandidate = await realpath(candidate);
            const candidateStat = await stat(canonicalCandidate);
            if (!candidateStat.isDirectory() || !isStrictChild(canonicalRoot, canonicalCandidate)) continue;
        } catch {
            continue;
        }
        const meta = await readEntryMeta(canonicalCandidate, entry.name);
        if (meta) folders.push(meta);
    }
    folders.sort((left, right) => right.finishedAt.localeCompare(left.finishedAt) || left.folderId.localeCompare(right.folderId));
    return { catalogRoot: canonicalRoot, folders };
}

/** Resolve a catalog-relative folder and repeat the containment/meta checks. */
export async function resolveSelectionRulesFolder(
    serverRoot: string,
    folderPath: string,
): Promise<{ entry: SelectionRulesCatalogEntry; absolutePath: string } | null> {
    if (typeof folderPath !== "string" || !folderPath.trim()) return null;
    const requestedRoot = catalogRootFor(serverRoot);
    let canonicalRoot: string;
    try {
        canonicalRoot = await realpath(requestedRoot);
    } catch {
        return null;
    }
    const candidate = path.resolve(canonicalRoot, folderPath);
    let canonicalCandidate: string;
    try {
        canonicalCandidate = await realpath(candidate);
        const candidateStat = await stat(canonicalCandidate);
        if (!candidateStat.isDirectory() || !isStrictChild(canonicalRoot, canonicalCandidate)) return null;
    } catch {
        return null;
    }
    const folderId = path.basename(canonicalCandidate);
    const entry = await readEntryMeta(canonicalCandidate, folderId);
    return entry ? { entry, absolutePath: canonicalCandidate } : null;
}
