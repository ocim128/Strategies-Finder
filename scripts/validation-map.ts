/**
 * Change-to-validation routing map and pure plan construction.
 *
 * Maps repository paths to guides, focused test filters, and fixed checks so
 * `npm run validate:changes` can propose a validation plan for the current
 * Git changes. Rules are additive: every matching rule contributes its guides,
 * filters, and checks, and the planner unions and deduplicates the result.
 *
 * This table is manually maintained. It cannot prove semantic impact: shared
 * modules are expressed as extra widening rules, and unclassified
 * non-documentation paths fall back to the full JS checks. Caller inspection
 * per AGENTS.md is still required. See README.md "Validating changes" and
 * docs/settings.md for where this command fits.
 */

import { selectTests } from "./run-tests";

export const VALIDATION_PLAN_FORMAT_VERSION = 1;

export type ValidationCheckId =
    | "typecheck"
    | "typecheck:tests"
    | "focused-tests"
    | "full-js"
    | "e2e"
    | "rust";

export type ValidationCheckCommand =
    | { kind: "npm-script"; script: string }
    | { kind: "focused-tests" }
    | { kind: "rust-cargo" };

export type ValidationCheckDefinition = {
    id: ValidationCheckId;
    title: string;
    /** How the check executes; mirrored by the human report. */
    command: ValidationCheckCommand;
    /** Contained checks that this check makes redundant when selected. */
    supersedes: readonly ValidationCheckId[];
};

/** Canonical order also defines execution and display order. */
export const VALIDATION_CHECKS: readonly ValidationCheckDefinition[] = [
    {
        id: "typecheck",
        title: "Application typecheck",
        command: { kind: "npm-script", script: "typecheck" },
        supersedes: [],
    },
    {
        id: "typecheck:tests",
        title: "Test typecheck",
        command: { kind: "npm-script", script: "typecheck:tests" },
        supersedes: [],
    },
    {
        id: "focused-tests",
        title: "Focused spec run",
        command: { kind: "focused-tests" },
        supersedes: [],
    },
    {
        id: "full-js",
        title: "Full JS verification and build budget (npm run ci)",
        command: { kind: "npm-script", script: "ci" },
        supersedes: ["typecheck", "typecheck:tests", "focused-tests"],
    },
    {
        id: "e2e",
        title: "Browser E2E smoke (npm run test:e2e)",
        command: { kind: "npm-script", script: "test:e2e" },
        supersedes: [],
    },
    {
        id: "rust",
        title: "Rust format, tests, and clippy (rust-engine/)",
        command: { kind: "rust-cargo" },
        supersedes: [],
    },
];

const CHECKS_BY_ID: Map<string, ValidationCheckDefinition> = new Map(
    VALIDATION_CHECKS.map(check => [check.id, check]),
);

/** Checks selected by a typical focused plan: both typechecks plus one filtered spec invocation. */
const FOCUSED_JS_CHECKS: readonly ValidationCheckId[] = ["typecheck", "typecheck:tests", "focused-tests"];

export type ValidationRule = {
    /** Stable identifier used in plans, JSON output, and tests. */
    id: string;
    /** Human-readable reason template shown when the rule selects checks. */
    summary: string;
    /** Exact repository-relative file paths (slash-separated). */
    files?: readonly string[];
    /** Directory prefixes matched on directory boundaries (`lib/finder/`). */
    directories?: readonly string[];
    /** Path suffixes, matched against the slash-normalized path. */
    suffixes?: readonly string[];
    /** Advisory documentation references (repo-relative, optional #anchor). */
    guides: readonly string[];
    /** Test runner filters; each must individually match at least one spec. */
    testFilters: readonly string[];
    checks: readonly ValidationCheckId[];
    notes?: readonly string[];
};

/**
 * Routing rules mirroring the AGENTS.md "Route by change" table.
 *
 * Shared modules get explicit widening rules instead of a dependency graph:
 * a file may match several rules, and the union of their outputs is selected.
 * Directory rules intentionally do not swallow shared files that live inside
 * them (for example `batch-dataset-loader-core.ts` inside `lib/batch-backtest/`
 * is also imported by Finder, so it carries its own widening rule).
 */
