import { expect } from "chai";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import {
    generateStrategyManifestSource,
    generateStrategyMetaSource,
    generateStrategyLoadersSource,
    generateStrategyKeysSource,
    getStrategyManifestPath,
    getStrategyMetaPath,
    getStrategyLoadersPath,
    getStrategyKeysPath,
} from "../scripts/strategy-manifest-generator";

function normalizeLineEndings(value: string): string {
    return value.replace(/\r\n/g, "\n");
}

function checkSynced(path: string, generator: () => string, label: string): void {
    const actual = normalizeLineEndings(readFileSync(path, "utf8"));
    const expected = normalizeLineEndings(generator());
    expect(actual).to.equal(expected, `${label} is out of sync — run npm run strategies:sync-manifest`);
}

describe("Strategy manifest sync", () => {
    it("keeps the generated manifest aligned with strategy files", () => {
        checkSynced(getStrategyManifestPath(), generateStrategyManifestSource, "manifest.ts");
    });

    it("keeps the generated meta aligned with strategy files", () => {
        checkSynced(getStrategyMetaPath(), generateStrategyMetaSource, "manifest-meta.ts");
    });

    it("keeps the generated loaders aligned with strategy files", () => {
        checkSynced(getStrategyLoadersPath(), generateStrategyLoadersSource, "manifest-loaders.ts");
    });

    it("keeps the generated keys aligned with strategy files", () => {
        checkSynced(getStrategyKeysPath(), generateStrategyKeysSource, "manifest-keys.ts");
    });
});
