import { expect } from "chai";
import { describe, it } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
    ANALYSIS_PANEL_REQUIRED_IDS,
    FINDER_MANAGER_REQUIRED_IDS,
    PAIR_COMBINER_BRIDGE_REQUIRED_IDS,
    PORTFOLIO_LAB_REQUIRED_IDS,
    SETTINGS_WORKSPACE_REQUIRED_IDS,
    UI_EVENT_HANDLER_REQUIRED_IDS,
    WALK_FORWARD_SERVICE_REQUIRED_IDS,
} from "./lib/feature-dom-contracts";

const PARTIALS_DIR = path.join(process.cwd(), "html-partials");

function loadPartialMarkup(): string {
    return readdirSync(PARTIALS_DIR)
        .filter(name => name.endsWith(".html"))
        .sort()
        .map(name => readFileSync(path.join(PARTIALS_DIR, name), "utf8"))
        .join("\n");
}

function extractIds(markup: string): Set<string> {
    const ids = new Set<string>();
    const idPattern = /id\s*=\s*["']([^"'<>]+)["']/g;
    let match: RegExpExecArray | null;

    while ((match = idPattern.exec(markup)) !== null) {
        ids.add(match[1]);
    }

    return ids;
}

describe("Feature DOM contracts", () => {
    const markup = loadPartialMarkup();
    const htmlIds = extractIds(markup);
    const contractGroups = {
        uiEventHandlers: [...UI_EVENT_HANDLER_REQUIRED_IDS],
        settingsWorkspace: [...SETTINGS_WORKSPACE_REQUIRED_IDS],
        analysisPanel: [...ANALYSIS_PANEL_REQUIRED_IDS],
        portfolioLab: [...PORTFOLIO_LAB_REQUIRED_IDS],
        finderManager: [...FINDER_MANAGER_REQUIRED_IDS],
        pairCombinerBridge: [...PAIR_COMBINER_BRIDGE_REQUIRED_IDS],
        walkForwardService: [...WALK_FORWARD_SERVICE_REQUIRED_IDS],
    } as const;

    for (const [groupName, ids] of Object.entries(contractGroups)) {
        it(`${groupName} required ids stay unique`, () => {
            expect(new Set(ids).size).to.equal(ids.length);
        });

        it(`${groupName} required ids exist in html partials`, () => {
            const missingIds = ids.filter(id => !htmlIds.has(id));
            expect(missingIds).to.deep.equal([]);
        });
    }
});
