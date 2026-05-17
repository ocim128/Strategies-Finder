import { expect } from "chai";
import { describe, it } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LiveTradeSubmitRequest } from "../lib/execution-lab/execution-lab-model";
import {
    loadLiveExecutorStatus,
    readLiveExecutorConfig,
    submitLiveTradeToExecutor,
} from "../lib/execution-lab/live-executor-adapter";

function request(): LiveTradeSubmitRequest {
    return {
        action: "entry",
        requestId: "live-request-1",
        sessionId: "session-1",
        paperTradeId: "paper-1",
        createdAtIso: "2026-01-01T00:00:01.000Z",
        expiresAtSec: Math.floor(Date.now() / 1000) + 10,
        symbol: "BTCUSDT",
        strategyKey: "test_strategy",
        eventStartTs: 1_700_000_000,
        eventEndTs: 1_700_000_300,
        marketSlug: "btc-event",
        conditionId: "condition",
        tokenId: "yes-token",
        side: "yes",
        stakeUsd: 5,
        signalTimeSec: 1_700_000_010,
        entryTimeSec: 1_700_000_011,
        maxPrice: 0.55,
        orderType: "FAK",
    };
}

async function withEnv<T>(updates: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
    const previous = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(updates)) {
        previous.set(key, process.env[key]);
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }
    try {
        return await run();
    } finally {
        for (const [key, value] of previous.entries()) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    }
}

