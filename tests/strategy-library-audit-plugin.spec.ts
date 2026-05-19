import { expect } from "chai";
import { describe, it } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildStrategyLibraryAudit } from "../lib/strategy-library-audit-plugin";

function createTempRepo(): string {
    return mkdtempSync(path.join(os.tmpdir(), "strategy-library-audit-"));
}

function writeFile(repoRoot: string, relativePath: string, source: string): void {
    const filePath = path.join(repoRoot, ...relativePath.split("/"));
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, source.trimStart(), "utf8");
}

function writeHelperExports(repoRoot: string): void {
    writeFile(repoRoot, "lib/strategies/strategy-helpers.ts", `
        export function createBuySignal() {}
        export function createSellSignal() {}
        export function createSignalLoop() {}
        export function ensureCleanData() {}
    `);
    writeFile(repoRoot, "lib/strategies/indicators.ts", `
        export function calculateADX() {}
    `);
    writeFile(repoRoot, "lib/strategies/lib/price-action-statistics-core.ts", `
        export function buildRollingMedian() {}
        export function buildRollingZScore() {}
    `);
    writeFile(repoRoot, "lib/strategies/lib/price-action-frequency-core.ts", `
        export function buildCurrentOnly() {}
    `);
    writeFile(repoRoot, "lib/strategies/lib/range-conviction-core.ts", `
        export function buildRangeConviction() {}
    `);
    writeFile(repoRoot, "lib/strategies/lib/cross-symbol-helpers.ts", `
        export function buildRelativeStrength() {}
        export function buildRollingPairCorrelation() {}
    `);
    writeFile(repoRoot, "lib/strategies/lib/polymarket-1s-helpers.ts", `
        export function buildPolymarket1sPressureGap() {}
    `);
}

function strategySource(exportName: string, imports: string): string {
    return `
        import type { Strategy } from "../../types/strategies";
        ${imports}

        export const ${exportName}: Strategy = {
            name: "${exportName}",
            description: "fixture",
            defaultParams: {},
            paramLabels: {},
            execute: () => [],
        };
    `;
}

describe("Strategy library audit plugin", () => {
    it("counts helper imports with normalized rates and excludes current helper/core modules", () => {
        const repoRoot = createTempRepo();
        try {
            writeHelperExports(repoRoot);
            writeFile(repoRoot, "lib/strategies/lib/alpha_strategy.ts", strategySource("alpha_strategy", `
                import { createBuySignal, ensureCleanData } from "../strategy-helpers";
                import {
                    buildRollingMedian as median
                } from "./price-action-statistics-core";
            `));
            writeFile(repoRoot, "lib/strategies/lib/beta_strategy.ts", strategySource("beta_strategy", `
                import { buildCurrentOnly } from "./price-action-frequency-core";
            `));
            writeFile(repoRoot, "lib/strategies/lib/gamma_strategy.ts", strategySource("gamma_strategy", ""));
            writeFile(repoRoot, "lib/strategies/lib/delta_strategy.ts", strategySource("delta_strategy", ""));
            writeFile(repoRoot, "lib/strategies/lib/shared-helper.ts", `
                import { buildRollingMedian } from "./price-action-statistics-core";
                export function helperOnly() {}
            `);

            for (let index = 1; index <= 5; index++) {
                writeFile(repoRoot, `archive/strategy/rejected_${index}.ts`, strategySource(`rejected_${index}`, `
                    import { buildRollingMedian, missingOldHelper } from "./price-action-statistics-core";
                `));
            }

            const result = buildStrategyLibraryAudit({
                repoRoot,
                generatedAt: new Date("2026-05-18T00:00:00Z"),
            });

            expect(result.currentStrategyFileCount).to.equal(4);
            expect(result.archivedStrategyFileCount).to.equal(5);
            expect(result.generatedAt).to.equal("2026-05-18T00:00:00.000Z");

            const median = result.helperRows.find((row) => row.helperName === "buildRollingMedian");
            expect(median).to.not.equal(undefined);
            expect(median?.currentFileCount).to.equal(1);
            expect(median?.archivedFileCount).to.equal(5);
            expect(median?.currentUsageRate).to.equal(0.25);
            expect(median?.archivedUsageRate).to.equal(1);
            expect(median?.archiveLift).to.equal(4);
            expect(median?.flags).to.include("archive_heavy");
            expect(median?.currentExamples).to.deep.equal(["lib/strategies/lib/alpha_strategy.ts"]);

            const currentOnly = result.helperRows.find((row) => row.helperName === "buildCurrentOnly");
            expect(currentOnly?.flags).to.include("current_only");
            expect(currentOnly?.flags).to.include("low_evidence");

            const missing = result.helperRows.find((row) => row.helperName === "missingOldHelper");
            expect(missing?.flags).to.include("archive_only");
            expect(missing?.flags).to.include("missing_export");

            const core = result.helperRows.find((row) => row.helperName === "createBuySignal");
            expect(core?.flags).to.include("core_helper");
        } finally {
            rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it("uses archive fallback for files without a detectable Strategy type", () => {
        const repoRoot = createTempRepo();
        try {
            writeHelperExports(repoRoot);
            writeFile(repoRoot, "archive/strategy/legacy_rejected.ts", `
                import { buildRollingZScore } from "./price-action-statistics-core";
                export const legacy_rejected = {
                    name: "legacy",
                    execute: () => [],
                };
            `);

            const result = buildStrategyLibraryAudit({ repoRoot });
            const zScore = result.helperRows.find((row) => row.helperName === "buildRollingZScore");

            expect(result.archivedStrategyFileCount).to.equal(1);
            expect(zScore?.archivedFileCount).to.equal(1);
            expect(result.warnings.some((warning) => warning.includes("archive filename fallback"))).to.equal(true);
        } finally {
            rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it("throws when both scan roots are missing", () => {
        const repoRoot = createTempRepo();
        try {
            expect(() => buildStrategyLibraryAudit({ repoRoot }))
                .to.throw("No strategy audit scan roots were found.");
        } finally {
            rmSync(repoRoot, { recursive: true, force: true });
        }
    });
});
