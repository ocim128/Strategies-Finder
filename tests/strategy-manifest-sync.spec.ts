import { expect } from "chai";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import {
    generateStrategyManifestSource,
    getStrategyManifestPath,
} from "../scripts/strategy-manifest-generator";

function normalizeLineEndings(value: string): string {
    return value.replace(/\r\n/g, "\n");
}

describe("Strategy manifest sync", () => {
    it("keeps the generated manifest aligned with strategy files", () => {
        const actual = normalizeLineEndings(readFileSync(getStrategyManifestPath(), "utf8"));
        const expected = normalizeLineEndings(generateStrategyManifestSource());

        expect(actual).to.equal(expected);
    });
});
