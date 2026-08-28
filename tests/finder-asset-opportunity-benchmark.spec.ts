import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import { join } from "node:path";

const REPO_ROOT = process.cwd();
const ESNO_PATH = join(
    REPO_ROOT,
    "..",
    "node_modules",
    ".bin",
    process.platform === "win32" ? "esno.cmd" : "esno",
);
const BENCHMARK_SCRIPT = join(REPO_ROOT, "scripts", "finder-asset-opportunity-benchmark.ts");
const benchmarkArgs = [
    BENCHMARK_SCRIPT,
    "--engine=rust",
    "--arm=coverage-synthetic",
    "--assets=1",
    "--bars=1000",
    "--cache=cold",
    "--oos=next_exit",
    "--routing=all-path-rust",
    "--workers=1",
    "--repetitions=1",
    "--iterations=1",
];

async function startHealthServer(buildProfile?: "debug" | "release"): Promise<{
    url: string;
    close: () => Promise<void>;
}> {
    const server = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
            status: "healthy",
            engine: "trading-engine-rust",
            protocolVersion: 2,
            ...(buildProfile === undefined ? {} : { buildProfile }),
            capabilities: {
                "backtest.next_open.v1": true,
                "backtest.risk_max_hold.v1": true,
                "backtest.exit_reason.v1": true,
            },
        }));
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
    });
    const serverAddress = server.address();
    assert(serverAddress && typeof serverAddress !== "string");
    return {
        url: `http://127.0.0.1:${serverAddress.port}`,
        close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
    };
}

async function runBenchmarkAgainstHealth(buildProfile?: "debug" | "release"): Promise<{
    exitCode: number;
    output: string;
}> {
    const healthServer = await startHealthServer(buildProfile);
    try {
        const child = spawn(ESNO_PATH, benchmarkArgs, {
            cwd: REPO_ROOT,
            env: {
                ...process.env,
                RUST_ENGINE_URL: healthServer.url,
            },
            shell: process.platform === "win32",
        });
        let output = "";
        child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
        child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
        const exitCode = await new Promise<number>((resolve, reject) => {
            child.once("error", reject);
            child.once("close", (code) => resolve(code ?? 1));
        });
        return { exitCode, output };
    } finally {
        await healthServer.close();
    }
}

describe("Finder Asset Opportunity benchmark build-profile gate", () => {
    it("rejects a debug Rust service before measurement", async () => {
        const result = await runBenchmarkAgainstHealth("debug");
        assert.notEqual(result.exitCode, 0, result.output);
        assert.match(result.output, /requires buildProfile=\"release\"/);
        assert.match(result.output, /advertised debug/);
    });

    it("rejects legacy health metadata without a build profile before measurement", async () => {
        const result = await runBenchmarkAgainstHealth();
        assert.notEqual(result.exitCode, 0, result.output);
        assert.match(result.output, /requires buildProfile=\"release\"/);
        assert.match(result.output, /advertised missing/);
    });
});
