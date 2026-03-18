import { expect } from "chai";
import { describe, it } from "node:test";
import { buildParameterAuditReport } from "./lib/parameter-audit-logic";
import type { ParameterAuditParameterInput } from "./lib/types/parameter-audit";

function buildInput(parameters: ParameterAuditParameterInput[]) {
    return buildParameterAuditReport({
        strategyKey: "demo_strategy",
        strategyName: "Demo Strategy",
        sourceType: "current_strategy",
        sourceLabel: "Current Strategy: Demo Strategy",
        parameters,
        usedMiniRuns: true,
        usedWfaReuse: false,
        usedFinderReuse: false,
    });
}

describe("Parameter Audit logic", () => {
    it("keeps mini-run-only disable-heavy parameters in a cautious boundary/range bucket", () => {
        const report = buildInput([
            {
                name: "volFilter",
                label: "Vol Filter",
                baseValue: 0,
                range: { name: "volFilter", min: 0, max: 1, step: 0.25 },
                samples: [
                    { origin: "mini_run", value: 0, score: 12, accepted: true, params: { volFilter: 0 }, label: "m1" },
                    { origin: "mini_run", value: 0, score: 11.5, accepted: true, params: { volFilter: 0 }, label: "m2" },
                    { origin: "mini_run", value: 0.5, score: 11.2, accepted: false, params: { volFilter: 0.5 }, label: "m3" },
                    { origin: "mini_run", value: 1, score: 10.8, accepted: false, params: { volFilter: 1 }, label: "m4" },
                ],
            },
        ]);

        expect(report.rows[0]?.classification).to.equal("boundary_problem");
        expect(report.rows[0]?.suggestedAction).to.equal("narrow_range");
    });

    it("keeps high-impact stable parameters as core", () => {
        const report = buildInput([
            {
                name: "lookback",
                label: "Lookback",
                baseValue: 20,
                range: { name: "lookback", min: 10, max: 30, step: 5 },
                samples: [
                    { origin: "wfa_window", value: 20, score: 44, accepted: true, params: { lookback: 20 }, label: "w1" },
                    { origin: "wfa_window", value: 20, score: 41, accepted: true, params: { lookback: 20 }, label: "w2" },
                    { origin: "wfa_window", value: 15, score: 18, accepted: false, params: { lookback: 15 }, label: "w3" },
                    { origin: "wfa_window", value: 25, score: 12, accepted: false, params: { lookback: 25 }, label: "w4" },
                    { origin: "mini_run", value: 10, score: 5, accepted: false, params: { lookback: 10 }, label: "m1" },
                    { origin: "mini_run", value: 30, score: 1, accepted: false, params: { lookback: 30 }, label: "m2" },
                ],
            },
        ]);

        expect(report.rows[0]?.classification).to.equal("core");
        expect(report.rows[0]?.suggestedAction).to.equal("keep");
    });

    it("marks low-standalone parameters with strong pair-dependence as interaction only", () => {
        const report = buildInput([
            {
                name: "trigger",
                label: "Trigger",
                baseValue: 1,
                range: { name: "trigger", min: 0, max: 2, step: 1 },
                samples: [
                    { origin: "wfa_window", value: 1, score: 23, accepted: true, params: { trigger: 1, confirm: 5 }, label: "w1" },
                    { origin: "wfa_window", value: 1, score: 22.5, accepted: true, params: { trigger: 1, confirm: 5 }, label: "w2" },
                    { origin: "wfa_window", value: 1, score: 22.8, accepted: true, params: { trigger: 1, confirm: 5 }, label: "w3" },
                    { origin: "mini_run", value: 0, score: 21.8, accepted: false, params: { trigger: 0, confirm: 5 }, label: "m1" },
                    { origin: "mini_run", value: 2, score: 21.6, accepted: false, params: { trigger: 2, confirm: 5 }, label: "m2" },
                ],
            },
            {
                name: "confirm",
                label: "Confirm",
                baseValue: 5,
                range: { name: "confirm", min: 3, max: 7, step: 1 },
                samples: [
                    { origin: "wfa_window", value: 5, score: 23, accepted: true, params: { trigger: 1, confirm: 5 }, label: "w1" },
                    { origin: "wfa_window", value: 5, score: 22.5, accepted: true, params: { trigger: 1, confirm: 5 }, label: "w2" },
                    { origin: "wfa_window", value: 5, score: 22.8, accepted: true, params: { trigger: 1, confirm: 5 }, label: "w3" },
                    { origin: "mini_run", value: 3, score: 10, accepted: false, params: { trigger: 1, confirm: 3 }, label: "m1" },
                    { origin: "mini_run", value: 7, score: 9, accepted: false, params: { trigger: 1, confirm: 7 }, label: "m2" },
                ],
            },
        ]);

        expect(report.rows[0]?.classification).to.equal("interaction_only");
        expect(report.rows[0]?.suggestedAction).to.equal("investigate_interaction");
    });

    it("does not promote mini-run-only evidence to core or remove recommendations", () => {
        const report = buildInput([
            {
                name: "threshold",
                label: "Threshold",
                baseValue: 0,
                range: { name: "threshold", min: 0, max: 1, step: 0.25 },
                samples: [
                    { origin: "mini_run", value: 0, score: 28, accepted: true, params: { threshold: 0 }, label: "m1" },
                    { origin: "mini_run", value: 0.25, score: 24, accepted: true, params: { threshold: 0.25 }, label: "m2" },
                    { origin: "mini_run", value: 0.5, score: 16, accepted: false, params: { threshold: 0.5 }, label: "m3" },
                    { origin: "mini_run", value: 0.75, score: 15, accepted: false, params: { threshold: 0.75 }, label: "m4" },
                    { origin: "mini_run", value: 1, score: 12, accepted: false, params: { threshold: 1 }, label: "m5" },
                ],
            },
        ]);

        expect(report.rows[0]?.classification).to.equal("weak");
        expect(report.rows[0]?.suggestedAction).to.equal("narrow_range");
        expect(report.rows[0]?.impactScore).to.be.lessThan(80);
    });

    it("treats strong disable-heavy stable parameters as fixable constants, not core", () => {
        const report = buildInput([
            {
                name: "threshold",
                label: "Threshold",
                baseValue: 0,
                range: { name: "threshold", min: 0, max: 1, step: 0.25 },
                samples: [
                    { origin: "wfa_window", value: 0, score: 38, accepted: true, params: { threshold: 0 }, label: "w1" },
                    { origin: "wfa_window", value: 0, score: 36, accepted: true, params: { threshold: 0 }, label: "w2" },
                    { origin: "wfa_window", value: 0, score: 35, accepted: true, params: { threshold: 0 }, label: "w3" },
                    { origin: "wfa_window", value: 0, score: 34, accepted: true, params: { threshold: 0 }, label: "w4" },
                    { origin: "wfa_window", value: 0.25, score: 12, accepted: false, params: { threshold: 0.25 }, label: "w5" },
                    { origin: "wfa_window", value: 0.5, score: 8, accepted: false, params: { threshold: 0.5 }, label: "w6" },
                    { origin: "wfa_window", value: 0.75, score: 6, accepted: false, params: { threshold: 0.75 }, label: "w7" },
                    { origin: "wfa_window", value: 1, score: 5, accepted: false, params: { threshold: 1 }, label: "w8" },
                ],
            },
        ]);

        expect(report.rows[0]?.classification).to.equal("redundant");
        expect(report.rows[0]?.suggestedAction).to.equal("fix_constant");
    });
});
