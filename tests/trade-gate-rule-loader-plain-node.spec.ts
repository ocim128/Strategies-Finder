import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { build } from "esbuild";
import { describe, it } from "node:test";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();

function runPlainNode(scriptPath: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        const env = { ...process.env };
        delete env.NODE_OPTIONS;
        const child = spawn(process.execPath, [scriptPath], {
            cwd: ROOT,
            env,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => {
            stdout += chunk.toString();
        });
        child.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
        });
        child.once("error", reject);
        child.once("close", (code) => resolve({ code, stdout, stderr }));
    });
}

describe("Trade Gate rule loader in plain Node", () => {
    it("transpiles the golden TypeScript rule, caches it, and cleans its run temp files", async () => {
        const tempRoot = await mkdtemp(path.join(ROOT, ".trade-gate-plain-node-test-"));
        try {
            const loaderSourcePath = path.join(ROOT, "lib", "batch-backtest", "trade-gate-rule-loader.ts");
            const rulePath = path.join(ROOT, "tests", "fixtures", "trade-ledger-parity", "golden-rule.ts");
            const loaderOutputPath = path.join(tempRoot, "trade-gate-rule-loader.mjs");
            const childPath = path.join(tempRoot, "plain-node-child.mjs");
            await build({
                entryPoints: [loaderSourcePath],
                outfile: loaderOutputPath,
                bundle: false,
                format: "esm",
                platform: "node",
                target: "node22",
                logLevel: "silent",
            });
            await writeFile(childPath, `
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { createTradeGateRuleLoaderRun, getTradeGateRuleLoaderStats } from ${JSON.stringify(pathToFileURL(loaderOutputPath).href)};

const sourcePath = ${JSON.stringify(rulePath)};
const source = await readFile(sourcePath, "utf8");
const sourceHash = createHash("sha256").update(source).digest("hex");
const firstRun = await createTradeGateRuleLoaderRun();
try {
    const first = await firstRun.loadRule({ ruleId: "golden-rule", sourcePath, source, sourceHash });
    assert.equal(first({ feat_atrPct: 2 }), true);
    assert.equal(first({ feat_atrPct: 1 }), false);
    const afterFirstLoad = getTradeGateRuleLoaderStats().transforms;
    assert.equal(afterFirstLoad, 1);
    assert.equal((await readdir(firstRun.tempDir)).length, 1);

    const second = await firstRun.loadRule({ ruleId: "golden-rule", sourcePath, source, sourceHash });
    assert.strictEqual(second, first);
    assert.equal(getTradeGateRuleLoaderStats().transforms, afterFirstLoad);
    await firstRun.dispose();
    let firstRunCleaned = false;
    try {
        await stat(firstRun.tempDir);
    } catch (error) {
        firstRunCleaned = error && typeof error === "object" && "code" in error && error.code === "ENOENT";
        if (!firstRunCleaned) throw error;
    }
    assert.equal(firstRunCleaned, true);

    const secondRun = await createTradeGateRuleLoaderRun();
    try {
        const cached = await secondRun.loadRule({ ruleId: "golden-rule", sourcePath, source, sourceHash });
        assert.strictEqual(cached, first);
        assert.equal(cached({ feat_atrPct: 2 }), true);
        assert.equal(getTradeGateRuleLoaderStats().transforms, afterFirstLoad);
        assert.equal((await readdir(secondRun.tempDir)).length, 0);
        await secondRun.dispose();
        let secondRunCleaned = false;
        try {
            await stat(secondRun.tempDir);
        } catch (error) {
            secondRunCleaned = error && typeof error === "object" && "code" in error && error.code === "ENOENT";
            if (!secondRunCleaned) throw error;
        }
        assert.equal(secondRunCleaned, true);
    } finally {
        await secondRun.dispose();
    }
    console.log(JSON.stringify({ transforms: getTradeGateRuleLoaderStats().transforms, cached: true, cleaned: true }));
} finally {
    await firstRun.dispose();
}
`, "utf8");

            const result = await runPlainNode(childPath);
            assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
            assert.doesNotMatch(result.stderr, /Unknown file extension/);
            const output = JSON.parse(result.stdout.trim()) as { transforms: number; cached: boolean; cleaned: boolean };
            assert.deepEqual(output, { transforms: 1, cached: true, cleaned: true });
        } finally {
            await rm(tempRoot, { recursive: true, force: true });
        }
    });
});