export const VALIDATION_RULES: readonly ValidationRule[] = [
    {
        id: "docs",
        summary: "Documentation-only change; no code checks are selected and code was not validated.",
        suffixes: [".md"],
        guides: ["docs/README.md"],
        testFilters: [],
        checks: [],
    },
    {
        id: "finder",
        summary: "Finder module changed; Finder guides and finder- specs select.",
        directories: ["lib/finder/"],
        files: ["lib/finder-manager.ts"],
        guides: ["docs/finder.md", "docs/finder-server-side.md"],
        testFilters: ["finder-"],
        checks: FOCUSED_JS_CHECKS,
    },
    {
        id: "batch",
        summary: "Batch Backtest module changed; Batch guide and batch-, sp500-top-mean-, and trade-ledger specs select.",
        directories: ["lib/batch-backtest/"],
        guides: ["docs/batch-backtest-server-side.md", "docs/trade-ledger.md"],
        testFilters: ["batch-", "sp500-top-mean-", "trade-ledger-"],
        checks: FOCUSED_JS_CHECKS,
    },
    {
        id: "dom-partials",
        summary: "HTML partial changed; the DOM contract spec and browser E2E select.",
        directories: ["html-partials/"],
        guides: ["README.md#ui-structure"],
        testFilters: ["feature-dom-contracts"],
        checks: [...FOCUSED_JS_CHECKS, "e2e"],
    },
    {
        id: "dom-contract",
        summary: "Feature DOM contract module changed; the DOM contract spec selects alongside owner rules.",
        suffixes: ["-dom.ts"],
        guides: ["README.md#ui-structure"],
        testFilters: ["feature-dom-contracts"],
        checks: FOCUSED_JS_CHECKS,
    },
    {
        id: "strategy-authoring",
        summary: "Built-in strategy source or generated manifest changed; strategy authoring specs select.",
        directories: ["lib/strategies/lib/"],
        files: [
            "lib/strategies/manifest-eager.ts",
            "lib/strategies/manifest-summary.ts",
            "lib/strategies/manifest-loaders.ts",
            "lib/strategies/manifest-keys.ts",
        ],
        guides: ["docs/strategy-authoring.md"],
        testFilters: [
            "strategy-manifest-sync",
            "new-strategy-lib-smoke",
            "strategy-prepared-parity",
            "strategy-registry-loading",
            "worker-strategy-support",
            "strategies-lib",
        ],
        checks: FOCUSED_JS_CHECKS,
        notes: [
            "Generated manifests: run `npm run strategies:sync-manifest` after strategy source changes; never edit manifest files by hand.",
        ],
    },
    {
        id: "shared-backtest-core",
        summary: "Shared backtest engine, strategy helper, settings model, or persistence file changed; full JS verification runs so every focused suite, including Rust parity specs, is covered.",
        files: [
            "lib/backtest-service.ts",
            "lib/settings-model.ts",
            "lib/settings-manager.ts",
            "lib/persisted-json.ts",
            "lib/rust-settings-sanitizer.ts",
            "lib/time-key.ts",
            "lib/time-normalization.ts",
            "lib/constants.ts",
            "lib/strategies/backtest.ts",
            "lib/strategies/strategy-helpers.ts",
            "lib/strategies/indicators.ts",
            "lib/strategies/entry-eval.ts",
        ],
        directories: ["lib/strategies/backtest/"],
        guides: ["docs/backtest-engines-typescript-rust.md", "docs/settings.md", "docs/path-dependent-exits.md"],
        testFilters: [],
        checks: ["full-js"],
    },
    {
        id: "shared-dataset-loaders",
        summary: "Shared server dataset loader changed; both Finder and Batch loader-parity and data contracts select because Finder imports Batch loaders.",
        files: [
            "lib/batch-backtest/batch-dataset-loader-core.ts",
            "lib/batch-backtest/server-ibkr-csv-loader.ts",
            "lib/batch-backtest/server-crypto-csv-loader.ts",
            "lib/batch-backtest/server-batch-data-loader.ts",
        ],
        guides: ["docs/finder-server-side.md", "docs/batch-backtest-server-side.md"],
        testFilters: ["loader-parity", "server-ibkr-csv-loader", "server-crypto-csv-loader"],
        checks: FOCUSED_JS_CHECKS,
    },
    {
        id: "synthetic-pair-helpers",
        summary: "Synthetic pair helper changed; synthetic- data contracts select.",
        files: [
            "lib/synthetic-pair-parser.ts",
            "lib/synthetic-leg-identity.ts",
            "lib/synthetic-pair-session.ts",
            "lib/synthetic-pair-token.ts",
        ],
        guides: ["docs/synthetic-pairs.md"],
        testFilters: ["synthetic-"],
        checks: FOCUSED_JS_CHECKS,
    },
    {
        id: "price-data",
        summary: "Price data or caching module changed; price-data guide and data contract specs select.",
        directories: ["lib/data/", "lib/market-data/"],
        files: [
            "lib/data-manager.ts",
            "lib/candle-cache.ts",
            "lib/ohlcv-binary.ts",
            "lib/local-daily-datasets.ts",
            "lib/local-data-cache-invalidation.ts",
            "lib/local-sqlite-api.ts",
            "lib/local-sqlite-vite-plugin.ts",
            "lib/tradfi-pair-data.ts",
        ],
        guides: ["docs/price-data.md"],
        testFilters: ["data-", "candle-cache"],
        checks: FOCUSED_JS_CHECKS,
    },
    {
        id: "ibkr-crypto-data",
        summary: "IBKR or Crypto data surface changed; sync guide and ibkr-/alpaca-/crypto- specs select.",
        directories: ["lib/ibkr-data/", "lib/crypto-data/"],
        guides: ["docs/alpaca-ibkr-sync.md"],
        testFilters: ["ibkr-", "alpaca-", "crypto-"],
        checks: FOCUSED_JS_CHECKS,
    },
    {
        id: "alerts",
        summary: "Alert module changed; alert- specs select.",
        files: [
            "lib/alert-service.ts",
            "lib/alert-storage.ts",
            "lib/alert-config-resolver.ts",
            "lib/alert-evaluation-window.ts",
            "lib/alert-signal-utils.ts",
            "lib/alert-stream-id.ts",
            "lib/alert-modals.ts",
            "lib/alert-subscription-renderer.ts",
            "lib/alert-subscription-utils.ts",
            "lib/alert-worker-compat.ts",
            "lib/current-alert-subscription.ts",
        ],
        guides: ["workers/README.md"],
        testFilters: ["alert-"],
        checks: FOCUSED_JS_CHECKS,
    },
    {
        id: "workers",
        summary: "Worker API changed; Worker and alert specs select.",
        directories: ["workers/"],
        guides: ["workers/README.md"],
        testFilters: ["entry-signal-worker", "worker-strategy-support", "alert-"],
        checks: FOCUSED_JS_CHECKS,
    },
    {
        id: "settings-ui",
        summary: "Settings UI or handler module changed; settings- specs select.",
        files: [
            "lib/settings-dom.ts",
            "lib/settings-manager-dom.ts",
            "lib/settings-parse-utils.ts",
            "lib/settings-workspace-model.ts",
            "lib/strategy-panel-settings-registry.ts",
            "lib/handlers/settings-handlers.ts",
            "lib/handlers/settings-handlers-dom.ts",
            "lib/handlers/settings-handlers-shared.ts",
            "lib/handlers/settings-section-handlers.ts",
            "lib/handlers/settings-ux-handlers.ts",
            "lib/handlers/settings-workspace.ts",
        ],
        guides: ["docs/settings.md"],
        testFilters: ["settings-"],
        checks: FOCUSED_JS_CHECKS,
    },
    {
        id: "chart-renderers",
        summary: "Chart or renderer module changed; full JS verification runs because behavioral renderer coverage has no stable spec mapping.",
        directories: ["lib/renderers/"],
        files: [
            "lib/backtest-chart-renderer.ts",
            "lib/chart-manager.ts",
            "lib/chart-manager-dom.ts",
        ],
        guides: ["README.md#chart-and-renderer-layer"],
        testFilters: [],
        checks: ["full-js"],
        notes: [
            "No behavioral spec maps to these renderer files; run `npm run test -- <filter>` for the owning feature's spec chosen by inspection (AGENTS.md) while iterating.",
        ],
    },
    {
        id: "render-scheduler",
        summary: "Render scheduler changed; its dedicated spec selects.",
        files: ["lib/render-scheduler.ts"],
        guides: ["README.md#chart-and-renderer-layer"],
        testFilters: ["render-scheduler"],
        checks: FOCUSED_JS_CHECKS,
    },
    {
        id: "walk-forward",
        summary: "Walk Forward module changed; walk-forward- specs select.",
        files: [
            "lib/walk-forward-service.ts",
            "lib/walk-forward-dom.ts",
            "lib/walk-forward-formatters.ts",
            "lib/walk-forward-range-utils.ts",
            "lib/walk-forward-thresholds.ts",
            "lib/walk-forward-auto-suggest.ts",
            "lib/walk-forward-ui.ts",
            "lib/strategies/walk-forward.ts",
            "lib/strategies/walk-forward-decay.ts",
        ],
        guides: ["README.md"],
        testFilters: ["walk-forward-"],
        checks: FOCUSED_JS_CHECKS,
    },
    {
        id: "monte-carlo",
        summary: "Monte Carlo module changed; monte-carlo specs select.",
        files: [
            "lib/monte-carlo-dom.ts",
            "lib/monte-carlo-renderer.ts",
            "lib/monte-carlo-service.ts",
        ],
        directories: ["lib/strategies/monte-carlo/"],
        guides: ["README.md"],
        testFilters: ["monte-carlo"],
        checks: FOCUSED_JS_CHECKS,
    },
    {
        id: "e2e-and-startup",
        summary: "E2E spec, startup, or layout module changed; browser E2E plus the DOM contract spec select.",
        files: [
            "tests/e2e.spec.ts",
            "index.ts",
            "index.html",
            "lib/app-bootstrap.ts",
            "lib/layout-manager.ts",
            "lib/ui-manager.ts",
            "lib/ui-manager-dom.ts",
        ],
        guides: ["README.md#how-it-boots"],
        testFilters: ["feature-dom-contracts"],
        checks: [...FOCUSED_JS_CHECKS, "e2e"],
    },
    {
        id: "rust-engine",
        summary: "Rust engine or client/wire contract changed; Rust format/test/clippy and rust- parity specs select.",
        directories: ["rust-engine/"],
        files: [
            "lib/rust-engine-client.ts",
            "lib/rust-backtest-result-validator.ts",
            "lib/rust-settings-sanitizer.ts",
        ],
        guides: ["docs/backtest-engines-typescript-rust.md"],
        testFilters: ["rust-"],
        checks: [...FOCUSED_JS_CHECKS, "rust"],
    },
    {
        id: "build-tooling",
        summary: "Package, lockfile, tsconfig, Vite/build config, or CI config changed; full JS verification runs. E2E and Rust select additively when their own surfaces change.",
        files: [
            "package.json",
            "package-lock.json",
            "tsconfig.json",
            "tsconfig.tests.json",
            "tsconfig.types.json",
            "vite.config.ts",
        ],
        directories: [".github/"],
        guides: ["README.md#validation-commands"],
        testFilters: [],
        checks: ["full-js"],
    },
    {
        id: "validation-tooling",
        summary: "Validation routing tooling changed; full JS verification runs and planning should be re-smoked with `npm run validate:changes`.",
        files: [
            "scripts/validation-map.ts",
            "scripts/validate-changes.ts",
            "scripts/run-tests.ts",
            "tests/validation-map.spec.ts",
            "tests/validate-changes.spec.ts",
            "tests/test-runner-contract.spec.ts",
        ],
        guides: ["AGENTS.md"],
        testFilters: [],
        checks: ["full-js"],
    },
];

