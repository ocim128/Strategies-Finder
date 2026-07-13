import type { Time } from "lightweight-charts";
import type { OHLCVData } from "../strategies/index";
import { state } from "../state";
import { DATA_PROVIDER_TOTAL_LIMIT } from "../data/constants";
import { getIntervalSeconds } from "./utils";

export const MIN_MOCK_BARS = 100;
export const MAX_MOCK_BARS = 500000;

const MOCK_SYMBOLS = new Set(["MOCK_STOCK", "MOCK_CRYPTO", "MOCK_FOREX"]);

export function isMockSymbol(symbol: string): boolean {
    return MOCK_SYMBOLS.has(symbol);
}

/** One reproducible model is enough for UI and strategy smoke testing. */
export function generateMockData(symbol: string, interval: string): OHLCVData[] {
    const requestedBars = Number.isFinite(state.mockChartBars)
        ? Math.floor(state.mockChartBars)
        : DATA_PROVIDER_TOTAL_LIMIT;
    const bars = Math.min(MAX_MOCK_BARS, Math.max(MIN_MOCK_BARS, requestedBars));
    const intervalSeconds = Math.max(1, getIntervalSeconds(interval));
    const latestTime = Math.floor(Date.now() / 1000 / intervalSeconds) * intervalSeconds;
    const rng = createRng(hashString(`${symbol}:${interval}`));
    const data: OHLCVData[] = [];
    let price = startingPrice(symbol);

    for (let index = 0; index < bars; index += 1) {
        const cycle = Math.sin(index / 180) * 0.0008;
        const noise = normal(rng) * 0.004;
        const shock = rng() < 0.002 ? normal(rng) * 0.025 : 0;
        const open = price;
        const close = Math.max(0.0001, open * Math.exp(cycle + noise + shock));
        const range = Math.abs(normal(rng)) * 0.003 + 0.001;
        const high = Math.max(open, close) * (1 + range);
        const low = Math.max(0.0001, Math.min(open, close) * (1 - range));
        const volume = Math.round(100000 * (0.5 + rng() * 1.5) * (1 + Math.abs(noise + shock) * 20));
        const time = latestTime - (bars - index) * intervalSeconds;
        data.push({ time: time as Time, open, high, low, close, volume });
        price = close;
    }
    return data;
}

function startingPrice(symbol: string): number {
    if (symbol === "MOCK_CRYPTO") return 50000;
    if (symbol === "MOCK_FOREX") return 1.1;
    return 100;
}

function hashString(value: string): number {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

function createRng(seed: number): () => number {
    let stateValue = seed >>> 0;
    return () => {
        stateValue += 0x6d2b79f5;
        let value = Math.imul(stateValue ^ (stateValue >>> 15), 1 | stateValue);
        value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

function normal(rng: () => number): number {
    const u = Math.max(Number.EPSILON, rng());
    const v = Math.max(Number.EPSILON, rng());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
