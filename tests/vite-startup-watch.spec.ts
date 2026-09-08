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
    const sourceFiles = ["index.ts", "styles/base.css", "html-partials/header.html", "lib/app-bootstrap.ts"];
    const generatedFiles = [
        "archive/mining-ledger/run/feature-packs/columns/hash/values.bin",
        "artifacts/test-logs/latest/results.json",
        "batch-runs/run/report.html",
        "price-data/ibkr/csv/30m/SPY.csv",
        "logs/paper-execution/strategy/run.json",
        "reports/run/index.html",
        "rust-engine/target/release/build/output.bin",
        ".freebuff/worktrees/copy/index.html",
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
