/** Node worker-thread implementation of the compact random-control replay. */

import { parentPort, workerData } from "node:worker_threads";
import { mulberry32, type TradeLedgerControlRunResult } from "../lib/batch-backtest/trade-ledger-replay-core";
import type {
    SharedTradeLedgerControlDataset,
    TradeLedgerControlWorkerDoneMessage,
    TradeLedgerControlWorkerRunMessage,
} from "../lib/batch-backtest/trade-ledger-control-pool";

if (!parentPort) throw new Error("Ledger control worker requires parentPort.");

const dataset = workerData.dataset as SharedTradeLedgerControlDataset;
const signalTimes = new Float64Array(dataset.signalTimes);
const signalBarIndices = new Float64Array(dataset.signalBarIndices);
const barsHeld = new Float64Array(dataset.barsHeld);
const pnlPercents = new Float64Array(dataset.pnlPercents);
const pairOffsets = new Uint32Array(dataset.pairOffsets);
const pairIndices = new Uint32Array(dataset.pairIndices);

function mean(values: readonly number[]): number | null {
    if (values.length === 0) return null;
    let total = 0;
    for (const value of values) total += value;
    return total / values.length;
}

function median(values: readonly number[]): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = sorted.length / 2;
    return sorted.length % 2 === 1
        ? sorted[Math.floor(middle)]!
        : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function runControl(k: number, input: TradeLedgerControlWorkerRunMessage): TradeLedgerControlRunResult {
    const rng = mulberry32(input.controlSeed + 1 + k);
    let equity = 1;
    const isPnls: number[] = [];
    const holdoutPnls: number[] = [];
    const cooldownBars = input.replay.cooldownBars;

    if (input.replay.maxOpenTrades === 1) {
        for (let pair = 0; pair < dataset.pairCount; pair += 1) {
            let slotUntil = Number.NEGATIVE_INFINITY;
            let cooldownUntilBar = -1;
            for (let cursor = pairOffsets[pair]!; cursor < pairOffsets[pair + 1]!; cursor += 1) {
                const index = pairIndices[cursor]!;
                const fillBar = signalBarIndices[index]! + input.shift;
                const cooling = cooldownBars > 0 && cooldownUntilBar >= fillBar;
                if (slotUntil >= fillBar || cooling || !(rng() < input.calibratedP)) continue;
                const pnl = pnlPercents[index]!;
                const exitBar = fillBar + barsHeld[index]!;
                slotUntil = exitBar;
                if (cooldownBars > 0) cooldownUntilBar = Math.max(cooldownUntilBar, exitBar + cooldownBars - 1);
                equity *= 1 + pnl / 100;
                if (signalTimes[index]! < input.splitTime) isPnls.push(pnl);
                else holdoutPnls.push(pnl);
            }
        }
    } else {
        for (let pair = 0; pair < dataset.pairCount; pair += 1) {
            const slots: number[] = [];
            let cooldownUntilBar = -1;
            for (let cursor = pairOffsets[pair]!; cursor < pairOffsets[pair + 1]!; cursor += 1) {
                const index = pairIndices[cursor]!;
                const fillBar = signalBarIndices[index]! + input.shift;
                let openSlots = 0;
                let freeIdx = -1;
                for (let slot = 0; slot < slots.length; slot += 1) {
                    const until = slots[slot]!;
                    if (until >= fillBar) openSlots += 1;
                    else if (freeIdx < 0) freeIdx = slot;
                }
                const cooling = cooldownBars > 0 && cooldownUntilBar >= fillBar;
                if (openSlots >= input.replay.maxOpenTrades || cooling || !(rng() < input.calibratedP)) continue;
                const pnl = pnlPercents[index]!;
                const exitBar = fillBar + barsHeld[index]!;
                if (freeIdx >= 0) slots[freeIdx] = exitBar;
                else slots.push(exitBar);
                if (cooldownBars > 0) cooldownUntilBar = Math.max(cooldownUntilBar, exitBar + cooldownBars - 1);
                equity *= 1 + pnl / 100;
                if (signalTimes[index]! < input.splitTime) isPnls.push(pnl);
                else holdoutPnls.push(pnl);
            }
        }
    }

    return {
        totalReturnPercent: (equity - 1) * 100,
        isMeanPnlPercent: mean(isPnls),
        isMedianPnlPercent: median(isPnls),
        holdoutMeanPnlPercent: mean(holdoutPnls),
        holdoutMedianPnlPercent: median(holdoutPnls),
    };
}

parentPort.on("message", (message: TradeLedgerControlWorkerRunMessage) => {
    try {
        const response: TradeLedgerControlWorkerDoneMessage = {
            type: "done",
            taskId: message.taskId,
            results: [],
        };
        for (let k = message.startK; k < message.endK; k += 1) {
            response.results.push({ k, result: runControl(k, message) });
        }
        parentPort!.postMessage(response);
    } catch (error) {
        parentPort!.postMessage({ type: "error", taskId: message.taskId, error: error instanceof Error ? error.message : String(error) });
    }
});

parentPort.postMessage({ type: "ready" });
