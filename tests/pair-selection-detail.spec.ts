import { expect } from "chai";
import { describe, it } from "node:test";
import {
    SELECTION_RULES_DETAIL_PENDING_PROBE_MAX_EVENTS,
    tallyPairSelectionRule,
    type PairSelectionArchive,
    type PairSelectionDetailRow,
    type PairSelectionRuleDetail,
} from "../lib/pair-selection/tally";
import type { PairSelectionRule } from "../lib/pair-selection/types";

interface SpecCandidate {
    pair: string;
    base: string;
    quote: string;
    direction: "long" | "short";
    /** Causal feature the fixture rules score on. */
    return20: number;
    /** Private-to-the-harness 24-bar horizon outcome; null = unavailable. */
    outcome: number | null;
    /** Optional ATR feature; null means the loudest-ATR reference cannot be formed. */
    atrPct: number | null;
}

interface SpecEvent {
    signalTime: number;
    candidates: SpecCandidate[];
}

function specCandidate(
    pair: string,
    direction: "long" | "short",
    return20: number,
    outcome: number | null,
    atrPct: number | null = 1,
): SpecCandidate {
    const [base, quote] = pair.split("/");
    return { pair, base: base!, quote: quote!, direction, return20, outcome, atrPct };
}

function buildArchive(events: readonly SpecEvent[]): PairSelectionArchive {
    const horizonReturns = new Map<string, number | null>();
    for (const event of events) {
        for (const candidate of event.candidates) {
            horizonReturns.set(JSON.stringify([24, event.signalTime, candidate.pair, candidate.direction]), candidate.outcome);
        }
    }
    return {
        runId: "detail-spec-run",
        interval: "4h",
        strategyKey: "detail-spec-strategy",
        ledgerHorizons: [24],
        events: events.map(({ signalTime, candidates }) => ({
            context: { signalTime, interval: "4h", strategyKey: "detail-spec-strategy" },
            candidates: candidates.map((candidate) => ({
                pair: candidate.pair,
                baseSymbol: candidate.base,
                quoteSymbol: candidate.quote,
                direction: candidate.direction,
                signalTime,
                signalBarIndex: 0,
                feat_entryRangePosition: null,
                feat_atrPct: candidate.atrPct,
                feat_return20: candidate.return20,
                feat_gapPct: null,
                feat_dow: null,
                feat_hour: null,
                feat_pairWinRatePrior: null,
                feat_pairTradesPrior: 0,
                feat_barsSincePairLastFire: null,
                feat_pairSpreadVolatility20: null,
                feat_legVolatilityRatio20: null,
                feat_candidatesAtTime: null,
            })),
        })),
        horizonReturns,
        diagnostics: {
            loadWallMs: 0, rowsParsed: 0, jsonParseMs: 0, streamWallMs: 0, readResidualMs: 0,
            consumeMs: 0, rankRowsParsed: 0, rankJsonParseMs: 0, rankStreamWallMs: 0,
            rankReadResidualMs: 0, rankJoinMs: 0, rankJoinFused: false, ranksLoaded: false,
            rows: 0, events: events.length, candidates: 0,
        },
    };
}

const argmaxRule: PairSelectionRule = {
    key: "detail_spec_argmax",
    name: "DETAIL_SPEC_ARGMAX",
    description: "Selects the highest feat_return20.",
    defaultParams: {},
    paramLabels: {},
    score: (candidate) => candidate.feat_return20 ?? Number.NEGATIVE_INFINITY,
};

const rejectAllRule: PairSelectionRule = {
    key: "detail_spec_reject_all",
    name: "DETAIL_SPEC_REJECT_ALL",
    description: "Rejects every candidate.",
    defaultParams: {},
    paramLabels: {},
    score: () => Number.NEGATIVE_INFINITY,
};

