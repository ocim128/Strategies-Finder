import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    LineRingBuffer,
    classifyTestRunStatus,
    normalizeForMatch,
    parseExplicitJobCount,
    parseTimeoutMs,
    sanitizeLogName,
    selectTests,
} from "../scripts/run-tests";

describe("test runner contracts", () => {
    it("keeps bounded failure output while preserving partial lines", () => {
        const buffer = new LineRingBuffer(2);
        buffer.pushChunk("first\nsecond\nthird");
        assert.deepEqual(buffer.flush(), ["second", "third"]);
    });

    it("normalizes filters and selects matching specs", () => {
        assert.equal(normalizeForMatch("Tests\\Feature-Dom-Contracts.spec.ts"), "tests/feature-dom-contracts.spec.ts");
        assert.deepEqual(
            selectTests(
                ["tests/feature-dom-contracts.spec.ts", "tests/e2e.spec.ts", "tests/worker.spec.ts"],
                ["FEATURE-DOM"]
            ),
            ["tests/feature-dom-contracts.spec.ts"]
        );
    });

    it("validates bounded runner options", () => {
        assert.equal(parseExplicitJobCount("4"), 4);
        assert.equal(parseTimeoutMs("5000"), 5000);
        assert.throws(() => parseExplicitJobCount("0"), /positive numeric/);
        assert.throws(() => parseTimeoutMs("999"), /at least 1000/);
    });

    it("makes explicit skip outcomes distinct from passes and failures", () => {
        assert.equal(classifyTestRunStatus(0, false, false, false), "PASS");
        assert.equal(classifyTestRunStatus(0, false, false, false, "catalog unavailable"), "SKIP");
        assert.equal(classifyTestRunStatus(1, false, false, false, "catalog unavailable"), "FAIL");
    });

    it("sanitizes platform-specific log names", () => {
        assert.equal(sanitizeLogName("tests\\foo/bar.spec.ts"), "tests__foo__bar.spec.ts");
    });
});