const RULES_BY_ID = new Map(VALIDATION_RULES.map(rule => [rule.id, rule]));

export type PlannedRuleMatch = {
    ruleId: string;
    summary: string;
    /** Changed paths (original casing) that triggered this rule. */
    paths: string[];
    guides: string[];
    testFilters: string[];
    checks: ValidationCheckId[];
    notes: string[];
};

export type ValidationPlan = {
    formatVersion: number;
    /** Sorted, deduplicated, slash-normalized changed paths (original casing). */
    changedPaths: string[];
    matches: PlannedRuleMatch[];
    /** Paths matched no rule and received the full-JS fallback. */
    unmatchedPaths: string[];
    fallbackApplied: boolean;
    guides: string[];
    /** Validated, deduplicated filters for the single focused spec invocation. */
    testFilters: string[];
    /** Specs the resolved filters select from the current inventory. */
    selectedSpecs: string[];
    /** Canonical-ordered, deduplicated checks after superseding. */
    checks: ValidationCheckId[];
    /** True when every change is documentation and no code check selects. */
    docsOnly: boolean;
};

export type ValidationPlanInput = {
    /** Repository-relative paths with any separator; originals are reported. */
    changedPaths: readonly string[];
    /** Current spec inventory from the test runner's discovery. */
    availableSpecs: readonly string[];
};

