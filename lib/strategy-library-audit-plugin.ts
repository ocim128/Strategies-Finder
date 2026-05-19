import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { Plugin } from "vite";
import { sendJson } from "./http-response-utils";

const EXAMPLE_LIMIT = 5;
const ARCHIVE_HEAVY_MIN_ARCHIVED_FILES = 5;
const ARCHIVE_HEAVY_LIFT = 2;

const HELPER_MODULE_GROUPS = new Set([
    "strategy-helpers",
    "indicators",
    "price-action-statistics-core",
    "price-action-frequency-core",
    "range-conviction-core",
    "cross-symbol-helpers",
    "polymarket-1s-helpers",
]);

const CORE_HELPERS = new Set([
    "createBuySignal",
    "createSellSignal",
    "createSignalLoop",
    "ensureCleanData",
]);

const HELPER_EXPORT_PATHS: Record<string, readonly string[]> = {
    "strategy-helpers": ["lib", "strategies", "strategy-helpers.ts"],
    indicators: ["lib", "strategies", "indicators.ts"],
    "price-action-statistics-core": ["lib", "strategies", "lib", "price-action-statistics-core.ts"],
    "price-action-frequency-core": ["lib", "strategies", "lib", "price-action-frequency-core.ts"],
    "range-conviction-core": ["lib", "strategies", "lib", "range-conviction-core.ts"],
    "cross-symbol-helpers": ["lib", "strategies", "lib", "cross-symbol-helpers.ts"],
    "polymarket-1s-helpers": ["lib", "strategies", "lib", "polymarket-1s-helpers.ts"],
};

type StrategyAuditCorpus = "current" | "archive";

export type StrategyLibraryAuditFlag =
    | "archive_only"
    | "archive_heavy"
    | "current_only"
    | "low_evidence"
    | "core_helper"
    | "missing_export";

export interface StrategyLibraryAuditRow {
    helperName: string;
    moduleSpecifier: string;
    moduleGroup: string;
    currentImportCount: number;
    archivedImportCount: number;
    currentFileCount: number;
    archivedFileCount: number;
    currentUsageRate: number | null;
    archivedUsageRate: number | null;
    archiveRatio: number | null;
    archiveLift: number | null;
    evidenceLevel: "low" | "medium" | "high";
    flags: StrategyLibraryAuditFlag[];
    currentExamples: string[];
    archivedExamples: string[];
}

export interface StrategyLibraryAuditResponse {
    ok: true;
    generatedAt: string;
    currentStrategyFileCount: number;
    archivedStrategyFileCount: number;
    scannedFileCount: number;
    helperRows: StrategyLibraryAuditRow[];
    warnings: string[];
}

interface StrategyLibraryAuditPaths {
    repoRoot: string;
    currentDir: string;
    archiveDir: string;
}

interface HelperImportUsage {
    helperName: string;
    moduleSpecifier: string;
    moduleGroup: string;
    fileRelativePath: string;
    corpus: StrategyAuditCorpus;
}

interface HelperAccumulator {
    helperName: string;
    moduleSpecifier: string;
    moduleGroup: string;
    currentImportCount: number;
    archivedImportCount: number;
    currentFiles: Set<string>;
    archivedFiles: Set<string>;
    currentExamples: string[];
    archivedExamples: string[];
}

class StrategyLibraryAuditError extends Error {
    public readonly status: number;

    constructor(message: string, status = 400) {
        super(message);
        this.name = "StrategyLibraryAuditError";
        this.status = status;
    }
}

function getStrategyLibraryAuditPaths(repoRoot: string): StrategyLibraryAuditPaths {
    const resolvedRoot = path.resolve(repoRoot);
    return {
        repoRoot: resolvedRoot,
        currentDir: path.resolve(resolvedRoot, "lib", "strategies", "lib"),
        archiveDir: path.resolve(resolvedRoot, "archive", "strategy"),
    };
}

function assertPathWithin(baseDir: string, targetPath: string, label: string): void {
    const relative = path.relative(baseDir, targetPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new StrategyLibraryAuditError(`${label} resolved outside ${baseDir}`, 500);
    }
}

function normalizeRelativePath(repoRoot: string, filePath: string): string {
    return path.relative(repoRoot, filePath).replace(/\\/g, "/");
}

