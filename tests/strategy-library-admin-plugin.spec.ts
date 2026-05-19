import { expect } from "chai";
import { describe, it } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_BUILT_IN_STRATEGY_KEY } from "../lib/strategy-defaults";
import {
    archiveAndDeleteBuiltInStrategies,
    archiveAndDeleteBuiltInStrategy,
    syncStrategyManifestForRepo,
} from "../lib/strategy-library-admin-plugin";

function createTempRepo(): string {
    return mkdtempSync(path.join(os.tmpdir(), "strategy-library-admin-"));
}

function writeStrategyFile(
    repoRoot: string,
    fileName: string,
    exportName: string,
    strategyName = exportName,
): string {
    const strategyDir = path.join(repoRoot, "lib", "strategies", "lib");
    mkdirSync(strategyDir, { recursive: true });
    const filePath = path.join(strategyDir, fileName);
    writeFileSync(
        filePath,
        [
            'import type { Strategy } from "../index";',
            "",
            `export const ${exportName}: Strategy = {`,
            `    name: "${strategyName}",`,
            '    description: "test",',
            "    defaultParams: {},",
            "    paramLabels: {},",
            '    metadata: { role: "entry", direction: "both" },',
            "    execute: () => [],",
            "};",
            "",
        ].join("\n"),
        "utf8"
    );
    return filePath;
}

const generatedStrategyArtifacts = [
    "manifest.ts",
    "manifest-eager.ts",
    "manifest-meta.ts",
    "manifest-summary.ts",
    "manifest-loaders.ts",
    "manifest-keys.ts",
] as const;

