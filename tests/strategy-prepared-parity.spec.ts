import { expect } from "chai";
import { describe, it } from "node:test";
import type { OHLCVData, Strategy, Time } from "../lib/types/strategies";
import { short_term_overextension_fade } from "../lib/strategies/lib/short_term_overextension_fade";
import { adjacent_overlap_coagulation_continuation } from "../lib/strategies/lib/adjacent_overlap_coagulation_continuation";
import { decay_anchor_reversion } from "../lib/strategies/lib/decay_anchor_reversion";
import { efficiency_keltner_router } from "../lib/strategies/lib/efficiency_keltner_router";
import { modern_arbitrage_speed_reversion } from "../lib/strategies/lib/modern_arbitrage_speed_reversion";

function buildData(length: number): OHLCVData[] {
    const data: OHLCVData[] = [];
    let close = 100;
    for (let i = 0; i < length; i++) {
        const drift = i < length / 2 ? 0.22 : -0.16;
        const wave = Math.sin(i / 6) * 1.1;
        close = Math.max(5, close + drift + wave * 0.3);
        data.push({
            time: (i + 1) as Time,
            open: close - 0.4,
            high: close + 1.1,
            low: close - 1.1,
            close,
            volume: 1000 + (i % 13) * 90,
        });
    }
    return data;
}

const targets: Array<{ key: string; strategy: Strategy; paramSets: Record<string, number>[] }> = [
    {
        key: "short_term_overextension_fade",
        strategy: short_term_overextension_fade,
        paramSets: [{ lookback: 6 }, { lookback: 20 }, { lookback: 45 }],
    },
    {
        key: "adjacent_overlap_coagulation_continuation",
        strategy: adjacent_overlap_coagulation_continuation,
        paramSets: [{ min_final_overlap: 0.3 }, { min_final_overlap: 0.7 }, { min_final_overlap: 0.9 }],
    },
    {
        key: "decay_anchor_reversion",
        strategy: decay_anchor_reversion,
        paramSets: [{ decay: 1 }],
    },
    {
        key: "efficiency_keltner_router",
        strategy: efficiency_keltner_router,
        paramSets: [
            { er_lookback: 8, keltner_lookback: 20, er_threshold: 0.25 },
            { er_lookback: 20, keltner_lookback: 55, er_threshold: 0.4 },
        ],
    },
    {
        key: "modern_arbitrage_speed_reversion",
        strategy: modern_arbitrage_speed_reversion,
        paramSets: [
            { lookback: 8, zThreshold: 0.9, efficiencyMax: 0.2 },
            { lookback: 25, zThreshold: 1.3, efficiencyMax: 0.35 },
        ],
    },
];

describe("prepared Finder execution parity (top-5 unprepared strategies)", () => {
    for (const { key, strategy, paramSets } of targets) {
        it(`${key}: executePrepared matches execute across param sets`, () => {
            const data = buildData(240);
            expect(strategy.prepareFinderData, `${key} prepareFinderData`).to.be.a("function");
            expect(strategy.executePrepared, `${key} executePrepared`).to.be.a("function");
            const prepared = strategy.prepareFinderData!(data);
            for (const params of paramSets) {
                const direct = strategy.execute(data, params);
                const viaPrepared = strategy.executePrepared!(prepared, params, data);
                expect(viaPrepared, `${key} params ${JSON.stringify(params)}`).to.deep.equal(direct);
            }
        });
    }
});
