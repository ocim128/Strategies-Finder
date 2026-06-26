import { expect } from "chai";
import { describe, it } from "node:test";
import { BACKTEST_DOM_SETTING_IDS } from "../lib/backtest-settings-resolver";
import { BACKTEST_SETTINGS_DOM_CONTRACTS } from "../lib/backtest-settings-dom-contract";

// The repo documents a recurring footgun (see AGENTS.md "Modify Exit Strategy Override"):
// a backtest setting id must be registered in BOTH the resolver list
// (BACKTEST_DOM_SETTING_IDS in backtest-settings-resolver.ts) AND the DOM contract
// (BACKTEST_SETTINGS_DOM_CONTRACTS in backtest-settings-dom-contract.ts). Adding to
// only one causes the symptom "DOM checked, settings false" — the reader silently
// drops the setting. These specs lock the relationship so the drift is caught at
// test time instead of by manual UI verification.
//
// The contract list is a superset (it also covers advanced-sizing fields with their
// own resolver path), so the correct invariant is SUBSET, not equality.

describe("backtest settings id parity", () => {
    it("BACKTEST_DOM_SETTING_IDS is a subset of BACKTEST_SETTINGS_DOM_CONTRACTS domIds", () => {
        // The contract list is a superset (it also covers advanced-sizing fields with
        // their own resolver path), so the correct invariant is SUBSET, not equality.
        // A violation here is the documented "DOM checked, settings false" footgun:
        // the resolver reads a setting the DOM contract reader silently drops.
        const contractDomIds = new Set(
            BACKTEST_SETTINGS_DOM_CONTRACTS.map((contract) => contract.domId)
        );

        const violations = BACKTEST_DOM_SETTING_IDS.filter(
            (id) => !contractDomIds.has(id)
        );

        expect(
            violations,
            `resolver id(s) missing from DOM contract — this causes "DOM checked, settings false": ${violations.join(", ")}`
        ).to.deep.equal([]);
    });
});
