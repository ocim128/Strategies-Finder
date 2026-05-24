import { expect } from "chai";
import { describe, it } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LiveCancelAllSubmitRequest, LiveTradeSubmitRequest } from "../lib/execution-lab/execution-lab-model";
import {
    loadLiveExecutorStatus,
    readLiveExecutorConfig,
    submitLiveCancelAllToExecutor,
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
        orderMode: "taker",
        maxPrice: 0.55,
        orderType: "FAK",
    };
}

function cancelRequest(): LiveCancelAllSubmitRequest {
    return {
        action: "cancel_all",
        requestId: "live-cancel-1",
        sessionId: "session-1",
        paperTradeId: "paper-1",
        exitTriggerKey: "session-1|event|yes|paper-1|exit",
        createdAtIso: "2026-01-01T00:00:02.000Z",
        symbol: "BTCUSDT",
        strategyKey: "test_strategy",
        marketSlug: "btc-event",
        conditionId: "condition",
        tokenId: "yes-token",
        scope: "token",
        reason: "limit_exit_signal",
        orderMode: "limit",
    };
}

function takeProfitRequest(): LiveTradeSubmitRequest {
    return {
        ...request(),
        action: "take_profit",
        requestId: "live-tp-1",
        entryRequestId: "live-request-1",
        orderMode: "limit",
        orderType: "GTC",
        maxPrice: 0.62,
        limitPrice: 0.62,
        limitReferencePrice: 0.57,
        shares: 8.5,
        exitTimeSec: 1_700_000_020,
        minPrice: 0.62,
        stakeUsd: 5.27,
    };
}