/** Planning refused to produce a plan; `issues` lists every blocker. */
export class ValidationMapError extends Error {
    readonly issues: string[];

    constructor(issues: string[]) {
        super(`Invalid validation plan: ${issues.join("; ")}`);
        this.name = "ValidationMapError";
        this.issues = issues;
    }
}

export function toPosixPath(value: string): string {
    return value.replace(/\\/g, "/");
}

/** Lowercased posix form used only for matching; reports keep original casing. */
export function toMatchKey(value: string): string {
    return toPosixPath(value).toLowerCase();
}

/** Prefix that preserves directory boundaries: `lib/finder` -> `lib/finder/`. */
function directoryPrefix(directory: string): string {
    const normalized = toMatchKey(directory);
    return normalized.endsWith("/") ? normalized : `${normalized}/`;
}

function ruleMatchesPath(rule: ValidationRule, matchKey: string): boolean {
    if (rule.files?.some(file => toMatchKey(file) === matchKey)) return true;
    if (rule.directories?.some(directory => matchKey.startsWith(directoryPrefix(directory)))) return true;
    if (rule.suffixes?.some(suffix => matchKey.endsWith(toMatchKey(suffix)))) return true;
    return false;
}

const CHANGED_SPEC_PATTERN = /^tests\/.+\.spec\.ts$/;

