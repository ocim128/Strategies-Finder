import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentFilePath = fileURLToPath(import.meta.url);
const scriptsDir = path.dirname(currentFilePath);
const repoRoot = path.resolve(scriptsDir, "..");

const STRATEGY_EXPORT_PATTERN = /export\s+const\s+([a-zA-Z][a-zA-Z0-9_]*)\s*:\s*Strategy\s*=/g;
const MANIFEST_KEY_PATTERN = /key:\s*"([^"]+)"/g;
const VALID_STRATEGY_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

export interface StrategyModuleDefinition {
    key: string;
    exportName: string;
    importPath: string;
}

interface StrategyManifestPaths {
    strategyLibDir: string;
    manifestPath: string;
    manifestMetaPath: string;
    manifestLoadersPath: string;
    manifestKeysPath: string;
}

interface StrategyManifestGenerationOptions {
    repoRoot?: string;
}

function getStrategyManifestPaths(root: string = repoRoot): StrategyManifestPaths {
    const resolvedRoot = path.resolve(root);
    return {
        strategyLibDir: path.join(resolvedRoot, "lib", "strategies", "lib"),
        manifestPath: path.join(resolvedRoot, "lib", "strategies", "manifest.ts"),
        manifestMetaPath: path.join(resolvedRoot, "lib", "strategies", "manifest-meta.ts"),
        manifestLoadersPath: path.join(resolvedRoot, "lib", "strategies", "manifest-loaders.ts"),
        manifestKeysPath: path.join(resolvedRoot, "lib", "strategies", "manifest-keys.ts"),
    };
}

const defaultPaths = getStrategyManifestPaths();
const manifestPath = defaultPaths.manifestPath;
const manifestMetaPath = defaultPaths.manifestMetaPath;
const manifestLoadersPath = defaultPaths.manifestLoadersPath;
const manifestKeysPath = defaultPaths.manifestKeysPath;

function normalizeLineEndings(value: string): string {
    return value.replace(/\r\n/g, "\n");
}

function readCurrentManifestOrder(currentManifestPath: string): string[] {
    if (!existsSync(currentManifestPath)) {
        return [];
    }

    const source = normalizeLineEndings(readFileSync(currentManifestPath, "utf8"));
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
        throw new Error(`Expected exactly one Strategy export in ${fileName}, found ${matches.length}.`);
    }

    return matches[0][1];
}

export function collectStrategyModuleDefinitions(
    options: StrategyManifestGenerationOptions = {}
): StrategyModuleDefinition[] {
    const paths = getStrategyManifestPaths(options.repoRoot);
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
            throw new Error(`Strategy export "${exportName}" in ${fileName} is not a valid strategy key.`);
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

export function generateStrategyManifestSource(
    definitions?: readonly StrategyModuleDefinition[],
    options: StrategyManifestGenerationOptions = {}
): string {
    const resolvedDefinitions = definitions ?? collectStrategyModuleDefinitions(options);
    const importLines = resolvedDefinitions.map(
        (definition) => `import { ${definition.exportName} } from "${definition.importPath}";`
    );
    const entryLines = resolvedDefinitions.map(
        (definition) => `    { key: "${definition.key}", strategy: ${definition.exportName} },`
    );

    return [
        'import type { Strategy } from "../types/strategies";',
        "",
        "// AUTO-GENERATED by `npm run strategies:sync-manifest`.",
        "// Do not manually edit strategy imports or `strategyManifest` entries.",
        "",
        ...importLines,
        "",
        "export interface StrategyManifestEntry {",
        "    key: string;",
        "    strategy: Strategy;",
        "    assets?: string[];",
        "}",
        "",
        "export const strategyManifest: readonly StrategyManifestEntry[] = [",
        ...entryLines,
        "];",
        "",
        "export function createStrategiesRecordFromManifest(",
        "    manifest: readonly StrategyManifestEntry[] = strategyManifest",
        "): Record<string, Strategy> {",
        "    const strategies: Record<string, Strategy> = {};",
        "",
        "    for (const entry of manifest) {",
        "        if (entry.key in strategies) {",
        "            throw new Error(`Duplicate strategy key in manifest: ${entry.key}`);",
        "        }",
        "        strategies[entry.key] = entry.strategy;",
        "    }",
        "",
        "    return strategies;",
        "}",
        "",
    ].join("\n");
}

export function getStrategyManifestPath(): string {
    return manifestPath;
}

export interface StrategyMetaEntry {
    key: string;
    name: string;
    description: string;
    defaultParams: string;
    paramLabels: string;
    metadata: string;
}

function extractStringProperty(source: string, propName: string): string | null {
    const re = new RegExp(`\\b${propName}\\s*:\\s*`, "g");
    let match: RegExpExecArray | null;
    while ((match = re.exec(source)) !== null) {
        const rest = source.slice(match.index + match[0].length);
        const trimmed = rest.trimStart();
        if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
            const quote = trimmed[0];
            const end = trimmed.indexOf(quote, 1);
            if (end !== -1) {
                return trimmed.slice(0, end + 1);
            }
        }
        if (trimmed.startsWith("`")) {
            const end = findClosingBacktick(trimmed, 1);
            if (end !== -1) {
                const raw = trimmed.slice(1, end);
                const resolved = resolveTemplateLiteral(source, raw);
                return `"${escapeForQuotedString(resolved)}"`;
            }
        }
    }
    return null;
}