function createSourceFile(filePath: string, source: string): ts.SourceFile {
    return ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function hasExportModifier(node: ts.Node): boolean {
    return Boolean(ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

function typeNodeReferencesStrategy(typeNode: ts.TypeNode | undefined): boolean {
    if (!typeNode) {
        return false;
    }
    return typeNode.getText().split(/\W+/).includes("Strategy");
}

function hasStrategyExport(sourceFile: ts.SourceFile): boolean {
    let found = false;

    const visit = (node: ts.Node): void => {
        if (found) {
            return;
        }

        if (ts.isVariableStatement(node) && hasExportModifier(node)) {
            for (const declaration of node.declarationList.declarations) {
                if (ts.isIdentifier(declaration.name) && typeNodeReferencesStrategy(declaration.type)) {
                    found = true;
                    return;
                }
            }
        }

        ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    return found;
}

function isKnownHelperCoreFile(fileName: string): boolean {
    const normalized = fileName.replace(/\\/g, "/").split("/").pop() ?? fileName;
    return normalized.endsWith("-core.ts")
        || normalized.endsWith("-helpers.ts")
        || normalized === "polymarket-1s-helpers.ts"
        || normalized === "cross-symbol-helpers.ts";
}

function listTsFiles(dir: string): string[] {
    if (!existsSync(dir)) {
        return [];
    }

    return readdirSync(dir)
        .filter((fileName) => fileName.endsWith(".ts"))
        .sort((left, right) => left.localeCompare(right))
        .map((fileName) => path.join(dir, fileName));
}

function normalizeModuleGroup(moduleSpecifier: string): string | null {
    const normalized = moduleSpecifier.replace(/\\/g, "/").replace(/\.ts$/i, "");
    const group = path.posix.basename(normalized);
    return HELPER_MODULE_GROUPS.has(group) ? group : null;
}

function extractHelperImports(sourceFile: ts.SourceFile, fileRelativePath: string, corpus: StrategyAuditCorpus): HelperImportUsage[] {
    const imports: HelperImportUsage[] = [];

    for (const statement of sourceFile.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
            continue;
        }

        const moduleSpecifier = statement.moduleSpecifier.text;
        const moduleGroup = normalizeModuleGroup(moduleSpecifier);
        if (!moduleGroup) {
            continue;
        }

        const namedBindings = statement.importClause?.namedBindings;
        if (!namedBindings || !ts.isNamedImports(namedBindings)) {
            continue;
        }

        for (const element of namedBindings.elements) {
            if (statement.importClause?.isTypeOnly || element.isTypeOnly) {
                continue;
            }

            imports.push({
                helperName: element.propertyName?.text ?? element.name.text,
                moduleSpecifier,
                moduleGroup,
                fileRelativePath,
                corpus,
            });
        }
    }

    return imports;
}

function addExample(examples: string[], fileRelativePath: string): void {
    if (examples.length < EXAMPLE_LIMIT && !examples.includes(fileRelativePath)) {
        examples.push(fileRelativePath);
    }
}

function addUsage(accumulators: Map<string, HelperAccumulator>, usage: HelperImportUsage): void {
    const key = `${usage.moduleGroup}:${usage.helperName}`;
    let accumulator = accumulators.get(key);
    if (!accumulator) {
        accumulator = {
            helperName: usage.helperName,
            moduleSpecifier: usage.moduleSpecifier,
            moduleGroup: usage.moduleGroup,
            currentImportCount: 0,
            archivedImportCount: 0,
            currentFiles: new Set<string>(),
            archivedFiles: new Set<string>(),
            currentExamples: [],
            archivedExamples: [],
        };
        accumulators.set(key, accumulator);
    }

    if (usage.corpus === "current") {
        accumulator.currentImportCount++;
        accumulator.currentFiles.add(usage.fileRelativePath);
        addExample(accumulator.currentExamples, usage.fileRelativePath);
        return;
    }

    accumulator.archivedImportCount++;
    accumulator.archivedFiles.add(usage.fileRelativePath);
    addExample(accumulator.archivedExamples, usage.fileRelativePath);
}

function extractExportedNames(sourceFile: ts.SourceFile): Set<string> {
    const exports = new Set<string>();

    for (const statement of sourceFile.statements) {
        if (ts.isFunctionDeclaration(statement) && hasExportModifier(statement) && statement.name) {
            exports.add(statement.name.text);
            continue;
        }

        if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
            for (const declaration of statement.declarationList.declarations) {
                if (ts.isIdentifier(declaration.name)) {
                    exports.add(declaration.name.text);
                }
            }
            continue;
        }

        if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
            for (const element of statement.exportClause.elements) {
                exports.add(element.name.text);
            }
        }
    }

    return exports;
}

function buildHelperExportIndex(repoRoot: string, warnings: string[]): Map<string, Set<string>> {
    const exportIndex = new Map<string, Set<string>>();

    for (const [moduleGroup, relativeParts] of Object.entries(HELPER_EXPORT_PATHS)) {
        const filePath = path.resolve(repoRoot, ...relativeParts);
        assertPathWithin(repoRoot, filePath, "Helper export path");

        if (!existsSync(filePath)) {
            warnings.push(`Helper export validation skipped for ${moduleGroup}; file is missing.`);
            continue;
        }

        try {
            const source = readFileSync(filePath, "utf8");
            const sourceFile = createSourceFile(filePath, source);
            exportIndex.set(moduleGroup, extractExportedNames(sourceFile));
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            warnings.push(`Helper export validation skipped for ${moduleGroup}: ${message}`);
        }
    }

    return exportIndex;
}

function getEvidenceLevel(totalFileCount: number): StrategyLibraryAuditRow["evidenceLevel"] {
    if (totalFileCount <= 2) {
        return "low";
    }
    if (totalFileCount < 10) {
        return "medium";
    }
    return "high";
}

function buildRows(
    accumulators: Map<string, HelperAccumulator>,
    currentStrategyFileCount: number,
    archivedStrategyFileCount: number,
    exportIndex: Map<string, Set<string>>,
): StrategyLibraryAuditRow[] {
    const rows: StrategyLibraryAuditRow[] = [];

    for (const accumulator of accumulators.values()) {
        const currentFileCount = accumulator.currentFiles.size;
        const archivedFileCount = accumulator.archivedFiles.size;
        const totalFileCount = currentFileCount + archivedFileCount;
        const currentUsageRate = currentStrategyFileCount > 0 ? currentFileCount / currentStrategyFileCount : null;
        const archivedUsageRate = archivedStrategyFileCount > 0 ? archivedFileCount / archivedStrategyFileCount : null;
        const archiveRatio = totalFileCount > 0 ? archivedFileCount / totalFileCount : null;
        const archiveLift = currentUsageRate && archivedUsageRate !== null
            ? archivedUsageRate / currentUsageRate
            : null;
        const flags: StrategyLibraryAuditFlag[] = [];
        const exportedNames = exportIndex.get(accumulator.moduleGroup);

        if (currentFileCount === 0 && archivedFileCount > 0) {
            flags.push("archive_only");
        }
        if (currentFileCount > 0 && archivedFileCount === 0) {
            flags.push("current_only");
        }
        if (
            currentFileCount > 0
            && archivedUsageRate !== null
            && currentUsageRate !== null
            && archivedUsageRate >= currentUsageRate * ARCHIVE_HEAVY_LIFT
            && archivedFileCount >= ARCHIVE_HEAVY_MIN_ARCHIVED_FILES
        ) {
            flags.push("archive_heavy");
        }
        if (totalFileCount <= 2) {
            flags.push("low_evidence");
        }
        if (CORE_HELPERS.has(accumulator.helperName)) {
            flags.push("core_helper");
        }
        if (exportedNames && !exportedNames.has(accumulator.helperName)) {
            flags.push("missing_export");
        }

        rows.push({
            helperName: accumulator.helperName,
            moduleSpecifier: accumulator.moduleSpecifier,
            moduleGroup: accumulator.moduleGroup,
            currentImportCount: accumulator.currentImportCount,
            archivedImportCount: accumulator.archivedImportCount,
            currentFileCount,
            archivedFileCount,
            currentUsageRate,
            archivedUsageRate,
            archiveRatio,
            archiveLift,
            evidenceLevel: getEvidenceLevel(totalFileCount),
            flags,
            currentExamples: [...accumulator.currentExamples],
            archivedExamples: [...accumulator.archivedExamples],
        });
    }

    return rows.sort(compareAuditRows);
}

function flagRank(row: StrategyLibraryAuditRow): number {
    if (row.flags.includes("archive_heavy") && !row.flags.includes("core_helper")) {
        return 0;
    }
    if (row.flags.includes("archive_only") && !row.flags.includes("missing_export")) {
        return 1;
    }
    if (row.flags.includes("archive_only")) {
        return 2;
    }
    if (row.flags.includes("current_only")) {
        return 3;
    }
    if (row.flags.includes("core_helper")) {
        return 5;
    }
    return 4;
}

function compareAuditRows(left: StrategyLibraryAuditRow, right: StrategyLibraryAuditRow): number {
    const rankDelta = flagRank(left) - flagRank(right);
    if (rankDelta !== 0) {
        return rankDelta;
    }

    const leftTotal = left.currentFileCount + left.archivedFileCount;
    const rightTotal = right.currentFileCount + right.archivedFileCount;
    if (leftTotal !== rightTotal) {
        return rightTotal - leftTotal;
    }

    return `${left.moduleGroup}:${left.helperName}`.localeCompare(`${right.moduleGroup}:${right.helperName}`);
}

function scanCorpus(
    repoRoot: string,
    corpus: StrategyAuditCorpus,
    dir: string,
    accumulators: Map<string, HelperAccumulator>,
    warnings: string[],
): number {
    const files = listTsFiles(dir);
    if (files.length === 0) {
        warnings.push(`${corpus === "current" ? "Current" : "Archive"} strategy scan root has no .ts files: ${normalizeRelativePath(repoRoot, dir)}`);
        return 0;
    }

    let strategyFileCount = 0;
    let archiveFallbackCount = 0;
    let skippedCurrentCount = 0;
    const skippedCurrentExamples: string[] = [];

    for (const filePath of files) {
        assertPathWithin(dir, filePath, "Strategy audit source path");
        const relativePath = normalizeRelativePath(repoRoot, filePath);

        let sourceFile: ts.SourceFile;
        try {
            const source = readFileSync(filePath, "utf8");
            sourceFile = createSourceFile(filePath, source);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            warnings.push(`Skipped unreadable strategy file ${relativePath}: ${message}`);
            continue;
        }

        const hasExport = hasStrategyExport(sourceFile);
        const isHelperCore = isKnownHelperCoreFile(filePath);
        const includeAsStrategy = corpus === "current"
            ? hasExport
            : hasExport || !isHelperCore;

        if (!includeAsStrategy) {
            if (corpus === "current" && !isHelperCore) {
                skippedCurrentCount++;
                addExample(skippedCurrentExamples, relativePath);
            }
            continue;
        }

        if (corpus === "archive" && !hasExport) {
            archiveFallbackCount++;
        }

        strategyFileCount++;
        for (const usage of extractHelperImports(sourceFile, relativePath, corpus)) {
            addUsage(accumulators, usage);
        }
    }

    if (skippedCurrentCount > 0) {
        warnings.push(
            `Skipped ${skippedCurrentCount} current .ts files without Strategy exports: ${skippedCurrentExamples.join(", ")}`
        );
    }
    if (archiveFallbackCount > 0) {
        warnings.push(`Used archive filename fallback for ${archiveFallbackCount} archived .ts files without detectable Strategy exports.`);
    }

    return strategyFileCount;
}

export function buildStrategyLibraryAudit(options: {
    repoRoot?: string;
    generatedAt?: Date;
} = {}): StrategyLibraryAuditResponse {
    const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
    const paths = getStrategyLibraryAuditPaths(repoRoot);
    assertPathWithin(paths.repoRoot, paths.currentDir, "Current strategy audit path");
    assertPathWithin(paths.repoRoot, paths.archiveDir, "Archived strategy audit path");

    if (!existsSync(paths.currentDir) && !existsSync(paths.archiveDir)) {
        throw new StrategyLibraryAuditError("No strategy audit scan roots were found.", 404);
    }

    const warnings: string[] = [];
    const accumulators = new Map<string, HelperAccumulator>();
    const currentStrategyFileCount = scanCorpus(repoRoot, "current", paths.currentDir, accumulators, warnings);
    const archivedStrategyFileCount = scanCorpus(repoRoot, "archive", paths.archiveDir, accumulators, warnings);
    const exportIndex = buildHelperExportIndex(repoRoot, warnings);

    return {
        ok: true,
        generatedAt: (options.generatedAt ?? new Date()).toISOString(),
        currentStrategyFileCount,
        archivedStrategyFileCount,
        scannedFileCount: currentStrategyFileCount + archivedStrategyFileCount,
        helperRows: buildRows(accumulators, currentStrategyFileCount, archivedStrategyFileCount, exportIndex),
        warnings,
    };
}

export function strategyLibraryAuditPlugin(): Plugin {
    const register = (middlewares: any) => {
        middlewares.use("/api/strategy-library", (req: any, res: any, next: () => void) => {
            const method = req.method || "GET";
            const requestUrl = new URL(req.url || "/", "http://localhost");

            try {
                if (method === "GET" && requestUrl.pathname === "/audit") {
                    sendJson(res, 200, buildStrategyLibraryAudit());
                    return;
                }

                next();
            } catch (error) {
                if (error instanceof StrategyLibraryAuditError) {
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
        name: "strategy-library-audit",
        configureServer(server) {
            register(server.middlewares);
        },
        configurePreviewServer(server) {
            register(server.middlewares);
        },
    };
}
