import { expect } from "chai";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

describe("Execution Lab live executor adapter", () => {
    it("reports configured executor status without exposing secrets", () => {
        const status = loadLiveExecutorStatus({
            executorPath: process.execPath,
            liveEnabled: false,
            maxStakeUsd: 12,
            exitMaxSlippageCents: 3,
        });

        expect(status.configured).to.equal(true);
        expect(status.available).to.equal(true);
        expect(status.dryRun).to.equal(true);
        expect(status.maxStakeUsd).to.equal(12);
        expect(status.exitMaxSlippageCents).to.equal(3);
    });

    it("loads non-VITE live executor settings from repo .env", () => {
        const dir = mkdtempSync(join(tmpdir(), "execution-lab-env-"));
        try {
            writeFileSync(join(dir, ".env"), [
                `EXECUTION_LAB_LIVE_EXECUTOR_PATH=${process.execPath}`,
                "EXECUTION_LAB_LIVE_ENABLED=1",
                "EXECUTION_LAB_LIVE_MAX_STAKE_USD=7",
                "EXECUTION_LAB_LIVE_EXIT_MAX_SLIPPAGE_CENTS=0",
                "EXECUTION_LAB_LIVE_TIMEOUT_MS=1234",
            ].join("\n"));

            const config = readLiveExecutorConfig({}, undefined, dir);
            expect(config.executorPath).to.equal(process.execPath);
            expect(config.liveEnabled).to.equal(true);
            expect(config.maxStakeUsd).to.equal(7);
            expect(config.exitMaxSlippageCents).to.equal(0);
            expect(config.timeoutMs).to.equal(1234);
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
            timeoutMs: 1000,
        });

        expect(response.status).to.equal("dry_run");
        expect(response.currentAsk).to.equal(0.52);
    });

    it("maps unavailable, timeout, and invalid stdout failures", async () => {
        const unavailable = await submitLiveTradeToExecutor(request(), {
            executorPath: "Z:\\missing\\live_trade_once.exe",
        });
        const timeout = await submitLiveTradeToExecutor(request(), {
            executorPath: process.execPath,
            executorArgs: ["-e", "setTimeout(() => {}, 10000);"],
            timeoutMs: 50,
        });
        const invalidStdout = await submitLiveTradeToExecutor(request(), {
            executorPath: process.execPath,
            executorArgs: ["-e", "console.log('not-json');"],
            timeoutMs: 1000,
        });

        expect(unavailable.reason).to.equal("executor_unavailable");
        expect(timeout.reason).to.equal("executor_timeout");
        expect(invalidStdout.reason).to.equal("executor_invalid_stdout");
    });
});