function findClosingBacktick(source: string, start: number): number {
    for (let i = start; i < source.length; i++) {
        if (source[i] === "\\") { i++; continue; }
        if (source[i] === "`") return i;
    }
    return -1;
}

function resolveTemplateLiteral(fileSource: string, templateContent: string): string {
    const constants = extractSimpleConstants(fileSource);
    return templateContent.replace(/\$\{([^}]+)\}/g, (_match, expr: string) => {
        const trimmed = expr.trim();
        if (constants.has(trimmed)) {
            return String(constants.get(trimmed));
        }
        return `[${trimmed}]`;
    });
}

function extractSimpleConstants(source: string): Map<string, number> {
    const constants = new Map<string, number>();
    const re = /\bconst\s+([A-Z_][A-Z0-9_]*)\s*=\s*(-?\d+(?:\.\d+)?)\s*[;\r\n]/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(source)) !== null) {
        constants.set(match[1], Number(match[2]));
    }
    return constants;
}

function escapeForQuotedString(value: string): string {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "");
}

function extractBalancedObject(source: string, propName: string): string | null {
    const re = new RegExp(`\\b${propName}\\s*:\\s*`, "g");
    let match: RegExpExecArray | null;
    while ((match = re.exec(source)) !== null) {
        const rest = source.slice(match.index + match[0].length);
        const trimmed = rest.trimStart();
        if (!trimmed.startsWith("{")) continue;
        let depth = 0;
        let inString: string | null = null;
        for (let i = 0; i < trimmed.length; i++) {
            const ch = trimmed[i];
            if (inString) {
                if (ch === "\\") { i++; continue; }
                if (ch === inString) inString = null;
                continue;
            }
            if (ch === '"' || ch === "'" || ch === "`") { inString = ch; continue; }
            if (ch === "{") depth++;
            if (ch === "}") {
                depth--;
                if (depth === 0) {
                    return trimmed.slice(0, i + 1);
                }
            }
        }
    }
    return null;
}

function extractStrategyMeta(source: string, key: string): StrategyMetaEntry {
    const name = extractStringProperty(source, "name") ?? `"${key}"`;
    const description = extractStringProperty(source, "description") ?? `""`;
    const defaultParams = extractBalancedObject(source, "defaultParams") ?? "{}";
    const paramLabels = extractBalancedObject(source, "paramLabels") ?? "{}";
    const metadata = extractBalancedObject(source, "metadata") ?? undefined;
    return { key, name, description, defaultParams, paramLabels, metadata: metadata ?? "undefined" };
}

function collectStrategyMeta(
    definitions: readonly StrategyModuleDefinition[],
    options: StrategyManifestGenerationOptions = {}
): StrategyMetaEntry[] {
    const paths = getStrategyManifestPaths(options.repoRoot);
    return definitions.map((def) => {
        const fileName = def.importPath.replace("./lib/", "") + ".ts";
        const source = readFileSync(path.join(paths.strategyLibDir, fileName), "utf8");
        return extractStrategyMeta(source, def.key);
    });
}

