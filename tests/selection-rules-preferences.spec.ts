import { expect } from "chai";
import { describe, it } from "node:test";
import { normalizeSelectionRulesPreferences } from "../lib/selection-rules/preferences";

describe("selection-rules preferences", () => {
    it("preserves an intentional empty rule selection", () => {
        expect(normalizeSelectionRulesPreferences({
            folderId: "folder-a",
            horizonBars: 24,
            ruleKeys: [],
        }, ["rule-a"])).to.deep.equal({
            folderId: "folder-a",
            horizonBars: 24,
            ruleKeys: [],
        });
    });

    it("filters removed and duplicate rules while retaining valid settings", () => {
        expect(normalizeSelectionRulesPreferences({
            folderId: "folder-a",
            horizonBars: 48,
            ruleKeys: ["rule-b", "removed", "rule-b", "rule-a"],
        }, ["rule-a", "rule-b"])).to.deep.equal({
            folderId: "folder-a",
            horizonBars: 48,
            ruleKeys: ["rule-b", "rule-a"],
        });
    });

    it("rejects malformed preference payloads", () => {
        expect(normalizeSelectionRulesPreferences({ ruleKeys: "rule-a" }, ["rule-a"])).to.equal(null);
        expect(normalizeSelectionRulesPreferences({ ruleKeys: [], horizonBars: 0 }, ["rule-a"])).to.equal(null);
    });
});