describe("Strategy library admin plugin", () => {
    it("archives a built-in strategy file, deletes it, and resyncs all generated manifest artifacts", () => {
        const repoRoot = createTempRepo();
        try {
            const alphaPath = writeStrategyFile(repoRoot, "alpha_strategy.ts", "alpha_strategy");
            writeStrategyFile(repoRoot, "beta_strategy.ts", "beta_strategy");

            syncStrategyManifestForRepo(repoRoot);

            const originalAlpha = readFileSync(alphaPath, "utf8");
            const result = archiveAndDeleteBuiltInStrategy("alpha_strategy", {
                repoRoot,
                backupDate: new Date("2026-04-09T12:00:00Z"),
            });

            expect(existsSync(alphaPath)).to.equal(false);
            expect(existsSync(path.join(repoRoot, result.backupRelativePath))).to.equal(true);
            expect(readFileSync(path.join(repoRoot, result.backupRelativePath), "utf8")).to.equal(originalAlpha);
            expect(result.manifestStrategyCount).to.equal(1);

            for (const artifact of generatedStrategyArtifacts) {
                const source = readFileSync(path.join(repoRoot, "lib", "strategies", artifact), "utf8");
                expect(source.includes("alpha_strategy"), `${artifact} should drop alpha_strategy`).to.equal(false);
                expect(source.includes("beta_strategy"), `${artifact} should keep beta_strategy`).to.equal(true);
            }
        } finally {
            rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it("accepts a strategy display name for single-strategy deletion", () => {
        const repoRoot = createTempRepo();
        try {
            const alphaPath = writeStrategyFile(repoRoot, "alpha_strategy.ts", "alpha_strategy", "Alpha Strategy");
            writeStrategyFile(repoRoot, "beta_strategy.ts", "beta_strategy");

            syncStrategyManifestForRepo(repoRoot);

            const result = archiveAndDeleteBuiltInStrategy("Alpha Strategy", {
                repoRoot,
                backupDate: new Date("2026-04-09T12:00:00Z"),
            });

            expect(result.key).to.equal("alpha_strategy");
            expect(existsSync(alphaPath)).to.equal(false);
            expect(existsSync(path.join(repoRoot, result.backupRelativePath))).to.equal(true);

            const manifestSource = readFileSync(path.join(repoRoot, "lib", "strategies", "manifest-eager.ts"), "utf8");
            expect(manifestSource.includes('key: "alpha_strategy"')).to.equal(false);
            expect(manifestSource.includes('key: "beta_strategy"')).to.equal(true);
        } finally {
            rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it("archives and deletes multiple built-in strategies in one batch", () => {
        const repoRoot = createTempRepo();
        try {
            const alphaPath = writeStrategyFile(repoRoot, "alpha_strategy.ts", "alpha_strategy");
            const betaPath = writeStrategyFile(repoRoot, "beta_strategy.ts", "beta_strategy");
            writeStrategyFile(repoRoot, "gamma_strategy.ts", "gamma_strategy");

            syncStrategyManifestForRepo(repoRoot);

            const result = archiveAndDeleteBuiltInStrategies(
                ["alpha_strategy", "beta_strategy", "alpha_strategy"],
                {
                    repoRoot,
                    backupDate: new Date("2026-04-09T12:00:00Z"),
                }
            );

            expect(result.deleted.map((item) => item.key)).to.deep.equal(["alpha_strategy", "beta_strategy"]);
            expect(existsSync(alphaPath)).to.equal(false);
            expect(existsSync(betaPath)).to.equal(false);
            expect(existsSync(path.join(repoRoot, result.deleted[0].backupRelativePath))).to.equal(true);
            expect(existsSync(path.join(repoRoot, result.deleted[1].backupRelativePath))).to.equal(true);
            expect(result.manifestStrategyCount).to.equal(1);

            const manifestSource = readFileSync(path.join(repoRoot, "lib", "strategies", "manifest-eager.ts"), "utf8");
            expect(manifestSource.includes('key: "alpha_strategy"')).to.equal(false);
            expect(manifestSource.includes('key: "beta_strategy"')).to.equal(false);
            expect(manifestSource.includes('key: "gamma_strategy"')).to.equal(true);
        } finally {
            rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it("accepts filename, path, and label-style aliases when deleting built-in strategies", () => {
        const repoRoot = createTempRepo();
        try {
            const alphaPath = writeStrategyFile(repoRoot, "alpha_strategy.ts", "alpha_strategy", "Alpha Strategy");
            const betaPath = writeStrategyFile(repoRoot, "beta_strategy.ts", "beta_strategy");
            writeStrategyFile(repoRoot, "gamma_strategy.ts", "gamma_strategy");

            syncStrategyManifestForRepo(repoRoot);

            const result = archiveAndDeleteBuiltInStrategies(
                [
                    "Alpha Strategy",
                    "lib/strategies/lib/beta_strategy.ts",
                    "alpha-strategy.ts",
                ],
                {
                    repoRoot,
                    backupDate: new Date("2026-04-09T12:00:00Z"),
                }
            );

            expect(result.deleted.map((item) => item.key)).to.deep.equal(["alpha_strategy", "beta_strategy"]);
            expect(existsSync(alphaPath)).to.equal(false);
            expect(existsSync(betaPath)).to.equal(false);

            const manifestSource = readFileSync(path.join(repoRoot, "lib", "strategies", "manifest-eager.ts"), "utf8");
            expect(manifestSource.includes('key: "alpha_strategy"')).to.equal(false);
            expect(manifestSource.includes('key: "beta_strategy"')).to.equal(false);
            expect(manifestSource.includes('key: "gamma_strategy"')).to.equal(true);
        } finally {
            rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it("blocks deletion of the protected default built-in strategy", () => {
        const repoRoot = createTempRepo();
        try {
            const defaultPath = writeStrategyFile(
                repoRoot,
                `${DEFAULT_BUILT_IN_STRATEGY_KEY}.ts`,
                DEFAULT_BUILT_IN_STRATEGY_KEY
            );
            writeStrategyFile(repoRoot, "beta_strategy.ts", "beta_strategy");

            syncStrategyManifestForRepo(repoRoot);

            expect(() => archiveAndDeleteBuiltInStrategy(DEFAULT_BUILT_IN_STRATEGY_KEY, { repoRoot }))
                .to.throw(`Cannot delete the default built-in strategy "${DEFAULT_BUILT_IN_STRATEGY_KEY}".`);
            expect(existsSync(defaultPath)).to.equal(true);
        } finally {
            rmSync(repoRoot, { recursive: true, force: true });
        }
    });
});
