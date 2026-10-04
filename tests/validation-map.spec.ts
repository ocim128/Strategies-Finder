import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
    buildValidationPlan,
    describeCheckCommand,
    inspectValidationMap,
    VALIDATION_CHECKS,
    VALIDATION_PLAN_FORMAT_VERSION,
    VALIDATION_RULES,
    ValidationMapError,
    type ValidationPlan,
} from "../scripts/validation-map";
import { discoverTestFiles, selectTests } from "../scripts/run-tests";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Representative inventory mirroring real spec names so every rule filter in
 * the tests below resolves. The map-integrity test separately validates all
 * filters against the real inventory.
 */
const INVENTORY = [
    "tests/feature-dom-contracts.spec.ts",
    "tests/finder-engine.spec.ts",
    "tests/finder-server-loader-parity.spec.ts",
    "tests/batch-backtest-runner.spec.ts",
    "tests/batch-backtest-server-loader-parity.spec.ts",
    "tests/sp500-top-mean-worker.spec.ts",
    "tests/trade-ledger-checker.spec.ts",
    "tests/strategy-manifest-sync.spec.ts",
    "tests/new-strategy-lib-smoke.spec.ts",
    "tests/strategy-prepared-parity.spec.ts",
    "tests/strategy-registry-loading.spec.ts",
    "tests/worker-strategy-support.spec.ts",
    "tests/strategies-lib/prepared-execution-parity.spec.ts",
    "tests/strategies-lib/strategy-normalization-parity.spec.ts",
    "tests/settings-compat.spec.ts",
    "tests/settings-handlers-shared.spec.ts",
    "tests/persisted-json.spec.ts",
    "tests/synthetic-pair-transform.spec.ts",
    "tests/data-cache.spec.ts",
    "tests/data-persistence.spec.ts",
    "tests/candle-cache.spec.ts",
    "tests/ibkr-price-data.spec.ts",
    "tests/alpaca-fetcher.spec.ts",
    "tests/crypto-data-vite-plugin.spec.ts",
    "tests/alert-service.spec.ts",
    "tests/entry-signal-worker.spec.ts",
    "tests/rust-engine-client.spec.ts",
    "tests/rust-next-open-parity.spec.ts",
    "tests/rust-settings-parity.spec.ts",
    "tests/walk-forward-engine.spec.ts",
    "tests/monte-carlo-sizing.spec.ts",
    "tests/render-scheduler.spec.ts",
    "tests/server-ibkr-csv-loader.spec.ts",
    "tests/server-crypto-csv-loader.spec.ts",
    "tests/loader-parity-example.spec.ts",
];

function planFor(changedPaths: string[]): ValidationPlan {
    return buildValidationPlan({ changedPaths, availableSpecs: INVENTORY });
}

function ruleIds(plan: ValidationPlan): string[] {
    return plan.matches.map(match => match.ruleId);
}

function guideFileExists(guide: string): boolean {
    const filePath = guide.split("#")[0];
    return fs.existsSync(path.join(appRoot, filePath));
}

describe("validation map integrity", () => {
    it("has unique rule ids, known checks, and guides for every rule", () => {
        assert.deepEqual(inspectValidationMap(), []);
    });

    it("points every rule file, directory, and guide at a real repository path", () => {
        const problems: string[] = [];
        for (const rule of VALIDATION_RULES) {
            for (const file of rule.files ?? []) {
                if (!fs.existsSync(path.join(appRoot, file))) problems.push(`${rule.id}: missing file ${file}`);
            }
            for (const directory of rule.directories ?? []) {
                if (!fs.existsSync(path.join(appRoot, directory))) problems.push(`${rule.id}: missing directory ${directory}`);
            }
            for (const guide of rule.guides) {
                if (!guideFileExists(guide)) problems.push(`${rule.id}: missing guide ${guide}`);
            }
            if (rule.summary.trim().length === 0) problems.push(`${rule.id}: empty reason summary`);
        }
        assert.deepEqual(problems, []);
    });

    it("resolves every rule filter against the real spec inventory", () => {
        const realInventory = discoverTestFiles();
        const problems: string[] = [];
        for (const rule of VALIDATION_RULES) {
            for (const filter of rule.testFilters) {
                if (selectTests(realInventory, [filter]).length === 0) {
                    problems.push(`${rule.id}: filter "${filter}" matches zero current specs`);
                }
            }
        }
        assert.deepEqual(problems, []);
    });

    it("keeps the check catalog canonical and described", () => {
        const ids = VALIDATION_CHECKS.map(check => check.id);
        assert.deepEqual([...new Set(ids)], ids);
        for (const check of VALIDATION_CHECKS) {
            assert.ok(check.title.length > 0);
            const fragment = check.id === "focused-tests"
                ? "run-tests"
                : check.id === "rust"
                    ? "cargo"
                    : check.id === "full-js"
                        ? "ci"
                        : check.id;
            assert.ok(describeCheckCommand(check.id).includes(fragment), check.id);
        }
        assert.equal(VALIDATION_PLAN_FORMAT_VERSION, 1);
    });
});

