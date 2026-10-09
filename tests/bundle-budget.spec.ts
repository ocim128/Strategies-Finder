import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { collectStartupAssets, measureStartupBundle, type BuildManifest } from "../scripts/check-bundle-budget";

const root = fileURLToPath(new URL("../", import.meta.url));

describe("startup bundle budget", () => {
    it("includes shared static dependencies once, handles cycles, and excludes lazy chunks", () => {
        const manifest: BuildManifest = {
            entry: { file: "assets/entry.js", isEntry: true, imports: ["a", "b"], dynamicImports: ["lazy"] },
            a: { file: "assets/a.js", imports: ["shared"] },
            b: { file: "assets/b.js", imports: ["shared"] },
            shared: { file: "assets/shared.js", imports: ["entry"] },
            lazy: { file: "assets/lazy.js", imports: ["lazy-vendor"] },
            "lazy-vendor": { file: "assets/lazy-vendor.js" },
        };
        assert.deepEqual(collectStartupAssets(manifest, "assets/entry.js"), [
            "assets/entry.js", "assets/a.js", "assets/shared.js", "assets/b.js",
        ]);
        assert.throws(() => collectStartupAssets(manifest, "missing.js"), /missing from/);
        assert.throws(() => collectStartupAssets({
            entry: { file: "entry.js", isEntry: true, imports: ["missing"] },
        }, "entry.js"), /Static import missing/);
    });

    it("fails the CLI on oversized vendor chunks even when the entry remains small", () => {
        const artifacts = path.join(root, "artifacts");
        fs.mkdirSync(artifacts, { recursive: true });
        const fixtureRoot = fs.mkdtempSync(path.join(artifacts, "bundle-budget-"));
        try {
            const dist = path.join(fixtureRoot, "dist");
            fs.mkdirSync(path.join(dist, ".vite"), { recursive: true });
            fs.mkdirSync(path.join(dist, "assets"));
            fs.mkdirSync(path.join(fixtureRoot, "scripts"));
            const script = path.join(fixtureRoot, "scripts/check-bundle-budget.ts");
            fs.copyFileSync(path.join(root, "scripts/check-bundle-budget.ts"), script);
            fs.writeFileSync(path.join(dist, "index.html"), '<script src="/assets/entry.js" crossorigin type="module"></script>');
            const manifest: BuildManifest = {
                entry: { file: "assets/entry.js", isEntry: true, imports: ["vendor"], dynamicImports: ["lazy"] },
                vendor: { file: "assets/vendor.js" },
                lazy: { file: "assets/lazy.js" },
            };
            fs.writeFileSync(path.join(dist, ".vite/manifest.json"), JSON.stringify(manifest));
            fs.writeFileSync(path.join(dist, "assets/entry.js"), "// small entry");
            fs.writeFileSync(path.join(dist, "assets/vendor.js"), "x".repeat(851 * 1024));
            const esno = createRequire(import.meta.url).resolve("esno/esno.js");
            const run = () => spawnSync(process.execPath, [esno, script], { encoding: "utf8", timeout: 10_000 });
            const failed = run();
            assert.equal(failed.status, 1, failed.stderr);
            assert.match(failed.stderr, /exceeds its bundle budget/);
            assert.match(failed.stdout, /vendor\.js/);
            fs.writeFileSync(path.join(dist, "assets/vendor.js"), "// small vendor");
            assert.equal(run().status, 0);
            // The original entry limit still applies below the combined limit.
            fs.writeFileSync(path.join(dist, "assets/entry.js"), "x".repeat(651 * 1024));
            assert.equal(run().status, 1);
            fs.writeFileSync(path.join(dist, "assets/entry.js"), "// small entry");
            const measured = measureStartupBundle(dist);
            assert.equal(measured.assets.length, 2);
            assert.ok(measured.assets.every(asset => asset.gzipBytes > 0));
            // Lazy assets are not required to exist at startup; static assets are.
            fs.unlinkSync(path.join(dist, "assets/vendor.js"));
            assert.throws(() => measureStartupBundle(dist), /ENOENT/);
            manifest.vendor.file = "../outside.js";
            fs.writeFileSync(path.join(dist, ".vite/manifest.json"), JSON.stringify(manifest));
            assert.throws(() => measureStartupBundle(dist), /escapes dist/);
        } finally {
            fs.rmSync(fixtureRoot, { recursive: true, force: true });
        }
    });
});
