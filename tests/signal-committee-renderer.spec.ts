import { expect } from "chai";
import { describe, it } from "node:test";
import {
    buildCommitteeRowView,
    renderCommitteeHeader,
    renderCommitteeRows,
} from "../lib/signal-committee-renderer";
import type {
    AlertSubscription,
    CommitteeMemberState,
} from "../lib/alert-service";
import type { CommitteeAggregate } from "../lib/signal-committee-score";

/**
 * Tests for the Signal Committee view-model + HTML rendering layer.
 *
 * `buildCommitteeRowView` was extracted from the service specifically so the
 * status-precedence rules (last_status error vs cached-state reason vs
 * no_cached_state) and direction-label fallbacks can be unit-tested without
 * a DOM. These tests pin those rules down before they ossify.
 */

const NOW_SEC = 10_000;

type MemberPick = Pick<AlertSubscription,
    | "stream_id"
    | "symbol"
    | "interval"
    | "strategy_key"
    | "last_status"
    | "enabled">;

function baseMember(overrides: Partial<MemberPick> = {}): MemberPick {
    return {
        stream_id: "stream:a:1m:strat:cfg",
        symbol: "BTCUSDT",
        interval: "1m",
        strategy_key: "strat",
        last_status: "ok",
        enabled: 1,
        ...overrides,
    };
}

function openLongState(opts: { entrySec?: number; entryPrice?: number; latestClose?: number } = {}): CommitteeMemberState {
    const entrySec = opts.entrySec ?? 9_000;
    const entryPrice = opts.entryPrice ?? 100;
    return {
        streamId: "stream:a:1m:strat:cfg",
        ok: true,
        reason: null,
        symbol: "BTCUSDT",
        interval: "1m",
        strategyKey: "strat",
        evaluatedAt: "2026-06-21T00:00:00.000Z",
        closedCandleTimeSec: NOW_SEC,
        latestClose: opts.latestClose ?? 110,
        latestEntry: {
            direction: "long",
            signalTimeSec: entrySec,
            signalPrice: entryPrice,
            entryPrice,
            signalAgeBars: 1,
            isFresh: true,
            fingerprint: "strat:long:9000:100",
        },
        latestTrade: {
            entryTimeSec: entrySec,
            entryPrice,
            exitReason: "end_of_data",
            isOpen: true,
            takeProfitPrice: null,
            stopLossPrice: null,
            takeProfitPercent: null,
            stopLossPercent: null,
        },
        tradeWindows: null,
        lastStatus: "ok",
        lastRunAt: "2026-06-21T00:00:00.000Z",
        updatedAt: "2026-06-21T00:00:00.000Z",
        committeeTag: "default",
    };
}