describe("Execution Lab live executor adapter", () => {
    it("reports configured executor status without exposing secrets", () => {
        const status = loadLiveExecutorStatus({
            executorPath: process.execPath,
            liveEnabled: false,
            maxStakeUsd: 12,
            sizingMode: "exchange_min",
            orderType: "FOK",
            entryMaxSlippageCents: 2,
            exitMaxSlippageCents: 3,
        });

        expect(status.configured).to.equal(true);
        expect(status.available).to.equal(true);
        expect(status.dryRun).to.equal(true);
        expect(status.maxStakeUsd).to.equal(12);
        expect(status.sizingMode).to.equal("exchange_min");
        expect(status.orderType).to.equal("FOK");
        expect(status.entryMaxSlippageCents).to.equal(2);
        expect(status.exitMaxSlippageCents).to.equal(3);
        expect("executorPath" in status).to.equal(false);
    });

    it("loads non-VITE live executor settings from repo .env", () => {
        const dir = mkdtempSync(join(tmpdir(), "execution-lab-env-"));
        try {
            writeFileSync(join(dir, ".env"), [
                `EXECUTION_LAB_LIVE_EXECUTOR_PATH=${process.execPath}`,
                `EXECUTION_LAB_LIVE_EXECUTOR_CWD=${dir}`,
                "EXECUTION_LAB_LIVE_ENABLED=1",
                "EXECUTION_LAB_LIVE_MAX_STAKE_USD=7",
                "EXECUTION_LAB_LIVE_SIZING_MODE=exchange_min",
                "EXECUTION_LAB_LIVE_ORDER_TYPE=FOK",
                "EXECUTION_LAB_LIVE_ENTRY_MAX_SLIPPAGE_CENTS=4",
                "EXECUTION_LAB_LIVE_EXIT_MAX_SLIPPAGE_CENTS=0",
                "EXECUTION_LAB_LIVE_TIMEOUT_MS=1234",
            ].join("\n"));

            const config = readLiveExecutorConfig({}, undefined, dir);
            expect(config.executorPath).to.equal(process.execPath);
            expect(config.executorCwd).to.equal(dir);
            expect(config.liveEnabled).to.equal(true);
            expect(config.maxStakeUsd).to.equal(7);
            expect(config.sizingMode).to.equal("exchange_min");
            expect(config.orderType).to.equal("FOK");
            expect(config.entryMaxSlippageCents).to.equal(4);
            expect(config.exitMaxSlippageCents).to.equal(0);
            expect(config.timeoutMs).to.equal(1234);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("infers the side repo root when the executor lives under target debug or release", () => {
        const dir = mkdtempSync(join(tmpdir(), "execution-lab-cwd-"));
        try {
            const binaryDir = join(dir, "target", "debug");
            mkdirSync(binaryDir, { recursive: true });
            const config = readLiveExecutorConfig({
                EXECUTION_LAB_LIVE_EXECUTOR_PATH: join(binaryDir, "live_trade_once.exe"),
            }, undefined, dir);

            expect(config.executorCwd).to.equal(dir);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("uses ARBITRAGE_ORDER_TYPE as a compatibility fallback for live order type", () => {
        const dir = mkdtempSync(join(tmpdir(), "execution-lab-env-"));
        try {
            const config = readLiveExecutorConfig({
                ARBITRAGE_ORDER_TYPE: "FOK",
                EXECUTION_LAB_LIVE_ORDER_TYPE: undefined,
            }, undefined, dir);

            expect(config.orderType).to.equal("FOK");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("maps fake executor JSON stdout to a structured response", async () => {
        const script = [
            "let body='';",
            "process.stdin.on('data', c => body += c);",
            "process.stdin.on('end', () => {",
            "const req = JSON.parse(body);",
            "console.log(JSON.stringify({ ok: true, requestId: req.requestId, status: 'dry_run', currentAsk: 0.52, maxPrice: req.maxPrice }));",
            "});",
        ].join("");
        const response = await submitLiveTradeToExecutor(request(), {
            executorPath: process.execPath,
            executorArgs: ["-e", script],
            liveEnabled: false,
            maxStakeUsd: 10,
            orderType: "FAK",
            timeoutMs: 1000,
        });

        expect(response.status).to.equal("dry_run");
        expect(response.currentAsk).to.equal(0.52);
    });

    it("runs the executor from its configured working directory", async () => {
        const dir = mkdtempSync(join(tmpdir(), "execution-lab-cwd-"));
        const script = [
            "let body='';",
            "process.stdin.on('data', c => body += c);",
            "process.stdin.on('end', () => {",
            "const req = JSON.parse(body);",
            `const expected = ${JSON.stringify(dir)};`,
            "console.log(JSON.stringify({ ok: true, requestId: req.requestId, status: process.cwd() === expected ? 'dry_run' : 'failed' }));",
            "});",
        ].join("");
        try {
            const response = await submitLiveTradeToExecutor(request(), {
                executorPath: process.execPath,
                executorCwd: dir,
                executorArgs: ["-e", script],
                liveEnabled: false,
                maxStakeUsd: 10,
                orderType: "FAK",
                timeoutMs: 1000,
            });

            expect(response.status).to.equal("dry_run");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("passes configured order type to the request and executor environment", async () => {
        const script = [
            "let body='';",
            "process.stdin.on('data', c => body += c);",
            "process.stdin.on('end', () => {",
            "const req = JSON.parse(body);",
            "const aligned = req.orderType === 'FOK' && process.env.ARBITRAGE_ORDER_TYPE === 'FOK' && process.env.EXECUTION_LAB_LIVE_ORDER_TYPE === 'FOK';",
            "console.log(JSON.stringify({ ok: true, requestId: req.requestId, status: aligned ? 'dry_run' : 'failed' }));",
            "});",
        ].join("");
        const response = await submitLiveTradeToExecutor({ ...request(), orderType: "FOK" }, {
            executorPath: process.execPath,
            executorArgs: ["-e", script],
            liveEnabled: false,
            maxStakeUsd: 10,
            orderType: "FOK",
            timeoutMs: 1000,
        });

        expect(response.status).to.equal("dry_run");
    });

    it("rejects configured order type mismatches before invoking the executor", async () => {
        const response = await submitLiveTradeToExecutor(request(), {
            executorPath: process.execPath,
            liveEnabled: false,
            maxStakeUsd: 10,
            orderType: "FOK",
            timeoutMs: 1000,
        });

        expect(response.status).to.equal("rejected");
        expect(response.reason).to.equal("order_type_config_mismatch");
    });

    it("does not forward unrelated parent secrets to the executor process", async () => {
        await withEnv({ POLYMARKET_PRIVATE_KEY: "secret" }, async () => {
            const script = [
                "let body='';",
                "process.stdin.on('data', c => body += c);",
                "process.stdin.on('end', () => {",
                "const req = JSON.parse(body);",
                "console.log(JSON.stringify({ ok: true, requestId: req.requestId, status: process.env.POLYMARKET_PRIVATE_KEY ? 'failed' : 'dry_run' }));",
                "});",
            ].join("");
            const response = await submitLiveTradeToExecutor(request(), {
                executorPath: process.execPath,
                executorArgs: ["-e", script],
                liveEnabled: false,
                maxStakeUsd: 10,
                orderType: "FAK",
                timeoutMs: 1000,
            });

            expect(response.status).to.equal("dry_run");
        });
    });

    it("does not apply the paper stake cap before exchange-min executor sizing", async () => {
        const script = [
            "let body='';",
            "process.stdin.on('data', c => body += c);",
            "process.stdin.on('end', () => {",
            "const req = JSON.parse(body);",
            "console.log(JSON.stringify({ ok: true, requestId: req.requestId, status: 'dry_run' }));",
            "});",
        ].join("");
        const response = await submitLiveTradeToExecutor({ ...request(), stakeUsd: 11 }, {
            executorPath: process.execPath,
            executorArgs: ["-e", script],
            liveEnabled: false,
            maxStakeUsd: 10,
            sizingMode: "exchange_min",
            orderType: "FAK",
            timeoutMs: 1000,
        });

        expect(response.status).to.equal("dry_run");
    });

    it("keeps the paper stake cap in fixed executor sizing", async () => {
        const response = await submitLiveTradeToExecutor({ ...request(), stakeUsd: 11 }, {
            executorPath: process.execPath,
            liveEnabled: false,
            maxStakeUsd: 10,
            sizingMode: "fixed",
            orderType: "FAK",
            timeoutMs: 1000,
        });

        expect(response.status).to.equal("rejected");
        expect(response.reason).to.equal("stake_above_executor_cap");
    });

    it("maps unavailable, timeout, and invalid stdout failures", async () => {
        const unavailable = await submitLiveTradeToExecutor(request(), {
            executorPath: "Z:\\missing\\live_trade_once.exe",
            orderType: "FAK",
        });
        const timeout = await submitLiveTradeToExecutor(request(), {
            executorPath: process.execPath,
            executorArgs: ["-e", "setTimeout(() => {}, 10000);"],
            maxStakeUsd: 10,
            orderType: "FAK",
            timeoutMs: 50,
        });
        const invalidStdout = await submitLiveTradeToExecutor(request(), {
            executorPath: process.execPath,
            executorArgs: ["-e", "console.log('not-json');"],
            maxStakeUsd: 10,
            orderType: "FAK",
            timeoutMs: 1000,
        });

        expect(unavailable.reason).to.equal("executor_unavailable");
        expect(timeout.reason).to.equal("executor_timeout");
        expect(invalidStdout.reason).to.equal("executor_invalid_stdout");
    });
});
