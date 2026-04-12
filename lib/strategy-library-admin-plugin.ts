import type { IncomingMessage } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Plugin, ViteDevServer } from "vite";
import { generateStrategyManifestSource, type StrategyModuleDefinition } from "../scripts/strategy-manifest-generator";
import { DEFAULT_BUILT_IN_STRATEGY_KEY } from "./strategy-defaults";

const STRATEGY_EXPORT_PATTERN = /export\s+const\s+([a-zA-Z][a-zA-Z0-9_]*)\s*:\s*Strategy\s*=/g;
const MANIFEST_KEY_PATTERN = /key:\s*"([^"]+)"/g;
const VALID_STRATEGY_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;
const STRATEGY_NAME_PATTERN = /\bname\s*:\s*(['"`])(.+?)\1/;

class StrategyLibraryAdminError extends Error {
    public readonly status: number;

    constructor(message: string, status = 400) {
        super(message);
        this.name = "StrategyLibraryAdminError";
        this.status = status;
    }
}

export interface DeleteBuiltInStrategyResult {
    key: string;
    sourcePath: string;
    sourceRelativePath: string;
    backupPath: string;
    backupRelativePath: string;
    manifestPath: string;
    manifestStrategyCount: number;
}

export interface DeleteBuiltInStrategyBatchItemResult {
    key: string;
    sourcePath: string;
    sourceRelativePath: string;
    backupPath: string;
    backupRelativePath: string;
}

export interface DeleteBuiltInStrategiesBatchResult {
    deleted: DeleteBuiltInStrategyBatchItemResult[];
    manifestPath: string;
    manifestStrategyCount: number;
}

function normalizeLineEndings(value: string): string {
    return value.replace(/\r\n/g, "\n");
}

function getStrategyLibraryPaths(repoRoot: string) {
    return {
        repoRoot,
        strategyRootDir: path.resolve(repoRoot, "lib", "strategies"),
        strategyLibDir: path.resolve(repoRoot, "lib", "strategies", "lib"),
        manifestPath: path.resolve(repoRoot, "lib", "strategies", "manifest.ts"),
        archiveDir: path.resolve(repoRoot, "archive", "strategy"),
    };
}

function assertPathWithin(baseDir: string, targetPath: string, label: string): void {
    const relative = path.relative(baseDir, targetPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new StrategyLibraryAdminError(`${label} resolved outside ${baseDir}`, 500);
    }
}

function readCurrentManifestOrder(manifestPath: string): string[] {
    if (!existsSync(manifestPath)) {
        return [];
    }

    const source = normalizeLineEndings(readFileSync(manifestPath, "utf8"));
    const keys: string[] = [];
    let match: RegExpExecArray | null;

    while ((match = MANIFEST_KEY_PATTERN.exec(source)) !== null) {
        keys.push(match[1]);
    }

    return keys;
}

function extractStrategyExportName(source: string, fileName: string): string | null {
    const matches = [...source.matchAll(STRATEGY_EXPORT_PATTERN)];
    if (matches.length === 0) {
        return null;
    }
    if (matches.length > 1) {
        throw new StrategyLibraryAdminError(
            `Expected exactly one Strategy export in ${fileName}, found ${matches.length}.`,
            500
        );
    }

    return matches[0][1];
}

function extractStrategyDisplayName(source: string): string | null {
    const match = STRATEGY_NAME_PATTERN.exec(source);
    if (!match) {
        return null;
    }

    const value = match[2]?.trim();
    return value ? value : null;
}

export function collectStrategyModuleDefinitionsForRepo(repoRoot: string): StrategyModuleDefinition[] {
    const paths = getStrategyLibraryPaths(repoRoot);
    if (!existsSync(paths.strategyLibDir)) {
        return [];
    }

    const existingOrder = readCurrentManifestOrder(paths.manifestPath);
    const existingRank = new Map(existingOrder.map((key, index) => [key, index]));
    const strategyFiles = readdirSync(paths.strategyLibDir)
        .filter((fileName) => fileName.endsWith(".ts"))
        .sort((left, right) => left.localeCompare(right));

    const definitions: StrategyModuleDefinition[] = [];
    for (const fileName of strategyFiles) {
        const source = readFileSync(path.join(paths.strategyLibDir, fileName), "utf8");
        const exportName = extractStrategyExportName(source, fileName);
        if (!exportName) {
            continue;
        }

        if (!VALID_STRATEGY_KEY_PATTERN.test(exportName)) {
            throw new StrategyLibraryAdminError(
                `Strategy export "${exportName}" in ${fileName} is not a valid strategy key.`,
                500
            );
        }

        definitions.push({
            key: exportName,
            exportName,
            importPath: `./lib/${fileName.replace(/\.ts$/, "")}`,
        });
    }

    definitions.sort((left, right) => {
        const leftRank = existingRank.get(left.key);
        const rightRank = existingRank.get(right.key);

        if (leftRank !== undefined && rightRank !== undefined) {
            return leftRank - rightRank;
        }
        if (leftRank !== undefined) {
            return -1;
        }
        if (rightRank !== undefined) {
            return 1;
        }

        return left.key.localeCompare(right.key);
    });

    return definitions;
}

export function syncStrategyManifestForRepo(repoRoot: string): { path: string; count: number } {
    const paths = getStrategyLibraryPaths(repoRoot);
    const definitions = collectStrategyModuleDefinitionsForRepo(repoRoot);
    mkdirSync(path.dirname(paths.manifestPath), { recursive: true });
    writeFileSync(paths.manifestPath, generateStrategyManifestSource(definitions), "utf8");
    return {
        path: paths.manifestPath,
        count: definitions.length,
    };
}

function formatBackupTimestamp(date: Date): string {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");
    const hours = String(date.getUTCHours()).padStart(2, "0");
    const minutes = String(date.getUTCMinutes()).padStart(2, "0");
    const seconds = String(date.getUTCSeconds()).padStart(2, "0");
    return `${year}${month}${day}T${hours}${minutes}${seconds}Z`;
}

function createUniqueBackupPath(archiveDir: string, fileName: string, date: Date): string {
    const parsed = path.parse(fileName);
    const timestamp = formatBackupTimestamp(date);
    let attempt = 0;

    while (true) {
        const suffix = attempt === 0 ? "" : `__${attempt}`;
        const candidate = path.join(
            archiveDir,
            `${parsed.name}__${timestamp}${suffix}${parsed.ext}`
        );
        if (!existsSync(candidate)) {
            return candidate;
        }
        attempt++;
    }
}

interface PendingStrategyDeletion {
    key: string;
    sourcePath: string;
    sourceRelativePath: string;
    sourceContents: string;
    backupPath: string;
    backupRelativePath: string;
}

interface StrategyDeleteLookup {
    definitionsByKey: Map<string, StrategyModuleDefinition>;
    aliasToKey: Map<string, string>;
    ambiguousAliases: Set<string>;
}

function resolveStrategySourcePath(repoRoot: string, definition: StrategyModuleDefinition): string {
    const paths = getStrategyLibraryPaths(repoRoot);
    const relativeImportPath = definition.importPath.replace(/^\.\//, "");
    const sourcePath = path.resolve(paths.strategyRootDir, `${relativeImportPath}.ts`);
    assertPathWithin(paths.strategyLibDir, sourcePath, "Strategy source path");
    return sourcePath;
}

function normalizeStrategyKeyAlias(value: string): string {
    const trimmed = value.trim().replace(/^["'`]+|["'`]+$/g, "");
    if (!trimmed) {
        return "";
    }

    const fileLikeValue = trimmed.replace(/\\/g, "/").split("/").pop() ?? trimmed;
    const withoutExtension = fileLikeValue.replace(/\.ts$/i, "");
    return withoutExtension
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "");
}

function registerStrategyDeleteAlias(
    aliasToKey: Map<string, string>,
    ambiguousAliases: Set<string>,
    alias: string,
    strategyKey: string,
): void {
    const normalizedAlias = normalizeStrategyKeyAlias(alias);
    if (!normalizedAlias || ambiguousAliases.has(normalizedAlias)) {
        return;
    }

    const existing = aliasToKey.get(normalizedAlias);
    if (existing && existing !== strategyKey) {
        aliasToKey.delete(normalizedAlias);
        ambiguousAliases.add(normalizedAlias);
        return;
    }

    aliasToKey.set(normalizedAlias, strategyKey);
}

function createStrategyDeleteLookup(repoRoot: string): StrategyDeleteLookup {
    const definitions = collectStrategyModuleDefinitionsForRepo(repoRoot);
    const definitionsByKey = new Map<string, StrategyModuleDefinition>();
    const aliasToKey = new Map<string, string>();
    const ambiguousAliases = new Set<string>();

    for (const definition of definitions) {
        definitionsByKey.set(definition.key, definition);

        const importBaseName = path.posix.basename(definition.importPath);
        const sourcePath = resolveStrategySourcePath(repoRoot, definition);
        const source = existsSync(sourcePath) ? readFileSync(sourcePath, "utf8") : "";
        const strategyDisplayName = source ? extractStrategyDisplayName(source) : null;
        const aliases = [
            definition.key,
            definition.exportName,
            importBaseName,
            `${importBaseName}.ts`,
            definition.key.replace(/_/g, "-"),
            definition.key.replace(/_/g, " "),
            strategyDisplayName,
        ].filter((alias): alias is string => typeof alias === "string" && alias.length > 0);

        for (const alias of aliases) {
            registerStrategyDeleteAlias(aliasToKey, ambiguousAliases, alias, definition.key);
        }
    }

    return {
        definitionsByKey,
        aliasToKey,
        ambiguousAliases,
    };
}

function resolveRequestedStrategyKey(rawKey: string, lookup: StrategyDeleteLookup): string {
    const normalizedAlias = normalizeStrategyKeyAlias(rawKey);
    if (!normalizedAlias) {
        throw new StrategyLibraryAdminError("Provide at least one built-in strategy key.");
    }

    if (lookup.ambiguousAliases.has(normalizedAlias)) {
        throw new StrategyLibraryAdminError(
            `"${rawKey.trim()}" matches multiple built-in strategies. Use the exact manifest key.`,
        );
    }

    const resolved = lookup.aliasToKey.get(normalizedAlias);
    if (!resolved) {
        throw new StrategyLibraryAdminError(`"${rawKey.trim()}" is not a valid strategy key.`);
    }

    return resolved;
}

function normalizeStrategyDeleteKeys(
    rawKeys: readonly string[],
    lookup: StrategyDeleteLookup,
): string[] {
    const normalized: string[] = [];
    const seen = new Set<string>();

    for (const rawKey of rawKeys) {
        const key = resolveRequestedStrategyKey(rawKey, lookup);
        if (!key || seen.has(key)) {
            continue;
        }
        seen.add(key);
        normalized.push(key);
    }

    if (normalized.length === 0) {
        throw new StrategyLibraryAdminError("Provide at least one built-in strategy key.");
    }

    return normalized;
}

function preparePendingStrategyDeletion(
    repoRoot: string,
    key: string,
    backupDate: Date,
    lookup: StrategyDeleteLookup,
): PendingStrategyDeletion {
    const paths = getStrategyLibraryPaths(repoRoot);

    if (key === DEFAULT_BUILT_IN_STRATEGY_KEY) {
        throw new StrategyLibraryAdminError(
            `Cannot delete the default built-in strategy "${DEFAULT_BUILT_IN_STRATEGY_KEY}". Update lib/strategy-defaults.ts first if you need a different default.`,
        );
    }

    const definition = lookup.definitionsByKey.get(key);
    if (!definition) {
        throw new StrategyLibraryAdminError(`Built-in strategy "${key}" was not found.`, 404);
    }

    const sourcePath = resolveStrategySourcePath(repoRoot, definition);
    if (!existsSync(sourcePath)) {
        throw new StrategyLibraryAdminError(`Strategy source file is missing for "${key}".`, 404);
    }

    const sourceContents = readFileSync(sourcePath, "utf8");
    const backupPath = createUniqueBackupPath(paths.archiveDir, path.basename(sourcePath), backupDate);

    return {
        key,
        sourcePath,
        sourceRelativePath: path.relative(repoRoot, sourcePath),
        sourceContents,
        backupPath,
        backupRelativePath: path.relative(repoRoot, backupPath),
    };
}

export function archiveAndDeleteBuiltInStrategies(
    strategyKeys: readonly string[],
    options: {
        repoRoot?: string;
        backupDate?: Date;
    } = {},
): DeleteBuiltInStrategiesBatchResult {
    const repoRoot = options.repoRoot ? path.resolve(options.repoRoot) : process.cwd();
    const paths = getStrategyLibraryPaths(repoRoot);
    assertPathWithin(paths.repoRoot, paths.archiveDir, "Strategy archive path");
    mkdirSync(paths.archiveDir, { recursive: true });

    const lookup = createStrategyDeleteLookup(repoRoot);
    const normalizedKeys = normalizeStrategyDeleteKeys(strategyKeys, lookup);
    const backupDate = options.backupDate ?? new Date();
    const pending = normalizedKeys.map((key) =>
        preparePendingStrategyDeletion(repoRoot, key, backupDate, lookup)
    );

    for (const item of pending) {
        writeFileSync(item.backupPath, item.sourceContents, "utf8");
    }

    const deleted: PendingStrategyDeletion[] = [];
    try {
        for (const item of pending) {
            unlinkSync(item.sourcePath);
            deleted.push(item);
        }

        const manifest = syncStrategyManifestForRepo(repoRoot);
        return {
            deleted: pending.map((item) => ({
                key: item.key,
                sourcePath: item.sourcePath,
                sourceRelativePath: item.sourceRelativePath,
                backupPath: item.backupPath,
                backupRelativePath: item.backupRelativePath,
            })),
            manifestPath: manifest.path,
            manifestStrategyCount: manifest.count,
        };
    } catch (error) {
        try {
            for (const item of deleted) {
                writeFileSync(item.sourcePath, item.sourceContents, "utf8");
            }
            syncStrategyManifestForRepo(repoRoot);
        } catch (restoreError) {
            const restoreMessage = restoreError instanceof Error ? restoreError.message : String(restoreError);
            throw new StrategyLibraryAdminError(
                `Batch delete failed after backup. Manual restore may be required from archive/strategy. Restore failed: ${restoreMessage}`,
                500
            );
        }

        if (error instanceof StrategyLibraryAdminError) {
            throw error;
        }

        const message = error instanceof Error ? error.message : String(error);
        throw new StrategyLibraryAdminError(`Batch delete aborted: ${message}`, 500);
    }
}

export function archiveAndDeleteBuiltInStrategy(
    strategyKey: string,
    options: {
        repoRoot?: string;
        backupDate?: Date;
    } = {},
): DeleteBuiltInStrategyResult {
    const key = strategyKey.trim();
    const result = archiveAndDeleteBuiltInStrategies([key], options);
    const deleted = result.deleted[0];
    return {
        key: deleted.key,
        sourcePath: deleted.sourcePath,
        sourceRelativePath: deleted.sourceRelativePath,
        backupPath: deleted.backupPath,
        backupRelativePath: deleted.backupRelativePath,
        manifestPath: result.manifestPath,
        manifestStrategyCount: result.manifestStrategyCount,
    };
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Uint8Array[] = [];
    let total = 0;
    const maxBodyBytes = 1024 * 1024;

    for await (const chunk of req) {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        total += bytes.length;
        if (total > maxBodyBytes) {
            throw new StrategyLibraryAdminError("Request body too large.", 413);
        }
        chunks.push(bytes);
    }

    const text = Buffer.concat(chunks).toString("utf8").trim();
    if (!text) {
        return {};
    }

    const parsed = JSON.parse(text);
    return (parsed && typeof parsed === "object") ? parsed as Record<string, unknown> : {};
}

function sendJson(res: any, status: number, payload: unknown): void {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(payload));
}

function invalidateStrategyLibraryServerState(server: ViteDevServer | null): void {
    if (!server) {
        return;
    }

    for (const environment of Object.values(server.environments)) {
        environment.moduleGraph.invalidateAll();
    }
}

export function strategyLibraryAdminPlugin(): Plugin {
    let devServer: ViteDevServer | null = null;

    const register = (middlewares: any) => {
        middlewares.use("/api/strategy-library", async (req: any, res: any) => {
            const method = req.method || "GET";
            const requestUrl = new URL(req.url || "/", "http://localhost");

            try {
                if (method === "POST" && requestUrl.pathname === "/delete") {
                    const payload = await readJsonBody(req as IncomingMessage);
                    const key = typeof payload.key === "string" ? payload.key : "";
                    const result = archiveAndDeleteBuiltInStrategy(key);
                    invalidateStrategyLibraryServerState(devServer);
                    sendJson(res, 200, {
                        ok: true,
                        ...result,
                    });
                    return;
                }

                if (method === "POST" && requestUrl.pathname === "/delete-batch") {
                    const payload = await readJsonBody(req as IncomingMessage);
                    const keys = Array.isArray(payload.keys)
                        ? payload.keys.filter((value): value is string => typeof value === "string")
                        : [];
                    const result = archiveAndDeleteBuiltInStrategies(keys);
                    invalidateStrategyLibraryServerState(devServer);
                    sendJson(res, 200, {
                        ok: true,
                        ...result,
                    });
                    return;
                }

                sendJson(res, 404, { ok: false, error: "Not found" });
            } catch (error) {
                if (error instanceof StrategyLibraryAdminError) {
                    sendJson(res, error.status, { ok: false, error: error.message });
                    return;
                }

                sendJson(res, 500, {
                    ok: false,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        });
    };

    return {
        name: "strategy-library-admin",
        configureServer(server) {
            devServer = server;
            register(server.middlewares);
        },
        configurePreviewServer(server) {
            register(server.middlewares);
        },
    };
}