function targetedCancelRequest(): LiveCancelAllSubmitRequest {
    return {
        ...cancelRequest(),
        scope: "session",
        orderIds: ["0xabc"],
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

async function withJsonServer<T>(
    handler: (body: any) => unknown,
    run: (url: string) => Promise<T>
): Promise<T> {
    const server = createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
            const payload = body ? JSON.parse(body) : {};
            const response = handler(payload);
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(response));
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected local server address");
    try {
        return await run(`http://127.0.0.1:${address.port}/trade`);
    } finally {
        await new Promise<void>((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
        });
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
        expect(status.orderMode).to.equal("taker");
        expect(status.sizingMode).to.equal("exchange_min");
        expect(status.orderType).to.equal("FOK");
        expect(status.takerOrderType).to.equal("FOK");
        expect(status.supportedLimitOrderType).to.equal("GTC");
        expect(status.entryMaxSlippageCents).to.equal(2);
        expect(status.exitMaxSlippageCents).to.equal(3);
        expect("executorPath" in status).to.equal(false);
    });

    it("reports an opt-in HTTP executor without exposing its URL", () => {
        const status = loadLiveExecutorStatus({
            executorUrl: "http://127.0.0.1:9123/trade",
            liveEnabled: false,
            maxStakeUsd: 12,
            sizingMode: "fixed",
            orderType: "FAK",
        });

        expect(status.configured).to.equal(true);
        expect(status.available).to.equal(true);
        expect(status.executorKind).to.equal("http");
        expect("executorUrl" in status).to.equal(false);
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

    it("normalizes executor geoblock check failures as rejections", async () => {
        const script = [
            "let body='';",
            "process.stdin.on('data', c => body += c);",
            "process.stdin.on('end', () => {",
            "const req = JSON.parse(body);",
            "console.log(JSON.stringify({ ok: true, requestId: req.requestId, status: 'failed', reason: 'geoblock_check_failed', maxPrice: req.maxPrice }));",
            "});",
        ].join("");
        const response = await submitLiveTradeToExecutor(request(), {
            executorPath: process.execPath,
            executorArgs: ["-e", script],
            liveEnabled: true,
            maxStakeUsd: 10,
            orderType: "FAK",
            timeoutMs: 1000,
        });

        expect(response.status).to.equal("rejected");
        expect(response.reason).to.equal("geoblock_check_failed");
        expect(response.maxPrice).to.equal(0.55);
    });

    it("submits live trades to an opt-in HTTP executor", async () => {
        await withJsonServer((payload) => ({
            ok: true,
            requestId: payload.requestId,
            status: "dry_run",
            currentAsk: 0.51,
            maxPrice: payload.maxPrice,
        }), async (executorUrl) => {
            const response = await submitLiveTradeToExecutor(request(), {
                executorUrl,
                liveEnabled: false,
                maxStakeUsd: 10,
                orderType: "FAK",
                timeoutMs: 1000,
            });

            expect(response.status).to.equal("dry_run");
            expect(response.currentAsk).to.equal(0.51);
        });
    });

    it("allows UI non-secret config to override env order mode and limit settings", async () => {
        const script = [
            "let body='';",
            "process.stdin.on('data', c => body += c);",
            "process.stdin.on('end', () => {",
            "const req = JSON.parse(body);",
            "const aligned = req.orderMode === 'limit' && req.orderType === 'GTC' && req.maxPrice === req.limitPrice && process.env.EXECUTION_LAB_LIVE_ORDER_MODE === 'limit';",
            "console.log(JSON.stringify({ ok: true, requestId: req.requestId, status: aligned ? 'posted_live' : 'failed', limitPrice: req.limitPrice }));",
            "});",
        ].join("");
        const response = await submitLiveTradeToExecutor({
            ...request(),
            orderMode: "limit",
            orderType: "GTC",
            maxPrice: 0.49,
            limitPrice: 0.49,
            limitReferencePrice: 0.55,
            limitOffsetEnabled: true,
            limitOffsetCents: 6,
        } as LiveTradeSubmitRequest, {
            executorPath: process.execPath,
            executorArgs: ["-e", script],
            liveEnabled: false,
            maxStakeUsd: 10,
            orderMode: "taker",
            orderType: "FAK",
            timeoutMs: 1000,
        }, {
            orderMode: "limit",
            takerOrderType: "FAK",
            sizingMode: "fixed",
            maxStakeUsd: 10,
            entryMaxSlippageCents: 1,
            exitMaxSlippageCents: 5,
            limitOffsetEnabled: true,
            limitOffsetCents: 6,
            limitCancelAllOnExitEnabled: true,
        });

        expect(response.status).to.equal("posted_live");
        expect(response.limitPrice).to.equal(0.49);
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

    it("forces take-profit requests through the limit order environment", async () => {
        const script = [
            "let body='';",
            "process.stdin.on('data', c => body += c);",
            "process.stdin.on('end', () => {",
            "const req = JSON.parse(body);",
            "const aligned = req.action === 'take_profit' && req.orderMode === 'limit' && req.orderType === 'GTC' && process.env.EXECUTION_LAB_LIVE_ORDER_MODE === 'limit' && process.env.ARBITRAGE_ORDER_TYPE === 'GTC';",
            "console.log(JSON.stringify({ ok: true, requestId: req.requestId, status: aligned ? 'posted_live' : 'failed', limitPrice: req.limitPrice, minPrice: req.minPrice }));",
            "});",
        ].join("");
        const response = await submitLiveTradeToExecutor(takeProfitRequest(), {
            executorPath: process.execPath,
            executorArgs: ["-e", script],
            liveEnabled: false,
            maxStakeUsd: 1,
            orderMode: "taker",
            orderType: "FAK",
            timeoutMs: 1000,
        });

        expect(response.status).to.equal("posted_live");
        expect(response.limitPrice).to.equal(0.62);
        expect(response.minPrice).to.equal(0.62);
    });

    it("forwards cancel-all requests with the configured cancel scope", async () => {
        const script = [
            "let body='';",
            "process.stdin.on('data', c => body += c);",
            "process.stdin.on('end', () => {",
            "const req = JSON.parse(body);",
            "const aligned = req.action === 'cancel_all' && req.scope === 'token' && process.env.EXECUTION_LAB_LIVE_ORDER_MODE === 'limit';",
            "console.log(JSON.stringify({ ok: true, requestId: req.requestId, status: aligned ? 'submitted' : 'failed', scope: req.scope, canceledCount: 2 }));",
            "});",
        ].join("");
        const response = await submitLiveCancelAllToExecutor(cancelRequest(), {
            executorPath: process.execPath,
            executorArgs: ["-e", script],
            liveEnabled: false,
            maxStakeUsd: 10,
            orderMode: "limit",
            orderType: "FAK",
            limitCancelAllOnExitEnabled: true,
            cancelScope: "token",
            timeoutMs: 1000,
        });

        expect(response.status).to.equal("submitted");
        expect(response.scope).to.equal("token");
        expect(response.canceledCount).to.equal(2);
    });

    it("defaults cancel-all to targeted session order ids", async () => {
        const script = [
            "let body='';",
            "process.stdin.on('data', c => body += c);",
            "process.stdin.on('end', () => {",
            "const req = JSON.parse(body);",
            "const aligned = req.action === 'cancel_all' && req.scope === 'session' && req.orderIds[0] === '0xabc' && process.env.EXECUTION_LAB_LIVE_CANCEL_SCOPE === 'session';",
            "console.log(JSON.stringify({ ok: true, requestId: req.requestId, status: aligned ? 'submitted' : 'failed', scope: req.scope, canceledOrderIds: req.orderIds, canceledCount: 1 }));",
            "});",
        ].join("");
        const response = await submitLiveCancelAllToExecutor(targetedCancelRequest(), {
            executorPath: process.execPath,
            executorArgs: ["-e", script],
            liveEnabled: false,
            maxStakeUsd: 10,
            orderMode: "limit",
            limitCancelAllOnExitEnabled: true,
            timeoutMs: 1000,
        });

        expect(response.status).to.equal("submitted");
        expect(response.scope).to.equal("session");
        expect(response.canceledOrderIds).to.deep.equal(["0xabc"]);
    });

    it("forwards targeted order-id cancels when broad cancel-on-exit is disabled", async () => {
        const script = [
            "let body='';",
            "process.stdin.on('data', c => body += c);",
            "process.stdin.on('end', () => {",
            "const req = JSON.parse(body);",
            "const aligned = req.action === 'cancel_all' && req.scope === 'session' && req.orderIds[0] === '0xabc';",
            "console.log(JSON.stringify({ ok: true, requestId: req.requestId, status: aligned ? 'submitted' : 'failed', scope: req.scope, canceledOrderIds: req.orderIds, canceledCount: 1 }));",
            "});",
        ].join("");
        const response = await submitLiveCancelAllToExecutor(targetedCancelRequest(), {
            executorPath: process.execPath,
            executorArgs: ["-e", script],
            liveEnabled: false,
            maxStakeUsd: 10,
            orderMode: "limit",
            limitCancelAllOnExitEnabled: false,
            cancelScope: "account",
            timeoutMs: 1000,
        });

        expect(response.status).to.equal("submitted");
        expect(response.scope).to.equal("session");
        expect(response.canceledOrderIds).to.deep.equal(["0xabc"]);
    });

    it("rejects cancel-all requests without a concrete configured scope", async () => {
        const response = await submitLiveCancelAllToExecutor(cancelRequest(), {
            executorPath: process.execPath,
            executorArgs: ["-e", "throw new Error('should not run')"],
            liveEnabled: false,
            maxStakeUsd: 10,
            orderMode: "limit",
            limitCancelAllOnExitEnabled: true,
            cancelScope: "unknown",
            timeoutMs: 1000,
        });

        expect(response.status).to.equal("rejected");
        expect(response.reason).to.equal("cancel_scope_unconfigured");
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
