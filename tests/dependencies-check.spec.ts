import assert from "node:assert/strict";
import { it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

it("dependency preflight accepts app dependencies and rejects invalid or missing versions", () => {
    const root = fileURLToPath(new URL("../", import.meta.url));
    const artifacts = path.join(root, "artifacts");
    fs.mkdirSync(artifacts, { recursive: true });
    const fixtureRoot = fs.mkdtempSync(path.join(artifacts, "dependency-check-"));
    try {
        fs.mkdirSync(path.join(fixtureRoot, "scripts"));
        const script = path.join(fixtureRoot, "scripts/check-dependencies.cjs");
        fs.copyFileSync(path.join(root, "scripts/check-dependencies.cjs"), script);
        const hiddenPackage = path.join(fixtureRoot, "node_modules/hidden-package");
        fs.mkdirSync(hiddenPackage, { recursive: true });
        fs.writeFileSync(path.join(hiddenPackage, "package.json"), JSON.stringify({
            name: "hidden-package", version: "1.2.3", exports: { ".": "./index.js" },
        }));
        fs.writeFileSync(path.join(hiddenPackage, "index.js"), "module.exports = {};");
        // Unrelated installed packages must not make an app's preflight fail.
        const extraneous = path.join(fixtureRoot, "node_modules/unrelated-package");
        fs.mkdirSync(extraneous);
        fs.writeFileSync(path.join(extraneous, "package.json"), '{"name":"unrelated-package","version":"0.0.0"}');
        const run = (dependencies: Record<string, string>) => {
            fs.writeFileSync(path.join(fixtureRoot, "package.json"), JSON.stringify({ dependencies }));
            return spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 10_000 });
        };
        const valid = run({ "hidden-package": "^1.0.0", semver: ">=7.0.0" });
        assert.equal(valid.status, 0, valid.stderr);
        assert.match(valid.stdout, /OK hidden-package@1\.2\.3/);
        assert.doesNotMatch(valid.stdout, /unrelated-package/);
        const invalid = run({ "hidden-package": "^2.0.0" });
        assert.equal(invalid.status, 1);
        assert.match(invalid.stdout, /INVALID hidden-package@1\.2\.3/);
        const missing = run({ "no-such-dependency-fixture": "1.0.0" });
        assert.equal(missing.status, 1);
        assert.match(missing.stderr, /MISSING no-such-dependency-fixture/);
    } finally {
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
});
