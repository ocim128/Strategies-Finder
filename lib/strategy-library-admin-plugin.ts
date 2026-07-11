import type { IncomingMessage } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Plugin, ViteDevServer } from "vite";
import {
    syncStrategyManifestForRepo as syncGeneratedStrategyManifestForRepo,
    type StrategyModuleDefinition,
} from "../scripts/strategy-manifest-generator";
import { DEFAULT_BUILT_IN_STRATEGY_KEY } from "./strategy-defaults";
import { isLoopbackHost } from "./local-api-transport";
import { sendJson } from "./http-response-utils";
import { readJsonBody, sendCaughtErrorJson } from "./vite-http-utils";

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
    return syncGeneratedStrategyManifestForRepo(repoRoot);
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

/**
 * Loopback/same-origin gate for the destructive strategy-admin mutation
 * routes. Mirrors the established IBKR idiom (`isAllowedIbkrCaller` in
 * `ibkr-data-vite-plugin.ts`): a same-origin browser caller (Origin/Referer on
 * a loopback host) is trusted without a token; any other caller must present
 * the shared `LOCAL_PROXY_TOKEN` bearer (the same secret the Cloudflare Tunnel
 * candle-proxy workflow uses).
 *
 * Audit Finding 1: `/api/strategy-library/delete*` previously accepted ANY
 * request — a cross-origin `fetch(..., {mode:"no-cors"})` with a `text/plain`
 * body bypassed the CORS preflight and silently deleted repo source files.
 *
 * Loopback host parsing goes through `isLoopbackHost` (IPv6-aware, unlike the
 * IBKR gate which predates the `[::1]` fix in Finding 5). Returns true when the
 * caller is allowed; the route sends the 403 itself so the response shape
 * matches the rest of the handler.
 */
export function isAllowedStrategyAdminCaller(req: { headers?: Record<string, unknown> }): boolean {
    const origin = String(req.headers?.origin ?? "");
    const referer = String(req.headers?.referer ?? "");
    if (isLoopbackUrl(origin) || isLoopbackUrl(referer)) return true;
    // Non-local caller: require the documented shared secret.
    const token = process.env.LOCAL_PROXY_TOKEN?.trim();
    if (!token) return false;
    const auth = String(req.headers?.authorization ?? "");
    return auth === `Bearer ${token}`;
}

/**
 * True if `url` (an absolute `http(s)://host[:port]/...` string) points at a
 * loopback origin. Empty or non-absolute values are not loopback. Uses
 * `isLoopbackHost` for the authority check so bracketed IPv6
 * (`http://[::1]:5173`) is recognized.
 */
function isLoopbackUrl(url: string): boolean {
    if (!url) return false;
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return false;
    }
    return parsed.protocol === "http:" && isLoopbackHost(parsed.host);
}

const STRATEGY_ADMIN_MAX_BODY_BYTES = 1024 * 1024;

/**
 * Read and JSON-parse the request body. Rejects non-JSON Content-Types so a
 * CSRF `text/plain` body (CORS-simple, no preflight) cannot reach the deletion
 * handlers — defense in depth on top of {@link isAllowedStrategyAdminCaller}.
 * Empty bodies parse to `{}` for handlers that accept no payload.
 */
async function readAdminJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    // `requireJsonContentType` throws HttpStatusError(415) for non-JSON bodies;
    // the catch in the handler maps both HttpStatusError and the domain
    // StrategyLibraryAdminError to their status codes.
    return readJsonBody(req, STRATEGY_ADMIN_MAX_BODY_BYTES, { requireJsonContentType: true });
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
                // Finding 1: gate destructive routes before any work. A 403 here
                // means a cross-origin / unauthenticated caller (e.g. a CSRF
                // no-cors fetch) never reaches the deletion handlers.
                if (!isAllowedStrategyAdminCaller(req as { headers?: Record<string, unknown> })) {
                    sendJson(res, 403, {
                        ok: false,
                        error: "Forbidden: strategy-library admin routes allow same-origin loopback callers or a valid LOCAL_PROXY_TOKEN bearer only.",
                    });
                    return;
                }

                if (method === "POST" && requestUrl.pathname === "/delete") {
                    const payload = await readAdminJsonBody(req as IncomingMessage);
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
                    const payload = await readAdminJsonBody(req as IncomingMessage);
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
                // HttpStatusError (415 non-JSON Content-Type, 413 oversized,
                // 400 malformed) and any unexpected error.
                sendCaughtErrorJson(res, error);
            }
        });
    };

    return {
        name: "strategy-library-admin",
        configureServer(server) {
            devServer = server;
            register(server.middlewares);
        },
        // Intentionally NO configurePreviewServer: the strategy-admin routes
        // delete repository source files and resync manifests — destructive
        // operations that have no place in a preview/production-style build.
        // Dev-only is the documented defense-in-depth posture (audit Finding 1).
    };
}
