import { expect } from "chai";
import { describe, it } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { UI_EVENT_HANDLER_REQUIRED_IDS } from "./lib/handlers/ui-event-handlers-dom";
import { STATE_SUBSCRIPTIONS_REQUIRED_IDS } from "./lib/handlers/state-subscriptions-dom";
import { EDITOR_MANAGER_REQUIRED_IDS } from "./lib/editor-manager-dom";
import { SETTINGS_WORKSPACE_REQUIRED_IDS, UI_MANAGER_REQUIRED_IDS } from "./lib/ui-manager-dom";
import { RESULTS_RENDERER_REQUIRED_IDS } from "./lib/renderers/results-renderer-dom";
import { TRADES_RENDERER_REQUIRED_IDS } from "./lib/renderers/trades-renderer-dom";
import { SETTINGS_MANAGER_REQUIRED_IDS } from "./lib/settings-manager-dom";
import { POLYMARKET_PANEL_REQUIRED_IDS } from "./lib/polymarket-panel-dom";
import { EXECUTION_LAB_REQUIRED_IDS } from "../lib/execution-lab/execution-lab-dom";
import { PORTFOLIO_LAB_REQUIRED_IDS } from "./lib/portfolio-lab-dom";
import { LIVE_POSITIONS_REQUIRED_IDS } from "./lib/live-positions-dom";
import { FINDER_MANAGER_REQUIRED_IDS } from "./lib/finder/finder-manager-dom";
import { HUNT_REQUIRED_IDS } from "../lib/hunt/hunt-dom";
import { PAIR_COMBINER_BRIDGE_REQUIRED_IDS } from "./lib/pairCombiner/pair-combiner-bridge-dom";
import { WALK_FORWARD_SERVICE_REQUIRED_IDS } from "./lib/walk-forward-dom";
import { ENSEMBLE_LAB_REQUIRED_IDS } from "./lib/strategy-ensemble-dom";
import { MONTE_CARLO_REQUIRED_IDS } from "../lib/monte-carlo-dom";
import { STRATEGY_LIBRARY_ADMIN_REQUIRED_IDS } from "../lib/strategy-library-admin-dom";
import { STRATEGY_LIBRARY_AUDIT_REQUIRED_IDS } from "../lib/strategy-library-audit-dom";
import { CROSS_SYMBOL_REQUIRED_IDS } from "../lib/cross-symbol-dom";
import { CHART_MANAGER_REQUIRED_IDS } from "../lib/chart-manager-dom";
import { STRATEGY_PANEL_REQUIRED_IDS } from "../lib/strategy-panel-dom";
import { STRATEGY_DEBUGGER_REQUIRED_IDS } from "../lib/strategy-debugger-dom";

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

function extractStrategyPanelTabIds(markup: string): string[] {
    const tabIds: string[] = [];
    const buttonPattern = /<button\b[^>]*>/g;
    let match: RegExpExecArray | null;

    while ((match = buttonPattern.exec(markup)) !== null) {
        const tag = match[0];
        const classMatch = /class\s*=\s*["']([^"']*)["']/.exec(tag);
        if (!classMatch?.[1].split(/\s+/).includes("panel-tab")) {
            continue;
        }
        const dataTabMatch = /data-tab\s*=\s*["']([^"']+)["']/.exec(tag);
        if (dataTabMatch) {
            tabIds.push(dataTabMatch[1]);
        }
    }

    return tabIds;
}

describe("Feature DOM contracts", () => {
    const markup = loadPartialMarkup();
    const htmlIds = extractIds(markup);
    const contractGroups = {
        uiEventHandlers: [...UI_EVENT_HANDLER_REQUIRED_IDS],
        stateSubscriptions: [...STATE_SUBSCRIPTIONS_REQUIRED_IDS],
        editorManager: [...EDITOR_MANAGER_REQUIRED_IDS],
        uiManager: [...UI_MANAGER_REQUIRED_IDS],
        resultsRenderer: [...RESULTS_RENDERER_REQUIRED_IDS],
        tradesRenderer: [...TRADES_RENDERER_REQUIRED_IDS],
        settingsManager: [...SETTINGS_MANAGER_REQUIRED_IDS],
        settingsWorkspace: [...SETTINGS_WORKSPACE_REQUIRED_IDS],

        portfolioLab: [...PORTFOLIO_LAB_REQUIRED_IDS],
        livePositions: [...LIVE_POSITIONS_REQUIRED_IDS],
        polymarketPanel: [...POLYMARKET_PANEL_REQUIRED_IDS],
        executionLab: [...EXECUTION_LAB_REQUIRED_IDS],
        ensembleLab: [...ENSEMBLE_LAB_REQUIRED_IDS],
        finderManager: [...FINDER_MANAGER_REQUIRED_IDS],
        hunt: [...HUNT_REQUIRED_IDS],
        pairCombinerBridge: [...PAIR_COMBINER_BRIDGE_REQUIRED_IDS],
        walkForwardService: [...WALK_FORWARD_SERVICE_REQUIRED_IDS],
        monteCarlo: [...MONTE_CARLO_REQUIRED_IDS],
        strategyLibraryAdmin: [...STRATEGY_LIBRARY_ADMIN_REQUIRED_IDS],
        strategyLibraryAudit: [...STRATEGY_LIBRARY_AUDIT_REQUIRED_IDS],
        crossSymbol: [...CROSS_SYMBOL_REQUIRED_IDS],
        chartManager: [...CHART_MANAGER_REQUIRED_IDS],
        strategyPanel: [...STRATEGY_PANEL_REQUIRED_IDS],
        strategyDebugger: [...STRATEGY_DEBUGGER_REQUIRED_IDS],
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

    it("strategy panel tab buttons have matching tab panels", () => {
        const missingPanels = extractStrategyPanelTabIds(markup)
            .filter(tabId => !htmlIds.has(`${tabId}Tab`));

        expect(missingPanels).to.deep.equal([]);
    });
});
