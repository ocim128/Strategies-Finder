import { expect } from "chai";
import { describe, it } from "node:test";
import {
    buildPrimaryVetoPreparedSignals,
    buildTargetConflictFilterPreparedSignals,
    type EnsembleRecipeSignalArtifact,
} from "./lib/ensemble-signal-recipes";
import { DEFAULT_BACKTEST_SETTINGS, type StrategyConfig } from "./lib/settings-model";
import { timeKey, type Signal, type Strategy } from "./lib/strategies";
import type { EnsembleEntryPresence } from "./lib/strategy-ensemble-types";

function createSignal(time: number, type: Signal["type"], barIndex: number): Signal {
    return {
        time,
        type,
        price: 100,
        barIndex,
    };
}

function createConfig(name: string): StrategyConfig {
    return {
        name,
        createdAt: "2026-03-28T00:00:00.000Z",
        updatedAt: "2026-03-28T00:00:00.000Z",
        strategyKey: `${name}_strategy`,
        strategyParams: {},
        backtestSettings: {
            ...DEFAULT_BACKTEST_SETTINGS,
            executionModel: "next_open",
        },
    };
}

function createStrategy(name: string): Strategy {
    return {
        name,
        description: `${name} strategy`,
        defaultParams: {},
        paramLabels: {},
        execute: () => [],
    };
}

function createPresenceLookup(entries: Array<{ time: number; longEntry?: boolean; shortEntry?: boolean }>): Map<string, EnsembleEntryPresence> {
    return new Map(
        entries.map((entry) => [
            timeKey(entry.time),
            {
                longEntry: entry.longEntry === true,
                shortEntry: entry.shortEntry === true,
            },
        ])
    );
}

function createArtifact(input: {
    name: string;
    tradeDirection: EnsembleRecipeSignalArtifact["tradeDirection"];
    preparedSignals: Signal[];
    entryPresenceByTime?: Map<string, EnsembleEntryPresence>;
}): EnsembleRecipeSignalArtifact {
    return {
        config: createConfig(input.name),
        strategy: createStrategy(input.name),
        familyLabel: input.name,
        tradeDirection: input.tradeDirection,
        preparedSignals: input.preparedSignals,
        entryPresenceByTime: input.entryPresenceByTime ?? new Map<string, EnsembleEntryPresence>(),
        backtestSettings: {
            ...DEFAULT_BACKTEST_SETTINGS,
            tradeDirection: input.tradeDirection,
            executionModel: "next_open",
        },
    };
}

describe("Ensemble signal recipes", () => {
    it("builds the aligned one-side conflict overlay across all selected configs, not just the target", () => {
        const targetArtifact = createArtifact({
            name: "Target",
            tradeDirection: "long",
            preparedSignals: [
                createSignal(300, "buy", 1),
                createSignal(900, "buy", 3),
            ],
        });
        const contextArtifact = createArtifact({
            name: "Opposer",
            tradeDirection: "both",
            preparedSignals: [
                createSignal(300, "sell", 1),
                createSignal(600, "sell", 2),
                createSignal(1200, "buy", 4),
            ],
            entryPresenceByTime: createPresenceLookup([
                { time: 300, shortEntry: true },
                { time: 600, shortEntry: true },
                { time: 900, longEntry: true },
                { time: 1200, longEntry: true },
            ]),
        });

        const filtered = buildTargetConflictFilterPreparedSignals(targetArtifact, [contextArtifact]);

        expect(filtered.map((signal) => `${signal.type}@${signal.time}`)).to.deep.equal([
            "sell@600",
            "buy@900",
            "buy@1200",
        ]);
    });

    it("keeps primary exits but vetoes only the primary entries that the veto config opposes", () => {
        const primaryArtifact = createArtifact({
            name: "Primary",
            tradeDirection: "short",
            preparedSignals: [
                createSignal(300, "sell", 1),
                createSignal(600, "buy", 2),
                createSignal(900, "sell", 3),
            ],
        });
        const vetoArtifact = createArtifact({
            name: "Veto",
            tradeDirection: "long",
            preparedSignals: [],
            entryPresenceByTime: createPresenceLookup([
                { time: 300, longEntry: true },
            ]),
        });

        const filtered = buildPrimaryVetoPreparedSignals(primaryArtifact, vetoArtifact);

        expect(filtered.map((signal) => `${signal.type}@${signal.time}`)).to.deep.equal([
            "buy@600",
            "sell@900",
        ]);
    });
});
