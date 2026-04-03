import { expect } from "chai";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getSettingsSectionDefinition } from "./lib/strategy-panel-settings-registry";

function readSettingsSectionIds(partialPath: string): string[] {
    const html = readFileSync(resolve(process.cwd(), partialPath), "utf8");
    const matches = html.matchAll(/data-section="([^"]+)"/g);
    return Array.from(matches, (match) => match[1]);
}

describe("Strategy panel settings registry", () => {
    it("registers every execution settings section found in HTML partials", () => {
        const sectionIds = [
            ...readSettingsSectionIds("html-partials/tab-settings-section-core.html"),
            ...readSettingsSectionIds("html-partials/tab-settings-section-execution.html"),
        ];

        sectionIds.forEach((sectionId) => {
            expect(
                getSettingsSectionDefinition(sectionId),
                `Missing settings registry entry for section ${sectionId}`
            ).to.not.equal(null);
        });
    });
});
