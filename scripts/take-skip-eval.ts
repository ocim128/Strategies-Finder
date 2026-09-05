/* Take/skip evaluation — standalone, reads L2 ledger JSONL directly. No checker/campaign dependencies. */
import { createReadStream } from "node:fs";
import readline from "node:readline";
import { createHash } from "node:crypto";

function fnv1a64(text: string): string {
    let h = BigInt("0xcbf29ce484222325");
    for (let i = 0; i < text.length; i++) {
        h ^= BigInt(text.charCodeAt(i));
        h = (h * BigInt("0x100000001b3")) & BigInt("0xFFFFFFFFFFFFFFFF");
    }
    return h.toString(16).padStart(16, "0");
}
function tieDigest(t: number, asset: string): string {
    return fnv1a64(`max_active_tie_v1|1|${Math.trunc(t)}|${asset}`);
}

interface Snap { eventId: string; decisionTimeSec: number; asset: string; signedVotes: number; activePairCount: number; longEligible: boolean; ema200Above: boolean; breadth: number | null; regime: string; }
interface Outcome { eventId: string; asset: string; horizonBars: number; direction: string; eligible: boolean; status: string; return: number; entryTimeSec: number; exitTimeSec: number; }
interface EvalEvent { t: number; eventId: string; inc: Snap; incReturn: number; }