describe("signal-committee-renderer / buildCommitteeRowView", () => {
    it("renders LONG / +1 for an open long trade", () => {
        const view = buildCommitteeRowView(baseMember(), openLongState(), NOW_SEC, "cfg");
        expect(view.directionLabel).to.equal("LONG");
        expect(view.directionTone).to.equal("long");
        expect(view.voteLabel).to.equal("+1");
        expect(view.statusTone).to.equal("ok");
        // entry 100 -> last 110 = +10%
        expect(view.gainLabel).to.equal("+10.00%");
    });

    it("renders SHORT / -1 for an open short trade and inverts gain", () => {
        const state = openLongState({ entryPrice: 100, latestClose: 90 });
        state.latestEntry = state.latestEntry
            ? { ...state.latestEntry, direction: "short", fingerprint: "strat:short:9000:100" }
            : null;
        const view = buildCommitteeRowView(baseMember(), state, NOW_SEC, "cfg");
        expect(view.directionLabel).to.equal("SHORT");
        expect(view.directionTone).to.equal("short");
        expect(view.voteLabel).to.equal("-1");
        // short: (entry - last)/entry*100 = (100-90)/100*100 = +10%
        expect(view.gainLabel).to.equal("+10.00%");
    });

    it("renders FLAT / 0 when the trade is closed but state is ok", () => {
        const state = openLongState();
        state.latestTrade = state.latestTrade
            ? { ...state.latestTrade, isOpen: false, exitReason: "tp" }
            : null;
        const view = buildCommitteeRowView(baseMember(), state, NOW_SEC, "cfg");
        expect(view.directionLabel).to.equal("FLAT");
        expect(view.directionTone).to.equal("flat");
        expect(view.voteLabel).to.equal("0");
        // No open trade -> gain/age both render "—".
        expect(view.gainLabel).to.equal("—");
        expect(view.ageLabel).to.equal("—");
    });

    it("renders PENDING when cached state is no_cached_state and last_status is clean", () => {
        const state: CommitteeMemberState = {
            ...openLongState(),
            ok: false,
            reason: "no_cached_state",
            latestTrade: null,
            latestEntry: null,
        };
        const view = buildCommitteeRowView(baseMember({ last_status: "no_cached_state" }), state, NOW_SEC, "cfg");
        expect(view.directionLabel).to.equal("PENDING");
        expect(view.directionTone).to.equal("pending");
        expect(view.statusLabel).to.equal("no_cached_state");
        expect(view.statusTone).to.equal("warn");
    });

    it("surfaces ERROR direction label when no_cached_state coexists with an error last_status", () => {
        const state: CommitteeMemberState = {
            ...openLongState(),
            ok: false,
            reason: "no_cached_state",
            latestTrade: null,
            latestEntry: null,
        };
        const view = buildCommitteeRowView(
            baseMember({ last_status: "error:Binance API unavailable" }),
            state,
            NOW_SEC,
            "cfg"
        );
        // The error in last_status wins over the otherwise-pending label.
        expect(view.directionLabel).to.equal("ERROR");
        expect(view.directionTone).to.equal("error");
        expect(view.statusLabel).to.contain("error:Binance API unavailable");
        expect(view.statusTone).to.equal("error");
    });

    it("uses cached-state reason as the status when last_status is clean and state is not ok", () => {
        const state: CommitteeMemberState = {
            ...openLongState(),
            ok: false,
            reason: "insufficient_data",
            latestTrade: null,
            latestEntry: null,
        };
        const view = buildCommitteeRowView(baseMember({ last_status: "ok" }), state, NOW_SEC, "cfg");
        expect(view.directionLabel).to.equal("ERROR");
        expect(view.statusLabel).to.equal("insufficient_data");
        // A non-no_cached_state reason is a harder failure than "pending".
        expect(view.statusTone).to.equal("error");
    });

    it("an error last_status overrides an otherwise-ok cached state", () => {
        // Cached state says ok=true with an open long, but the cron's last run
        // failed. The error must win so the row doesn't lie about being healthy.
        const state = openLongState();
        const view = buildCommitteeRowView(
            baseMember({ last_status: "error:telegram send failed" }),
            state,
            NOW_SEC,
            "cfg"
        );
        expect(view.statusLabel).to.equal("error:telegram send failed");
        expect(view.statusTone).to.equal("error");
    });

    it("falls back to strategy_key when stream id has no config name", () => {
        const view = buildCommitteeRowView(baseMember(), openLongState(), NOW_SEC, null);
        expect(view.configName).to.equal("strat");
    });

    it("truncates status labels longer than 80 chars and preserves the prefix", () => {
        const longError = "error:" + "x".repeat(120);
        const view = buildCommitteeRowView(
            baseMember({ last_status: longError }),
            undefined,
            NOW_SEC,
            "cfg"
        );
        expect(view.statusLabel.length).to.equal(80);
        expect(view.statusLabel.endsWith("...")).to.equal(true);
        // State map miss + error last_status -> error tone.
        expect(view.statusTone).to.equal("error");
    });

    it("treats an undefined state as warn-tone 'no state' when last_status is also null", () => {
        const view = buildCommitteeRowView(
            baseMember({ last_status: null }),
            undefined,
            NOW_SEC,
            "cfg"
        );
        expect(view.statusLabel).to.equal("no state");
        expect(view.statusTone).to.equal("warn");
    });
});

describe("signal-committee-renderer / renderCommitteeHeader", () => {
    function aggregate(overrides: Partial<CommitteeAggregate>): CommitteeAggregate {
        return {
            score: 0,
            longCount: 0,
            shortCount: 0,
            flatCount: 0,
            excludedCount: 0,
            avgAgeSec: null,
            avgGainPct: null,
            ...overrides,
        };
    }

    it("renders score with a leading + when positive and there are open trades", () => {
        const header = renderCommitteeHeader(aggregate({ score: 3, longCount: 3 }), "2026-06-21T00:00:00.000Z");
        expect(header.score).to.equal("+3");
        expect(header.scoreTone).to.equal("positive");
        expect(header.longShort).to.equal("3L / 0S / 0Flat");
    });

    it("renders — score when there are no open or flat rows", () => {
        const header = renderCommitteeHeader(aggregate({ score: 0 }), "2026-06-21T00:00:00.000Z");
        expect(header.score).to.equal("—");
        expect(header.scoreTone).to.equal("neutral");
    });

    it("renders a negative score tone when shorts dominate", () => {
        const header = renderCommitteeHeader(aggregate({ score: -2, shortCount: 2 }), null);
        expect(header.scoreTone).to.equal("negative");
    });

    it("renders — lastUpdated when updatedAtIso is null", () => {
        const header = renderCommitteeHeader(aggregate({ score: 1, longCount: 1 }), null);
        expect(header.lastUpdated).to.equal("—");
    });
});

