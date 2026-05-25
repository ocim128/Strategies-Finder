import { expect } from "chai";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
    STRATEGY_PANEL_SETTINGS_SECTIONS,
    getSettingsSectionDefinition,
} from "./lib/strategy-panel-settings-registry";
import { BACKTEST_SETTINGS_DOM_IDS } from "./lib/backtest-settings-dom-contract";

function readSettingsSectionIds(partialPath: string): string[] {
    const html = readFileSync(resolve(process.cwd(), partialPath), "utf8");
    const matches = html.matchAll(/data-section="([^"]+)"/g);
    return Array.from(matches, (match) => match[1]);
}

function readFormControlIds(partialPath: string): string[] {
    const html = readFileSync(resolve(process.cwd(), partialPath), "utf8");
    const controlMatches = html.matchAll(/<(?:input|select|textarea)\b[^>]*\bid="([^"]+)"/g);
    return Array.from(controlMatches, (match) => match[1]);
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

    it("keeps the settings sections in the requested display order", () => {
        expect(STRATEGY_PANEL_SETTINGS_SECTIONS.map((section) => section.id)).to.deep.equal([
            "risk",
            "realism",
            "polymarket",
            "sizing",
            "direction",
            "confirmation",
            "engine",
            "combiner",
        ]);
    });

    it("keeps Polymarket controls in their dedicated settings section", () => {
        const html = readFileSync(resolve(process.cwd(), "html-partials/tab-settings-section-execution.html"), "utf8");
        const polymarketSectionIndex = html.indexOf('data-section="polymarket"');
        const annotationToggleIndex = html.indexOf('id="polymarketAnnotationEnabled"');

        expect(polymarketSectionIndex).to.be.greaterThan(-1);
        expect(annotationToggleIndex).to.be.greaterThan(polymarketSectionIndex);
    });

    it("registers every execution settings form control in the backtest settings DOM contract", () => {
        const contractIds = new Set(BACKTEST_SETTINGS_DOM_IDS);
        const missing = readFormControlIds("html-partials/tab-settings-section-execution.html")
            .filter((id) => !contractIds.has(id));

        expect(missing).to.deep.equal([]);
    });
});
