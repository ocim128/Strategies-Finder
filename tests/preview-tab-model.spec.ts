import { expect } from "chai";
import { describe, it } from "node:test";
import { buildExecutionAwarePreview } from "./lib/preview-tab-model";
import type { EntryPreview } from "./lib/types/strategies";

function createPreview(): EntryPreview {
    return {
        mode: 0,
        direction: "short",
        level: 1,
        fanPrice: 1.34,
        lastClose: 1.34,
        distance: 0.049,
        distancePct: null,
        status: "triggered",
        title: "Live Signal Preview",
        summary: {
            eyebrow: "Forming Bar",
            headline: "Would confirm short now",
            detail: "ER gate is active and z-score is 0.049 on the short side.",
            tone: "negative",
        },
        meta: {
            longReady: false,
            shortReady: true,
            nearestSide: "long",
            deadzoneActive: true,
            secondsToClose: 13,
            isClosedBarPreview: false,
        },
        rows: [
            { section: "Decision", label: "Would confirm", value: "short now" },
            { section: "Decision", label: "Nearest side", value: "long (0.049 away)" },
            { section: "Gate", label: "Short", value: "ready (<= 5.000)" },
        ],
        note: "Preview only.",
    };
}

function createConflictedPreview(): EntryPreview {
    return {
        mode: 0,
        direction: "long",
        level: 0,
        fanPrice: 1.33,
        lastClose: 1.33,
        distance: -0.044,
        distancePct: null,
        status: "triggered",
        title: "Live Signal Preview",
        summary: {
            eyebrow: "Forming Bar",
            headline: "Would confirm long now",
            detail: "Both raw gates are currently true on the forming bar.",
            tone: "positive",
        },
        meta: {
            longReady: true,
            shortReady: true,
            nearestSide: "long",
            deadzoneActive: true,
            secondsToClose: 289,
            isClosedBarPreview: false,
        },
        rows: [
            { section: "Decision", label: "Would confirm", value: "long now" },
            { section: "Decision", label: "Nearest side", value: "long (-0.044 away)" },
            { section: "Gate", label: "Long", value: "ready (>= 0.000)" },
            { section: "Gate", label: "Short", value: "ready (<= 5.000)" },
        ],
        note: "Preview only.",
    };
}

describe("preview-tab-model", () => {
    it("marks a disallowed raw short trigger as ignored in long-only mode", () => {
        const preview = buildExecutionAwarePreview(createPreview(), "long");

        expect(preview.summary).to.deep.equal({
            eyebrow: "Forming Bar",
            headline: "Short raw trigger is ignored",
            detail: "The short side is ready, but Direction Mode is long only, so it is not executable.",
            tone: "neutral",
        });
        expect(preview.rows?.slice(0, 4)).to.deep.equal([
            { section: "Decision", label: "Direction mode", value: "Long only" },
            { section: "Decision", label: "Executable now", value: "No" },
            { section: "Decision", label: "Raw trigger", value: "short" },
            { section: "Decision", label: "Nearest side", value: "long (0.049 away)" },
        ]);
    });

    it("marks the same raw short trigger as executable in short-only mode", () => {
        const preview = buildExecutionAwarePreview(createPreview(), "short");

        expect(preview.summary?.headline).to.equal("Executable short now");
        expect(preview.summary?.tone).to.equal("negative");
        expect(preview.rows?.[1]).to.deep.equal({
            section: "Decision",
            label: "Executable now",
            value: "Short now",
        });
    });

    it("resolves dual raw readiness to the emitted long signal in combined mode", () => {
        const preview = buildExecutionAwarePreview(createConflictedPreview(), "combined");

        expect(preview.summary).to.deep.equal({
            eyebrow: "Forming Bar",
            headline: "Executable long now",
            detail: "Both raw gates are true, but the strategy resolves this bar to long based on its current signal ordering.",
            tone: "positive",
        });
        expect(preview.rows?.slice(0, 5)).to.deep.equal([
            { section: "Decision", label: "Direction mode", value: "Combined (L+S)" },
            { section: "Decision", label: "Executable now", value: "Long now" },
            { section: "Decision", label: "Raw trigger", value: "long" },
            { section: "Decision", label: "Conflict handling", value: "Resolved to long" },
            { section: "Decision", label: "Nearest side", value: "long (-0.044 away)" },
        ]);
    });
});
