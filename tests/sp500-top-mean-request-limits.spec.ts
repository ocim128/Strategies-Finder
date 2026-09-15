import { expect } from "chai";
import { describe, it } from "node:test";
import {
    parseTopMeanMenuHorizons,
    parseTopMeanMenuOptionalPositiveInt,
    TOP_MEAN_HORIZONS_MAX_LENGTH,
    TOP_MEAN_HORIZONS_MAX_VALUE,
    TOP_MEAN_MAX_PAIRS_MAX,
    TOP_MEAN_WORKER_COUNT_MAX,
    validateTopMeanRequestLimits,
} from "../lib/batch-backtest/sp500-top-mean-request-limits";

describe("validateTopMeanRequestLimits", () => {
    it("accepts legitimate UI-shaped values", () => {
        const result = validateTopMeanRequestLimits({
            horizons: [12, 24, 48],
            workerCount: 4,
            maxPairs: 2000,
        });
        expect(result.ok).to.equal(true);
        if (result.ok) {
            expect(result.value.horizons).to.deep.equal([12, 24, 48]);
            expect(result.value.workerCount).to.equal(4);
            expect(result.value.maxPairs).to.equal(2000);
        }
    });

    it("rejects empty, non-integer, zero, duplicate, oversized, and too-many horizons", () => {
        expect(validateTopMeanRequestLimits({ horizons: [] }).ok).to.equal(false);
        expect(validateTopMeanRequestLimits({ horizons: [1.5] }).ok).to.equal(false);
        expect(validateTopMeanRequestLimits({ horizons: [0] }).ok).to.equal(false);
        expect(validateTopMeanRequestLimits({ horizons: [-3] }).ok).to.equal(false);
        expect(validateTopMeanRequestLimits({ horizons: [12, 12] }).ok).to.equal(false);
        expect(validateTopMeanRequestLimits({ horizons: [TOP_MEAN_HORIZONS_MAX_VALUE + 1] }).ok).to.equal(false);
        const tooMany = Array.from({ length: TOP_MEAN_HORIZONS_MAX_LENGTH + 1 }, (_, i) => i + 1);
        expect(validateTopMeanRequestLimits({ horizons: tooMany }).ok).to.equal(false);
    });

    it("rejects workerCount / maxPairs outside the documented bounds", () => {
        expect(validateTopMeanRequestLimits({ horizons: [12], workerCount: 0 }).ok).to.equal(false);
        expect(validateTopMeanRequestLimits({ horizons: [12], workerCount: TOP_MEAN_WORKER_COUNT_MAX + 1 }).ok).to.equal(false);
        expect(validateTopMeanRequestLimits({ horizons: [12], maxPairs: 0 }).ok).to.equal(false);
        expect(validateTopMeanRequestLimits({ horizons: [12], maxPairs: TOP_MEAN_MAX_PAIRS_MAX + 1 }).ok).to.equal(false);
    });

    it("normalizes absent/null/off capTiltWeight to baseline (field omitted)", () => {
        for (const capTiltWeight of [undefined, null, "off"]) {
            const result = validateTopMeanRequestLimits({ horizons: [12], capTiltWeight });
            expect(result.ok).to.equal(true);
            if (result.ok) {
                expect(result.value.capTiltWeight, `capTiltWeight=${String(capTiltWeight)}`).to.equal(undefined);
            }
        }
    });

    it("accepts the active capTiltWeight enum values and rejects anything else", () => {
        const small = validateTopMeanRequestLimits({ horizons: [12], capTiltWeight: "smallBase2x" });
        expect(small.ok).to.equal(true);
        if (small.ok) expect(small.value.capTiltWeight).to.equal("smallBase2x");
        const large = validateTopMeanRequestLimits({ horizons: [12], capTiltWeight: "largeBase2x" });
        expect(large.ok).to.equal(true);
        if (large.ok) expect(large.value.capTiltWeight).to.equal("largeBase2x");
        const similar = validateTopMeanRequestLimits({ horizons: [12], capTiltWeight: "similarCap2x" });
        expect(similar.ok).to.equal(true);
        if (similar.ok) expect(similar.value.capTiltWeight).to.equal("similarCap2x");

        for (const bad of ["bogus", "OFF", "SmallBase2x", "", 5, true]) {
            const result = validateTopMeanRequestLimits({ horizons: [12], capTiltWeight: bad });
            expect(result.ok, `capTiltWeight=${String(bad)} must be rejected`).to.equal(false);
            if (!result.ok) {
                expect(result.error).to.include("capTiltWeight");
                expect(result.error).to.include("smallBase2x");
            }
        }
    });
});

describe("parseTopMeanMenuOptionalPositiveInt", () => {
    it("treats blank input as not set (auto workers / full universe)", () => {
        for (const raw of ["", "   ", "\t"]) {
            const result = parseTopMeanMenuOptionalPositiveInt(raw);
            expect(result.kind, JSON.stringify(raw)).to.equal("blank");
        }
    });

    it("accepts strict positive integers", () => {
        for (const [raw, value] of [["1", 1], [" 12 ", 12], ["24", 24]] as const) {
            const result = parseTopMeanMenuOptionalPositiveInt(raw);
            expect(result.kind, raw).to.equal("valid");
            if (result.kind === "valid") expect(result.value).to.equal(value);
        }
    });

    // Audit (menu-numeric finding): "0" used to become undefined and silently
    // launch the automatic/full-universe workload; "12.5" was truncated to 12.
    it("rejects zero, fractional, negative, and non-numeric input as invalid", () => {
        for (const raw of ["0", "12.5", "-4", "abc", "12abc", "1e3", "+8"]) {
            const result = parseTopMeanMenuOptionalPositiveInt(raw);
            expect(result.kind, raw).to.equal("invalid");
        }
    });
});

describe("parseTopMeanMenuHorizons", () => {
    it("defaults blank input to 12,24,48", () => {
        const result = parseTopMeanMenuHorizons("");
        expect(result.kind).to.equal("valid");
        if (result.kind === "valid") expect(result.horizons).to.deep.equal([12, 24, 48]);
    });

    it("parses comma-separated positive integers and skips blank tokens", () => {
        const result = parseTopMeanMenuHorizons(" 6 , , 18 ");
        expect(result.kind).to.equal("valid");
        if (result.kind === "valid") expect(result.horizons).to.deep.equal([6, 18]);
    });

    // Audit (menu-numeric finding): invalid tokens used to be silently dropped
    // as long as one valid token remained.
    it("rejects any non-blank token that is not a positive integer", () => {
        for (const raw of ["12,abc", "abc", "12.5,24", "12,0,24", "-3", "12,1e2"]) {
            const result = parseTopMeanMenuHorizons(raw);
            expect(result.kind, raw).to.equal("invalid");
            if (result.kind === "invalid") {
                expect(result.token, raw).to.be.a("string").with.length.greaterThan(0);
            }
        }
    });

    it("rejects an all-blank token list", () => {
        expect(parseTopMeanMenuHorizons(" , , ").kind).to.equal("invalid");
    });
});
