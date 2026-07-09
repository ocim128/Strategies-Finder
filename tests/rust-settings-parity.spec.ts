import { expect } from "chai";
import { describe, it } from "node:test";
import { BACKTEST_SETTINGS_DOM_CONTRACTS } from "../lib/backtest-settings-dom-contract";
import { RUST_UNSUPPORTED_BACKTEST_SETTING_KEYS } from "../lib/rust-settings-sanitizer";

// The Rust sanitizer (rust-settings-sanitizer.ts) and the DOM contract
// (backtest-settings-dom-contract.ts) are two independent declarations of the
// same fact: "which settings the Rust engine cannot handle." Keeping them in
// sync by hand is the documented source of silent TS/Rust divergence — a
// setting the contract marks unsupported but the sanitizer misses would leak
// into Rust and produce different numbers than the TS engine.
//
// Note: RUST_UNSUPPORTED_BACKTEST_SETTING_KEYS intentionally also lists removed /
// legacy settings (e.g. rsiPeriod, tradeFilterMode) for backward-compat with
// stored payloads, so the lists are NOT directly comparable. The two invariants
// below are the correct weaker form: no contradiction in either direction for
// keys that DO appear in both surfaces.

describe("Rust/TS settings parity", () => {
    it("never marks a setting rustSupport 'supported' while the sanitizer lists it unsupported", () => {
        const rustUnsupported = new Set<string>(RUST_UNSUPPORTED_BACKTEST_SETTING_KEYS);
        const contradictions: string[] = [];

        for (const contract of BACKTEST_SETTINGS_DOM_CONTRACTS) {
            if (contract.rustSupport !== "supported") continue;
            if (rustUnsupported.has(contract.domId) || rustUnsupported.has(contract.settingKey)) {
                contradictions.push(
                    `${contract.domId}: contract says supported, sanitizer says unsupported`
                );
            }
        }

        expect(
            contradictions,
            `contract/sanitizer contradictions: ${contradictions.join("; ")}`
        ).to.deep.equal([]);
    });

    it("sanitizes every contract entry the contract marks rustSupport 'unsupported'", () => {
        const rustUnsupported = new Set<string>(RUST_UNSUPPORTED_BACKTEST_SETTING_KEYS);
        const unsanitized = BACKTEST_SETTINGS_DOM_CONTRACTS
            .filter(
                (contract) =>
                    contract.rustSupport === "unsupported"
                    && !rustUnsupported.has(contract.domId)
                    && !rustUnsupported.has(contract.settingKey)
            )
            .map((contract) => `${contract.domId} (${contract.settingKey})`);

        expect(
            unsanitized,
            `contract marks unsupported but sanitizer does not list — would leak to Rust: ${unsanitized.join("; ")}`
        ).to.deep.equal([]);
    });
});