describe("validation plan routing", () => {
    it("routes finder modules to finder guides and specs", () => {
        const plan = planFor(["lib/finder/finder-engine.ts"]);
        assert.deepEqual(ruleIds(plan), ["finder"]);
        assert.deepEqual(plan.checks, ["typecheck", "typecheck:tests", "focused-tests"]);
        assert.deepEqual(plan.testFilters, ["finder-"]);
        assert.ok(plan.guides.includes("docs/finder.md"));
        assert.ok(plan.guides.includes("docs/finder-server-side.md"));
        assert.ok(plan.selectedSpecs.includes("tests/finder-engine.spec.ts"));
        assert.ok(plan.selectedSpecs.every(spec => spec.includes("finder-")));
        assert.equal(plan.fallbackApplied, false);
        assert.equal(plan.docsOnly, false);
    });

    it("matches the finder-manager file without breaking directory boundaries", () => {
        const managerPlan = planFor(["lib/finder-manager.ts"]);
        assert.deepEqual(ruleIds(managerPlan), ["finder"]);

        const neighborPlan = planFor(["lib/finderx/unrelated.ts"]);
        assert.deepEqual(ruleIds(neighborPlan), []);
        assert.deepEqual(neighborPlan.checks, ["full-js"]);
        assert.deepEqual(neighborPlan.unmatchedPaths, ["lib/finderx/unrelated.ts"]);
    });

    it("widens shared dataset loaders to both Finder and Batch contracts", () => {
        const plan = planFor(["lib/batch-backtest/batch-dataset-loader-core.ts"]);
        assert.ok(ruleIds(plan).includes("batch"));
        assert.ok(ruleIds(plan).includes("shared-dataset-loaders"));
        assert.ok(plan.testFilters.includes("batch-"));
        assert.ok(plan.testFilters.includes("loader-parity"));
        assert.ok(plan.selectedSpecs.includes("tests/finder-server-loader-parity.spec.ts"));
        assert.ok(plan.selectedSpecs.includes("tests/batch-backtest-server-loader-parity.spec.ts"));
    });

    it("lets a full JS check supersede contained typechecks and focused specs", () => {
        const plan = planFor(["lib/persisted-json.ts"]);
        assert.deepEqual(ruleIds(plan), ["shared-backtest-core"]);
        assert.deepEqual(plan.checks, ["full-js"]);
        assert.deepEqual(plan.testFilters, []);
    });

    it("keeps E2E and Rust checks additive next to a full JS check", () => {
        const plan = planFor(["lib/rust-settings-sanitizer.ts"]);
        assert.ok(ruleIds(plan).includes("shared-backtest-core"));
        assert.ok(ruleIds(plan).includes("rust-engine"));
        assert.deepEqual(plan.checks, ["full-js", "rust"]);
    });

    it("routes HTML partials to the DOM contract spec and E2E", () => {
        const plan = planFor(["html-partials/tab-finder.html"]);
        assert.deepEqual(ruleIds(plan), ["dom-partials"]);
        assert.ok(plan.checks.includes("e2e"));
        assert.ok(plan.checks.includes("focused-tests"));
        assert.deepEqual(plan.testFilters, ["feature-dom-contracts"]);
    });

    it("routes DOM contract modules additively with their owning feature", () => {
        const plan = planFor(["lib/finder/finder-ui-dom.ts"]);
        assert.ok(ruleIds(plan).includes("dom-contract"));
        assert.ok(ruleIds(plan).includes("finder"));
        assert.ok(plan.testFilters.includes("feature-dom-contracts"));
        assert.ok(plan.testFilters.includes("finder-"));
    });

    it("routes strategy sources and generated manifests to authoring specs", () => {
        for (const changed of ["lib/strategies/lib/ema_confirmation.ts", "lib/strategies/manifest-eager.ts"]) {
            const plan = planFor([changed]);
            assert.deepEqual(ruleIds(plan), ["strategy-authoring"], changed);
            for (const filter of [
                "strategy-manifest-sync",
                "new-strategy-lib-smoke",
                "strategy-prepared-parity",
                "strategy-registry-loading",
                "worker-strategy-support",
                "strategies-lib",
            ]) {
                assert.ok(plan.testFilters.includes(filter), `${changed} should select ${filter}`);
            }
            assert.ok(plan.matches[0].notes.some(note => note.includes("strategies:sync-manifest")));
        }
    });

    it("treats documentation-only changes as an explicit no-op", () => {
        const plan = planFor(["docs/finder.md", "README.md"]);
        assert.deepEqual(ruleIds(plan), ["docs"]);
        assert.deepEqual(plan.checks, []);
        assert.equal(plan.docsOnly, true);
        assert.equal(plan.fallbackApplied, false);
        assert.deepEqual(plan.testFilters, []);
        assert.deepEqual(plan.selectedSpecs, []);

        const mixed = planFor(["docs/finder.md", "lib/finder/finder-engine.ts"]);
        assert.equal(mixed.docsOnly, false);
        assert.deepEqual(mixed.checks, ["typecheck", "typecheck:tests", "focused-tests"]);
    });

    it("routes startup, layout, and E2E surfaces to browser E2E", () => {
        for (const changed of ["lib/app-bootstrap.ts", "tests/e2e.spec.ts", "index.ts"]) {
            const plan = planFor([changed]);
            assert.ok(ruleIds(plan).includes("e2e-and-startup"), changed);
            assert.ok(plan.checks.includes("e2e"), changed);
            assert.equal(plan.unmatchedPaths.length, 0, changed);
        }
        // The excluded E2E spec is not in the runner inventory, so no self
        // filter may be added for it.
        assert.equal(planFor(["tests/e2e.spec.ts"]).testFilters.includes("tests/e2e.spec.ts"), false);
    });

    it("routes the Rust engine to Rust checks and parity specs", () => {
        const plan = planFor(["rust-engine/src/lib.rs"]);
        assert.deepEqual(ruleIds(plan), ["rust-engine"]);
        assert.ok(plan.checks.includes("rust"));
        assert.deepEqual(plan.testFilters, ["rust-"]);
        assert.ok(plan.selectedSpecs.includes("tests/rust-next-open-parity.spec.ts"));
    });

    it("routes build and CI tooling to full JS checks", () => {
        for (const changed of ["package.json", "tsconfig.tests.json", "vite.config.ts", ".github/workflows/strategies-finder-test-specs.yml"]) {
            const plan = planFor([changed]);
            assert.ok(ruleIds(plan).includes("build-tooling"), changed);
            assert.ok(plan.checks.includes("full-js"), changed);
        }
    });

    it("routes validation tooling to full JS checks", () => {
        const plan = planFor(["scripts/validate-changes.ts"]);
        assert.deepEqual(ruleIds(plan), ["validation-tooling"]);
        assert.deepEqual(plan.checks, ["full-js"]);
    });

    it("maps the render scheduler to its dedicated spec", () => {
        const plan = planFor(["lib/render-scheduler.ts"]);
        assert.deepEqual(ruleIds(plan), ["render-scheduler"]);
        assert.deepEqual(plan.checks, ["typecheck", "typecheck:tests", "focused-tests"]);
        assert.deepEqual(plan.testFilters, ["render-scheduler"]);
        assert.ok(plan.selectedSpecs.includes("tests/render-scheduler.spec.ts"));
    });

    it("falls back to full JS for renderer modules without mapped behavioral specs", () => {
        const plan = planFor(["lib/renderers/resultsRenderer.ts"]);
        assert.deepEqual(ruleIds(plan), ["chart-renderers"]);
        assert.deepEqual(plan.checks, ["full-js"]);
        assert.deepEqual(plan.selectedSpecs, []);
        assert.ok(plan.matches[0].notes.length > 0);
    });

    it("schedules both typechecks and the focused run for spec-only changes", () => {
        const plan = planFor(["tests/finder-engine.spec.ts"]);
        assert.ok(plan.testFilters.includes("tests/finder-engine.spec.ts"));
        assert.ok(plan.selectedSpecs.includes("tests/finder-engine.spec.ts"));
        assert.deepEqual(plan.checks, ["typecheck", "typecheck:tests", "focused-tests"]);
        assert.equal(plan.docsOnly, false);
        assert.deepEqual(plan.unmatchedPaths, []);
        assert.equal(plan.fallbackApplied, false);
    });

    it("falls back instead of silently passing when a spec was deleted", () => {
        const plan = planFor(["tests/retired-feature.spec.ts"]);
        assert.deepEqual(plan.unmatchedPaths, ["tests/retired-feature.spec.ts"]);
        assert.equal(plan.fallbackApplied, true);
        assert.deepEqual(plan.checks, ["full-js"]);
    });

    it("routes deleted known tooling specs by their former path", () => {
        const plan = planFor(["tests/validation-map.spec.ts"]);
        assert.ok(ruleIds(plan).includes("validation-tooling"));
        assert.deepEqual(plan.unmatchedPaths, []);
    });

    it("falls back to full JS for unclassified files and reports the path", () => {
        const plan = planFor(["assets/mystery-payload.bin"]);
        assert.deepEqual(ruleIds(plan), []);
        assert.deepEqual(plan.unmatchedPaths, ["assets/mystery-payload.bin"]);
        assert.deepEqual(plan.checks, ["full-js"]);
    });

    it("normalizes Windows separators and matches case-insensitively", () => {
        const plan = planFor(["LIB\\FINDER\\Finder-Engine.TS"]);
        assert.deepEqual(ruleIds(plan), ["finder"]);
        assert.deepEqual(plan.unmatchedPaths, []);
    });

    it("deduplicates and sorts changed paths deterministically", () => {
        const plan = planFor([
            "lib/batch/zz.ts",
            "docs/finder.md",
            "lib/finder/finder-engine.ts",
            "docs/finder.md",
            "lib\\finder\\finder-engine.ts",
        ]);
        assert.deepEqual(plan.changedPaths, ["docs/finder.md", "lib/batch/zz.ts", "lib/finder/finder-engine.ts"]);
        const again = buildValidationPlan({
            changedPaths: [...plan.changedPaths].reverse(),
            availableSpecs: INVENTORY,
        });
        assert.deepEqual(again, plan);
    });

    it("reports an empty change set as a no-op rather than docs-only", () => {
        const plan = planFor([]);
        assert.deepEqual(plan.changedPaths, []);
        assert.deepEqual(plan.matches, []);
        assert.deepEqual(plan.checks, []);
        assert.equal(plan.docsOnly, false);
        assert.equal(plan.fallbackApplied, false);
    });

    it("errors when a rule filter matches zero specs instead of planning cleanly", () => {
        assert.throws(
            () => buildValidationPlan({ changedPaths: ["lib/finder/finder-engine.ts"], availableSpecs: [] }),
            (error: unknown) => error instanceof ValidationMapError
                && error.issues.some(issue => issue.includes('Rule "finder"') && issue.includes('"finder-"')),
        );
    });

    it("selects no code checks for docs even when other rules also match paths", () => {
        const plan = planFor(["docs/settings.md", "workers/README.md", "DEPLOY_TO_VERCEL.md"]);
        assert.deepEqual(ruleIds(plan), ["docs"]);
        assert.equal(plan.docsOnly, true);
    });
});
