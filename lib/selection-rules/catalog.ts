import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { SelectionRulesCatalogEntry } from "./stream-types";

export const SELECTION_RULES_ARCHIVE_RELATIVE_ROOT = path.join("archive", "mining-ledger");
export const SELECTION_RULES_LEDGER_VERSION = 3;
export const SELECTION_RULES_FEATURE_VERSION = 3;

export type SelectionRulesCatalogSkipReason =
    | "missing_or_malformed_metadata"
    | "unsupported_version"
    | "not_replay_eligible"
    | "incomplete_ledger"
    | "invalid_totals"
    | "invalid_metadata"
    | "unsafe_or_unreadable_folder";

export interface SelectionRulesCatalogSkippedFolder {
    folderId: string;
    reason: SelectionRulesCatalogSkipReason;
}

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

async function inspectEntryMeta(
    folderPath: string,
    folderId: string,
): Promise<{ entry: SelectionRulesCatalogEntry | null; reason?: SelectionRulesCatalogSkipReason }> {
    const [provenance, summary] = await Promise.all([
        readJson(path.join(folderPath, "provenance.json")),
        readJson(path.join(folderPath, "summary.json")),
    ]);
    if (!provenance || !summary) return { entry: null, reason: "missing_or_malformed_metadata" };
    if (provenance.ledgerVersion !== SELECTION_RULES_LEDGER_VERSION
        || provenance.featureVersion !== SELECTION_RULES_FEATURE_VERSION) {
        return { entry: null, reason: "unsupported_version" };
    }
    const replay = provenance.replay;
    if (!replay || typeof replay !== "object" || Array.isArray(replay) || (replay as Record<string, unknown>).replayEligible !== true) {
        return { entry: null, reason: "not_replay_eligible" };
    }
    if (summary.ledgerComplete !== true) return { entry: null, reason: "incomplete_ledger" };
    const totals = summary.totals;
    if (!totals || typeof totals !== "object" || Array.isArray(totals)) return { entry: null, reason: "invalid_totals" };
    const totalsRecord = totals as Record<string, unknown>;
    if (!nonNegativeInteger(totalsRecord.signals) || !nonNegativeInteger(totalsRecord.pairs)) {
        return { entry: null, reason: "invalid_totals" };
    }
    if (!isValidFolderId(folderId)
        || !nonEmptyString(provenance.runId)
        || !nonEmptyString(provenance.startedAt)
        || !nonEmptyString(summary.finishedAt)
        || !nonEmptyString(provenance.interval)
        || !nonEmptyString(provenance.strategyKey)
        || !positiveIntegers(provenance.ledgerHorizons)) {
        return { entry: null, reason: "invalid_metadata" };
    }
    return {
        entry: {
            folderId,
            runId: provenance.runId,
            startedAt: provenance.startedAt,
            finishedAt: summary.finishedAt,
            interval: provenance.interval,
            strategyKey: provenance.strategyKey,
            ledgerHorizons: [...provenance.ledgerHorizons],
            totals: { signals: totalsRecord.signals, pairs: totalsRecord.pairs },
        },
    };
}

async function readEntryMeta(folderPath: string, folderId: string): Promise<SelectionRulesCatalogEntry | null> {
    return (await inspectEntryMeta(folderPath, folderId)).entry;
}

export async function discoverSelectionRulesCatalog(serverRoot: string): Promise<{
    catalogRoot: string;
    folders: SelectionRulesCatalogEntry[];
    skippedFolders: SelectionRulesCatalogSkippedFolder[];
}> {
    const requestedRoot = catalogRootFor(serverRoot);
    let canonicalRoot: string;
    try {
        canonicalRoot = await realpath(requestedRoot);
    } catch {
        return { catalogRoot: requestedRoot, folders: [], skippedFolders: [] };
    }

    let entries;
    try {
        entries = await readdir(canonicalRoot, { withFileTypes: true });
    } catch {
        return { catalogRoot: canonicalRoot, folders: [], skippedFolders: [] };
    }

    const candidates = entries.filter((entry) => entry.isDirectory() || entry.isSymbolicLink());
    const inspections: Array<{
        entry: SelectionRulesCatalogEntry | null;
        skipped: SelectionRulesCatalogSkippedFolder | null;
    }> = new Array(candidates.length);
    let cursor = 0;
    async function inspectNext(): Promise<void> {
        while (true) {
            const index = cursor++;
            if (index >= candidates.length) return;
            const entry = candidates[index]!;
            const candidate = path.join(canonicalRoot, entry.name);
            try {
                const canonicalCandidate = await realpath(candidate);
                const candidateStat = await stat(canonicalCandidate);
                if (!candidateStat.isDirectory() || !isStrictChild(canonicalRoot, canonicalCandidate)) {
                    inspections[index] = {
                        entry: null,
                        skipped: { folderId: entry.name, reason: "unsafe_or_unreadable_folder" },
                    };
                    continue;
                }
                const inspected = await inspectEntryMeta(canonicalCandidate, entry.name);
                inspections[index] = {
                    entry: inspected.entry,
                    skipped: inspected.entry ? null : { folderId: entry.name, reason: inspected.reason ?? "invalid_metadata" },
                };
            } catch {
                inspections[index] = {
                    entry: null,
                    skipped: { folderId: entry.name, reason: "unsafe_or_unreadable_folder" },
                };
            }
        }
    }
    const workerCount = Math.min(16, Math.max(1, candidates.length));
    await Promise.all(Array.from({ length: workerCount }, () => inspectNext()));

    const folders: SelectionRulesCatalogEntry[] = [];
    const skippedFolders: SelectionRulesCatalogSkippedFolder[] = [];
    for (const inspection of inspections) {
        if (inspection.entry) folders.push(inspection.entry);
        else if (inspection.skipped) skippedFolders.push(inspection.skipped);
    }
    folders.sort((left, right) => right.finishedAt.localeCompare(left.finishedAt) || left.folderId.localeCompare(right.folderId));
    skippedFolders.sort((left, right) => left.folderId.localeCompare(right.folderId));
    return { catalogRoot: canonicalRoot, folders, skippedFolders };
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
