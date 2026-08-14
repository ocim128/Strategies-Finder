import { expect } from "chai";
import { describe, it } from "node:test";
import { builtInStrategyKeys } from "../../lib/strategies/manifest-keys";
import { decay_anchor_reversion } from "../../lib/strategies/lib/decay_anchor_reversion";
import { defended_low_reversion } from "../../lib/strategies/lib/defended_low_reversion";
import { lagged_value_anchor_reversion } from "../../lib/strategies/lib/lagged_value_anchor_reversion";
import { buildFinderSearchBaseParams, normalizeFinderCandidateParams } from "../../lib/finder/finder-runner-core";

const SURVIVING_REVERSION_KEYS = [
    "decay_anchor_reversion",
    "defended_low_reversion",
    "lagged_value_anchor_reversion",
];

describe("reversion strategy family", () => {
    it("registers the surviving reversion strategies in the built-in manifest", () => {
        for (const key of SURVIVING_REVERSION_KEYS) {
            expect(builtInStrategyKeys, `manifest missing ${key}`).to.include(key);
        }
    });

    it("normalizes params to canonical bounds", () => {
        // decay_anchor_reversion: decay is fixed at 1.
        expect(decay_anchor_reversion.normalizeParams?.({ decay: 0.2 })).to.deep.equal({ decay: 1 });
        expect(decay_anchor_reversion.normalizeParams?.({ decay: 0.95 })).to.deep.equal({ decay: 1 });
        expect(decay_anchor_reversion.normalizeParams?.({ decay: 1 })).to.deep.equal({ decay: 1 });

        // defended_low_reversion / lagged_value_anchor_reversion: lookback clamped >= 10
        expect(defended_low_reversion.normalizeParams?.({ lookback: 5 })).to.deep.equal({ lookback: 10 });
        expect(lagged_value_anchor_reversion.normalizeParams?.({ lookback: 5 })).to.deep.equal({ lookback: 10 });
    });

    it("keeps the fixed decay out of Finder's parameter search", () => {
        const finderBaseParams = buildFinderSearchBaseParams(decay_anchor_reversion, {});

        expect(decay_anchor_reversion.finderFixedParams).to.deep.equal(["decay"]);
        expect(decay_anchor_reversion.metadata?.walkForwardParams).to.deep.equal([]);
        expect(finderBaseParams).to.deep.equal({});
        expect(normalizeFinderCandidateParams(decay_anchor_reversion, finderBaseParams)).to.deep.equal({ decay: 1 });
    });
});
