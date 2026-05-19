import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    collectStrategyModuleDefinitions,
    type StrategyModuleDefinition,
} from "./strategy-manifest-generator";

type StrategyPreparedAuditEntry = {
    key: string;
    relativePath: string;
    hasPreparedPath: boolean;
    matchedFamilies: string[];
    score: number;
};

const currentFilePath = fileURLToPath(import.meta.url);
const scriptsDir = path.dirname(currentFilePath);
const repoRoot = path.resolve(scriptsDir, "..");
const strategyLibDir = path.join(repoRoot, "lib", "strategies", "lib");

const HEAVY_FAMILY_PATTERNS: ReadonlyArray<{ family: string; pattern: RegExp }> = [
    { family: "rolling-entropy", pattern: /\bbuildRollingEntropy\b/ },
    { family: "rolling-skewness", pattern: /\bbuildRollingSkewness\b/ },
    { family: "rolling-zscore-median-percentile", pattern: /\b(?:buildRollingZScore|buildRollingMedian|buildPercentileRank)\b/ },
    { family: "correlation-autocorrelation", pattern: /\b(?:buildRollingCorrelation|buildRollingPairCorrelation|buildRollingAutoCorrelation)\b/ },
    { family: "cross-symbol-relative", pattern: /\b(?:buildRelativeStrength|crossSymbolConfig)\b/ },
    { family: "efficiency-ratio", pattern: /\bbuildEfficiencyRatio\b/ },
    { family: "vwap", pattern: /\b(?:rolling_vwap|Rolling VWAP|session VWAP)\b/i },
];

function readStrategySource(definition: StrategyModuleDefinition): string {
    const fileStem = definition.importPath.replace("./lib/", "");
    return readFileSync(path.join(strategyLibDir, `${fileStem}.ts`), "utf8");
}

function getRelativeStrategyPath(definition: StrategyModuleDefinition): string {
    const fileStem = definition.importPath.replace("./lib/", "");
    return path.posix.join("lib/strategies/lib", `${fileStem}.ts`);
}

function analyzePreparedPath(definition: StrategyModuleDefinition): StrategyPreparedAuditEntry {
    const source = readStrategySource(definition);
    const matchedFamilies = HEAVY_FAMILY_PATTERNS
        .filter(({ pattern }) => pattern.test(source))
        .map(({ family }) => family);

    const hasPreparedPath = /\bprepareFinderData\s*:/.test(source)
        && /\bexecutePrepared\s*:/.test(source);

    return {
        key: definition.key,
        relativePath: getRelativeStrategyPath(definition),
        hasPreparedPath,
        matchedFamilies,
        score: matchedFamilies.length,
    };
}

function main(): void {
    const auditEntries = collectStrategyModuleDefinitions()
        .map(analyzePreparedPath)
        .filter((entry) => entry.matchedFamilies.length > 0)
        .sort((left, right) => right.score - left.score || left.key.localeCompare(right.key));

    const preparedEntries = auditEntries.filter((entry) => entry.hasPreparedPath);
    const missingEntries = auditEntries.filter((entry) => !entry.hasPreparedPath);

    console.log("Prepared strategy audit");
    console.log(`Heavy strategy candidates: ${auditEntries.length}`);
    console.log(`Prepared path present: ${preparedEntries.length}`);
    console.log(`Prepared path missing: ${missingEntries.length}`);

    if (preparedEntries.length > 0) {
        console.log("");
        console.log("Prepared heavy strategies:");
        for (const entry of preparedEntries) {
            console.log(`- ${entry.key} [${entry.matchedFamilies.join(", ")}]`);
        }
    }

    if (missingEntries.length > 0) {
        console.log("");
        console.log("Heavy strategies still missing prepared execution:");
        for (const entry of missingEntries) {
            console.log(`- ${entry.key} [${entry.matchedFamilies.join(", ")}] (${entry.relativePath})`);
        }
    }
}

main();
