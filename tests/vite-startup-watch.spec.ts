import { expect } from "chai";
import { it } from "node:test";
import path from "node:path";
import { createFilter, loadConfigFromFile } from "vite";

it("watches UI source without crawling generated research data at startup", { timeout: 15_000 }, async () => {
    const loaded = await loadConfigFromFile(
        { command: "serve", mode: "development" },
        path.resolve("vite.config.ts"),
    );
    expect(loaded, "the app's Vite config must load").not.to.equal(null);
    const ignored = loaded!.config.server?.watch?.ignored as string[];
    const isWatched = createFilter(undefined, ignored);
    const sourceFiles = [
        "index.ts",
        "styles/base.css",
        "html-partials/header.html",
        "lib/app-bootstrap.ts",
        // Regression guard for root-anchored ignores: these live under a folder
        // name that is ALSO a runtime output tree at the repo root. A
        // depth-agnostic `**/signals/**` (or `**/dist/**`) would silently stop
        // hot reload here.
        "lib/signals/example.ts",
        "lib/dist/example.ts",
        "lib/asset-opportunity-analysis-notes.ts",
    ];
    const generatedFiles = [
        "archive/mining-ledger/run/feature-packs/columns/hash/values.bin",
        "artifacts/test-logs/latest/results.json",
        "batch-runs/run/report.html",
        "price-data/ibkr/csv/30m/SPY.csv",
        "logs/paper-execution/strategy/run.json",
        "reports/run/index.html",
        "rust-engine/target/release/build/output.bin",
        ".freebuff/worktrees/copy/index.html",
        "screenshots/run/capture.png",
        // Aborted specs used to leave these in the repo root (now mkdtemp'd).
        "asset-opportunity-analysis-abc123/fixture.json",
        // Runtime output trees of the app and of local tooling.
        "signals/pass/2026-01-01.json",
        "dist/index.html",
        ".kilo/cache/state.json",
        ".zcode/session.json",
        ".workbuddy-ai/state.json",
        ".codegraph/index.db",
        ".hermes/log.json",
        ".wrangler/state/v3/cache.json",
        ".wt-tmp/copy/lib/app-bootstrap.ts",
    ];
    for (const file of sourceFiles) {
        expect(isWatched(path.resolve(file)), `${file} must still support UI hot reload`).to.equal(true);
    }
    for (const file of generatedFiles) {
        expect(isWatched(path.resolve(file)), `${file} must not consume a filesystem watcher`).to.equal(false);
        expect(isWatched(path.dirname(path.resolve(file))), `${file}'s directory must not be crawled`).to.equal(false);
    }
    expect(loaded!.config.optimizeDeps?.entries,
        "dependency scanning must start at the app entry rather than crawl archived HTML reports").to.deep.equal(["index.html"]);
});
