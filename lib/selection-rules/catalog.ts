import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { SelectionRulesCatalogEntry } from "./stream-types";

export const SELECTION_RULES_ARCHIVE_RELATIVE_ROOT = path.join("archive", "batch-open-score");
export const SELECTION_RULES_ARCHIVE_SCHEMA = "top_mean_archive.v3";

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

function isValidRunId(value: unknown): value is string {
    return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function parseCatalogMeta(value: unknown, folderName: string): SelectionRulesCatalogEntry | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const meta = value as Record<string, unknown>;
    if (meta.schema !== SELECTION_RULES_ARCHIVE_SCHEMA) return null;
    if (!isValidRunId(meta.runId) || meta.runId !== folderName) return null;
    if (typeof meta.completedAt !== "string" || !meta.completedAt.trim()) return null;
    if (typeof meta.interval !== "string" || !meta.interval.trim()) return null;
    if (!Array.isArray(meta.horizons) || meta.horizons.length === 0) return null;
    const horizons = meta.horizons.map((value) => value as number);
    if (horizons.some((value) => !Number.isInteger(value) || value <= 0)) return null;
    if (new Set(horizons).size !== horizons.length) return null;
    if (typeof meta.fingerprint !== "string" || !meta.fingerprint.trim()) return null;
    return {
        runId: meta.runId,
        completedAt: meta.completedAt,
        interval: meta.interval,
        horizons,
        fingerprint: meta.fingerprint,
    };
}

async function readEntryMeta(folderPath: string, folderName: string): Promise<SelectionRulesCatalogEntry | null> {
    try {
        const text = await readFile(path.join(folderPath, "meta.json"), "utf8");
        return parseCatalogMeta(JSON.parse(text) as unknown, folderName);
    } catch {
        return null;
    }
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
    folders.sort((left, right) => right.completedAt.localeCompare(left.completedAt) || left.runId.localeCompare(right.runId));
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
    const entry = await readEntryMeta(canonicalCandidate, path.basename(canonicalCandidate));
    return entry ? { entry, absolutePath: canonicalCandidate } : null;
}
