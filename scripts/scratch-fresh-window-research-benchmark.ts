import { performance } from "node:perf_hooks";

const row = (index: number) => ({
    symbol: `PAIR_${index % 679}`,
    strategyKey: `strategy_${index % 45}`,
    candidateFingerprint: `{"p":${index % 31},"q":${index % 17}}`,
    identityHash: `${index.toString(16).padStart(64, "0")}`,
    candidateIndex: index,
    evaluationOk: true,
    passesTradeFilter: index % 5 !== 0,
    netProfitPercent: (index % 101) / 10,
    totalTrades: index % 20,
    tpHitCount: index % 8,
    medianBarsToTP: index % 12,
    medianBarsToTerminal: index % 18,
    tpFirstShare: (index % 10) / 10,
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
}
