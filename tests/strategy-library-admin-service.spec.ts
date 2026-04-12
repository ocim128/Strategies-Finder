import { expect } from "chai";
import { describe, it } from "node:test";
import { parseStrategyLibraryBulkEntries } from "../lib/strategy-library-admin-utils";

describe("Strategy library admin service", () => {
    it("keeps newline-separated strategy names intact while parsing bulk entries", () => {
        const parsed = parseStrategyLibraryBulkEntries(
            [
                "Entropy Ratio Regime Alignment",
                "Alpha Strategy",
                "alpha_strategy.ts",
                "Alpha Strategy",
            ].join("\n")
        );

        expect(parsed).to.deep.equal([
            "Entropy Ratio Regime Alignment",
            "Alpha Strategy",
            "alpha_strategy.ts",
        ]);
    });

    it("supports comma-separated bulk entries without breaking names that contain spaces", () => {
        const parsed = parseStrategyLibraryBulkEntries(
            "Entropy Ratio Regime Alignment, Alpha Strategy, lib/strategies/lib/alpha_strategy.ts"
        );

        expect(parsed).to.deep.equal([
            "Entropy Ratio Regime Alignment",
            "Alpha Strategy",
            "lib/strategies/lib/alpha_strategy.ts",
        ]);
    });
});
