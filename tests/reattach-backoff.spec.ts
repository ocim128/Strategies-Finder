import { expect } from "chai";
import { describe, it } from "node:test";
import {
    ReattachBackoffController,
    REATTACH_FAILURE_BACKOFF_MS,
    MAX_REATTACH_CONSECUTIVE_FAILURES,
} from "../lib/batch-backtest/reattach-backoff";

/**
 * Audit Finding 1: the Batch + TOP_MEAN reattach loops share the same
 * transient-failure backoff state machine. This locks the math both loops
 * depend on — the consecutive counter, the backoff index formula, and the
 * give-up threshold — so a change here is a one-file change instead of a
 * two-path port.
 */
describe("ReattachBackoffController (audit Finding 1)", () => {
    it("uses the documented backoff schedule and give-up threshold", () => {
        expect(REATTACH_FAILURE_BACKOFF_MS).to.deep.equal([2_000, 5_000, 10_000, 15_000]);
        expect(MAX_REATTACH_CONSECUTIVE_FAILURES).to.equal(20);
    });

    it("clamps the backoff index to the last step after the schedule is exhausted", () => {
        const ctrl = new ReattachBackoffController();
        // Failures 1..4 walk the schedule; failure 5+ clamps to the 15s ceiling.
        const steps: number[] = [];
        for (let i = 0; i < 6; i += 1) {
            steps.push(ctrl.recordFailure().backoffDelayMs);
        }
        expect(steps).to.deep.equal([2_000, 5_000, 10_000, 15_000, 15_000, 15_000]);
    });

    it("does not give up before the threshold and reports 1-based counts for status text", () => {
        const ctrl = new ReattachBackoffController();
        // Give-up is `consecutive > MAX` (strictly greater), so failures 1..MAX
        // must not give up. Mirrors the original `reattachConsecutiveFailures >
        // MAX_REATTACH_CONSECUTIVE_FAILURES` gate both loops used.
        for (let i = 1; i <= MAX_REATTACH_CONSECUTIVE_FAILURES; i += 1) {
            const outcome = ctrl.recordFailure();
            expect(outcome.gaveUp, `failure ${i} must not give up`).to.equal(false);
            expect(outcome.consecutive).to.equal(i);
            expect(outcome.max).to.equal(MAX_REATTACH_CONSECUTIVE_FAILURES);
        }
        // The (MAX + 1)th failure gives up.
        const fatal = ctrl.recordFailure();
        expect(fatal.gaveUp, "failure past the threshold must give up").to.equal(true);
        expect(fatal.consecutive).to.equal(MAX_REATTACH_CONSECUTIVE_FAILURES + 1);
    });

    it("recordSuccess resets the counter so a single healthy poll clears the backoff budget", () => {
        const ctrl = new ReattachBackoffController();
        // Accumulate a few failures.
        ctrl.recordFailure();
        ctrl.recordFailure();
        expect(ctrl.getConsecutive()).to.equal(2);
        // A single success resets to zero — the next failure starts fresh at 2s.
        ctrl.recordSuccess();
        expect(ctrl.getConsecutive()).to.equal(0);
        const outcome = ctrl.recordFailure();
        expect(outcome.consecutive).to.equal(1);
        expect(outcome.backoffDelayMs).to.equal(2_000);
    });

    it("reset clears the counter for a new reattach run", () => {
        const ctrl = new ReattachBackoffController();
        ctrl.recordFailure();
        ctrl.recordFailure();
        ctrl.reset();
        expect(ctrl.getConsecutive()).to.equal(0);
    });
});