async function main() {
    const dir = "archive/batch-open-score/sp500_top_mean_1788560534200_jedw";
    const snaps: Snap[] = [];
    const rl1 = readline.createInterface({ input: createReadStream(`${dir}/pool-snapshots.jsonl`), crlfDelay: Infinity });
    for await (const line of rl1) {
        if (!line.trim()) continue;
        snaps.push(JSON.parse(line));
    }
    const outcomes = new Map<string, Outcome>();
    const rl2 = readline.createInterface({ input: createReadStream(`${dir}/candidate-outcomes.jsonl`), crlfDelay: Infinity });
    for await (const line of rl2) {
        if (!line.trim()) continue;
        const o = JSON.parse(line);
        if (o.horizonBars === 24 && o.direction === "long") {
            outcomes.set(`${o.eventId}|${o.asset}`, o);
        }
    }

    // Group by event
    const eventMap = new Map<string, { t: number; eventId: string; cands: Snap[] }>();
    for (const s of snaps) {
        let e = eventMap.get(s.eventId);
        if (!e) { e = { t: s.decisionTimeSec, eventId: s.eventId, cands: [] }; eventMap.set(s.eventId, e); }
        e.cands.push(s);
    }

    // Select incumbents + join outcomes
    const events: EvalEvent[] = [];
    for (const [, e] of eventMap) {
        const base = e.cands.filter(c => c.longEligible && c.activePairCount > 0 && Number.isFinite(c.signedVotes / c.activePairCount) && c.signedVotes / c.activePairCount > 0);
        if (base.length < 2) continue;
        let best = base[0]!, bestScore = best.signedVotes / best.activePairCount, bestD = tieDigest(e.t, best.asset);
        for (const c of base.slice(1)) {
            const sc = c.signedVotes / c.activePairCount, d = tieDigest(e.t, c.asset);
            if (sc > bestScore || (sc === bestScore && (d < bestD || (d === bestD && c.asset < best.asset)))) { best = c; bestScore = sc; bestD = d; }
        }
        const key = `${e.eventId}|${best.asset}`;
        const o = outcomes.get(key);
        if (!o || !o.eligible || o.status !== "ok" || !Number.isFinite(o.return) || !Number.isFinite(o.entryTimeSec) || !Number.isFinite(o.exitTimeSec)) continue;
        events.push({ t: e.t, eventId: e.eventId, inc: best, incReturn: o.return });
    }
    events.sort((a, b) => a.t - b.t || a.eventId.localeCompare(b.eventId));
    console.log(`evaluable events: ${events.length}`);
    console.log(`total incumbent return: ${(events.reduce((s, e) => s + e.incReturn, 0) * 100).toFixed(2)}%`);

    // Asset histories (incrementally built)
    const assetReturns = new Map<string, number[]>();
    const globalReturns: number[] = [];
    const selectedAssets: string[] = [];

    interface Gate { name: string; taken: number; skipped: number; takenSum: number; allSum: number; }
    const gates: Array<{ name: string; check: (e: EvalEvent, ctx: { S1: number; S2: number | null; C: number; B: number | null; tieCount: number; assetHist: number[]; globalHist: number[] }) => boolean }> = [
        { name: "score_floor_075", check: (e, c) => c.S1 >= 0.75 },
        { name: "coverage_floor_41", check: (e, c) => c.C >= 41 },
        { name: "score_margin_0025", check: (e, c) => c.S2 === null ? true : c.S1 - c.S2 >= 0.025 },
        { name: "unique_score_winner", check: (e, c) => c.tieCount === 1 },
        { name: "bullish_breadth_only", check: (e, c) => c.B !== null && c.B >= 0.50 },
        { name: "breadth_euphoria_cap_078", check: (e, c) => c.B === null ? true : c.B <= 0.78 },
        { name: "bear_coverage_confirmation_48", check: (e, c) => c.B === null ? c.C >= 48 : (c.B >= 0.50 ? true : c.C >= 48) },
        { name: "same_asset_two_loss_veto", check: (e, c) => { const h = c.assetHist; return h.length < 2 ? true : !(h[h.length - 1] < 0 && h[h.length - 2] < 0); } },
        { name: "global_return_regime_10", check: (e, c) => c.globalHist.length < 10 ? true : c.globalHist.slice(-10).reduce((a, b) => a + b, 0) / 10 >= 0 },
        { name: "global_volatility_cap_10pct", check: (e, c) => c.globalHist.length < 20 ? true : Math.sqrt(c.globalHist.slice(-20).reduce((s, v) => s + v * v, 0) / 20 - Math.pow(c.globalHist.slice(-20).reduce((a, b) => a + b, 0) / 20, 2)) <= 0.10 },
    ];
    const gateResults: Gate[] = gates.map(g => ({ name: g.name, taken: 0, skipped: 0, takenSum: 0, allSum: 0 }));

    for (const e of events) {
        // Build context
        const allScores = eventMap.get(e.eventId)!.cands
            .filter(c => c.longEligible && c.activePairCount > 0)
            .map(c => c.signedVotes / c.activePairCount)
            .filter(s => Number.isFinite(s) && s > 0)
            .sort((a, b) => b - a);
        const S1 = allScores[0] ?? 0;
        const S2 = allScores[1] ?? null;
        const C = e.inc.activePairCount;
        const B = e.inc.breadth;
        const tieCount = allScores.filter(s => s === allScores[0]).length;
        const assetKey = e.inc.asset;
        const assetHist = assetReturns.get(assetKey) ?? [];
        const globalHist = [...globalReturns];

        const ctx = { S1, S2, C, B, tieCount, assetHist, globalHist };

        // Update histories with THIS event's incumbent outcome
        globalReturns.push(e.incReturn);
        if (!assetReturns.has(assetKey)) assetReturns.set(assetKey, []);
        assetReturns.get(assetKey)!.push(e.incReturn);

        // Apply gates
        for (let gi = 0; gi < gates.length; gi++) {
            const take = gates[gi].check(e, ctx);
            const g = gateResults[gi];
            g.allSum += e.incReturn;
            if (take) { g.taken += 1; g.takenSum += e.incReturn; } else { g.skipped += 1; }
        }
    }

    const allTotal = gateResults[0]?.allSum ?? 0;
    console.log(`\nallReturnSum=${(allTotal * 100).toFixed(4)}pp over ${events.length} events`);
    console.log("");
    for (const g of gateResults) {
        const diff = g.takenSum - (allTotal - (g.allSum - g.allSum)); // diff = takenSum - (allSum - takenSum_skipped_returns)
        // Actually: takenSum is sum over taken events. allSum is sum over ALL events.
        // difference = takenSum - allSum = -(sum of skipped returns)
        const d = g.takenSum - allTotal;
        console.log(`GATE|name=${g.name}|taken=${g.taken}|skipped=${events.length - g.taken}|takenReturnSum=${(g.takenSum * 100).toFixed(4)}pp|allReturnSum=${(allTotal * 100).toFixed(4)}pp|difference=${(d * 100).toFixed(4)}pp|verdict=${d > 0 ? "POSITIVE" : "NEGATIVE"}`);
    }
}
main();
