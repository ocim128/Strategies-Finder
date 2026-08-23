import { performance } from "node:perf_hooks";
import { simulateFinderAssetOpportunityForwardOutcome } from "../lib/finder/finder-asset-opportunity-forward-contract";
import type { OHLCVData } from "../lib/types/strategies";

const row = (index: number) => ({
    symbol: `PAIR_${index % 679}`,
    strategyKey: `strategy_${index % 45}`,
    candidateFingerprint: `{"p":${index % 31},"q":${index % 17}}`,
    identityHash: `${index.toString(16).padStart(64, "0")}`,
    candidateIndex: index,
    evaluationOk: true,
    passesTradeFilter: index % 5 !== 0,
    profitFactor: 0.5 + (index % 101) / 10,
    netProfitPercent: (index % 101) / 10,
    totalTrades: index % 20,
    tpHitCount: index % 8,
    medianBarsToTP: index % 12,
    medianBarsToTerminal: index % 18,
    tpFirstShare: (index % 10) / 10,
    forwardOutcomes: Object.fromEntries([12, 18, 24].map((horizonBars) => [String(horizonBars), {
        exitReason: index % 3 === 0 ? "take_profit" : index % 3 === 1 ? "stop_loss" : "end_of_data",
        barsHeld: horizonBars,
        netReturnPercent: (index % 17) / 100,
        entryPrice: 100,
        exitPrice: 100 + (index % 17) / 100,
    }])),
});

const counts = [5_800, 8_600];
const chunkSize = 256;
for (const count of counts) {
    const rows = Array.from({ length: count }, (_, index) => row(index));
    const jsonBytes = Buffer.byteLength(JSON.stringify(rows), "utf8");
    const startedAt = performance.now();
    let clonedRows = 0;
    let chunks = 0;
    for (let start = 0; start < rows.length; start += chunkSize) {
        const chunk = rows.slice(start, start + chunkSize);
        const cloned = structuredClone(chunk);
        clonedRows += cloned.length;
        chunks += 1;
    }
    const elapsedMs = performance.now() - startedAt;
    console.log(JSON.stringify({ count, chunkSize, chunks, clonedRows, jsonBytes, elapsedMs: Math.round(elapsedMs * 100) / 100 }));

    const candles: OHLCVData[] = Array.from({ length: 48 }, (_, index) => ({
        time: (index * 14_400) as OHLCVData["time"],
        open: 100 + (index % 3) * 0.01,
        high: 100.5 + (index % 3) * 0.01,
        low: 99.5 - (index % 2) * 0.01,
        close: 100 + (index % 4) * 0.02,
        volume: 1,
    }));
    const outcomeStartedAt = performance.now();
    let outcomeCount = 0;
    for (let index = 0; index < count; index += 1) {
        for (const horizonBars of [12, 18, 24]) {
            const outcome = simulateFinderAssetOpportunityForwardOutcome({
                candles,
                direction: index % 2 === 0 ? "long" : "short",
                entryPrice: 100,
                entryBarIndex: 0,
                takeProfitPrice: 102,
                stopLossPrice: 98,
                horizonBars,
                executionModel: "next_open",
                allowSameBarExit: false,
                slippageBps: 10,
                commissionPercent: 0.1,
            });
            if (outcome) outcomeCount += 1;
        }
    }
    const outcomeElapsedMs = performance.now() - outcomeStartedAt;
    console.log(JSON.stringify({
        count,
        outcomeCalls: count * 3,
        outcomeCount,
        outcomeElapsedMs: Math.round(outcomeElapsedMs * 100) / 100,
        outcomeMicrosecondsPerCall: Math.round((outcomeElapsedMs * 1_000) / (count * 3) * 100) / 100,
    }));
}