describe("signal-committee-renderer / renderCommitteeRows", () => {
    it("emits an empty-state row with colspan when given no rows", () => {
        const html = renderCommitteeRows([]);
        expect(html).to.contain("colspan=\"10\"");
        expect(html).to.contain("Add Current Configuration");
    });

    it("escapes user-controlled fields (config name, status) to prevent HTML injection", () => {
        const view = {
            streamId: "stream:<x>",
            configName: "<script>alert(1)</script>",
            symbol: "BTCUSDT",
            interval: "1m",
            strategyKey: "strat",
            directionLabel: "LONG",
            directionTone: "long" as const,
            voteLabel: "+1",
            ageLabel: "1m 00s",
            gainLabel: "+1.00%",
            statusLabel: "ok",
            statusTone: "ok" as const,
            enabled: true,
        };
        const html = renderCommitteeRows([view]);
        expect(html).to.not.contain("<script>");
        expect(html).to.contain("&lt;script&gt;");
        // Stream id is also round-tripped through escapeHtml on the buttons.
        expect(html).to.contain("data-signal-committee-load=\"stream:&lt;x&gt;\"");
    });

    it("tones the direction cell and omits a vote column", () => {
        // Vote is no longer a column; direction carries the tone instead.
        const longRow = renderCommitteeRows([{
            streamId: "s1",
            configName: "cfg",
            symbol: "BTCUSDT",
            interval: "1m",
            strategyKey: "strat",
            directionLabel: "LONG",
            directionTone: "long",
            voteLabel: "+1",
            ageLabel: "—",
            gainLabel: "—",
            statusLabel: "ok",
            statusTone: "ok",
            enabled: true,
        }]);
        expect(longRow).to.contain("signal-committee__direction--long");
        // 10 cells = leading bulk-select checkbox + 9 original columns.
        const cells = longRow.match(/<td/g)?.length ?? 0;
        expect(cells).to.equal(10);
    });

    it("prepends a select checkbox carrying the stream id for bulk delete", () => {
        // The checkbox is the first cell and carries the stream id so the bulk
        // delete handler can fan out deletes without re-deriving it.
        const html = renderCommitteeRows([{
            streamId: "btcusdt:5m:strat",
            configName: "cfg",
            symbol: "BTCUSDT",
            interval: "5m",
            strategyKey: "strat",
            directionLabel: "FLAT",
            directionTone: "flat",
            voteLabel: "0",
            ageLabel: "—",
            gainLabel: "—",
            statusLabel: "ok",
            statusTone: "ok",
            enabled: true,
        }]);
        expect(html).to.contain('data-signal-committee-select="btcusdt:5m:strat"');
        // Checkbox must be the FIRST cell so it aligns with the header's
        // select-all checkbox column.
        const firstCell = html.match(/<tr[^>]*>\s*(<td[^>]*>)/)?.[1] ?? "";
        expect(firstCell).to.contain("signal-committee__select-cell");
    });
});

describe("signal-committee-renderer / deactivate (enabled flag)", () => {
    it("buildCommitteeRowView surfaces enabled=false for a disabled member", () => {
        const view = buildCommitteeRowView(
            baseMember({ enabled: 0 }),
            openLongState(),
            NOW_SEC,
            "cfg"
        );
        expect(view.enabled).to.equal(false);
    });

    it("forces a DISABLED direction label and 0 vote even with a stale open trade underneath", () => {
        // The member has a cached open long, but is deactivated — the row must
        // not lie about voting +1. Direction becomes DISABLED, tone muted.
        const view = buildCommitteeRowView(
            baseMember({ enabled: 0 }),
            openLongState(),
            NOW_SEC,
            "cfg"
        );
        expect(view.directionLabel).to.equal("DISABLED");
        expect(view.directionTone).to.equal("none");
        expect(view.voteLabel).to.equal("0");
    });

    it("renders an Activate button and disabled pill for a deactivated row", () => {
        const html = renderCommitteeRows([{
            streamId: "stream:z",
            configName: "cfg",
            symbol: "BTCUSDT",
            interval: "1m",
            strategyKey: "strat",
            directionLabel: "DISABLED",
            directionTone: "none",
            voteLabel: "0",
            ageLabel: "—",
            gainLabel: "—",
            statusLabel: "ok",
            statusTone: "ok",
            enabled: false,
        }]);
        // Muted row class.
        expect(html).to.contain('class="signal-committee__row--disabled"');
        // Disabled pill in the status cell.
        expect(html).to.contain("signal-committee__disabled-pill");
        // Toggle button targets enabling (next state = 1).
        expect(html).to.contain('data-signal-committee-toggle-enabled="1:stream:z"');
        expect(html).to.contain(">Activate<");
    });

    it("renders a Deactivate button for an active row with no muted class or pill", () => {
        const html = renderCommitteeRows([{
            streamId: "stream:z",
            configName: "cfg",
            symbol: "BTCUSDT",
            interval: "1m",
            strategyKey: "strat",
            directionLabel: "LONG",
            directionTone: "long",
            voteLabel: "+1",
            ageLabel: "—",
            gainLabel: "—",
            statusLabel: "ok",
            statusTone: "ok",
            enabled: true,
        }]);
        expect(html).to.not.contain("signal-committee__row--disabled");
        expect(html).to.not.contain("signal-committee__disabled-pill");
        // Toggle button targets disabling (next state = 0).
        expect(html).to.contain('data-signal-committee-toggle-enabled="0:stream:z"');
        expect(html).to.contain(">Deactivate<");
    });
});
