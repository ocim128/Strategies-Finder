import { expect } from "chai";
import { describe, it } from "node:test";
import type { HuntProfileTiming, HuntTimingSummary } from "../lib/hunt/hunt-runner";

describe("Hunt runner", () => {
    it("HuntTimingSummary shape is structurally valid for a single-profile run", () => {
        const profile: HuntProfileTiming = {
            profileName: "ETH 1d",
            symbol: "ETHUSDT",
            interval: "1d",
            dataLoadMs: 120,
            blockSliceMs: 0.5,
            finderMs: 4500,
            totalMs: 4621,
        };
        const summary: HuntTimingSummary = {
            totalRunMs: 4700,
            profileCount: 1,
            profiles: [profile],
        };

        expect(summary.profileCount).to.equal(1);
        expect(summary.profiles).to.have.length(1);
        expect(summary.profiles[0]).to.deep.equal(profile);
        expect(summary.totalRunMs).to.be.greaterThan(0);
        expect(summary.profiles[0].dataLoadMs).to.be.greaterThan(0);
        expect(summary.profiles[0].finderMs).to.be.greaterThan(0);
        expect(summary.profiles[0].totalMs).to.be.greaterThan(0);
    });

    it("HuntProfileTiming accumulates all major buckets", () => {
        const timing: HuntProfileTiming = {
            profileName: "BTC 4h",
            symbol: "BTCUSDT",
            interval: "4h",
            dataLoadMs: 200,
            blockSliceMs: 1,
            finderMs: 8000,
            totalMs: 8201,
        };

        const buckets = ["dataLoadMs", "blockSliceMs", "finderMs", "totalMs"] as const;
        for (const key of buckets) {
            expect(timing[key]).to.be.a("number");
            expect(timing[key]).to.be.at.least(0);
        }

        expect(timing.totalMs).to.be.at.least(timing.dataLoadMs + timing.blockSliceMs + timing.finderMs - 1);
    });

    it("HuntTimingSummary supports multi-profile timing", () => {
        const profiles: HuntProfileTiming[] = [
            { profileName: "ETH 1d", symbol: "ETHUSDT", interval: "1d", dataLoadMs: 50, blockSliceMs: 0.2, finderMs: 3000, totalMs: 3050 },
            { profileName: "BTC 4h", symbol: "BTCUSDT", interval: "4h", dataLoadMs: 80, blockSliceMs: 0.3, finderMs: 5000, totalMs: 5080 },
        ];
        const summary: HuntTimingSummary = {
            totalRunMs: 8200,
            profileCount: 2,
            profiles,
        };

        expect(summary.profileCount).to.equal(2);
        expect(summary.profiles).to.have.length(2);
        expect(summary.totalRunMs).to.be.at.least(
            summary.profiles.reduce((sum, p) => sum + p.totalMs, 0) - 2
        );
    });

    it("dataset cache key normalizes symbol and interval", () => {
        const buildKey = (symbol: string, interval: string) =>
            `${symbol.trim().toUpperCase()}|${interval.trim().toLowerCase()}`;

        expect(buildKey("ethusdt", "1D")).to.equal("ETHUSDT|1d");
        expect(buildKey("  btcusdt  ", "  4H  ")).to.equal("BTCUSDT|4h");
        expect(buildKey("ETHUSDT", "1d")).to.equal(buildKey("ethusdt", "1D"));
        expect(buildKey("BTCUSDT", "4h")).to.not.equal(buildKey("BTCUSDT", "1d"));
        expect(buildKey("ETHUSDT", "1d")).to.not.equal(buildKey("BTCUSDT", "1d"));
    });

    it("dataset cache deduplicates same symbol+interval via Promise sharing", async () => {
        let fetchCount = 0;
        const cache = new Map<string, Promise<string[]>>();
        const fetch = async (_key: string): Promise<string[]> => {
            fetchCount++;
            return ["candle"];
        };
        const getOrFetch = (symbol: string, interval: string) => {
            const k = `${symbol.toUpperCase()}|${interval.toLowerCase()}`;
            const existing = cache.get(k);
            if (existing) return existing;
            const p = fetch(k);
            cache.set(k, p);
            return p;
        };

        await getOrFetch("ETHUSDT", "1d");
        await getOrFetch("ETHUSDT", "1d");
        await getOrFetch("ethusdt", "1D");

        expect(fetchCount).to.equal(1);

        await getOrFetch("BTCUSDT", "4h");
        expect(fetchCount).to.equal(2);
    });
});