function compareStrings(left: string, right: string): number {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
}

/**
 * Build a deterministic validation plan from changed paths.
 *
 * Every rule filter is validated individually against `availableSpecs` using
 * the runner's `selectTests()` semantics, because selection alone only detects an
 * empty aggregate selection. A filter matching zero specs is map rot and
 * raises `ValidationMapError` instead of an apparently clean plan.
 */
export function buildValidationPlan(input: ValidationPlanInput): ValidationPlan {
    const changedPaths: string[] = [];
    const seenPaths = new Set<string>();
    for (const changed of input.changedPaths) {
        const key = toMatchKey(changed);
        if (!key || seenPaths.has(key)) continue;
        seenPaths.add(key);
        changedPaths.push(toPosixPath(changed));
    }
    changedPaths.sort((left, right) => compareStrings(toMatchKey(left), toMatchKey(right)));

    const specByKey = new Map<string, string>();
    for (const spec of input.availableSpecs) {
        specByKey.set(toMatchKey(spec), toPosixPath(spec));
    }

    const matchesByRuleId = new Map<string, PlannedRuleMatch>();
    const unmatchedPaths: string[] = [];
    const selfFilters = new Set<string>();

    for (const changed of changedPaths) {
        const key = toMatchKey(changed);

        const matchedRules = VALIDATION_RULES.filter(rule => ruleMatchesPath(rule, key));
        // Documentation paths (docs-only rules, e.g. any Markdown file) are
        // classified as documentation even when a code rule's directory also
        // contains them (workers/README.md); only docs rules contribute.
        const docsOnlyPath = matchedRules.some(rule => rule.checks.length === 0);
        const effectiveRules = docsOnlyPath
            ? matchedRules.filter(rule => rule.checks.length === 0)
            : matchedRules;
        for (const rule of effectiveRules) {
            let match = matchesByRuleId.get(rule.id);
            if (!match) {
                match = {
                    ruleId: rule.id,
                    summary: rule.summary,
                    paths: [],
                    guides: [...rule.guides],
                    testFilters: [...rule.testFilters],
                    checks: [...rule.checks],
                    notes: [...(rule.notes ?? [])],
                };
                matchesByRuleId.set(rule.id, match);
            }
            match.paths.push(changed);
        }

        if (CHANGED_SPEC_PATTERN.test(key)) {
            const inventoryPath = specByKey.get(key);
            if (inventoryPath) {
                // Existing spec: include it directly in the focused invocation.
                selfFilters.add(inventoryPath);
            } else if (effectiveRules.length === 0) {
                // Deleted or renamed-away spec: former-path routing found
                // nothing, so fall back instead of silently passing.
                unmatchedPaths.push(changed);
            }
            continue;
        }

        if (effectiveRules.length === 0) {
            unmatchedPaths.push(changed);
        }
    }

    const issues: string[] = [];
    const ruleFilters: string[] = [];
    for (const match of matchesByRuleId.values()) {
        for (const filter of match.testFilters) {
            if (selectTests(input.availableSpecs, [filter]).length === 0) {
                issues.push(`Rule "${match.ruleId}" filter "${filter}" matches zero known specs.`);
            } else {
                ruleFilters.push(filter);
            }
        }
    }
    if (issues.length > 0) {
        throw new ValidationMapError(issues);
    }

    const rawChecks = new Set<ValidationCheckId>();
    for (const match of matchesByRuleId.values()) {
        for (const checkId of match.checks) {
            if (!CHECKS_BY_ID.has(checkId)) {
                throw new ValidationMapError([`Rule "${match.ruleId}" references unknown check "${checkId}".`]);
            }
            rawChecks.add(checkId);
        }
    }
    // A changed existing spec schedules the focused trio even when no other
    // rule matched; otherwise spec-only changes would validate nothing.
    if (selfFilters.size > 0) {
        for (const checkId of FOCUSED_JS_CHECKS) {
            rawChecks.add(checkId);
        }
    }
    if (unmatchedPaths.length > 0) {
        rawChecks.add("full-js");
    }

    // A full JS check supersedes its contained typechecks/spec steps rather
    // than rerunning them. E2E and Rust always stay explicit.
    const superseded = new Set<ValidationCheckId>();
    for (const checkId of rawChecks) {
        for (const containedId of CHECKS_BY_ID.get(checkId)?.supersedes ?? []) {
            superseded.add(containedId);
        }
    }
    const checks = VALIDATION_CHECKS
        .map(check => check.id)
        .filter(checkId => rawChecks.has(checkId) && !superseded.has(checkId));

    const selectedFilters = [...new Set([...ruleFilters, ...selfFilters])].sort(compareStrings);
    // Empty filters mean "all specs" to selectTests(), so a resolved selection
    // is only reported when the focused run is actually scheduled.
    const selectedSpecs = checks.includes("focused-tests")
        ? [...new Set(selectTests(input.availableSpecs, selectedFilters))].sort(compareStrings)
        : [];

    const guides = new Set<string>();
    for (const match of matchesByRuleId.values()) {
        for (const guide of match.guides) guides.add(guide);
    }

    const matches = [...matchesByRuleId.values()]
        .sort((left, right) => {
            const leftIndex = VALIDATION_RULES.findIndex(rule => rule.id === left.ruleId);
            const rightIndex = VALIDATION_RULES.findIndex(rule => rule.id === right.ruleId);
            return leftIndex - rightIndex;
        })
        .map(match => ({ ...match, paths: [...match.paths].sort(compareStrings) }));

    return {
        formatVersion: VALIDATION_PLAN_FORMAT_VERSION,
        changedPaths,
        matches,
        unmatchedPaths: [...unmatchedPaths].sort(compareStrings),
        fallbackApplied: unmatchedPaths.length > 0,
        guides: [...guides].sort(compareStrings),
        testFilters: selectedFilters,
        selectedSpecs,
        checks,
        docsOnly: checks.length === 0 && changedPaths.length > 0,
    };
}

