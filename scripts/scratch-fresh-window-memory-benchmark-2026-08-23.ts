export {};

type ScalarResearchRow = {
    symbol: string;
    strategyKey: string;
    candidateFingerprint: string;
    identityHash: string;
    candidateIndex: number;
    evaluationOk: boolean;
    passesTradeFilter: boolean;
    profitFactor: number;
    netProfitPercent: number;
    totalTrades: number;
    tpHitCount: number;
    medianBarsToTP: number;
    medianBarsToTerminal: number;
    tpFirstShare: number;
    forwardOutcomes: Record<string, {
        exitReason: "take_profit" | "stop_loss" | "end_of_data";
        barsHeld: number;
        grossReturnPercent: number;
        slippagePercent: number;
        commissionPercent: number;
        netReturnPercent: number;
        entryPrice: number;
        exitPrice: number;
        entryTimestamp: string;
        exitTimestamp: string;
    }>;
};

const row = (index: number): ScalarResearchRow => ({
    symbol: `PAIR_${index % 679}`,
    strategyKey: `strategy_${index % 45}`,
    candidateFingerprint: `{"p":${index % 31},"q":${index % 17}}`,
    identityHash: index.toString(16).padStart(64, "0"),
    candidateIndex: index,
    evaluationOk: true,
    passesTradeFilter: true,
    profitFactor: 1 + (index % 17) / 10,
    netProfitPercent: (index % 19) / 10,
    totalTrades: 10,
    tpHitCount: 3,
    medianBarsToTP: 4,
    medianBarsToTerminal: 5,
    tpFirstShare: 0.5,
    forwardOutcomes: Object.fromEntries([12, 18, 24].map((horizon) => [String(horizon), {
        exitReason: index % 3 === 0 ? "take_profit" : index % 3 === 1 ? "stop_loss" : "end_of_data",
        barsHeld: horizon,
        grossReturnPercent: 0.2,
        slippagePercent: 0.02,
        commissionPercent: 0.1,
        netReturnPercent: 0.08,
        entryPrice: 100,
        exitPrice: 100.2,
        entryTimestamp: "2026-08-23T00:00:00.000Z",
        exitTimestamp: "2026-08-24T00:00:00.000Z",
    }])),
});

const count = 679 * 45;
const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
if (typeof gc === "function") gc();
const before = process.memoryUsage().heapUsed;
const rows = Array.from({ length: count }, (_, index) => row(index));
const after = process.memoryUsage().heapUsed;
console.log(JSON.stringify({
    symbols: 679,
    strategies: 45,
    rows: count,
    jsonBytes: Buffer.byteLength(JSON.stringify(rows), "utf8"),
    heapDeltaBytes: after - before,
    heapDeltaMiB: Math.round((after - before) / 1024 / 1024 * 100) / 100,
}));