function collectDetail(archive: PairSelectionArchive, rule: PairSelectionRule): { result: ReturnType<typeof tallyPairSelectionRule>; detail: PairSelectionRuleDetail | null } {
    let detail: PairSelectionRuleDetail | null = null;
    const result = tallyPairSelectionRule(archive, rule, undefined, 24, undefined, (payload) => { detail = payload; });
    return { result, detail };
}

function rowKey(row: PairSelectionDetailRow): string {
    return `${row.signalTime}|${row.pair}|${row.direction}|${row.status}`;
}

describe("pair-selection detail payload", () => {
    it("emits COMPLETE rows one-to-one with the strict tally samples", () => {
        const archive = buildArchive([
            {
                signalTime: 100,
                candidates: [
                    specCandidate("A/B", "long", 3, 0.10),
                    specCandidate("C/D", "long", 2, 0.00),
                    specCandidate("E/F", "short", 1, 0.20),
                ],
            },
            {
                signalTime: 200,
                candidates: [
                    specCandidate("G/H", "long", 6, 0.20),
                    specCandidate("I/J", "long", 5, -0.10),
                ],
            },
        ]);
        const { result, detail } = collectDetail(archive, argmaxRule);
        expect(detail).to.not.equal(null);
        const history = detail!.history;
        expect(history.map(rowKey)).to.deep.equal([
            "100|A/B|long|COMPLETE",
            "200|G/H|long|COMPLETE",
        ]);
        expect(history[0]).to.include({
            candidateCount: 3,
            tiedCount: 1,
            status: "COMPLETE",
        });
        expect(history[0]!.selectedReturn).to.be.closeTo(0.10, 1e-12);
        expect(history[0]!.othersMean).to.be.closeTo(0.10, 1e-12);
        expect(history[0]!.delta).to.be.closeTo(0, 1e-12);
        expect(history[1]).to.include({
            candidateCount: 2,
            status: "COMPLETE",
            selectedReturn: 0.20,
            othersMean: -0.10,
        });
        expect(history[1]!.delta).to.be.closeTo(0.30, 1e-12);
        expect(detail!.latest).to.equal(history[history.length - 1]);
        // Summary output is untouched by detail production.
        expect(result.picks.map((pick) => pick.pair)).to.deep.equal(["A/B", "G/H"]);
        expect(result.tally.eligibleEvents).to.equal(2);
        expect(result.diagnostics.scoredCandidates).to.equal(5);
    });

    it("reports a PENDING latest selection through the bounded tail probe", () => {
        const archive = buildArchive([
            {
                signalTime: 100,
                candidates: [
                    specCandidate("A/B", "long", 3, 0.10),
                    specCandidate("C/D", "long", 2, 0.00),
                ],
            },
            // Gated tail: the most recent pick whose horizon outcome is unknown.
            {
                signalTime: 400,
                candidates: [
                    specCandidate("M/N", "long", 9, null),
                    specCandidate("O/P", "long", 1, 0.05),
                ],
            },
        ]);
        const { detail } = collectDetail(archive, argmaxRule);
        expect(detail!.probe).to.deep.equal({ eventsScanned: 1, scoredCandidates: 2 });
        const latest = detail!.latest!;
        expect(rowKey(latest)).to.equal("400|M/N|long|PENDING");
        expect(latest.selectedReturn).to.equal(null);
        expect(latest.othersMean).to.equal(null);
        expect(latest.delta).to.equal(null);
        // The pending row joins the history as its newest entry but the
        // completed summary only ever saw event 100.
        expect(detail!.history.map(rowKey)).to.deep.equal(["100|A/B|long|COMPLETE", "400|M/N|long|PENDING"]);
    });

    it("retains every pending selection in the bounded tail window", () => {
        const archive = buildArchive([
            {
                signalTime: 100,
                candidates: [
                    specCandidate("A/B", "long", 3, 0.10),
                    specCandidate("C/D", "long", 2, 0.00),
                ],
            },
            {
                signalTime: 200,
                candidates: [
                    specCandidate("E/F", "long", 9, null),
                    specCandidate("G/H", "long", 1, null),
                ],
            },
            {
                signalTime: 300,
                candidates: [
                    specCandidate("I/J", "long", 8, null),
                    specCandidate("K/L", "long", 2, null),
                ],
            },
            {
                signalTime: 400,
                candidates: [
                    specCandidate("M/N", "long", 7, null),
                    specCandidate("O/P", "long", 3, null),
                ],
            },
        ]);
        const { detail } = collectDetail(archive, argmaxRule);
        expect(detail!.probe).to.deep.equal({ eventsScanned: 3, scoredCandidates: 6 });
        expect(detail!.history.map(rowKey)).to.deep.equal([
            "100|A/B|long|COMPLETE",
            "200|E/F|long|PENDING",
            "300|I/J|long|PENDING",
            "400|M/N|long|PENDING",
        ]);
        expect(rowKey(detail!.latest!)).to.equal("400|M/N|long|PENDING");
        for (const pair of ["E/F", "I/J", "M/N"]) {
            const performance = detail!.pairPerformance.find((entry) => entry.pair === pair);
            expect(performance).to.include({ selectedCount: 1, completedCount: 0, winRate: null });
        }
    });

    it("marks selected-outcome-known pool-incomplete rows and keeps them out of completed aggregates", () => {
        const archive = buildArchive([
            {
                signalTime: 100,
                candidates: [
                    specCandidate("A/B", "long", 3, 0.10),
                    specCandidate("C/D", "long", 2, 0.00),
                ],
            },
            {
                signalTime: 400,
                candidates: [
                    specCandidate("M/N", "long", 9, 0.50),
                    specCandidate("O/P", "long", 1, null),
                ],
            },
        ]);
        const { detail } = collectDetail(archive, argmaxRule);
        const latest = detail!.latest!;
        expect(rowKey(latest)).to.equal("400|M/N|long|SELECTED_OUTCOME_KNOWN_POOL_INCOMPLETE");
        expect(latest.selectedReturn).to.be.closeTo(0.50, 1e-12);
        expect(latest.othersMean).to.equal(null);
        expect(latest.delta).to.equal(null);
        const performance = detail!.pairPerformance.find((entry) => entry.pair === "M/N");
        expect(performance).to.not.equal(undefined);
        expect(performance!.selectedCount).to.equal(1);
        expect(performance!.completedCount).to.equal(0);
        expect(performance!.wins).to.equal(0);
        expect(performance!.winRate).to.equal(null);
        expect(performance!.meanSelectedReturn).to.equal(null);
        expect(performance!.meanDelta).to.equal(null);
        const completed = detail!.pairPerformance.find((entry) => entry.pair === "A/B");
        expect(completed!.completedCount).to.equal(1);
        expect(completed!.wins).to.equal(1);
        expect(completed!.winRate).to.be.closeTo(1, 1e-12);
    });

    it("keeps a complete-outcome probe without a reference pick out of completed performance", () => {
        const archive = buildArchive([
            {
                signalTime: 400,
                candidates: [
                    specCandidate("M/N", "long", 9, 0.50, null),
                    specCandidate("O/P", "long", 1, 0.00, null),
                ],
            },
        ]);
        const { result, detail } = collectDetail(archive, argmaxRule);
        expect(result.tally.eligibleEvents).to.equal(0);
        expect(detail!.latest!.status).to.equal("COMPLETE");
        const performance = detail!.pairPerformance.find((entry) => entry.pair === "M/N");
        expect(performance).to.include({
            selectedCount: 1,
            completedCount: 0,
            wins: 0,
            winRate: null,
            meanSelectedReturn: null,
            medianSelectedReturn: null,
            meanDelta: null,
        });
    });

    it("carries tie counts into detail rows", () => {
        const archive = buildArchive([
            {
                signalTime: 200,
                candidates: [
                    specCandidate("G/H", "long", 1, 0.20),
                    specCandidate("I/J", "long", 1, -0.10),
                ],
            },
        ]);
        const tieRule: PairSelectionRule = { ...argmaxRule, score: () => 1 };
        const { detail, result } = collectDetail(archive, tieRule);
        const row = detail!.latest!;
        expect(row.tiedCount).to.equal(2);
        expect(row.score).to.equal(1);
        expect(["G/H", "I/J"]).to.include(row.pair);
        expect(result.picks[0]!.tiedCount).to.equal(2);
    });

    it("skips rule-rejects-all tail events and falls back to the newest completed row", () => {
        const archive = buildArchive([
            {
                signalTime: 100,
                candidates: [
                    specCandidate("A/B", "long", 3, 0.10),
                    specCandidate("C/D", "long", 2, 0.00),
                ],
            },
            {
                signalTime: 300,
                candidates: [
                    specCandidate("K/L", "long", 9, 0.30),
                    specCandidate("M/N", "long", 1, 0.01),
                ],
            },
        ]);
        const { result, detail } = collectDetail(archive, rejectAllRule);
        expect(result.tally.eligibleEvents).to.equal(0);
        expect(result.diagnostics.unscoredEvents).to.equal(2);
        expect(detail!.latest).to.equal(null);
        expect(detail!.history).to.deep.equal([]);
        expect(detail!.probe).to.deep.equal({ eventsScanned: 2, scoredCandidates: 4 });
    });

    it("skips single-candidate tail events without spending probe budget", () => {
        const archive = buildArchive([
            {
                signalTime: 100,
                candidates: [
                    specCandidate("A/B", "long", 3, 0.10),
                    specCandidate("C/D", "long", 2, 0.00),
                ],
            },
            // Gated tail: two single-candidate events then a gated pick.
            { signalTime: 300, candidates: [specCandidate("K/L", "long", 9, 0.30)] },
            { signalTime: 350, candidates: [specCandidate("Q/R", "short", 5, null)] },
            {
                signalTime: 400,
                candidates: [
                    specCandidate("M/N", "long", 9, null),
                    specCandidate("O/P", "long", 1, 0.05),
                ],
            },
        ]);
        const { detail } = collectDetail(archive, argmaxRule);
        expect(detail!.probe).to.deep.equal({ eventsScanned: 1, scoredCandidates: 2 });
        expect(rowKey(detail!.latest!)).to.equal("400|M/N|long|PENDING");
    });

    it("groups pair performance by pair AND direction", () => {
        const archive = buildArchive([
            {
                signalTime: 100,
                candidates: [
                    specCandidate("A/B", "long", 3, 0.10),
                    specCandidate("A/B", "short", 2, -0.02),
                ],
            },
            {
                signalTime: 200,
                candidates: [
                    specCandidate("A/B", "long", 4, -0.05),
                    specCandidate("A/B", "short", 1, 0.01),
                ],
            },
        ]);
        const longOnly: PairSelectionRule = {
            ...argmaxRule,
            score: (candidate) => candidate.direction === "long" ? candidate.feat_return20 ?? Number.NEGATIVE_INFINITY : Number.NEGATIVE_INFINITY,
        };
        const shortOnly: PairSelectionRule = {
            ...argmaxRule,
            score: (candidate) => candidate.direction === "short" ? candidate.feat_return20 ?? Number.NEGATIVE_INFINITY : Number.NEGATIVE_INFINITY,
        };
        const longDetail = collectDetail(archive, longOnly).detail!;
        const shortDetail = collectDetail(archive, shortOnly).detail!;
        // Same pair under both directions must never merge into one group.
        expect(longDetail.pairPerformance).to.have.length(1);
        expect(longDetail.pairPerformance[0]).to.include({ pair: "A/B", direction: "long", selectedCount: 2 });
        expect(shortDetail.pairPerformance).to.have.length(1);
        expect(shortDetail.pairPerformance[0]).to.include({ pair: "A/B", direction: "short", selectedCount: 2, wins: 1 });
    });

    it("caps the tail probe at the configured multi-candidate event limit", () => {
        const events: SpecEvent[] = [
            {
                signalTime: 100,
                candidates: [
                    specCandidate("A/B", "long", 3, 0.10),
                    specCandidate("C/D", "long", 2, 0.00),
                ],
            },
        ];
        // Four more gated multi-candidate tail events than the configured
        // limit; the probe must stop at the limit.
        for (let index = 0; index < SELECTION_RULES_DETAIL_PENDING_PROBE_MAX_EVENTS + 4; index += 1) {
            events.push({
                signalTime: 1000 + index,
                candidates: [
                    specCandidate(`R${index}/S${index}`, "long", 9, null),
                    specCandidate(`T${index}/U${index}`, "long", 1, 0.05),
                ],
            });
        }
        const archive = buildArchive(events);
        const { detail } = collectDetail(archive, rejectAllRule);
        expect(detail!.probe.eventsScanned).to.equal(SELECTION_RULES_DETAIL_PENDING_PROBE_MAX_EVENTS);
        expect(detail!.probe.scoredCandidates).to.equal(SELECTION_RULES_DETAIL_PENDING_PROBE_MAX_EVENTS * 2);
        expect(detail!.history).to.deep.equal([]);
        expect(detail!.latest).to.equal(null);

        // With an argmax rule every tail event picks, so the probe still scans
        // the whole bounded window and keeps the newest row as latest.
        const withPick = collectDetail(archive, argmaxRule);
        expect(withPick.detail!.probe.eventsScanned).to.equal(SELECTION_RULES_DETAIL_PENDING_PROBE_MAX_EVENTS);
        expect(withPick.detail!.latest!.signalTime).to.equal(1000 + SELECTION_RULES_DETAIL_PENDING_PROBE_MAX_EVENTS + 3);
        expect(withPick.detail!.latest!.pair).to.equal(`R${SELECTION_RULES_DETAIL_PENDING_PROBE_MAX_EVENTS + 3}/S${SELECTION_RULES_DETAIL_PENDING_PROBE_MAX_EVENTS + 3}`);
    });

    it("leaves the summary result, diagnostics, and report lines byte-identical with a detail sink attached", () => {
        const archive = buildArchive([
            {
                signalTime: 100,
                candidates: [
                    specCandidate("A/B", "long", 3, 0.10),
                    specCandidate("C/D", "long", 2, 0.00),
                ],
            },
            {
                signalTime: 400,
                candidates: [
                    specCandidate("M/N", "long", 9, null),
                    specCandidate("O/P", "long", 1, 0.05),
                ],
            },
        ]);
        const plain = tallyPairSelectionRule(archive, argmaxRule, undefined, 24);
        const { result: withDetail, detail } = collectDetail(archive, argmaxRule);
        expect(withDetail.picks).to.deep.equal(plain.picks);
        expect(withDetail.tally).to.deep.equal(plain.tally);
        expect(withDetail.reportLines).to.deep.equal(plain.reportLines);
        expect(Buffer.from(withDetail.reportLines.join("\n"))).to.deep.equal(Buffer.from(plain.reportLines.join("\n")));
        expect(withDetail.diagnostics.scoredCandidates).to.equal(plain.diagnostics.scoredCandidates);
        expect(withDetail.diagnostics.unscoredEvents).to.equal(plain.diagnostics.unscoredEvents);
        expect(detail).to.not.equal(null);
        // The probe row exists only in the detail payload, never in picks.
        expect(plain.picks.every((pick) => pick.signalTime !== 400)).to.equal(true);
        expect(withDetail.picks.every((pick) => pick.signalTime !== 400)).to.equal(true);
    });
});
