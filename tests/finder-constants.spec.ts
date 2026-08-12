import { expect } from "chai";
import { describe, it } from "node:test";
import { DEFAULT_SORT_PRIORITY, FINDER_SORT_OPTIONS, METRIC_FULL_LABELS, METRIC_LABELS } from "../lib/finder/constants";

describe("Finder metric labels", () => {
    it("keeps a compact label for every selectable metric", () => {
        for (const metric of Object.keys(METRIC_FULL_LABELS) as Array<keyof typeof METRIC_FULL_LABELS>) {
            expect(METRIC_LABELS[metric], `${metric} compact label`).to.be.a("string").and.not.empty;
        }
    });

    it("offers every default sort-priority metric as a selectable option", () => {
        expect(FINDER_SORT_OPTIONS).to.include.members(DEFAULT_SORT_PRIORITY);
    });
});