export type MapIssue = { ruleId: string; issue: string };

/**
 * Static integrity audit used by tests and `--check-map`: unique rule ids,
 * known check ids, non-empty guides, and no redundant matchers. Path/filter
 * existence is verified by the specs, which have filesystem access.
 */
export function inspectValidationMap(): MapIssue[] {
    const issues: MapIssue[] = [];
    const seenRuleIds = new Set<string>();

    for (const rule of VALIDATION_RULES) {
        if (seenRuleIds.has(rule.id)) {
            issues.push({ ruleId: rule.id, issue: "Duplicate rule id." });
        }
        seenRuleIds.add(rule.id);

        if (rule.guides.length === 0) {
            issues.push({ ruleId: rule.id, issue: "Rule has no guide references." });
        }
        if (!rule.files?.length && !rule.directories?.length && !rule.suffixes?.length) {
            issues.push({ ruleId: rule.id, issue: "Rule has no files, directories, or suffixes and can never match." });
        }
        for (const checkId of rule.checks) {
            if (!CHECKS_BY_ID.has(checkId)) {
                issues.push({ ruleId: rule.id, issue: `Unknown check id "${checkId}".` });
            }
        }
        if (rule.checks.length === 0 && rule.testFilters.length > 0) {
            issues.push({ ruleId: rule.id, issue: "Docs-only rule still selects test filters." });
        }
        for (const checkId of rule.checks) {
            for (const supersededId of CHECKS_BY_ID.get(checkId)?.supersedes ?? []) {
                if (rule.checks.includes(supersededId)) {
                    issues.push({ ruleId: rule.id, issue: `Rule selects "${checkId}" and its contained "${supersededId}".` });
                }
            }
        }
    }

    for (const check of VALIDATION_CHECKS) {
        for (const supersededId of check.supersedes) {
            if (!CHECKS_BY_ID.has(supersededId)) {
                issues.push({ ruleId: check.id, issue: `Superseded id "${supersededId}" is not a known check.` });
            }
        }
    }

    return issues;
}

export function getValidationRule(ruleId: string): ValidationRule | undefined {
    return RULES_BY_ID.get(ruleId);
}

export function getValidationCheck(checkId: string): ValidationCheckDefinition | undefined {
    return CHECKS_BY_ID.get(checkId);
}

/** Human-readable execution description for a check (used by reports). */
export function describeCheckCommand(checkId: ValidationCheckId, filters?: readonly string[]): string {
    const check = CHECKS_BY_ID.get(checkId);
    if (!check) return checkId;
    if (check.command.kind === "npm-script") return `npm run ${check.command.script}`;
    if (check.command.kind === "rust-cargo") {
        return [
            "cargo fmt --manifest-path rust-engine/Cargo.toml -- --check",
            "cargo test --manifest-path rust-engine/Cargo.toml",
            "cargo clippy --manifest-path rust-engine/Cargo.toml --all-targets -- -D warnings",
        ].join(" && ");
    }
    const filterText = filters && filters.length > 0
        ? ` ${filters.join(" ")}`
        : " <resolved filters>";
    return `esno scripts/run-tests.ts${filterText} --json (single invocation)`;
}