export function generateStrategyMetaSource(
    definitions?: readonly StrategyModuleDefinition[],
    options: StrategyManifestGenerationOptions = {}
): string {
    const resolvedDefinitions = definitions ?? collectStrategyModuleDefinitions(options);
    const metaEntries = collectStrategyMeta(resolvedDefinitions, options);
    const entryLines = metaEntries.map(
        (entry) => [
            "    {",
            `        key: "${entry.key}",`,
            `        name: ${entry.name},`,
            `        description: ${entry.description},`,
            `        defaultParams: ${entry.defaultParams} as Record<string, number>,`,
            `        paramLabels: ${entry.paramLabels} as Record<string, string>,`,
            `        metadata: ${entry.metadata === "undefined" ? "undefined" : entry.metadata},`,
            "    },",
        ].join("\n")
    );

    return [
        'import type { StrategyParams } from "../types/strategies";',
        "",
        "// AUTO-GENERATED by `npm run strategies:sync-manifest`.",
        "// Do not manually edit.",
        "",
        "export interface BuiltInStrategyMeta {",
        "    key: string;",
        "    name: string;",
        "    description: string;",
        "    defaultParams: StrategyParams;",
        "    paramLabels: Record<string, string>;",
        "    metadata?: {",
        "        role?: string;",
        "        direction?: string;",
        "        walkForwardParams?: string[];",
        "    };",
        "}",
        "",
        "export const builtInStrategyMeta: readonly BuiltInStrategyMeta[] = [",
        ...entryLines,
        "];",
        "",
    ].join("\n");
}

export function generateStrategyLoadersSource(
    definitions?: readonly StrategyModuleDefinition[],
    options: StrategyManifestGenerationOptions = {}
): string {
    const resolvedDefinitions = definitions ?? collectStrategyModuleDefinitions(options);
    const loaderLines = resolvedDefinitions.map(
        (def) =>
            `    "${def.key}": () => import("${def.importPath}").then(m => m.${def.exportName}),`
    );

    return [
        'import type { Strategy } from "../types/strategies";',
        "",
        "// AUTO-GENERATED by `npm run strategies:sync-manifest`.",
        "// Do not manually edit.",
        "",
        "export const builtInStrategyLoaders: Record<string, () => Promise<Strategy>> = {",
        ...loaderLines,
        "};",
        "",
    ].join("\n");
}

export function generateStrategyKeysSource(
    definitions?: readonly StrategyModuleDefinition[],
    options: StrategyManifestGenerationOptions = {}
): string {
    const resolvedDefinitions = definitions ?? collectStrategyModuleDefinitions(options);
    const keyLines = resolvedDefinitions.map(
        (def) => `    "${def.key}",`
    );

    return [
        "// AUTO-GENERATED by `npm run strategies:sync-manifest`.",
        "// Do not manually edit.",
        "",
        "export const builtInStrategyKeys: readonly string[] = [",
        ...keyLines,
        "];",
        "",
    ].join("\n");
}

export function getStrategyMetaPath(): string {
    return manifestMetaPath;
}

export function getStrategyLoadersPath(): string {
    return manifestLoadersPath;
}

export function getStrategyKeysPath(): string {
    return manifestKeysPath;
}

export function syncStrategyManifest(
    options: StrategyManifestGenerationOptions = {}
): { path: string; count: number } {
    const paths = getStrategyManifestPaths(options.repoRoot);
    const definitions = collectStrategyModuleDefinitions(options);
    mkdirSync(path.dirname(paths.manifestPath), { recursive: true });
    writeFileSync(paths.manifestPath, generateStrategyManifestSource(definitions, options), "utf8");
    writeFileSync(paths.manifestMetaPath, generateStrategyMetaSource(definitions, options), "utf8");
    writeFileSync(paths.manifestLoadersPath, generateStrategyLoadersSource(definitions, options), "utf8");
    writeFileSync(paths.manifestKeysPath, generateStrategyKeysSource(definitions, options), "utf8");
    return {
        path: paths.manifestPath,
        count: definitions.length,
    };
}

export function syncStrategyManifestForRepo(repoRoot: string): { path: string; count: number } {
    return syncStrategyManifest({ repoRoot });
}
